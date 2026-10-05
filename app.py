#!/usr/bin/env python3
"""
InterBase Query Manager — a self-contained web app for running SQL
across multiple InterBase servers and databases.

Zero-install: all dependencies are in ./vendor (Flask, firebirdsql).
Just copy the folder to your RDS and run:  python app.py
Open http://localhost:5000 in your browser.
"""

import os
import sys
import json
import time
import uuid
import threading
import secrets
import hashlib
from datetime import datetime, date
from decimal import Decimal

# ── vendored deps (zero-install) ──────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

from flask import Flask, render_template, request, jsonify, Response, stream_with_context, session, redirect, url_for

# firebirdsql speaks the Firebird wire protocol which InterBase understands
# (InterBase is the ancestor of Firebird; the wire protocol is compatible)
try:
    import firebirdsql
except ImportError:
    firebirdsql = None

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
app.secret_key = secrets.token_hex(32)

# ── Paths ─────────────────────────────────────────────────────────────────
BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH    = os.path.join(BASE_DIR, "config.json")
SAVED_DIR      = os.path.join(BASE_DIR, "saved")
HISTORY_PATH   = os.path.join(BASE_DIR, "saved", "history.json")
os.makedirs(SAVED_DIR, exist_ok=True)

# ── Authentication ─────────────────────────────────────────────────────────
# Authentication uses the members_ table in PAYOFFICE.IB on PIDB08.
# Columns: USERNAME, PASSWD

AUTH_HOST = "10.100.5.18"  # PIDB08
AUTH_DB_PATH = r"e:\Databases\MyPO\PAYOFFICE.IB"

def _get_auth_conn():
    """Get a connection to the PAYOFFICE.IB auth database on PIDB08."""
    cfg = load_config()
    creds = cfg.get("credentials", {})
    # Find the server by host IP
    server = None
    for s in cfg.get("servers", []):
        if s.get("host") == AUTH_HOST:
            server = s
            break
    if not server:
        raise RuntimeError(f"Auth server {AUTH_HOST} not found in config")
    return cm.get(server["id"], AUTH_DB_PATH, creds.get("username", "SYSDBA"), creds.get("password", "masterkey"))

import hashlib as _hashlib

def _hash_passwd(password):
    """Hash a password the same way Affinity stores it in MEMBERS_.PASSWD.
    The column is 32 hex chars = MD5 hash."""
    return _hashlib.md5(password.encode("utf-8")).hexdigest()

def check_login(username, password):
    """Authenticate against the members_ table in PAYOFFICE.IB on PIDB08."""
    if firebirdsql is None:
        raise RuntimeError("Database driver not available")
    conn = _get_auth_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT USERNAME, PASSWD, LOGIN_DISABLED "
        "FROM MEMBERS_ "
        "WHERE UPPER(USERNAME) = '" + username.upper().replace("'", "''") + "'"
    )
    row = cur.fetchone()
    cur.close()
    if row:
        db_username = row[0].strip() if isinstance(row[0], str) else str(row[0])
        db_passwd = row[1].strip() if isinstance(row[1], str) else str(row[1])
        if isinstance(db_passwd, bytes):
            db_passwd = db_passwd.decode("latin-1")
        login_disabled = row[2]
        if isinstance(login_disabled, str):
            login_disabled = login_disabled.strip().upper()
        # Check if account is disabled
        if login_disabled in ("Y", "1", "TRUE"):
            return None
        # Compare MD5 hash of supplied password with stored hash
        if db_passwd.lower() == _hash_passwd(password).lower():
            return {
                "username": db_username,
                "name": db_username,
                "admin": True,
            }
    return None

def get_current_user():
    if "user" not in session:
        return None
    return session["user"]

from functools import wraps

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user" not in session:
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "Not authenticated"}), 401
            return redirect("/login")
        return f(*args, **kwargs)
    return decorated

# ── Connection idle timeout ───────────────────────────────────────────────
CONNECTION_IDLE_TIMEOUT = 300  # 5 minutes — drop idle connections
_connection_last_used = {}  # (server_id, db_path) -> timestamp

def touch_connection(key):
    _connection_last_used[key] = time.time()

def cleanup_idle_connections():
    """Drop connections that have been idle for too long."""
    now = time.time()
    with cm._lock:
        stale = [key for key, ts in _connection_last_used.items()
                 if now - ts > CONNECTION_IDLE_TIMEOUT]
        for key in stale:
            conn = cm._conns.pop(key, None)
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
            _connection_last_used.pop(key, None)

# Background thread to clean up idle connections every 60 seconds
def _idle_cleanup_thread():
    while True:
        time.sleep(60)
        try:
            cleanup_idle_connections()
        except Exception:
            pass

_cleanup_thread = threading.Thread(target=_idle_cleanup_thread, daemon=True)
_cleanup_thread.start()

# ── SQL safety check ──────────────────────────────────────────────────────
import re as _re

# Keywords that modify data or schema — blocked in multi-server mode
_WRITE_KEYWORDS = {
    "insert", "update", "delete", "drop", "alter", "create", "truncate",
    "merge", "execute", "exec", "grant", "revoke", "set", "commit",
    "rollback", "savepoint", "declare", "replace", "rename", "attach",
    "detach", "recreate", "shutdown", "online", "backup", "restore",
}

def is_readonly_sql(sql):
    """Return True only if the SQL is a safe read-only SELECT query.

    Checks:
    1. First non-comment keyword must be SELECT or WITH
    2. No write keywords found as standalone SQL statements
    3. Rejects multiple statements containing writes
    """
    if not sql or not sql.strip():
        return False

    # Strip comments (both -- and /* */ styles)
    cleaned = _re.sub(r'--[^\n]*', '', sql)
    cleaned = _re.sub(r'/\*.*?\*/', '', cleaned, flags=_re.DOTALL)
    cleaned = cleaned.strip()

    if not cleaned:
        return False

    # Split on semicolons to check each statement
    statements = [s.strip() for s in cleaned.split(';') if s.strip()]

    for stmt in statements:
        # Get the first word (keyword)
        first_word = stmt.split()[0].upper() if stmt.split() else ''
        # Must start with SELECT or WITH (CTE)
        if first_word not in ('SELECT', 'WITH'):
            return False

        # Also scan for dangerous keywords that could be embedded
        # (e.g. "SELECT ... INTO" creates a table in some dialects)
        words = set(_re.findall(r'\b([A-Za-z_]+)\b', stmt.lower()))
        # "SELECT ... INTO" is a write operation
        if 'into' in words and first_word == 'SELECT':
            return False
        # Check for any write keywords as statement-level keywords
        # (not inside string literals — we already stripped comments,
        # but string literals could still contain these words)
        # Simple heuristic: if any write keyword appears as a word
        # outside of quotes, block it
        stmt_no_strings = _re.sub(r"'[^']*'", "''", stmt)
        stmt_words = set(_re.findall(r'\b([A-Za-z_]+)\b', stmt_no_strings.lower()))
        dangerous = stmt_words & _WRITE_KEYWORDS
        if dangerous:
            return False

    return True

# ── Config ────────────────────────────────────────────────────────────────
def load_config():
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=4)

# ── Connection manager ───────────────────────────────────────────────────
class ConnectionManager:
    """Lazily creates and caches connections per (server_id, db_path)."""

    def __init__(self):
        self._conns = {}   # (server_id, db_path) -> connection
        self._lock = threading.Lock()
        self._auth_cache = {}  # host -> auth_plugin that worked

    def get(self, server_id, db_path, username, password):
        key = (server_id, db_path)
        with self._lock:
            conn = self._conns.get(key)
            if conn is not None:
                # Quick local check — is the socket still alive?
                sock = getattr(conn, 'sock', None)
                if sock is not None and getattr(sock, '_sock', None) is not None:
                    touch_connection(key)
                    return conn
                # Socket is dead — remove from cache and reconnect
                self._conns.pop(key, None)
        # create new connection outside lock to avoid blocking
        cfg = load_config()
        server = next((s for s in cfg["servers"] if s["id"] == server_id), None)
        if not server:
            raise ValueError(f"Server '{server_id}' not found in config")
        if firebirdsql is None:
            raise RuntimeError(
                "firebirdsql not installed. Run: pip install firebirdsql"
            )
        host = server["host"]
        port = server.get("port", 3050)

        # The patched firebirdsql library now auto-detects InterBase:
        # it tries Firebird 3+ protocol (Srp256) first, and if the server
        # rejects it (op_reject), falls back to the classic InterBase
        # protocol (CONNECT_VERSION 1 with password in DPB).
        auth_plugin = server.get("auth_plugin")      # None = auto-detect
        wire_crypt  = server.get("wire_crypt", True)  # default on
        errors = []

        # If a specific auth plugin is configured, try only that one.
        # If we've previously found a working auth method for this host,
        # use it directly (skip the rejected methods).
        # Otherwise try Srp256 first (library auto-falls-back to InterBase),
        # then Srp, then Legacy_Auth as a last resort.
        if auth_plugin:
            auth_chain = [auth_plugin]
        elif host in self._auth_cache:
            auth_chain = [self._auth_cache[host]]
        else:
            auth_chain = ["Srp256", "Srp", "Legacy_Auth"]

        for plugin in auth_chain:
            try:
                conn = firebirdsql.connect(
                    host=host,
                    port=port,
                    database=db_path,
                    user=username,
                    password=password,
                    charset="NONE",
                    auth_plugin_name=plugin,
                    wire_crypt=wire_crypt,
                    timeout=10,
                )
                with self._lock:
                    self._conns[key] = conn
                touch_connection(key)
                # Remember which auth method worked for this host
                self._auth_cache[host] = plugin
                return conn
            except Exception as e:
                err_msg = str(e)
                if plugin == "Legacy_Auth" and "passlib" in err_msg:
                    errors.append(f"{plugin}: requires passlib (not bundled)")
                else:
                    errors.append(f"{plugin}: {err_msg}")
                continue

        # All auth methods failed — show ALL errors
        raise ConnectionError(
            f"Could not connect to {host}:{port} — tried {', '.join(auth_chain)}.\n"
            + "\n".join(f"  • {e}" for e in errors)
        )

    def close_all(self):
        with self._lock:
            for conn in self._conns.values():
                try:
                    conn.close()
                except Exception:
                    pass
            self._conns.clear()

    def close(self, server_id, db_path):
        key = (server_id, db_path)
        with self._lock:
            conn = self._conns.pop(key, None)
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass

cm = ConnectionManager()

# ── JSON serialiser for Decimal / datetime ────────────────────────────────
def json_safe(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, bytes):
        # With charset NONE, text comes back as raw bytes.
        # Try WIN1252 first (most likely for InterBase), then Latin-1, then UTF-8.
        for enc in ("win1252", "latin-1", "utf-8"):
            try:
                return obj.decode(enc)
            except (UnicodeDecodeError, ValueError):
                continue
        # Last resort: decode with replacement
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, str):
        try:
            obj.encode("utf-8")
            return obj
        except UnicodeEncodeError:
            return obj.encode("utf-8", errors="replace").decode("utf-8")
    if isinstance(obj, dict):
        return {k: json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]
    return obj


def fast_row_to_json(row):
    """Convert a single database row to a JSON-safe list.

    Non-recursive fast path for query results.
    """
    out = []
    for v in row:
        if v is None:
            out.append(None)
        elif isinstance(v, str):
            if v.isascii():
                out.append(v)
            else:
                try:
                    v.encode("utf-8")
                    out.append(v)
                except UnicodeEncodeError:
                    out.append(v.encode("utf-8", errors="replace").decode("utf-8"))
        elif isinstance(v, bytes):
            # With charset NONE, text columns come back as raw bytes.
            # Latin-1 NEVER fails (every byte 0-255 is valid), so use it
            # directly instead of trying 3 encodings in a loop.
            # This is correct for WIN1252 data too (Latin-1 is a superset
            # for byte values 0-255, and Python's JSON encoder will handle
            # any remaining issues).
            out.append(v.decode("latin-1"))
        elif isinstance(v, Decimal):
            out.append(float(v))
        elif isinstance(v, (datetime, date)):
            out.append(v.isoformat())
        elif isinstance(v, (int, float, bool)):
            out.append(v)
        else:
            out.append(str(v))
    return out


def rows_to_json(rows):
    """Convert a list of database rows to JSON-safe lists — fast path."""
    return [fast_row_to_json(r) for r in rows]

# ── History ───────────────────────────────────────────────────────────────
def load_history():
    if not os.path.exists(HISTORY_PATH):
        return []
    try:
        with open(HISTORY_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return []

def save_history(entries):
    # keep last 1000 entries (per-user history)
    with open(HISTORY_PATH, "w") as f:
        json.dump(entries[-1000:], f, indent=2)

def add_history(entry):
    entries = load_history()
    entry["id"] = str(uuid.uuid4())[:8]
    entry["ts"] = datetime.now().isoformat(timespec="seconds")
    # Record which user ran the query
    user = get_current_user()
    entry["user"] = user["username"] if user else "unknown"
    entry["user_name"] = user.get("name", "") if user else ""
    entries.append(entry)
    save_history(entries)
    return entry

# ── Saved scripts ─────────────────────────────────────────────────────────
def list_saved_scripts():
    scripts = []
    if os.path.isdir(SAVED_DIR):
        for fn in os.listdir(SAVED_DIR):
            if fn.endswith(".sql") and fn != "history.json":
                fp = os.path.join(SAVED_DIR, fn)
                try:
                    with open(fp, "r", encoding="utf-8") as f:
                        content = f.read()
                    scripts.append({
                        "filename": fn,
                        "name": fn[:-4],  # strip .sql
                        "size": len(content),
                        "modified": datetime.fromtimestamp(
                            os.path.getmtime(fp)
                        ).isoformat(timespec="seconds"),
                        "preview": content[:200],
                    })
                except Exception:
                    pass
    return scripts

def save_script(name, sql):
    fn = f"{name}.sql"
    # sanitise filename
    safe = "".join(c for c in fn if c.isalnum() or c in "._- ")
    if not safe.endswith(".sql"):
        safe += ".sql"
    fp = os.path.join(SAVED_DIR, safe)
    with open(fp, "w", encoding="utf-8") as f:
        f.write(sql)
    return safe

def load_script(fn):
    fp = os.path.join(SAVED_DIR, fn)
    if not os.path.exists(fp):
        return None
    with open(fp, "r", encoding="utf-8") as f:
        return f.read()

def delete_script(fn):
    fp = os.path.join(SAVED_DIR, fn)
    if os.path.exists(fp):
        os.remove(fp)

# ── Login / Logout ────────────────────────────────────────────────────────
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        data = request.get_json() if request.is_json else request.form
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        try:
            user = check_login(username, password)
        except Exception as e:
            err = f"Cannot connect to authentication database: {e}"
            if request.is_json:
                return jsonify({"ok": False, "error": err}), 500
            return render_template("login.html", error=err)
        if user:
            session["user"] = {
                "username": user["username"],
                "name": user.get("name", user["username"]),
                "admin": user.get("admin", False),
            }
            if request.is_json:
                return jsonify({"ok": True, "user": session["user"]})
            return redirect("/")
        if request.is_json:
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401
        return render_template("login.html", error="Invalid username or password")
    return render_template("login.html", error=None)

@app.route("/logout")
def logout():
    session.pop("user", None)
    return redirect("/login")

@app.route("/api/auth-debug")
def auth_debug():
    """Debug endpoint to test authentication database connection (no login required)."""
    results = {}
    # 1. Can we connect?
    try:
        conn = _get_auth_conn()
        results["connection"] = "OK"
    except Exception as e:
        results["connection"] = f"FAILED: {e}"
        return jsonify(results)

    cur = conn.cursor()

    # 2. Does the MEMBERS_ table exist and how many rows?
    try:
        cur.execute("SELECT COUNT(*) FROM MEMBERS_")
        count = cur.fetchone()[0]
        results["members_count"] = count
    except Exception as e:
        results["members_count"] = f"ERROR: {e}"
        cur.close()
        return jsonify(results)

    # 3. Show first 5 users (username only, no passwords)
    try:
        cur.execute("SELECT USERNAME FROM MEMBERS_ ROWS 1 TO 5")
        sample = []
        for row in cur.fetchall():
            uname = row[0].strip() if isinstance(row[0], str) else str(row[0])
            sample.append(uname)
        results["sample_users"] = sample
    except Exception as e:
        results["sample_users"] = f"ERROR: {e}"

    # 4. What columns does MEMBERS_ have?
    try:
        cur.execute(
            "SELECT f.RDB$FIELD_NAME "
            "FROM RDB$RELATION_FIELDS f "
            "WHERE f.RDB$RELATION_NAME = 'MEMBERS_' "
            "ORDER BY f.RDB$FIELD_POSITION"
        )
        cols = []
        for row in cur.fetchall():
            cols.append(row[0].strip() if isinstance(row[0], str) else str(row[0]))
        results["columns"] = cols
    except Exception as e:
        results["columns"] = f"ERROR: {e}"

    # 5. If a username is provided, show password format and login_disabled
    test_user = request.args.get("user", "").strip()
    if test_user:
        try:
            cur.execute(
                "SELECT USERNAME, PASSWD, LOGIN_DISABLED "
                "FROM MEMBERS_ "
                "WHERE UPPER(USERNAME) = '" + test_user.upper().replace("'", "''") + "'"
            )
            row = cur.fetchone()
            if row:
                uname = row[0].strip() if isinstance(row[0], str) else str(row[0])
                passwd = row[1] if row[1] is not None else ""
                if isinstance(passwd, bytes):
                    passwd = passwd.decode("latin-1")
                disabled = row[2]
                # Show password format: first 20 chars + length + whether it looks like a hash
                passwd_str = str(passwd)
                results["test_user"] = {
                    "username": uname,
                    "passwd_prefix": passwd_str[:20],
                    "passwd_length": len(passwd_str),
                    "looks_like_hash": len(passwd_str) >= 32 and all(c in "0123456789abcdefABCDEF" for c in passwd_str),
                    "login_disabled": disabled,
                }
            else:
                results["test_user"] = f"User '{test_user}' not found in MEMBERS_"
        except Exception as e:
            results["test_user"] = f"ERROR: {e}"

    cur.close()
    return jsonify(results)

@app.route("/api/user")
def api_user():
    user = get_current_user()
    if user:
        return jsonify({"user": user})
    return jsonify({"user": None}), 401

# ── User management (admin only) ──────────────────────────────────────────
@login_required
@app.route("/api/users", methods=["GET", "POST"])
def api_users():
    user = get_current_user()
    if not user or not user.get("admin"):
        return jsonify({"error": "Admin access required"}), 403

    if request.method == "GET":
        # List users from members_ table
        try:
            conn = _get_auth_conn()
            cur = conn.cursor()
            cur.execute("SELECT USERNAME FROM MEMBERS_ ORDER BY USERNAME")
            users = []
            for row in cur.fetchall():
                uname = row[0].strip() if isinstance(row[0], str) else str(row[0])
                users.append({"username": uname, "name": uname, "admin": True})
            cur.close()
            return jsonify(users)
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    data = request.get_json()
    action = data.get("action")

    if action == "password":
        # Change password in members_ table
        pw_user = data.get("username", "").strip()
        new_pw = data.get("password", "")
        if not pw_user or not new_pw:
            return jsonify({"error": "Username and password required"}), 400
        try:
            conn = _get_auth_conn()
            cur = conn.cursor()
            cur.execute(
                "UPDATE MEMBERS_ SET PASSWD = '" + new_pw.replace("'", "''") + "' "
                "WHERE UPPER(USERNAME) = '" + pw_user.upper().replace("'", "''") + "'"
            )
            conn.commit()
            cur.close()
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    if action == "add":
        # Add user to members_ table
        new_user = data.get("username", "").strip()
        new_pw = data.get("password", "")
        if not new_user or not new_pw:
            return jsonify({"error": "Username and password required"}), 400
        try:
            conn = _get_auth_conn()
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO MEMBERS_ (USERNAME, PASSWD) VALUES ('"
                + new_user.replace("'", "''") + "', '" + new_pw.replace("'", "''") + "')"
            )
            conn.commit()
            cur.close()
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    if action == "delete":
        del_user = data.get("username", "").strip()
        if not del_user:
            return jsonify({"error": "Username required"}), 400
        try:
            conn = _get_auth_conn()
            cur = conn.cursor()
            cur.execute(
                "DELETE FROM MEMBERS_ WHERE UPPER(USERNAME) = '" + del_user.upper().replace("'", "''") + "'"
            )
            conn.commit()
            cur.close()
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    return jsonify({"error": "Unknown action"}), 400

# ── Routes ────────────────────────────────────────────────────────────────
@login_required
@app.route("/")
@login_required
def index():
    return render_template("index.html")

@login_required
@app.route("/api/config")
def api_config():
    cfg = load_config()
    # mask password in API response
    safe = json.loads(json.dumps(cfg))
    if safe.get("credentials", {}).get("password"):
        safe["credentials"]["password"] = "***"
    return jsonify(safe)

@login_required
@app.route("/api/config", methods=["POST"])
def api_save_config():
    cfg = request.get_json()
    if cfg:
        # if password is masked, keep old password
        old = load_config()
        if cfg.get("credentials", {}).get("password") == "***":
            cfg["credentials"]["password"] = old["credentials"]["password"]
        save_config(cfg)
        return jsonify({"ok": True})
    return jsonify({"ok": False, "error": "No config body"}), 400

# ── Add / delete databases ────────────────────────────────────────────────
@login_required
@app.route("/api/servers/<server_id>/databases", methods=["POST"])
def api_add_database(server_id):
    """Add a database to a server."""
    data = request.get_json()
    db_name = data.get("name", "").strip()
    db_path = data.get("path", "").strip()
    company_number = data.get("company_number", "").strip()
    if not db_name or not db_path:
        return jsonify({"ok": False, "error": "Name and path are required"}), 400

    cfg = load_config()
    server = next((s for s in cfg["servers"] if s["id"] == server_id), None)
    if not server:
        return jsonify({"ok": False, "error": "Server not found"}), 404

    # Check for duplicate path
    for db in server["databases"]:
        if db["path"].lower() == db_path.lower():
            return jsonify({"ok": False, "error": f"Database path already exists: {db_path}"}), 400

    new_db = {
        "name": db_name,
        "path": db_path,
        "company_number": company_number,
    }
    server["databases"].append(new_db)

    # Sort by company_number
    server["databases"].sort(
        key=lambda d: int(d.get("company_number", "0"))
        if str(d.get("company_number", "")).isdigit()
        else 0
    )

    save_config(cfg)
    return jsonify({"ok": True, "database": new_db})

@login_required
@app.route("/api/servers/<server_id>/databases", methods=["DELETE"])
def api_delete_database(server_id):
    """Delete a database from a server by path."""
    db_path = request.args.get("path", "").strip()
    if not db_path:
        return jsonify({"ok": False, "error": "Path parameter required"}), 400

    cfg = load_config()
    server = next((s for s in cfg["servers"] if s["id"] == server_id), None)
    if not server:
        return jsonify({"ok": False, "error": "Server not found"}), 404

    original_count = len(server["databases"])
    server["databases"] = [
        db for db in server["databases"] if db["path"].lower() != db_path.lower()
    ]

    if len(server["databases"]) == original_count:
        return jsonify({"ok": False, "error": "Database not found"}), 404

    save_config(cfg)
    return jsonify({"ok": True, "remaining": len(server["databases"])})

@login_required
@app.route("/api/servers")
def api_servers():
    cfg = load_config()
    servers = []
    for s in cfg["servers"]:
        servers.append({
            "id": s["id"],
            "name": s["name"],
            "host": s["host"],
            "port": s.get("port", 3050),
            "databases": s.get("databases", []),
        })
    return jsonify(servers)

@login_required
@app.route("/api/test-connection", methods=["POST"])
def api_test_connection():
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    cfg = load_config()
    creds = cfg.get("credentials", {})
    username = data.get("username", creds.get("username", "SYSDBA"))
    password = data.get("password", creds.get("password", "masterkey"))
    try:
        conn = cm.get(server_id, db_path, username, password)
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM RDB$DATABASE")
        row = cur.fetchone()
        cur.close()
        # Report which auth plugin actually succeeded
        auth_used = getattr(conn, "auth_plugin_name", "unknown")
        accept_plugin = getattr(conn, "accept_plugin_name", b"")
        if isinstance(accept_plugin, bytes):
            accept_plugin = accept_plugin.decode("utf-8", errors="replace")
        wire_crypt = getattr(conn, "wire_crypt", None)
        protocol = getattr(conn, "accept_version", None)
        return jsonify({
            "ok": True,
            "message": "Connection successful",
            "auth_requested": auth_used,
            "auth_accepted": accept_plugin or auth_used,
            "wire_crypt": wire_crypt,
            "protocol_version": protocol,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 200


@login_required
@app.route("/api/diagnose-connection", methods=["POST"])
def api_diagnose_connection():
    """Try each auth method separately and report detailed errors."""
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    cfg = load_config()
    creds = cfg.get("credentials", {})
    username = data.get("username", creds.get("username", "SYSDBA"))
    password = data.get("password", creds.get("password", "masterkey"))

    server = next((s for s in cfg["servers"] if s["id"] == server_id), None)
    if not server:
        return jsonify({"error": f"Server '{server_id}' not found"}), 400

    host = server["host"]
    port = server.get("port", 3050)

    if firebirdsql is None:
        return jsonify({"error": "firebirdsql not available"}), 500

    # Test raw TCP connectivity first
    import socket as _socket
    tcp_result = {"host": host, "port": port}
    try:
        sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect((host, port))
        sock.close()
        tcp_result["ok"] = True
        tcp_result["message"] = "TCP connection succeeded"
    except Exception as e:
        tcp_result["ok"] = False
        tcp_result["error"] = str(e)
        return jsonify({
            "tcp": tcp_result,
            "auth_attempts": [],
            "summary": f"TCP connection to {host}:{port} failed — {e}",
        })

    # Try each auth method separately
    wire_crypt = server.get("wire_crypt", True)
    auth_methods = ["Srp256", "Srp", "Legacy_Auth"]
    attempts = []

    for plugin in auth_methods:
        attempt = {"plugin": plugin, "wire_crypt": wire_crypt}
        try:
            conn = firebirdsql.connect(
                host=host,
                port=port,
                database=db_path,
                user=username,
                password=password,
                charset="NONE",
                auth_plugin_name=plugin,
                wire_crypt=wire_crypt,
                timeout=10,
            )
            # Connection succeeded — test a simple query
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM RDB$DATABASE")
            cur.fetchone()
            cur.close()

            accept_plugin = getattr(conn, "accept_plugin_name", b"")
            if isinstance(accept_plugin, bytes):
                accept_plugin = accept_plugin.decode("utf-8", errors="replace")
            protocol = getattr(conn, "accept_version", None)

            attempt["ok"] = True
            attempt["auth_accepted"] = accept_plugin or plugin
            attempt["protocol_version"] = protocol
            attempt["wire_crypt_enabled"] = getattr(conn, "wire_crypt", None)
            attempt["is_interbase"] = getattr(conn, "_is_interbase", False)
            conn.close()
            # Don't cache — let the real connection manager handle it
            cm.close(server_id, db_path)
            break  # success, no need to try more
        except Exception as e:
            attempt["ok"] = False
            attempt["error"] = str(e)
            # Try to extract the InterBase error code
            err_str = str(e)
            if "OperationalError" in err_str or "sqlcode" in err_str.lower():
                attempt["error_type"] = "database_error"
            elif "timeout" in err_str.lower() or "refused" in err_str.lower():
                attempt["error_type"] = "network_error"
            else:
                attempt["error_type"] = "auth_error"
        attempts.append(attempt)

    # Also try with wire_crypt=False in case encryption is the issue
    if not any(a.get("ok") for a in attempts):
        for plugin in ["Srp256", "Srp"]:
            attempt = {"plugin": plugin, "wire_crypt": False}
            try:
                conn = firebirdsql.connect(
                    host=host,
                    port=port,
                    database=db_path,
                    user=username,
                    password=password,
                    charset="NONE",
                    auth_plugin_name=plugin,
                    wire_crypt=False,
                    timeout=10,
                )
                cur = conn.cursor()
                cur.execute("SELECT 1 FROM RDB$DATABASE")
                cur.fetchone()
                cur.close()
                attempt["ok"] = True
                attempt["auth_accepted"] = plugin
                conn.close()
                cm.close(server_id, db_path)
                break
            except Exception as e:
                attempt["ok"] = False
                attempt["error"] = str(e)
            attempts.append(attempt)

    succeeded = [a for a in attempts if a.get("ok")]
    summary = "Connection succeeded!" if succeeded else \
        f"All {len(attempts)} auth attempts failed. See details below."

    return jsonify({
        "tcp": tcp_result,
        "auth_attempts": attempts,
        "summary": summary,
    })

# ── Metadata ──────────────────────────────────────────────────────────────
@login_required
@app.route("/api/metadata/<server_id>")
def api_metadata(server_id):
    """Return all tables, views, and their columns for a database."""
    db_path = request.args.get("db", "")
    cfg = load_config()
    creds = cfg.get("credentials", {})
    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    try:
        cur = conn.cursor()

        # Tables & views — simplest possible query
        cur.execute(
            "SELECT RDB$RELATION_NAME, RDB$RELATION_TYPE "
            "FROM RDB$RELATIONS "
            "WHERE RDB$SYSTEM_FLAG = 0 "
            "ORDER BY RDB$RELATION_NAME"
        )
        relations = []
        for row in cur.fetchall():
            name = row[0].strip() if row[0] else ""
            rtype = row[1] if row[1] else 0
            rel_type = "VIEW" if rtype == 1 else "TABLE"
            relations.append({"name": name, "type": rel_type})

        # Columns for each relation
        # InterBase classic protocol doesn't support ? parameters,
        # COALESCE, or large IN clauses. Use simple per-table queries
        # with direct string interpolation (safe — names come from system tables).
        type_map = {
            7: "SMALLINT", 8: "INTEGER", 9: "QUAD", 10: "FLOAT",
            11: "DOUBLE", 12: "DATE", 13: "TIME", 14: "CHAR",
            16: "INT64", 26: "BLOB", 35: "TIMESTAMP", 37: "VARCHAR",
            40: "CSTRING",
        }

        for rel in relations:
            tname = rel["name"]
            try:
                cur.execute(
                    "SELECT f.RDB$FIELD_NAME, "
                    "f.RDB$FIELD_SOURCE, "
                    "f.RDB$NULL_FLAG, "
                    "f.RDB$FIELD_POSITION, "
                    "r.RDB$FIELD_TYPE, "
                    "r.RDB$FIELD_LENGTH, "
                    "r.RDB$FIELD_SCALE, "
                    "r.RDB$FIELD_SUB_TYPE "
                    "FROM RDB$RELATION_FIELDS f "
                    "LEFT JOIN RDB$FIELDS r ON f.RDB$FIELD_SOURCE = r.RDB$FIELD_NAME "
                    "WHERE f.RDB$RELATION_NAME = '" + tname.replace("'", "''") + "' "
                    "ORDER BY f.RDB$FIELD_POSITION"
                )
                cols = []
                for r in cur.fetchall():
                    col_name = r[0].strip() if r[0] else ""
                    nullable = r[2] is None
                    field_type = r[4] if r[4] is not None else 0
                    length = r[5] if r[5] is not None else 0
                    scale = r[6] if r[6] is not None else 0
                    subtype = r[7] if r[7] is not None else 0

                    base_type = type_map.get(field_type, f"TYPE_{field_type}")
                    if base_type in ("CHAR", "VARCHAR", "CSTRING"):
                        type_str = f"{base_type}({length})"
                    elif base_type == "BLOB":
                        st_map = {0: "BLOB", 1: "TEXT", 2: "BLR"}
                        type_str = f"BLOB SUB_TYPE {subtype}" + (
                            f" ({st_map.get(subtype, subtype)})" if subtype in st_map else ""
                        )
                    elif scale and scale != 0:
                        type_str = f"{base_type}(*,{abs(scale)})"
                    else:
                        type_str = base_type
                    cols.append({
                        "name": col_name,
                        "type": type_str,
                        "nullable": nullable,
                        "position": r[3] if r[3] is not None else 0,
                    })
                rel["columns"] = cols
            except Exception:
                rel["columns"] = []

        # Primary keys — wrapped in try/except since some InterBase
        # versions may not support this query
        pk_map = {}
        try:
            cur.execute(
                "SELECT rc.RDB$RELATION_NAME, rc.RDB$FIELD_NAME "
                "FROM RDB$RELATION_CONSTRAINTS rc "
                "WHERE rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'"
            )
            for row in cur.fetchall():
                tbl = row[0].strip() if row[0] else ""
                col = row[1].strip() if row[1] else ""
                pk_map.setdefault(tbl, []).append(col)
        except Exception:
            pass

        for rel in relations:
            rel["primary_key"] = pk_map.get(rel["name"], [])

        cur.close()
        return jsonify(json_safe(relations))

    except Exception as e:
        return jsonify({"error": f"Schema query failed: {e}"}), 500

@login_required
@app.route("/api/table-preview/<server_id>")
def api_table_preview(server_id):
    """Preview first 100 rows of a table."""
    db_path = request.args.get("db", "")
    table   = request.args.get("table", "")
    cfg = load_config()
    creds = cfg.get("credentials", {})
    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    try:
        cur = conn.cursor()
        cur.execute(f'SELECT * FROM "{table}" ROWS 1 TO 100')
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        cur.close()
        return jsonify({
            "columns": cols,
            "rows": rows_to_json(rows),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@login_required
@app.route("/api/table-count/<server_id>")
def api_table_count(server_id):
    db_path = request.args.get("db", "")
    table   = request.args.get("table", "")
    cfg = load_config()
    creds = cfg.get("credentials", {})
    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
        cur = conn.cursor()
        cur.execute(f'SELECT COUNT(*) FROM "{table}"')
        count = cur.fetchone()[0]
        cur.close()
        return jsonify({"count": count})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Query execution with database-side pagination ────────────────────────
# Instead of fetching all rows and caching, we wrap the user's SQL in
# a subquery with ROWS m TO n so InterBase only sends the page we need.
# This turns a 25-second fetch of 20,000 rows into a <1-second fetch of 100.

PAGE_SIZE = 100

def _wrap_sql_paged(sql, page, page_size=PAGE_SIZE):
    """Wrap user SQL in a subquery with ROWS pagination.
    InterBase syntax: SELECT * FROM (<sql>) ROWS m TO n
    """
    # Strip trailing semicolon and whitespace
    clean = sql.strip().rstrip(';').strip()
    start = page * page_size + 1
    end = start + page_size - 1
    return f"SELECT * FROM ({clean}) ROWS {start} TO {end}"

def _wrap_sql_count(sql):
    """Wrap user SQL to get total row count.
    SELECT COUNT(*) FROM (<sql>)
    """
    clean = sql.strip().rstrip(';').strip()
    return f"SELECT COUNT(*) FROM ({clean})"

@login_required
@app.route("/api/query", methods=["POST"])
def api_query():
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    sql       = data.get("sql", "").strip()
    in_transaction = data.get("in_transaction", False)
    cfg = load_config()
    creds = cfg.get("credentials", {})
    if not sql:
        return jsonify({"error": "No SQL provided"}), 400
    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
    except Exception as e:
        return jsonify({"error": f"Connection failed: {e}"}), 500

    if in_transaction:
        conn.set_autocommit(False)
    else:
        conn.set_autocommit(True)

    t0 = time.time()

    def _do_execute(conn):
        # Check if this is a SELECT (returns rows) by running page 1
        page_sql = _wrap_sql_paged(sql, 0)
        cur = conn.cursor()
        cur.execute(page_sql)

        if not cur.description:
            # Not a SELECT — it's DML. Run the original SQL directly.
            cur.close()
            cur = conn.cursor()
            cur.execute(sql)
            row_count = cur.rowcount
            if not in_transaction:
                conn.commit()
            elapsed = time.time() - t0
            cur.close()
            add_history({
                "sql": sql, "server_id": server_id, "db_path": db_path,
                "row_count": row_count, "elapsed": round(elapsed, 3), "type": "DML",
            })
            return jsonify({
                "rows_affected": row_count, "elapsed": round(elapsed, 3),
                "in_transaction": in_transaction, "uncommitted": in_transaction,
            })

        # SELECT — fetch page 1 (only 100 rows from InterBase)
        columns = [d[0] for d in cur.description]
        rows = cur.fetchall()
        page_rows = rows_to_json(rows)
        cur.close()
        t_page1 = time.time()

        # Get total row count (separate query)
        total_count = None
        try:
            count_sql = _wrap_sql_count(sql)
            cur2 = conn.cursor()
            cur2.execute(count_sql)
            count_row = cur2.fetchone()
            cur2.close()
            if count_row:
                total_count = count_row[0]
        except Exception:
            pass  # Count query failed — total unknown
        t_count = time.time()

        elapsed = time.time() - t0
        add_history({
            "sql": sql, "server_id": server_id, "db_path": db_path,
            "row_count": total_count or len(page_rows),
            "elapsed": round(elapsed, 3), "type": "SELECT",
        })

        total_pages = ((total_count or len(page_rows)) + PAGE_SIZE - 1) // PAGE_SIZE

        return jsonify({
            "columns": columns,
            "rows": page_rows,
            "row_count": total_count or len(page_rows),
            "page": 0,
            "page_size": PAGE_SIZE,
            "total_pages": total_pages,
            "truncated": False,
            "elapsed": round(elapsed, 3),
            "in_transaction": in_transaction,
            "timing": {
                "page1": round(t_page1 - t0, 3),
                "count": round(t_count - t_page1, 3),
                "total": round(elapsed, 3),
            },
        })

    try:
        return _do_execute(conn)
    except Exception as e:
        # If wrapped SQL fails, try running the original SQL directly
        # (some SQL can't be wrapped in a subquery)
        try:
            cm.close(server_id, db_path)
            conn = cm.get(server_id, db_path, creds["username"], creds["password"])
            if in_transaction:
                conn.set_autocommit(False)
            else:
                conn.set_autocommit(True)
            cur = conn.cursor()
            cur.execute(sql)
            if cur.description:
                columns = [d[0] for d in cur.description]
                cur.arraysize = 2000
                rows = cur.fetchmany(10000)
                json_rows = rows_to_json(rows)
                cur.close()
                elapsed = time.time() - t0
                add_history({
                    "sql": sql, "server_id": server_id, "db_path": db_path,
                    "row_count": len(json_rows), "elapsed": round(elapsed, 3), "type": "SELECT",
                })
                return jsonify({
                    "columns": columns, "rows": json_rows[:PAGE_SIZE],
                    "row_count": len(json_rows), "page": 0, "page_size": PAGE_SIZE,
                    "total_pages": (len(json_rows) + PAGE_SIZE - 1) // PAGE_SIZE,
                    "elapsed": round(elapsed, 3), "in_transaction": in_transaction,
                    "fallback": True,
                })
            else:
                row_count = cur.rowcount
                if not in_transaction:
                    conn.commit()
                elapsed = time.time() - t0
                cur.close()
                return jsonify({
                    "rows_affected": row_count, "elapsed": round(elapsed, 3),
                    "in_transaction": in_transaction, "uncommitted": in_transaction,
                })
        except Exception as e2:
            elapsed = time.time() - t0
            add_history({
                "sql": sql, "server_id": server_id, "db_path": db_path,
                "error": str(e2), "elapsed": round(elapsed, 3), "type": "ERROR",
            })
            return jsonify({"error": str(e2), "elapsed": round(elapsed, 3)}), 200


@login_required
@app.route("/api/query-page", methods=["POST"])
def api_query_page():
    """Fetch a specific page of results using database-side ROWS pagination."""
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    sql       = data.get("sql", "").strip()
    page      = data.get("page", 0)
    cfg = load_config()
    creds = cfg.get("credentials", {})

    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
    except Exception as e:
        return jsonify({"error": f"Connection failed: {e}"}), 500

    try:
        page_sql = _wrap_sql_paged(sql, page)
        cur = conn.cursor()
        cur.execute(page_sql)
        columns = [d[0] for d in cur.description]
        rows = cur.fetchall()
        cur.close()
        return jsonify({
            "rows": rows_to_json(rows),
            "page": page,
            "page_size": PAGE_SIZE,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@login_required
@app.route("/api/commit", methods=["POST"])
def api_commit():
    """Commit the current transaction."""
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    cfg = load_config()
    creds = cfg.get("credentials", {})
    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
        conn.commit()
        conn.set_autocommit(True)  # back to normal mode
        return jsonify({"ok": True, "message": "Changes committed successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@login_required
@app.route("/api/rollback", methods=["POST"])
def api_rollback():
    """Rollback the current transaction — undo all uncommitted changes."""
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    cfg = load_config()
    creds = cfg.get("credentials", {})
    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
        conn.rollback()
        conn.set_autocommit(True)  # back to normal mode
        return jsonify({"ok": True, "message": "Changes rolled back successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ── Multi-server query (run same SQL across all selected servers/databases) ─
@login_required
@app.route("/api/multi-query", methods=["POST"])
def api_multi_query():
    data = request.get_json()
    targets  = data.get("targets", [])   # [{server_id, db_path}, ...]
    sql      = data.get("sql", "").strip()
    max_rows = data.get("max_rows", 500)
    combine  = data.get("combine", True)  # single result set with server/db columns

    if not sql:
        return jsonify({"error": "No SQL provided"}), 400
    if not targets:
        return jsonify({"error": "No targets selected"}), 400

    # ── SAFEGUARD: Multi-server mode is SELECT-only ────────────────
    if not is_readonly_sql(sql):
        return jsonify({
            "error": "Multi-Server mode only allows SELECT queries. "
                     "INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, EXECUTE, "
                     "MERGE and other write operations are blocked."
        }), 400

    cfg = load_config()
    creds = cfg.get("credentials", {})
    t0 = time.time()

    # Combined single result set
    all_columns = None
    all_rows = []
    errors = []
    total_rows = 0

    for tgt in targets:
        sid  = tgt["server_id"]
        dpath = tgt["db_path"]
        try:
            server = next((s for s in cfg["servers"] if s["id"] == sid), None)
            server_name = server["name"] if server else sid
            db_name = dpath.split("\\")[-1] if "\\" in dpath else dpath
        except Exception:
            server_name = sid
            db_name = dpath

        try:
            conn = cm.get(sid, dpath, creds["username"], creds["password"])
            cur = conn.cursor()
            cur.execute(sql)
            if cur.description:
                cols = [d[0] for d in cur.description]
                cur.arraysize = min(max_rows, 2000)
                rows = cur.fetchmany(max_rows)
                total_rows += len(rows)

                if combine:
                    # Add server/db columns and combine into single result
                    if all_columns is None:
                        all_columns = ["_SERVER", "_DATABASE"] + cols
                    for row in rows:
                        safe_row = fast_row_to_json(row)
                        all_rows.append([server_name, db_name] + safe_row)
                else:
                    # Separate results (legacy mode)
                    if not hasattr(api_multi_query, '_separate'):
                        api_multi_query._separate = []
                    api_multi_query._separate.append({
                        "server_id": sid, "server_name": server_name,
                        "db_name": db_name, "ok": True, "type": "SELECT",
                        "columns": cols, "rows": rows_to_json(rows),
                        "row_count": len(rows),
                        "truncated": len(rows) >= max_rows,
                    })
            cur.close()
        except Exception as e:
            errors.append(f"{server_name} / {db_name}: {e}")

    elapsed = round(time.time() - t0, 3)

    if combine and all_columns is not None:
        return jsonify({
            "columns": all_columns,
            "rows": all_rows,
            "row_count": len(all_rows),
            "truncated": total_rows >= max_rows * len(targets),
            "elapsed": elapsed,
            "errors": errors,
            "targets_run": len(targets),
        })
    elif combine and not all_columns:
        # No results from any target
        return jsonify({
            "columns": [],
            "rows": [],
            "row_count": 0,
            "elapsed": elapsed,
            "errors": errors,
            "targets_run": len(targets),
        })
    else:
        return jsonify({"results": api_multi_query._separate})

# ── History ──────────────────────────────────────────────────────────────
@login_required
@app.route("/api/history")
def api_history():
    return jsonify(load_history())

@login_required
@app.route("/api/history", methods=["DELETE"])
def api_clear_history():
    save_history([])
    return jsonify({"ok": True})

# ── Saved scripts ────────────────────────────────────────────────────────
@login_required
@app.route("/api/scripts")
def api_scripts():
    return jsonify(list_saved_scripts())

@login_required
@app.route("/api/scripts", methods=["POST"])
def api_save_script():
    data = request.get_json()
    name = data.get("name", "untitled")
    sql  = data.get("sql", "")
    fn = save_script(name, sql)
    return jsonify({"ok": True, "filename": fn})

@login_required
@app.route("/api/scripts/<fn>")
def api_get_script(fn):
    content = load_script(fn)
    if content is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"filename": fn, "sql": content})

@login_required
@app.route("/api/scripts/<fn>", methods=["DELETE"])
def api_del_script(fn):
    delete_script(fn)
    return jsonify({"ok": True})

# ── Export CSV ────────────────────────────────────────────────────────────
@login_required
@app.route("/api/export", methods=["POST"])
def api_export():
    """Execute query and return results as CSV download."""
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    sql       = data.get("sql", "").strip()
    max_rows  = data.get("max_rows", 100000)  # allow large exports
    cfg = load_config()
    creds = cfg.get("credentials", {})

    import csv as _csv
    import io

    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
    except Exception as e:
        return jsonify({"error": f"Connection failed: {e}"}), 500

    try:
        cur = conn.cursor()
        cur.execute(sql)
        if not cur.description:
            cur.close()
            return jsonify({"error": "Query does not return rows"}), 400

        columns = [d[0] for d in cur.description]
        cur.arraysize = 2000
        rows = cur.fetchmany(max_rows)
        cur.close()

        # Build CSV in memory — simple and reliable
        buf = io.StringIO()
        w = _csv.writer(buf)
        w.writerow(columns)
        for r in rows:
            w.writerow(fast_row_to_json(r))

        csv_data = buf.getvalue()

        now = datetime.now().strftime("%Y%m%d_%H%M")
        filename = f"query_results_{now}.csv"

        return Response(
            csv_data,
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    except Exception as e:
        # Retry once on stale connection
        cm.close(server_id, db_path)
        try:
            conn = cm.get(server_id, db_path, creds["username"], creds["password"])
            cur = conn.cursor()
            cur.execute(sql)
            if not cur.description:
                cur.close()
                return jsonify({"error": "Query does not return rows"}), 400
            columns = [d[0] for d in cur.description]
            cur.arraysize = 2000
            rows = cur.fetchmany(max_rows)
            cur.close()
            buf = io.StringIO()
            w = _csv.writer(buf)
            w.writerow(columns)
            for r in rows:
                w.writerow(fast_row_to_json(r))
            csv_data = buf.getvalue()
            now = datetime.now().strftime("%Y%m%d_%H%M")
            filename = f"query_results_{now}.csv"
            return Response(
                csv_data,
                mimetype="text/csv",
                headers={"Content-Disposition": f"attachment; filename={filename}"},
            )
        except Exception as e2:
            return jsonify({"error": str(e2)}), 500


# ── DBScanner integration ─────────────────────────────────────────────────
import subprocess

@login_required
@app.route("/api/scan-databases", methods=["POST"])
def api_scan_databases():
    """Run DBScanner.ps1 to discover databases via network shares, then
    update config.json with any new databases found."""
    user = get_current_user()
    if not user or not user.get("admin"):
        return jsonify({"error": "Admin access required"}), 403

    scanner_path = os.path.join(BASE_DIR, "DBScanner.ps1")
    if not os.path.exists(scanner_path):
        return jsonify({"error": "DBScanner.ps1 not found"}), 404

    try:
        # Run DBScanner in mode 1 (Affinity DBs — 4-digit numeric)
        result = subprocess.run(
            ["powershell", "-ExecutionPolicy", "Bypass", "-File", scanner_path, "-Mode", "1"],
            capture_output=True, text=True, timeout=120,
            cwd=BASE_DIR,
        )
        if result.returncode != 0:
            return jsonify({"error": f"Scanner failed: {result.stderr}"}), 500

        # Parse the output — each line is "SERVER:E:\DATABASES\NNNN\NNNN.IB"
        lines = result.stdout.strip().split('\n')
        found = {}
        for line in lines:
            line = line.strip()
            if ':' not in line or 'PIDB' not in line:
                continue
            parts = line.split(':', 1)
            server_name = parts[0].strip()
            db_path = parts[1].strip()
            if server_name not in found:
                found[server_name] = []
            found[server_name].append(db_path)

        # Map server names to config IDs and add missing databases
        cfg = load_config()
        added = []
        for srv in cfg["servers"]:
            # Extract PIDB name from host or name
            srv_host = srv["host"]
            # Find matching server name from scan results
            for scan_name, db_paths in found.items():
                # Match by comparing — we need to check if this server matches
                # The scan returns PIDB06, PIDB07 etc. The config has host IPs.
                # We'll match by checking if the server name contains the PIDB name
                if scan_name in srv.get("name", "") or scan_name in srv.get("host", ""):
                    existing_paths = set(db["path"].lower() for db in srv["databases"])
                    for path in db_paths:
                        if path.lower() not in existing_paths:
                            db_name = path.split("\\")[-1].replace(".IB", "").replace(".ib", "")
                            new_db = {
                                "name": db_name,
                                "path": path,
                                "company_number": db_name if db_name.isdigit() else "",
                            }
                            srv["databases"].append(new_db)
                            added.append(f"{srv['name']}: {db_name}")

        if added:
            # Re-sort by company_number
            for srv in cfg["servers"]:
                srv["databases"].sort(
                    key=lambda d: int(d.get("company_number", "0"))
                    if str(d.get("company_number", "")).isdigit()
                    else 0
                )
            save_config(cfg)

        return jsonify({
            "ok": True,
            "found": sum(len(v) for v in found.values()),
            "added": added,
            "added_count": len(added),
        })
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Scanner timed out (120s)"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Shutdown / Restart ───────────────────────────────────────────────────
@login_required
@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    cm.close_all()
    return jsonify({"ok": True})

@login_required
@app.route("/api/restart", methods=["POST"])
def api_restart():
    """Restart the Flask server.

    Writes a flag file that start.bat watches, then exits.
    start.bat will restart the server automatically.
    Also works with os.execv as a fallback.
    """
    cm.close_all()

    # Write a restart flag file so the launcher knows to restart
    # (rather than just exiting)
    restart_flag = os.path.join(BASE_DIR, ".restart_flag")
    try:
        with open(restart_flag, "w") as f:
            f.write("restart")
    except Exception:
        pass

    # Schedule the actual shutdown after the response is sent
    import threading as _threading
    import time as _time

    def _do_restart():
        _time.sleep(0.5)
        try:
            cm.close_all()
        except Exception:
            pass
        # Use os._exit to force-kill the process; start.bat will restart it
        os._exit(0)

    t = _threading.Thread(target=_do_restart, daemon=True)
    t.start()

    return jsonify({"ok": True, "message": "Restarting… page will reconnect in a few seconds"})

# ── Main ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  InterBase Query Manager")
    print("  Open http://localhost:5000 in your browser")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
