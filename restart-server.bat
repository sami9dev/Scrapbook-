@echo off
echo ============================================================
echo Restarting Permanent Localhost Server and Go Telegram Bot...
echo ============================================================
call "%~dp0stop-server.bat"
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
wscript.exe "%~dp0start-hidden.vbs"
powershell -NoProfile -Command "Start-Sleep -Seconds 4"
echo.
powershell -NoProfile -Command "try { $res = Invoke-RestMethod -Uri 'http://localhost:3000/health' -TimeoutSec 3; Write-Host '[ONLINE] Server is running healthy on http://localhost:3000' -ForegroundColor Green; Write-Host ('Uptime: ' + [math]::Round($res.uptime/60, 2) + ' minutes') } catch { Write-Host '[OFFLINE] Server is not running on http://localhost:3000' -ForegroundColor Red }"
