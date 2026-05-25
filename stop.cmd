@echo off
REM stop.cmd — Stop the PingHub server started by start.cmd.

setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "APP_DIR=%REPO_ROOT%\aic-pipeline"
set "PID_FILE=%APP_DIR%\.pinghub-logs\pinghub.pid"
set "LOG=[Ping AIC Studio]"

if "%~1"=="-h"     goto print_help
if "%~1"=="--help" goto print_help
goto main

:print_help
echo Usage: stop.cmd [OPTIONS]
echo.
echo Stop the PingHub server started by start.cmd. Sends a stop signal,
echo waits up to 3 seconds, then escalates to force-kill if needed.
echo Cleans up the PID file regardless of outcome.
echo.
echo If no server is running, exits quietly with code 0.
echo.
echo OPTIONS
echo   -h, --help         show this help and exit
echo.
echo RELATED
echo   start.cmd    bootstrap and launch the server
echo   status.cmd   show whether the server is currently running
exit /b 0

:main

if not exist "%PID_FILE%" (
  echo %LOG% Ping AIC Studio is not running ^(no PID file at %PID_FILE%^)
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

echo %LOG% stopping Ping AIC Studio ^(PID %PID%^)...
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
echo %LOG% Ping AIC Studio stopped
