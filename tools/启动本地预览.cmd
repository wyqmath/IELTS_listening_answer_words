@echo off
cd /d "%~dp0.."
echo Open http://127.0.0.1:11545/ in Chrome or Edge.
where py >nul 2>nul
if not errorlevel 1 (
  py -3 "%~dp0preview_server.py"
) else (
  python "%~dp0preview_server.py"
)
pause
