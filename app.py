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
from datetime import datetime, date
from decimal import Decimal

# ── vendored deps (zero-install) ──────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

from flask import Flask, render_template, request, jsonify, Response, stream_with_context

# firebirdsql speaks the Firebird wire protocol which InterBase understands
# (InterBase is the ancestor of Firebird; the wire protocol is compatible)
try:
    import firebirdsql
except ImportError:
    firebirdsql = None

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

# ── Paths ─────────────────────────────────────────────────────────────────
BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH    = os.path.join(BASE_DIR, "config.json")
SAVED_DIR      = os.path.join(BASE_DIR, "saved")
HISTORY_PATH   = os.path.join(BASE_DIR, "saved", "history.json")
os.makedirs(SAVED_DIR, exist_ok=True)

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

    def get(self, server_id, db_path, username, password):
        key = (server_id, db_path)
        with self._lock:
            conn = self._conns.get(key)
            if conn is not None:
                try:
                    # quick liveness check
                    cur = conn.cursor()
                    cur.execute("SELECT 1 FROM RDB$DATABASE")
                    cur.fetchall()
                    cur.close()
                    return conn
                except Exception:
                    try:
                        conn.close()
                    except Exception:
                        pass
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
        # InterBase files use host/port; we pass host:path as the dsn
        dsn = f"{host}/{port}:{db_path}"

        # InterBase 2020+ uses SRP auth + wire encryption.
        # firebirdsql defaults to Srp256 with wire_crypt=True.
        # We try Srp256 → Srp → Legacy_Auth with full error reporting.
        auth_plugin = server.get("auth_plugin")      # None = auto-detect
        wire_crypt  = server.get("wire_crypt", True)  # default on
        errors = []

        # If a specific auth plugin is configured, try only that one.
        # Otherwise try Srp256 → Srp → Legacy_Auth in order.
        if auth_plugin:
            auth_chain = [auth_plugin]
        else:
            auth_chain = ["Srp256", "Srp", "Legacy_Auth"]

        for plugin in auth_chain:
            try:
                conn = firebirdsql.connect(
                    dsn=dsn,
                    user=username,
                    password=password,
                    charset="UTF8",
                    auth_plugin_name=plugin,
                    wire_crypt=wire_crypt,
                )
                with self._lock:
                    self._conns[key] = conn
                return conn
            except Exception as e:
                err_msg = str(e)
                # passlib is needed for Legacy_Auth
                if plugin == "Legacy_Auth" and "passlib" in err_msg:
                    errors.append(f"{plugin}: requires passlib (not bundled)")
                else:
                    errors.append(f"{plugin}: {err_msg}")
                continue

        # All auth methods failed — show ALL errors so you can see what
        # Srp256 and Srp actually returned (not just the last one)
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
        # hex-encode blobs; show first 200 chars
        h = obj.hex()
        return h[:200] + ("…" if len(h) > 200 else "")
    if isinstance(obj, dict):
        return {k: json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]
    return obj

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
    # keep last 200
    with open(HISTORY_PATH, "w") as f:
        json.dump(entries[-200:], f, indent=2)

def add_history(entry):
    entries = load_history()
    entry["id"] = str(uuid.uuid4())[:8]
    entry["ts"] = datetime.now().isoformat(timespec="seconds")
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

# ── Routes ────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/config")
def api_config():
    cfg = load_config()
    # mask password in API response
    safe = json.loads(json.dumps(cfg))
    if safe.get("credentials", {}).get("password"):
        safe["credentials"]["password"] = "***"
    return jsonify(safe)

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
    dsn = f"{host}/{port}:{db_path}"

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
                dsn=dsn,
                user=username,
                password=password,
                charset="UTF8",
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
                    dsn=dsn,
                    user=username,
                    password=password,
                    charset="UTF8",
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

    cur = conn.cursor()

    # Tables & views
    cur.execute("""
        SELECT r.RDB$RELATION_NAME, r.RDB$RELATION_TYPE, r.RDB$DESCRIPTION
        FROM RDB$RELATIONS r
        WHERE r.RDB$SYSTEM_FLAG = 0 OR r.RDB$SYSTEM_FLAG IS NULL
        ORDER BY r.RDB$RELATION_NAME
    """)
    relations = []
    for row in cur.fetchall():
        name = row[0].strip() if row[0] else ""
        rtype = row[1] if row[1] else 0
        rel_type = "VIEW" if rtype == 1 else "TABLE"
        relations.append({"name": name, "type": rel_type})

    # Columns for each relation
    for rel in relations:
        cur.execute("""
            SELECT f.RDB$FIELD_NAME,
                   COALESCE(f.RDB$FIELD_SOURCE, ''),
                   f.RDB$NULL_FLAG,
                   f.RDB$FIELD_POSITION,
                   COALESCE(r.RDB$FIELD_TYPE, 0),
                   COALESCE(r.RDB$FIELD_LENGTH, 0),
                   COALESCE(r.RDB$FIELD_SCALE, 0),
                   COALESCE(r.RDB$FIELD_SUB_TYPE, 0)
            FROM RDB$RELATION_FIELDS f
            LEFT JOIN RDB$FIELDS r ON f.RDB$FIELD_SOURCE = r.RDB$FIELD_NAME
            WHERE f.RDB$RELATION_NAME = ?
            ORDER BY f.RDB$FIELD_POSITION
        """, (rel["name"],))
        cols = []
        for r in cur.fetchall():
            col_name = r[0].strip() if r[0] else ""
            nullable = not r[2] if r[2] is not None else True
            # map InterBase/Firebird type codes to readable names
            type_map = {
                7: "SMALLINT", 8: "INTEGER", 9: "QUAD", 10: "FLOAT",
                11: "DOUBLE", 12: "DATE", 13: "TIME", 14: "CHAR",
                16: "INT64", 26: "BLOB", 35: "TIMESTAMP", 37: "VARCHAR",
                40: "CSTRING",
            }
            base_type = type_map.get(r[4], f"TYPE_{r[4]}")
            length = r[5]
            scale = r[6]
            if base_type in ("CHAR", "VARCHAR", "CSTRING"):
                type_str = f"{base_type}({length})"
            elif base_type == "BLOB":
                subtype = r[7]
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

    # Primary keys
    cur.execute("""
        SELECT rc.RDB$RELATION_NAME, rc.RDB$FIELD_NAME
        FROM RDB$RELATION_CONSTRAINTS rc
        WHERE rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY'
          AND rc.RDB$INDEX_NAME IS NOT NULL
    """)
    pk_map = {}
    for row in cur.fetchall():
        tbl = row[0].strip() if row[0] else ""
        col = row[1].strip() if row[1] else ""
        pk_map.setdefault(tbl, []).append(col)

    for rel in relations:
        rel["primary_key"] = pk_map.get(rel["name"], [])

    cur.close()
    return jsonify(json_safe(relations))

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
        cur.execute(f'SELECT FIRST 100 * FROM "{table}"')
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        cur.close()
        return jsonify({
            "columns": cols,
            "rows": json_safe([list(r) for r in rows]),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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

# ── Query execution ──────────────────────────────────────────────────────
@app.route("/api/query", methods=["POST"])
def api_query():
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    sql       = data.get("sql", "").strip()
    max_rows  = data.get("max_rows", 1000)
    cfg = load_config()
    creds = cfg.get("credentials", {})
    if not sql:
        return jsonify({"error": "No SQL provided"}), 400
    try:
        conn = cm.get(server_id, db_path, creds["username"], creds["password"])
    except Exception as e:
        return jsonify({"error": f"Connection failed: {e}"}), 500

    t0 = time.time()
    try:
        cur = conn.cursor()
        cur.execute(sql)
        # Check if this is a SELECT-like query that returns rows
        if cur.description:
            columns = [d[0] for d in cur.description]
            rows = cur.fetchmany(max_rows)
            row_count = len(rows)
            elapsed = time.time() - t0
            cur.close()
            add_history({
                "sql": sql,
                "server_id": server_id,
                "db_path": db_path,
                "row_count": row_count,
                "elapsed": round(elapsed, 3),
                "type": "SELECT",
            })
            return jsonify({
                "columns": columns,
                "rows": json_safe([list(r) for r in rows]),
                "row_count": row_count,
                "truncated": row_count >= max_rows,
                "elapsed": round(elapsed, 3),
            })
        else:
            row_count = cur.rowcount
            conn.commit()
            elapsed = time.time() - t0
            cur.close()
            add_history({
                "sql": sql,
                "server_id": server_id,
                "db_path": db_path,
                "row_count": row_count,
                "elapsed": round(elapsed, 3),
                "type": "DML",
            })
            return jsonify({
                "rows_affected": row_count,
                "elapsed": round(elapsed, 3),
            })
    except Exception as e:
        elapsed = time.time() - t0
        add_history({
            "sql": sql,
            "server_id": server_id,
            "db_path": db_path,
            "error": str(e),
            "elapsed": round(elapsed, 3),
            "type": "ERROR",
        })
        return jsonify({"error": str(e), "elapsed": round(elapsed, 3)}), 200

# ── Multi-server query (run same SQL across all selected servers/databases) ─
@app.route("/api/multi-query", methods=["POST"])
def api_multi_query():
    data = request.get_json()
    targets  = data.get("targets", [])   # [{server_id, db_path}, ...]
    sql      = data.get("sql", "").strip()
    max_rows = data.get("max_rows", 500)
    if not sql:
        return jsonify({"error": "No SQL provided"}), 400
    if not targets:
        return jsonify({"error": "No targets selected"}), 400

    cfg = load_config()
    creds = cfg.get("credentials", {})
    results = []

    for tgt in targets:
        sid  = tgt["server_id"]
        dpath = tgt["db_path"]
        entry = {"server_id": sid, "db_path": dpath, "ok": False}
        try:
            server = next((s for s in cfg["servers"] if s["id"] == sid), None)
            entry["server_name"] = server["name"] if server else sid
            entry["db_name"] = dpath.split("\\")[-1] if "\\" in dpath else dpath
        except Exception:
            entry["server_name"] = sid
            entry["db_name"] = dpath
        t0 = time.time()
        try:
            conn = cm.get(sid, dpath, creds["username"], creds["password"])
            cur = conn.cursor()
            cur.execute(sql)
            if cur.description:
                cols = [d[0] for d in cur.description]
                rows = cur.fetchmany(max_rows)
                entry["ok"] = True
                entry["type"] = "SELECT"
                entry["columns"] = cols
                entry["rows"] = json_safe([list(r) for r in rows])
                entry["row_count"] = len(rows)
                entry["truncated"] = len(rows) >= max_rows
            else:
                row_count = cur.rowcount
                conn.commit()
                entry["ok"] = True
                entry["type"] = "DML"
                entry["rows_affected"] = row_count
            cur.close()
        except Exception as e:
            entry["ok"] = False
            entry["error"] = str(e)
        entry["elapsed"] = round(time.time() - t0, 3)
        results.append(entry)

    return jsonify({"results": results})

# ── History ──────────────────────────────────────────────────────────────
@app.route("/api/history")
def api_history():
    return jsonify(load_history())

@app.route("/api/history", methods=["DELETE"])
def api_clear_history():
    save_history([])
    return jsonify({"ok": True})

# ── Saved scripts ────────────────────────────────────────────────────────
@app.route("/api/scripts")
def api_scripts():
    return jsonify(list_saved_scripts())

@app.route("/api/scripts", methods=["POST"])
def api_save_script():
    data = request.get_json()
    name = data.get("name", "untitled")
    sql  = data.get("sql", "")
    fn = save_script(name, sql)
    return jsonify({"ok": True, "filename": fn})

@app.route("/api/scripts/<fn>")
def api_get_script(fn):
    content = load_script(fn)
    if content is None:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"filename": fn, "sql": content})

@app.route("/api/scripts/<fn>", methods=["DELETE"])
def api_del_script(fn):
    delete_script(fn)
    return jsonify({"ok": True})

# ── Export CSV ────────────────────────────────────────────────────────────
@app.route("/api/export", methods=["POST"])
def api_export():
    """Execute query and stream results as CSV."""
    data = request.get_json()
    server_id = data.get("server_id")
    db_path   = data.get("db_path")
    sql       = data.get("sql", "").strip()
    cfg = load_config()
    creds = cfg.get("credentials", {})

    def generate():
        import csv as _csv
        import io
        buf = io.StringIO()
        w = _csv.writer(buf)
        try:
            conn = cm.get(server_id, db_path, creds["username"], creds["password"])
            cur = conn.cursor()
            cur.execute(sql)
            if cur.description:
                cols = [d[0] for d in cur.description]
                w.writerow(cols)
                yield buf.getvalue()
                buf.seek(0); buf.truncate()
                while True:
                    batch = cur.fetchmany(500)
                    if not batch:
                        break
                    for r in batch:
                        w.writerow([json_safe(x) for x in r])
                    yield buf.getvalue()
                    buf.seek(0); buf.truncate()
            else:
                w.writerow(["rows_affected", cur.rowcount])
                yield buf.getvalue()
            cur.close()
        except Exception as e:
            w.writerow(["ERROR", str(e)])
            yield buf.getvalue()

    return Response(
        stream_with_context(generate()),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=query_results.csv"},
    )

# ── Shutdown ─────────────────────────────────────────────────────────────
@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    cm.close_all()
    return jsonify({"ok": True})

# ── Main ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 60)
    print("  InterBase Query Manager")
    print("  Open http://localhost:5000 in your browser")
    print("  Press Ctrl+C to stop")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5000, debug=False)
