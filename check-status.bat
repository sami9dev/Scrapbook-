@echo off
echo ============================================================
echo Checking Localhost Scraper Server & Go Bot Status...
echo ============================================================
powershell -NoProfile -Command ^
  "try { $res = Invoke-RestMethod -Uri 'http://localhost:3000/health' -TimeoutSec 3; Write-Host '[ONLINE] Server is running healthy on http://localhost:3000' -ForegroundColor Green; Write-Host ('Uptime: ' + [math]::Round($res.uptime/60, 2) + ' minutes') } catch { Write-Host '[OFFLINE] Server is not running on http://localhost:3000' -ForegroundColor Red }"
echo.
pause
