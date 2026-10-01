# InterBase Query Manager

A self-contained, zero-install web application for running SQL queries across multiple InterBase servers and databases. Built as a modern replacement for the IB Console Interactive SQL tool.

## Quick Start

1. **Copy the entire `Interbase_query_manager` folder** to your RDS environment (or run locally).
2. Double-click `start.bat` (or run `python app.py`).
3. Open `http://localhost:5000` in your browser.

That's it. No `pip install` needed — all Python dependencies are in the `vendor/` folder.

## Features

- **Multi-server, multi-database** — connect to all 5+ servers from one interface
- **Full schema browser** — tables, views, columns, primary keys, data types
- **SQL editor** with syntax highlighting, autocomplete, and bracket matching (CodeMirror)
- **Multi-server execution** — run the same SQL across all selected databases simultaneously
- **Table preview** — one-click preview of first 100 rows
- **Row count** — quick count for any table
- **Query history** — last 200 queries with re-run capability
- **Saved scripts** — save and organise SQL scripts
- **CSV export** — stream large result sets to CSV
- **Settings UI** — add/remove servers and databases without editing config files
- **Dark theme** — easy on the eyes during long sessions

## Configuration

Edit `config.json` or use the Settings (⚙) button in the top bar to configure:
- Server connections (host, port, databases)
- Default credentials (username/password)
- Query defaults (max rows, timeout)

## How It Works

The app uses the `firebirdsql` pure-Python library which speaks the Firebird wire protocol. InterBase is the ancestor of Firebird, and the wire protocol is compatible — so no InterBase-specific ODBC driver or client library is required.

## Requirements

- Python 3.8+ (already on most systems)
- Network access to your InterBase servers on port 3050 (default)
- A modern web browser

## File Structure

```
Interbase_query_manager/
├── app.py              ← Flask backend (main application)
├── start.bat           ← Windows launcher
├── config.json         ← Server/database configuration
├── vendor/             ← Bundled Python dependencies (zero-install)
│   ├── flask/
│   ├── firebirdsql/
│   └── ...
├── templates/
│   └── index.html      ← Web UI
├── static/
│   ├── css/style.css   ← Dark theme stylesheet
│   └── js/app.js       ← Frontend logic
└── saved/              ← Saved scripts & query history
```
