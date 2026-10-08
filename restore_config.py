#!/usr/bin/env python3
"""Rebuild config.json from ALL DBs 1.txt — restores databases that were
accidentally removed by the scan feature. Preserves server config and credentials."""

import json
import os
import re

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
SCAN_PATH = os.path.join(BASE_DIR, "ALL DBs 1.txt")

# Load current config
with open(CONFIG_PATH, "r") as f:
    cfg = json.load(f)

# Parse the scan file
# Lines look like: PIDB06:E:\DATABASES\1197\1197.IB
scan_entries = {}
with open(SCAN_PATH, "r") as f:
    for line in f:
        line = line.strip()
        if not line or ":" not in line or "PIDB" not in line:
            continue
        parts = line.split(":", 1)
        server_name = parts[0].strip()
        db_path = parts[1].strip()
        if server_name not in scan_entries:
            scan_entries[server_name] = []
        scan_entries[server_name].append(db_path)

# Map PIDB names to server names in config
# PIDB06 -> "Production Server 6 (PIDB06)", etc.
pidb_to_srv = {}
for srv in cfg["servers"]:
    m = re.search(r'(PIDB\d+)', srv.get("name", ""))
    if m:
        pidb_to_srv[m.group(1)] = srv

# For each server, ensure all databases from the scan are present
added = 0
for pidb_name, db_paths in scan_entries.items():
    if pidb_name not in pidb_to_srv:
        print(f"WARNING: {pidb_name} not found in config servers")
        continue
    srv = pidb_to_srv[pidb_name]
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
            existing_paths.add(path.lower())
            added += 1
            print(f"  Added: {pidb_name}: {db_name}")

# Sort databases by company_number
for srv in cfg["servers"]:
    srv["databases"].sort(
        key=lambda d: int(d.get("company_number", "0"))
        if str(d.get("company_number", "")).isdigit()
        else 0
    )

# Save
with open(CONFIG_PATH, "w") as f:
    json.dump(cfg, f, indent=4)

print(f"\nDone! Added {added} databases. Config saved to {CONFIG_PATH}")
print(f"Total databases per server:")
for srv in cfg["servers"]:
    print(f"  {srv['name']}: {len(srv['databases'])} databases")
