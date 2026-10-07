# ── Azure Cloud Shell commands for managing InterBase Query Manager on PINTAPPTEST ──
#
# Copy/paste these into Azure Cloud Shell (PowerShell) as needed.
# Change the --run-command-name to a unique value each time (e.g., iqm-restart5, iqm-restart6, etc.)
# Or delete old run commands first: see "Cleanup" section below.

# ─────────────────────────────────────────────────────────────
# 0. One-time setup — stop the prompt asking to install the extension
# ─────────────────────────────────────────────────────────────
az config set extension.use_dynamic_install=yes_without_prompt


# ─────────────────────────────────────────────────────────────
# 1. RESTART the app (stop process + start scheduled task)
# ─────────────────────────────────────────────────────────────
$script = 'Get-Process pythonw -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Seconds 2; Start-ScheduledTask -TaskName "InterbaseQueryManager"'
az connectedmachine run-command create --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-restart" --script $script

# Check the result:
az connectedmachine run-command show --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-restart"


# ─────────────────────────────────────────────────────────────
# 2. START the app (just start the scheduled task)
# ─────────────────────────────────────────────────────────────
$script = 'Start-ScheduledTask -TaskName "InterbaseQueryManager"'
az connectedmachine run-command create --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-start" --script $script


# ─────────────────────────────────────────────────────────────
# 3. STOP the app (kill the process)
# ─────────────────────────────────────────────────────────────
$script = 'Get-Process pythonw -ErrorAction SilentlyContinue | Stop-Process -Force'
az connectedmachine run-command create --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-stop" --script $script


# ─────────────────────────────────────────────────────────────
# 4. STATUS — check if the task is running and port 5000 is listening
# ─────────────────────────────────────────────────────────────
$script = 'Get-ScheduledTask -TaskName "InterbaseQueryManager" | Format-List TaskName, State; Get-ScheduledTaskInfo -TaskName "InterbaseQueryManager" | Format-List LastRunTime, LastTaskResult; netstat -ano | findstr ":5000"'
az connectedmachine run-command create --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-status" --script $script


# ─────────────────────────────────────────────────────────────
# 5. CLEANUP — delete old run-command resources (run occasionally)
# ─────────────────────────────────────────────────────────────
az connectedmachine run-command delete --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-restart"
az connectedmachine run-command delete --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-start"
az connectedmachine run-command delete --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-stop"
az connectedmachine run-command delete --resource-group rg-onprem-prod --machine-name PINTAPPTEST --run-command-name "iqm-status"


# ─────────────────────────────────────────────────────────────
# 6. LIST ALL run-commands on PINTAPPTEST (to find names for cleanup)
# ─────────────────────────────────────────────────────────────
az connectedmachine run-command list --resource-group rg-onprem-prod --machine-name PINTAPPTEST --query "[].name" -o table
