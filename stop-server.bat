@echo off
echo Stopping Scraper Server, Daemon, and Go Bot...
powershell -NoProfile -Command "Get-Process -Name 'bot' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*scraper*' -and ($_.Name -eq 'node.exe' -or $_.Name -eq 'bot.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo Server stopped.
