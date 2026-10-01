# InterBase Query Manager

A self-contained, **zero-install** web application for running SQL queries across multiple InterBase servers and databases. Built as a modern replacement for the IB Console Interactive SQL tool.

## Quick Start

1. **Copy the entire `Interbase_query_manager` folder** to your RDS environment.
2. Double-click `start.bat`.
3. Open `http://localhost:5000` in your browser.

**No Python installation required.** A portable Python 3.14 is bundled in the `python/` folder. No `pip install` needed — all dependencies are in `vendor/`.

## Features

- **Multi-server, multi-database** — connect to all 5+ servers from one interface
- **Full schema browser** — tables, views, columns, primary keys, data types
- **SQL editor** with syntax highlighting, autocomplete, and bracket matching (CodeMirror)
- **Multi-server execution** — run the same SQL across all selected databases simultaneously
- **InterBase 2020+ support** — SRP-256 auth + wire encryption, with auto-fallback to older auth methods
- **Table preview** — one-click preview of first 100 rows
- **Row count** — quick count for any table
- **Query history** — last 200 queries with re-run capability
- **Saved scripts** — save and organise SQL scripts
- **CSV export** — stream large result sets to CSV
- **Settings UI** — add/remove servers, configure auth per server
- **Dark theme** — easy on the eyes during long sessions

## Configuration

Edit `config.json` or use the Settings (⚙) button in the top bar to configure:
- Server connections (host, port, databases)
- Auth plugin per server (Auto, Srp256, Srp, or Legacy_Auth)
- Wire encryption per server
- Default credentials (username/password)
- Query defaults (max rows, timeout)

## How It Works

The app uses the `firebirdsql` pure-Python library which speaks the Firebird wire protocol. InterBase is the ancestor of Firebird, and the wire protocol is compatible — so no InterBase-specific ODBC driver or client library is required.

For InterBase 2020+, the connection defaults to **Srp256 authentication** with **wire encryption enabled**. If that fails, it automatically falls back to **Srp** then **Legacy_Auth**.

## Requirements

- **Nothing.** Python is bundled. Just copy the folder and run.
- Network access to your InterBase servers on port 3050 (default)
- A modern web browser

## File Structure

```
Interbase_query_manager/
├── app.py              ← Flask backend (main application)
├── start.bat           ← Windows launcher (uses bundled Python)
├── config.json         ← Server/database configuration
├── python/             ← Bundled portable Python 3.14 (zero-install)
├── vendor/             ← Python dependencies (Flask, firebirdsql, etc.)
├── templates/
│   └── index.html      ← Web UI
├── static/
│   ├── css/style.css   ← Dark theme stylesheet
│   └── js/app.js       ← Frontend logic
└── saved/              ← Saved scripts & query history
```

## Troubleshooting

**"python is not recognized"** — Make sure you're running `start.bat`, not `python app.py` directly. The `start.bat` script uses the bundled Python in `python/python.exe`.

**Connection errors** — Click the 🔌 Test Connection button to see which auth method was tried and the error. If all auth methods fail, check that the server hostname resolves from your machine and port 3050 is accessible.
