# InterBase Query Manager — Architecture & History

## What It Is

A self-contained, zero-install web application for running SQL queries against multiple InterBase database servers. It runs as a Windows Scheduled Task on PINTAPPTEST (an on-prem server managed via Azure Arc), and is accessible at `http://localhost:5000`.

## Tech Stack

| Component | Technology |
|---|---|
| Backend | Python 3 + Flask (vendored — no pip install needed) |
| Database Driver | `firebirdsql` (vendored — speaks the Firebird wire protocol, which InterBase understands) |
| Frontend | Vanilla JS + CodeMirror SQL editor |
| Database | InterBase (via Firebird wire protocol on port 3050) |
| Auth | Custom — MD5 password hashing against `MEMBERS_` table in `PAYOFFICE.IB` on PIDB08 |
| Hosting | Windows Scheduled Task running as SYSTEM (survives logoff, auto-starts on boot) |
| Server Management | Azure Arc + Cloud Shell (Run Command) |

## Zero-Install Design

All Python dependencies are in `vendor/` — Flask, firebirdsql, passlib, Werkzeug, Jinja2. No `pip install` required. Just copy the folder and run:

```
python app.py
```

Or use the bundled Python:
```
python\pythonw.exe app.py
```

## Authentication

- Users authenticate against the `MEMBERS_` table in `PAYOFFICE.IB` on PIDB08 (`10.100.5.18`)
- Passwords are stored as MD5 hashes (32 hex chars) in the `PASSWD` column
- The `LOGIN_DISABLED` column controls account disabling
- Admin access is controlled by `admin_users.json` on disk:
  - If the file doesn't exist → all users are admins (backwards compatible)
  - Once created → only listed usernames get admin access
- Non-admin users see only: theme toggle + logout + query editor + history + saved scripts
- Admin users see everything: settings, test connection, diagnose, restart, query builder, tools, transaction mode

## Database Servers

Configured in `config.json` (excluded from git — contains credentials and server IPs):

| Server | Host | Port |
|---|---|---|
| PIDB06 | 10.100.5.16 | 3050 |
| PIDB07 | 10.100.5.17 | 3050 |
| PIDB08 | 10.100.5.18 | 3050 |
| PIDB09 | 10.100.5.19 | 3050 |
| PIDB10 | 10.100.5.15 | 3050 |

Each server hosts multiple company databases (Affinity Payroll), identified by company number.

## Persistent Service (PINTAPPTEST)

The app runs as a Windows Scheduled Task on PINTAPPTEST, managed via Azure Arc.

### Installation

Done via Azure Cloud Shell → Run Command (runs as SYSTEM on PINTAPPTEST):

```powershell
$script = @'
$ProjectDir = "C:\Users\paula\Interbase_query_manager"
$PythonW = "$ProjectDir\python\pythonw.exe"
$App = "$ProjectDir\app.py"

Get-ScheduledTask -TaskName "InterbaseQueryManager" -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $PythonW -Argument $App -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -DontStopOnIdleEnd

Register-ScheduledTask -TaskName "InterbaseQueryManager" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "InterBase Query Manager web app (http://localhost:5000)"
Start-ScheduledTask -TaskName "InterbaseQueryManager"
'@

az connectedmachine run-command create --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "install-iqm3" --script $script
```

### Management

See `azure_commands.ps1` for all Cloud Shell commands. Key ones:

| Action | Command |
|---|---|
| Restart | Stop process + start task |
| Status | Check task state + port 5000 |
| Stop | Kill process |
| Start | Start task |

### Why a Scheduled Task (not a Windows Service)?

- PINTAPPTEST is an on-prem server connected to Azure via Azure Arc
- No local admin rights on PINTAPPTEST (standard user account)
- Azure Arc Run Command runs as SYSTEM, bypassing local admin requirements
- Scheduled Task survives logoff (runs as SYSTEM in Session 0)
- Auto-starts on boot (trigger: AtStartup)
- Auto-restarts on crash (up to 999 times, 1-minute intervals)

## Transaction Mode

- **On by default** — persisted in browser `localStorage`
- When on: DML statements are NOT auto-committed; user must click "Commit" or "Rollback"
- When off: DML statements auto-commit immediately
- Commit/Rollback no longer turns transaction mode off (fixed — stays on)
- State survives page reloads and logoffs (stored in `localStorage`)

## Query Builder

A visual SQL builder for non-technical users. Accessible via the "🛠 Query Builder" tab (admin only).

### Features

| Section | Capability |
|---|---|
| Tables | Pick primary table from dropdown |
| JOINs | Add INNER JOINs to related tables; foreign keys auto-suggested from DB schema |
| Columns | Checkboxes for each column across all tables; "Select all" option |
| Filters | WHERE clause builder: column, operator (=, !=, <, >, LIKE, IS NULL, IN, etc.), value, AND/OR connectors |
| Aggregates | COUNT, SUM, AVG, MIN, MAX with custom aliases; GROUP BY support |
| Sort | ORDER BY with ASC/DESC per column |
| SQL Preview | Live SQL generation; updates as you click |
| Run / Send to Editor | Execute directly or copy to main SQL editor |

### Backend Support

The metadata API (`/api/metadata/<server_id>`) returns:
- All tables and views with columns, types, nullable flags, primary keys
- Foreign key relationships (for JOIN suggestions) — queried from `RDB$RELATION_CONSTRAINTS` with a fallback to `RDB$INDICES`

## File Structure

```
Interbase_query_manager/
├── app.py                    # Flask app — all backend logic
├── config.json               # Database config (gitignored — contains credentials)
├── admin_users.json          # Admin user list (gitignored — created on first use)
├── start.bat                 # Local dev launcher (kills port 5000, starts app)
├── install_service.bat       # Install as scheduled task (admin cmd prompt)
├── service_manage.ps1        # Start/stop/status/uninstall the task
├── diagnose.bat              # Diagnostic script for troubleshooting
├── azure_commands.ps1        # Azure Cloud Shell commands for PINTAPPTEST management
├── DBScanner.ps1            # PowerShell script to scan for new databases
├── generate_config.py        # Initial config generator
├── .gitignore                # Excludes config.json, admin_users.json, etc.
├── python/                  # Bundled Python (python.exe + pythonw.exe)
├── vendor/                  # Vendored dependencies (Flask, firebirdsql, passlib, etc.)
├── saved/                   # Saved queries and history
│   └── history.json          # Query history (gitignored)
├── static/
│   ├── css/style.css         # All styling (dark + light themes)
│   └── js/app.js             # All frontend logic
└── templates/
    └── index.html            # Main HTML template
```

## Key Design Decisions

1. **Zero-install** — Everything vendored, no pip, no system-wide Python needed
2. **InterBase via Firebird protocol** — InterBase is the ancestor of Firebird; the wire protocol is compatible
3. **MD5 password hashing** — Matches how Affinity Payroll stores passwords in `MEMBERS_.PASSWD`
4. **Scheduled Task over Windows Service** — Works with Azure Arc + no local admin
5. **admin_users.json on disk** — Doesn't modify the payroll database schema; backwards compatible (no file = all admins)
6. **config.json gitignored** — Contains database credentials and internal server IPs; scrubbed from git history

## Restart Button

The in-app "↻ Restart Server" button works in two modes:
- **Scheduled task**: Exits with code 1; the task's "restart on failure" setting relaunches within ~1 minute
- **start.bat (dev)**: Writes `.restart_flag` file; start.bat detects it and restarts

The frontend polls for up to 90 seconds to handle the task's 1-minute restart interval.

## Deployment to PINTAPPTEST

1. Copy updated files to `C:\Users\paula\Interbase_query_manager\` on PINTAPPTEST
2. In Azure Cloud Shell, run the restart command from `azure_commands.ps1`
3. Verify with the status command
4. Open `http://localhost:5000` on PINTAPPTEST

## Git Repository

- **GitHub**: [https://github.com/pauldaspden/Interbase_query_manager](https://github.com/pauldaspden/Interbase_query_manager) (public)
- **Branch**: `master`
- `config.json` has been scrubbed from git history (contained credentials)
- `admin_users.json` is gitignored
