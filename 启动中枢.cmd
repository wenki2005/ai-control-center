@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo 请先安装 Node.js 24 或更高版本。 & pause & exit /b 1)
if not exist node_modules\ws call npm ci --ignore-scripts --no-audit
if errorlevel 1 (pause & exit /b 1)
call npm start
pause
