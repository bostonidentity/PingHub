@echo off
REM stop.cmd — Stop the PingHub server started by start.cmd.

setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "APP_DIR=%REPO_ROOT%\aic-pipeline"
set "PID_FILE=%APP_DIR%\.pinghub-logs\pinghub.pid"
set "LOG=[pinghub]"

if not exist "%PID_FILE%" (
  echo %LOG% not running ^(no PID file at %PID_FILE%^)
  exit /b 0
)

set /p PID=<"%PID_FILE%"
if "%PID%"=="" (
  echo %LOG% PID file empty; cleaning up
  del "%PID_FILE%" 2>nul
  exit /b 0
)

tasklist /FI "PID eq %PID%" 2>nul | findstr /C:"%PID%" >nul
if errorlevel 1 (
  echo %LOG% stale PID file ^(PID %PID% not running^); cleaning up
  del "%PID_FILE%" 2>nul
  exit /b 0
)

echo %LOG% stopping PID %PID%...
taskkill /PID %PID% >nul 2>&1

REM Wait up to 3 seconds
for /l %%i in (1,1,3) do (
  timeout /t 1 /nobreak >nul
  tasklist /FI "PID eq %PID%" 2>nul | findstr /C:"%PID%" >nul
  if errorlevel 1 goto done
)

echo %LOG% still alive after 3s, forcing
taskkill /F /PID %PID% >nul 2>&1
timeout /t 1 /nobreak >nul

:done
del "%PID_FILE%" 2>nul
echo %LOG% stopped
