#!/usr/bin/env python3
"""Generate config.json from GridExport.xlsx"""
import openpyxl
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
XLSX = os.path.join(BASE, "GridExport.xlsx")

# Server name -> IP mapping (as provided by user)
SERVER_IPS = {
    "PIDB06": "10.100.5.16",
    "PIDB07": "10.100.5.17",
    "PIDB08": "10.100.5.18",
    "PIDB09": "10.100.5.19",
    "PIDB10": "10.100.5.15",
}

SERVER_NAMES = {
    "PIDB06": "Production Server 6 (PIDB06)",
    "PIDB07": "Production Server 7 (PIDB07)",
    "PIDB08": "Production Server 8 (PIDB08)",
    "PIDB09": "Production Server 9 (PIDB09)",
    "PIDB10": "Production Server 10 (PIDB10)",
}

wb = openpyxl.load_workbook(XLSX)
ws = wb.active

# Parse all rows
servers_data = {}  # server_key -> list of databases

for i, row in enumerate(ws.iter_rows(values_only=True)):
    if i == 0:
        continue  # skip header row
    company_num, company_name, db_field = row
    if not company_num or not db_field:
        continue

    db_field = str(db_field)
    # Parse 'PIDB06:E:\DATABASES\2635\2635.IB'
    if ":" in db_field and "PIDB" in db_field:
        parts = db_field.split(":", 1)
        server_key = parts[0].strip()
        db_path = parts[1].strip()
    else:
        continue

    if server_key not in SERVER_IPS:
        continue

    if server_key not in servers_data:
        servers_data[server_key] = []

    # DB display name: company number + company name
    db_name = f"{company_num} {company_name}".strip()

    servers_data[server_key].append({
        "name": db_name,
        "path": db_path,
        "company_number": str(company_num),
    })

# Sort databases by company_number within each server
for server_key in servers_data:
    servers_data[server_key].sort(key=lambda d: int(d["company_number"]) if d["company_number"].isdigit() else 0)

# Build config
servers = []
for i, (server_key, dbs) in enumerate(sorted(servers_data.items()), 1):
    servers.append({
        "id": f"srv{i}",
        "name": SERVER_NAMES.get(server_key, server_key),
        "host": SERVER_IPS[server_key],
        "port": 3050,
        "auth_plugin": None,
        "wire_crypt": True,
        "databases": dbs,
    })

config = {
    "servers": servers,
    "credentials": {
        "username": "SYSDBA",
        "password": "masterkey",
    },
    "settings": {
        "max_rows": 1000,
        "query_timeout": 30,
        "theme": "dark",
    },
}

out_path = os.path.join(BASE, "config.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=4, ensure_ascii=False)

# Print summary
print("Config generated!")
print(f"Total servers: {len(servers)}")
for s in servers:
    print(f"  {s['name']} ({s['host']}): {len(s['databases'])} databases")
print(f"Total databases: {sum(len(s['databases']) for s in servers)}")
