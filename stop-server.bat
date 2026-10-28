@echo off
echo Stopping Scraper Server and Daemon on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /f /pid %%a >nul 2>&1
)
echo Server stopped.
