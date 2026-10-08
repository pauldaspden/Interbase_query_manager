# InterBase Query Manager

A self-contained, **zero-install** web application for running SQL queries across multiple InterBase servers and databases. Built as a modern replacement for the IB Console Interactive SQL tool.

## Quick Start

The app runs on **PINTAPPTEST** as a Windows Scheduled Task (managed via Azure Arc). It's available at `http://localhost:5000` on PINTAPPTEST.

### If the app is already installed

Just open `http://localhost:5000` in a browser on PINTAPPTEST. Log in with your Affinity credentials.

### If the app stops or needs restarting

Run this in Azure Cloud Shell:
```powershell
$script = 'Start-ScheduledTask -TaskName "InterbaseQueryManager"'
az connectedmachine run-command create --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-start1" --script $script
```

### First-time installation

1. Copy the `Interbase_query_manager` folder to `C:\Affinity\Web\Interbase_query_manager\` on PINTAPPTEST
2. Run `install_service.bat` as administrator (or via Azure Cloud Shell — see `ARCHITECTURE.md`)
3. Open `http://localhost:5000` in a browser on PINTAPPTEST

**No Python installation required.** A portable Python 3.14 is bundled in the `python/` folder. No `pip install` needed — all dependencies are in `vendor/`.

## Features

- **Multi-server, multi-database** — connect to all 5+ servers (PIDB06–PIDB10) from one interface
- **Full schema browser** — tables, views, columns, primary keys, foreign keys, data types
- **SQL editor** with syntax highlighting, autocomplete, and bracket matching (CodeMirror)
- **Multi-server execution** — run the same SQL across all selected databases simultaneously, with combined results showing full DB path and company number
- **Query Builder** — visual SQL builder for non-technical users (tables, JOINs, filters, aggregates, sort)
- **InterBase 2020+ support** — SRP-256 auth + wire encryption, with auto-fallback to older auth methods
- **Table preview** — one-click preview of first 100 rows
- **Row count** — quick count for any table
- **Query history** — all queries logged with user, timestamp, server, database, row count
- **Saved scripts** — save and organise SQL scripts
- **CSV export** — stream large result sets to CSV
- **Settings UI** — add/remove servers, configure auth per server
- **Admin access control** — restrict admin features (Settings, Query Builder, Tools, etc.) to specific users via `admin_users.json`
- **Server-side logging** — all queries, logins, commits, and rollbacks logged to `saved/app.log`
- **Transaction mode** — persistent (localStorage), keeps DML uncommitted until you click Commit/Rollback
- **Hide zero-row results** — in multi-server mode, skip databases with 0 matching rows
- **Dark/light theme** — toggle between dark and light

## Configuration

Edit `config.json` or use the Settings (⚙) button in the top bar (admin only) to configure:
- Server connections (host, port, databases)
- Auth plugin per server (Auto, Srp256, Srp, or Legacy_Auth)
- Wire encryption per server
- Default credentials (username/password)
- Query defaults (max rows, timeout)

## Authentication

Users authenticate against the `MEMBERS_` table in `PAYOFFICE.IB` on PIDB08. Passwords are stored as MD5 hashes. Admin access is controlled by `admin_users.json` on disk:
- If the file doesn't exist → all users are admins (backwards compatible)
- Once created → only listed usernames get admin access
- Non-admin users see only: theme toggle, logout, query editor, history, saved scripts

## How It Works

The app uses the `firebirdsql` pure-Python library which speaks the Firebird wire protocol. InterBase is the ancestor of Firebird, and the wire protocol is compatible — so no InterBase-specific ODBC driver or client library is required.

For InterBase 2020+, the connection defaults to **Srp256 authentication** with **wire encryption enabled**. If that fails, it automatically falls back to **Srp** then **Legacy_Auth**.

## Persistent Hosting (PINTAPPTEST)

The app runs as a **Windows Scheduled Task** on PINTAPPTEST (managed via Azure Arc). See `ARCHITECTURE.md` for full details.

### Key points
- Runs as `pythonw.exe` (no console window) as **SYSTEM** in Session 0
- Survives logoff, auto-starts on boot, auto-restarts on crash (up to 999 times)
- Managed via Azure Cloud Shell → `az connectedmachine run-command`
- See `azure_commands.ps1` for all management commands

### Restart from Azure Cloud Shell
```powershell
$script = 'Get-Process pythonw -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2; Start-ScheduledTask -TaskName "InterbaseQueryManager"'
az connectedmachine run-command create --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-restart7" --script $script
```

## Connection Management

- Connections are cached per `(server_id, db_path)` and reused during active use
- Idle connections are closed after **1 minute** of inactivity (background thread checks every 60 seconds)
- In transaction mode, the connection stays open so DML statements accumulate in one transaction
- Check open connections via `http://localhost:5000/api/connections` (admin only)

## Database Scanning

Use the **"🔍 Scan for New Databases"** button in Settings (admin only) to discover new databases via network shares. The scanner runs `DBScanner.ps1` which scans `\\PIDB06\DATABASES$` through `\\PIDB10\DATABASES$` for `.IB` files.

The scan is **add-only** — it will never remove databases from config. Use `restore_config.py` to rebuild config from a scan output file if needed.

## Requirements

- **Nothing.** Python is bundled. Just copy the folder and run.
- Network access to your InterBase servers on port 3050 (default)
- A modern web browser

## File Structure

```
Interbase_query_manager/
├── app.py                     ← Flask backend (main application)
├── start.bat                  ← Local dev launcher (uses bundled Python)
├── install_service.bat        ← Install as scheduled task (admin cmd prompt)
├── service_manage.ps1         ← Start/stop/status/uninstall the task
├── diagnose.bat               ← Diagnostic script for troubleshooting
├── azure_commands.ps1         ← Azure Cloud Shell commands for PINTAPPTEST
├── DBScanner.ps1              ← PowerShell script to scan for databases
├── restore_config.py          ← Rebuild config.json from scan output
├── generate_config.py         ← Initial config generator
├── ARCHITECTURE.md            ← Full architecture documentation
├── config.json                ← Server/database config (gitignored — credentials)
├── admin_users.json           ← Admin user list (gitignored — created on first use)
├── .gitignore
├── python/                    ← Bundled portable Python 3.14 (zero-install)
├── vendor/                    ← Python dependencies (Flask, firebirdsql, etc.)
├── templates/
│   └── index.html             ← Web UI
├── static/
│   ├── css/style.css          ← Dark/light theme stylesheet
│   └── js/app.js              ← Frontend logic
└── saved/                     ← Saved scripts, history, logs, secret key
    ├── history.json           ← Query history (gitignored)
    ├── app.log                ← Server log (gitignored)
    └── secret_key.dat         ← Persistent session key (gitignored)
```

## Troubleshooting

**"python is not recognized"** — Make sure you're running `start.bat`, not `python app.py` directly. The `start.bat` script uses the bundled Python in `python/python.exe`.

**Connection errors** — Click the 🔌 Test Connection button to see which auth method was tried and the error. If all auth methods fail, check that the server hostname resolves from your machine and port 3050 is accessible.

**History shows "unknown" user** — This was caused by the secret key being regenerated on every restart. Now fixed with a persistent key in `saved/secret_key.dat`.

**Scan removed databases** — This was a bug in the auto-delete feature, now removed. The scan is add-only. Use `restore_config.py` to recover if needed.

## Git Repository

- **GitHub:** [https://github.com/pauldaspden/Interbase_query_manager](https://github.com/pauldaspden/Interbase_query_manager) (public)
- `config.json` and `admin_users.json` are gitignored (contain credentials)
- See `ARCHITECTURE.md` for full history and design decisions
