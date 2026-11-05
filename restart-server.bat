@echo off
echo ============================================================
echo Restarting Permanent Localhost Server and Go Telegram Bot...
echo ============================================================
call "%~dp0stop-server.bat"
timeout /t 2 /nobreak >nul
wscript.exe "%~dp0start-hidden.vbs"
timeout /t 3 /nobreak >nul
echo.
call "%~dp0check-status.bat"
