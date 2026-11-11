# 4KHub4U Localhost Health Watchdog
$healthUrl = "http://localhost:3000/health"
try {
    $res = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 -ErrorAction Stop
    if ($res.status -eq "ok") {
        Write-Host "[Watchdog] localhost:3000 is healthy (uptime: $($res.uptime)s)"
        exit 0
    }
} catch {
    Write-Host "[Watchdog] localhost:3000 is down. Restarting via start-hidden.vbs..."
    Start-Process -FilePath "wscript.exe" -ArgumentList "C:\Users\sk621\scraper\start-hidden.vbs"
}
