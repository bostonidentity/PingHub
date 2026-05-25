@echo off
REM status.cmd — Show whether PingHub is currently running.
REM
REM Exit codes:
REM   0  running
REM   1  not running (or stale PID file)
REM   2  bad invocation

setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "APP_DIR=%REPO_ROOT%\aic-pipeline"
set "LOG_DIR=%APP_DIR%\.pinghub-logs"
set "LOG_FILE=%LOG_DIR%\pinghub.log"
set "PID_FILE=%LOG_DIR%\pinghub.pid"
set "LOG=[pinghub]"

if "%~1"=="-h"     goto print_help
if "%~1"=="--help" goto print_help
if not "%~1"=="" (
  echo %LOG% ERROR: unknown argument: %~1 1>&2
  goto print_help_err
)
goto main

:print_help
echo Usage: status.cmd [OPTIONS]
echo.
echo Show whether PingHub is currently running.
echo.
echo Looks at the PID file and verifies the process is alive. When running,
echo prints the PID and log file path.
echo.
echo OPTIONS
echo   -h, --help         show this help and exit
echo.
echo EXIT CODES
echo   0  running
echo   1  not running
echo.
echo RELATED
echo   start.cmd    bootstrap and launch the server
echo   stop.cmd     stop the running server
exit /b 0

:print_help_err
echo Usage: status.cmd [-h^|--help]
exit /b 2

:main
if not exist "%PID_FILE%" (
  echo %LOG% status: not running ^(no PID file^)
  exit /b 1
)

set /p PID=<"%PID_FILE%"
if "%PID%"=="" (
  echo %LOG% status: not running ^(PID file is empty - likely stale^)
  exit /b 1
)

tasklist /FI "PID eq %PID%" 2>nul | findstr /C:"%PID%" >nul
if errorlevel 1 (
  echo %LOG% status: not running ^(PID %PID% is not alive - stale PID file^)
  echo %LOG%   Run start.cmd to launch, or stop.cmd to clean up the stale file.
  exit /b 1
)

REM Running — try to extract URL from last "ready at" line in the log
set "URL="
if exist "%LOG_FILE%" (
  for /f "tokens=*" %%a in ('findstr /C:"ready at " "%LOG_FILE%"') do (
    set "LINE=%%a"
    for /f "tokens=2 delims= " %%b in ("!LINE:*ready at =!") do (
      set "URL=%%b"
    )
  )
)

echo %LOG% status: running
echo %LOG%   PID:      %PID%
if defined URL echo %LOG%   serving:  %URL%
echo %LOG%   log:      %LOG_FILE%
echo %LOG%   stop:     stop.cmd
exit /b 0
