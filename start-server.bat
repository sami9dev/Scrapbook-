@echo off
title CineFuel Scraper Development Mode (Cloud Offloaded)
echo =========================================================================
echo [PC FREEZE PREVENTION GUARD ACTIVE]
echo Heavy scraping and browser resolution are offloaded to Render cloud worker.
echo Local workers will NOT launch headless browsers or link resolution on this Windows PC.
echo Windows PC is reserved strictly for development and messaging.
echo =========================================================================
cd /d "%~dp0"
set BROWSER_SCRAPER_ENABLED=false
set WORKER_CONCURRENCY=1
node src/index.js
pause
