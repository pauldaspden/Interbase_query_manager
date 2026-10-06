# ── Manage the InterBase Query Manager scheduled task ──
# Usage (run from an admin PowerShell):
#   .\service_manage.ps1 start       — start the task
#   .\service_manage.ps1 stop        — stop the task (kill the process)
#   .\service_manage.ps1 status      — check if it's running
#   .\service_manage.ps1 uninstall    — remove the scheduled task entirely
#   .\service_manage.ps1 restart      — stop then start

# Check for admin rights
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script needs admin rights."
    Write-Host "Open PowerShell as Administrator and run it there."
    exit 1
}

$TaskName = "InterbaseQueryManager"

$Action = $args[0]
if (-not $Action) {
    Write-Host "Usage: .\service_manage.ps1 <start|stop|status|uninstall|restart>"
    exit 1
}

switch ($Action.ToLower()) {
    "start" {
        Write-Host "Starting InterBase Query Manager..."
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Started. Open http://localhost:5000"
    }

    "stop" {
        Write-Host "Stopping InterBase Query Manager..."
        # Stop the scheduled task
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        # Also kill any pythonw process running app.py from this project
        $projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
        $appPath = Join-Path $projectDir "app.py"
        Get-WmiObject Win32_Process -Filter "Name='pythonw.exe'" | Where-Object {
            $_.CommandLine -like "*app.py*"
        } | ForEach-Object {
            Write-Host "  Killing PID $($_.ProcessId)..."
            Stop-Process -Id $_.ProcessId -Force
        }
        Write-Host "Stopped."
    }

    "status" {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            $info = Get-ScheduledTaskInfo -TaskName $TaskName
            Write-Host "Task:       $TaskName"
            Write-Host "State:      $($task.State)"
            Write-Host "Last Run:    $($info.LastRunTime)"
            Write-Host "Last Result: $($info.LastTaskResult)"
            Write-Host "Next Run:    $($info.NextRunTime)"
        } else {
            Write-Host "Task '$TaskName' is not installed."
            Write-Host "Run .\install_service.ps1 to install it."
        }
    }

    "uninstall" {
        Write-Host "Removing InterBase Query Manager scheduled task..."
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        # Also kill any running instance
        Get-WmiObject Win32_Process -Filter "Name='pythonw.exe'" | Where-Object {
            $_.CommandLine -like "*app.py*"
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force
        }
        Write-Host "Uninstalled."
    }

    "restart" {
        Write-Host "Restarting InterBase Query Manager..."
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
        $appPath = Join-Path $projectDir "app.py"
        Get-WmiObject Win32_Process -Filter "Name='pythonw.exe'" | Where-Object {
            $_.CommandLine -like "*app.py*"
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force
        }
        Start-Sleep -Seconds 1
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Restarted."
    }

    default {
        Write-Host "Unknown action: $Action"
        Write-Host "Usage: .\service_manage.ps1 <start|stop|status|uninstall|restart>"
        exit 1
    }
}
