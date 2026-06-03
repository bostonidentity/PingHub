@echo off
REM PingHub release: stop the running server.
setlocal
set "LOG_DIR=%LOCALAPPDATA%\PingHub\logs"
set "PID_FILE=%LOG_DIR%\pinghub.pid"
set "LOG=[PingHub]"

if not exist "%PID_FILE%" (
  echo %LOG% not running ^(no PID file^)
  exit /b 0
)

set /p PID=<"%PID_FILE%"
tasklist /FI "PID eq %PID%" 2>nul | findstr /C:"%PID%" >nul
if errorlevel 1 (
  echo %LOG% stale PID file ^(PID %PID% not running^); cleaning up
  del "%PID_FILE%" 2>nul
  exit /b 0
)

echo %LOG% stopping PID %PID%...
taskkill /PID %PID% >nul 2>&1
ping -n 2 127.0.0.1 >nul
taskkill /F /PID %PID% >nul 2>&1
del "%PID_FILE%" 2>nul
echo %LOG% stopped
exit /b 0
