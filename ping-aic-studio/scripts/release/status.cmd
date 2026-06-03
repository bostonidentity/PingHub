@echo off
REM PingHub release: show server status.
setlocal
set "PID_FILE=%LOCALAPPDATA%\PingHub\logs\pinghub.pid"
set "LOG=[PingHub]"

if not exist "%PID_FILE%" (
  echo %LOG% not running
  exit /b 1
)
set /p PID=<"%PID_FILE%"
tasklist /FI "PID eq %PID%" 2>nul | findstr /C:"%PID%" >nul
if errorlevel 1 (
  echo %LOG% not running ^(stale PID %PID%^)
  exit /b 1
)
echo %LOG% running ^(PID %PID%^)
exit /b 0
