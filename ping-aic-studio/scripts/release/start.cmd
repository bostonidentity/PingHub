@echo off
REM PingHub release launcher (Windows).
REM Self-contained: uses bundled Node if present, otherwise system Node 20+.
REM No git, no npm, no build — the standalone server is pre-built.

setlocal enabledelayedexpansion

set "DIST_ROOT=%~dp0"
if "%DIST_ROOT:~-1%"=="\" set "DIST_ROOT=%DIST_ROOT:~0,-1%"
set "LAUNCHER=%DIST_ROOT%\launcher\launcher.mjs"
set "BUNDLED_NODE=%DIST_ROOT%\node\node.exe"
set "LOG_DIR=%LOCALAPPDATA%\PingHub\logs"
set "PID_FILE=%LOG_DIR%\pinghub.pid"
set "LOG=[PingHub]"

if not exist "%LAUNCHER%" (
  echo %LOG% ERROR: missing %LAUNCHER%
  exit /b 1
)

REM Already running?
set "TRACKED_PID="
if exist "%PID_FILE%" (
  set /p TRACKED_PID=<"%PID_FILE%"
  tasklist /FI "PID eq !TRACKED_PID!" 2>nul | findstr /C:"!TRACKED_PID!" >nul
  if errorlevel 1 (
    del "%PID_FILE%" 2>nul
    set "TRACKED_PID="
  )
)
if defined TRACKED_PID (
  echo %LOG% PingHub is already running ^(PID !TRACKED_PID!^). Run stop.cmd first.
  exit /b 0
)

REM Pick Node.
set "NODE_EXE="
if exist "%BUNDLED_NODE%" (
  set "NODE_EXE=%BUNDLED_NODE%"
  for /f "tokens=*" %%v in ('"%NODE_EXE%" -v 2^>nul') do echo %LOG% using bundled Node %%v
) else (
  where node >nul 2>&1
  if !errorlevel! EQU 0 (
    for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NV=%%v"
    if defined NV (
      set "NV=!NV:v=!"
      for /f "tokens=1 delims=." %%m in ("!NV!") do set "NMAJ=%%m"
      if !NMAJ! GEQ 20 (
        for /f "tokens=*" %%p in ('where node') do (
          if not defined NODE_EXE set "NODE_EXE=%%p"
        )
        echo %LOG% using system Node v!NV!
      )
    )
  )
)
if not defined NODE_EXE (
  echo %LOG% ERROR: Node 20+ not found. Install from https://nodejs.org or use the bundled-node release.
  exit /b 2
)

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "OUT_LOG=%LOG_DIR%\pinghub.out.log"
set "ERR_LOG=%LOG_DIR%\pinghub.err.log"

echo %LOG% launching in background...
del "%PID_FILE%" 2>nul
powershell -NoProfile -Command "$p = Start-Process -FilePath '%NODE_EXE%' -ArgumentList '%LAUNCHER% %*' -RedirectStandardOutput '%OUT_LOG%' -RedirectStandardError '%ERR_LOG%' -WindowStyle Hidden -PassThru; Set-Content -Path '%PID_FILE%' -Value $p.Id -Encoding ASCII"

set "SERVER_PID="
if exist "%PID_FILE%" set /p SERVER_PID=<"%PID_FILE%"
if not defined SERVER_PID (
  echo %LOG% ERROR: failed to launch
  exit /b 5
)
ping -n 4 127.0.0.1 >nul
tasklist /FI "PID eq %SERVER_PID%" 2>nul | findstr /C:"%SERVER_PID%" >nul
if errorlevel 1 (
  echo %LOG% ERROR: PingHub failed to start. Recent log:
  echo ----------------------------------------------------------------
  if exist "%ERR_LOG%" type "%ERR_LOG%"
  if exist "%OUT_LOG%" type "%OUT_LOG%"
  echo ----------------------------------------------------------------
  del "%PID_FILE%" 2>nul
  exit /b 5
)

echo %LOG% started successfully ^(PID %SERVER_PID%^)
echo %LOG%   log:  %OUT_LOG%
echo %LOG%   stop: stop.cmd
exit /b 0
