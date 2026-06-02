@echo off
REM start.cmd — Windows entry: bootstrap + launch PingHub in background.
REM Server logs go to ping-aic-studio\.pinghub-logs\pinghub.log.
REM Run stop.cmd to stop the server.

setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "APP_DIR=%REPO_ROOT%\ping-aic-studio"
set "LOG_DIR=%APP_DIR%\.pinghub-logs"
set "LOG_FILE=%LOG_DIR%\pinghub.log"
set "PID_FILE=%LOG_DIR%\pinghub.pid"
set "LOG=[Ping AIC Studio]"

if not exist "%APP_DIR%" (
  echo %LOG% ERROR: expected ping-aic-studio directory at %APP_DIR%
  exit /b 1
)

REM ── Parse flags ───────────────────────────────────────────────────
set "BUNDLED_NODE=0"
set "SKIP_UPDATE=0"
set "REINSTALL=0"
set "REBUILD=0"
set "FORCE_RESTART=0"
set "LAUNCHER_ARGS="
:parse_args
if "%~1"=="" goto parse_done
if "%~1"=="-h"             goto print_help
if "%~1"=="--help"         goto print_help
if "%~1"=="--bundled-node"  (set "BUNDLED_NODE=1"   & shift & goto parse_args)
if "%~1"=="--skip-update"   (set "SKIP_UPDATE=1"    & shift & goto parse_args)
if "%~1"=="--reinstall"     (set "REINSTALL=1"      & shift & goto parse_args)
if "%~1"=="--build"         (set "REBUILD=1"        & shift & goto parse_args)
if "%~1"=="--force-restart" (set "FORCE_RESTART=1"  & shift & goto parse_args)
set "LAUNCHER_ARGS=!LAUNCHER_ARGS! %~1"
shift
goto parse_args

:print_help
echo Usage: start.cmd [OPTIONS]
echo.
echo Bootstrap and launch PingHub in the background.
echo.
echo OPTIONS
echo   --port N           override port (default 3000; auto-falls-back if taken)
echo   --data-dir PATH    override PINGHUB_DATA_DIR
echo   --no-open          start the server without opening the browser
echo   --build            wipe .next and rebuild (keeps node_modules)
echo   --reinstall        wipe node_modules + .next before bootstrapping
echo   --bundled-node     force download of Node 20.18.0 (skip system Node)
echo   --skip-update      skip the git fetch update check
echo   --force-restart    if another instance is running, kill it without prompting
echo   -h, --help         show this help and exit
echo.
echo RELATED
echo   stop.cmd     stop the running server
echo   status.cmd   show whether the server is currently running
exit /b 0

:parse_done

REM ── Already running? Offer to stop running instances and continue. ──
set "TRACKED_PID="
if exist "%PID_FILE%" (
  set /p TRACKED_PID=<"%PID_FILE%"
  tasklist /FI "PID eq !TRACKED_PID!" 2>nul | findstr /C:"!TRACKED_PID!" >nul
  if errorlevel 1 (
    echo %LOG% stale PID file ^(PID !TRACKED_PID! not running^); cleaning up
    del "%PID_FILE%" 2>nul
    set "TRACKED_PID="
  )
)

REM Broad scan: every Ping AIC Studio standalone server on this machine,
REM regardless of which checkout it was launched from. Sibling clones are
REM caught too — the user is asked before anything is killed.
set "PID_LIST_FILE=%TEMP%\pinghub-pids-%RANDOM%.txt"
call :list_standalone_pids "%PID_LIST_FILE%"
set "ALL_PIDS="
if exist "%PID_LIST_FILE%" (
  for /f "usebackq delims=" %%p in ("%PID_LIST_FILE%") do set "ALL_PIDS=!ALL_PIDS! %%p"
  del "%PID_LIST_FILE%" 2>nul
)

set "ANYTHING="
if defined TRACKED_PID set "ANYTHING=1"
if defined ALL_PIDS    set "ANYTHING=1"

if defined ANYTHING (
  echo %LOG% Ping AIC Studio is already running:
  if defined TRACKED_PID (
    echo %LOG%   tracked PID: !TRACKED_PID!
    echo %LOG%     log:       %LOG_FILE%
  )
  if defined ALL_PIDS (
    echo %LOG%   standalone PID^(s^):!ALL_PIDS!
  )

  set "DO_KILL=0"
  if "%FORCE_RESTART%"=="1" (
    echo %LOG% --force-restart: stopping running instance^(s^)
    set "DO_KILL=1"
  ) else (
    set "REPLY="
    set /p "REPLY=%LOG% Stop them and start a new one? [Y/n] "
    if not defined REPLY   set "DO_KILL=1"
    if /i "!REPLY!"=="y"   set "DO_KILL=1"
    if /i "!REPLY!"=="yes" set "DO_KILL=1"
  )

  if "!DO_KILL!"=="0" (
    echo %LOG% leaving running instance^(s^) alone; exiting
    exit /b 0
  )

  REM Kill the tracked PID first (graceful), then any standalone
  REM children still around.
  if defined TRACKED_PID (
    echo %LOG% stopping tracked PID !TRACKED_PID!
    taskkill /PID !TRACKED_PID! >nul 2>&1
    ping -n 2 127.0.0.1 >nul
    taskkill /F /PID !TRACKED_PID! >nul 2>&1
  )
  call :kill_orphan_standalone
  if exist "%PID_FILE%" del "%PID_FILE%" 2>nul
  set "ANYTHING="
)
set "TRACKED_PID="
set "ALL_PIDS="
set "REPLY="
set "DO_KILL="

echo %LOG% detected: windows-x64

REM ── Optional --reinstall / --build ───────────────────────────────
if "%REINSTALL%"=="1" (
  echo %LOG% --reinstall: wiping node_modules and .next
  if exist "%APP_DIR%\node_modules" rmdir /s /q "%APP_DIR%\node_modules" 2>nul
  if exist "%APP_DIR%\.next"        rmdir /s /q "%APP_DIR%\.next"        2>nul
) else if "%REBUILD%"=="1" (
  echo %LOG% --build: wiping .next
  if exist "%APP_DIR%\.next"        rmdir /s /q "%APP_DIR%\.next"        2>nul
)

REM ── Ensure Node 20+ ───────────────────────────────────────────────
set "NODE_PIN_VERSION=20.18.0"
set "LOCAL_NODE_DIR=%APP_DIR%\.pinghub-node"
set "LOCAL_NODE_BIN=%LOCAL_NODE_DIR%\node.exe"
set "NODE_EXE="

if exist "%LOCAL_NODE_BIN%" (
  for /f "tokens=*" %%v in ('"%LOCAL_NODE_BIN%" -v 2^>nul') do set "NV=%%v"
  if defined NV (
    set "NV=!NV:v=!"
    for /f "tokens=1 delims=." %%m in ("!NV!") do set "NMAJ=%%m"
    if !NMAJ! GEQ 20 (
      set "NODE_EXE=%LOCAL_NODE_BIN%"
      echo %LOG% using bundled Node v!NV!
    )
  )
)

if not defined NODE_EXE (
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
  echo %LOG% Node 20+ not found. Downloading Node !NODE_PIN_VERSION!...
  set "TMP_DIR=%TEMP%\pinghub-node-%RANDOM%"
  mkdir "!TMP_DIR!" 2>nul
  set "ASSET=node-v%NODE_PIN_VERSION%-win-x64.zip"
  set "URL=https://nodejs.org/dist/v%NODE_PIN_VERSION%/!ASSET!"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri '!URL!' -OutFile '!TMP_DIR!\node.zip'" || (
    echo %LOG% ERROR: download failed. Install Node 20+ manually from https://nodejs.org
    exit /b 2
  )
  powershell -NoProfile -Command "Expand-Archive -Path '!TMP_DIR!\node.zip' -DestinationPath '!TMP_DIR!' -Force" || (
    echo %LOG% ERROR: failed to extract Node archive
    exit /b 2
  )
  if exist "%LOCAL_NODE_DIR%" rmdir /s /q "%LOCAL_NODE_DIR%"
  move "!TMP_DIR!\node-v%NODE_PIN_VERSION%-win-x64" "%LOCAL_NODE_DIR%" >nul
  rmdir /s /q "!TMP_DIR!" 2>nul
  if not exist "%LOCAL_NODE_BIN%" (
    echo %LOG% ERROR: Node binary not found at %LOCAL_NODE_BIN% after extraction
    exit /b 2
  )
  set "NODE_EXE=%LOCAL_NODE_BIN%"
  for /f "tokens=*" %%v in ('"%LOCAL_NODE_BIN%" -v') do echo %LOG% downloaded Node %%v
)

set "NODE_DIR="
for %%i in ("%NODE_EXE%") do set "NODE_DIR=%%~dpi"
set "PATH=%NODE_DIR%;%PATH%"

REM ── Check for updates (offer to pull) ─────────────────────────────
if "%SKIP_UPDATE%"=="0" (
  pushd "%REPO_ROOT%"
  git rev-parse --is-inside-work-tree >nul 2>&1
  if !errorlevel! EQU 0 (
    echo %LOG% checking for updates...
    git fetch --quiet origin >nul 2>&1
    if !errorlevel! EQU 0 (
      set "AHEAD=0"
      for /f %%a in ('git rev-list --count HEAD..@{u} 2^>nul') do set "AHEAD=%%a"
      if !AHEAD! GTR 0 (
        echo %LOG% !AHEAD! update^(s^) available
        set /p "REPLY=%LOG% Pull and rebuild now? [Y/n] "
        if /i "!REPLY!"=="n"    set "DO_PULL=0"
        if /i "!REPLY!"=="no"   set "DO_PULL=0"
        if not defined DO_PULL  set "DO_PULL=1"
        if "!DO_PULL!"=="1" (
          echo %LOG% pulling latest...
          git pull --ff-only --quiet
          if !errorlevel! EQU 0 (
            echo %LOG% pulled - marking build dir for rebuild
            if exist "%APP_DIR%\.next" rmdir /s /q "%APP_DIR%\.next" 2>nul
          ) else (
            echo %LOG% ERROR: git pull failed - resolve manually then re-run
            popd
            exit /b 5
          )
        )
      ) else (
        echo %LOG% up to date
      )
    ) else (
      echo %LOG% ^(could not reach origin - skipping update check^)
    )
  )
  popd
)

REM ── npm install ───────────────────────────────────────────────────
pushd "%APP_DIR%"

set "DEPS_STALE=0"
if not exist "node_modules" set "DEPS_STALE=1"
if not exist "node_modules\.package-lock.json" set "DEPS_STALE=1"

if "%DEPS_STALE%"=="1" (
  echo %LOG% installing dependencies ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo %LOG% ERROR: npm install failed
    popd
    exit /b 3
  )
) else (
  echo %LOG% dependencies up to date
)

REM ── Build ─────────────────────────────────────────────────────────
REM Decide whether the existing .next is stale. We compute a SHA-256
REM fingerprint of every build-affecting input (src, configs, package.json,
REM Node major version, etc.) and compare it to the fingerprint stored
REM next to the build. Any mismatch — git pull, branch switch, manual edit,
REM dep bump, Node upgrade — wipes .next and rebuilds.
set "FP_FILE=.next\.build-fingerprint"
set "FP_SCRIPT=%APP_DIR%\scripts\build-fingerprint.mjs"
set "NEED_BUILD=0"

if not exist ".next\standalone\server.js" (
  echo %LOG% no existing build - will build
  set "NEED_BUILD=1"
) else if not exist "%FP_SCRIPT%" (
  echo %LOG% build present ^(fingerprint script missing; skipping staleness check^)
) else (
  set "WANT_FP="
  for /f "delims=" %%h in ('""%NODE_EXE%" "%FP_SCRIPT%" 2^>nul"') do set "WANT_FP=%%h"
  set "HAVE_FP="
  if exist "%FP_FILE%" set /p HAVE_FP=<"%FP_FILE%"
  if not defined WANT_FP (
    echo %LOG% build present ^(could not compute fingerprint; skipping staleness check^)
  ) else if "!WANT_FP!"=="!HAVE_FP!" (
    echo %LOG% build up to date ^(fingerprint matches^)
  ) else (
    echo %LOG% source changed since last build - wiping .next
    if exist ".next" rmdir /s /q ".next" 2>nul
    if exist ".next" (
      echo %LOG% .next locked - killing orphan standalone server and retrying wipe
      call :kill_orphan_standalone
      if exist ".next" rmdir /s /q ".next"
    )
    set "NEED_BUILD=1"
  )
)

if "!NEED_BUILD!"=="1" (
  call :build_with_recovery
  if errorlevel 1 (
    echo %LOG% ERROR: build failed - see output above
    popd
    exit /b 4
  )
  REM Record the fingerprint of the inputs that produced this build.
  if exist "%FP_SCRIPT%" (
    set "WANT_FP="
    for /f "delims=" %%h in ('""%NODE_EXE%" "%FP_SCRIPT%" 2^>nul"') do set "WANT_FP=%%h"
    if defined WANT_FP (
      if not exist ".next" mkdir ".next"
      >"%FP_FILE%" echo !WANT_FP!
    )
  )
)

popd

REM ── Launch in background ──────────────────────────────────────────
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo. >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"
echo  Ping AIC Studio start at %DATE% %TIME% >> "%LOG_FILE%"
echo  node: %NODE_EXE% >> "%LOG_FILE%"
echo  cwd: %APP_DIR% >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

echo %LOG% launching in background...
pushd "%APP_DIR%"

REM Use PowerShell to spawn detached and write PID to file. We avoid
REM capturing PowerShell stdout with `for /f` because Start-Process with
REM -RedirectStandard* keeps the host alive until the child exits, which
REM hangs cmd's pipe reader. Writing the PID to a file and reading it back
REM dodges that.
del "%PID_FILE%" 2>nul
powershell -NoProfile -Command "$p = Start-Process -FilePath '%NODE_EXE%' -ArgumentList 'launcher\launcher.mjs%LAUNCHER_ARGS%' -RedirectStandardOutput '%LOG_FILE%.out' -RedirectStandardError '%LOG_FILE%.err' -WindowStyle Hidden -PassThru; Set-Content -Path '%PID_FILE%' -Value $p.Id -Encoding ASCII; exit 0"
popd

set "SERVER_PID="
if exist "%PID_FILE%" set /p SERVER_PID=<"%PID_FILE%"
if not defined SERVER_PID (
  echo %LOG% ERROR: failed to launch Ping AIC Studio ^(no PID written^)
  exit /b 5
)

REM Wait briefly, then verify it's still running
ping -n 4 127.0.0.1 >nul
tasklist /FI "PID eq %SERVER_PID%" 2>nul | findstr /C:"%SERVER_PID%" >nul
if errorlevel 1 (
  echo %LOG% ERROR: Ping AIC Studio failed to start. Last lines of log:
  echo ----------------------------------------------------------------
  if exist "%LOG_FILE%.err" type "%LOG_FILE%.err"
  if exist "%LOG_FILE%.out" type "%LOG_FILE%.out"
  echo ----------------------------------------------------------------
  del "%PID_FILE%" 2>nul
  exit /b 5
)

echo %LOG% Ping AIC Studio started successfully ^(PID %SERVER_PID%^)
echo %LOG%   log:  %LOG_FILE%.out
echo %LOG%   stop: stop.cmd
exit /b 0

REM ── build_with_recovery ──────────────────────────────────────────
REM Run `npm run build` with tiered auto-recovery:
REM   1. plain build
REM   2. on failure, classify the error from the captured log:
REM      - "Cannot find module" / "Can't resolve"  -> npm install + retry
REM      - "EBUSY" / "ETXTBSY" / "EPERM"           -> kill orphans + wipe + retry
REM      - anything else                            -> kill orphans + wipe + retry
REM   3. on second failure, full reinstall (rm node_modules + .next), retry
REM   4. final failure returns errorlevel 1
:build_with_recovery
set "BUILD_LOG=%TEMP%\pinghub-build-%RANDOM%.log"
echo %LOG% building app ^(npm run build^)...
call npm run build > "%BUILD_LOG%" 2>&1
set "BUILD_RC=!errorlevel!"
type "%BUILD_LOG%"
if "!BUILD_RC!"=="0" (
  del "%BUILD_LOG%" 2>nul
  exit /b 0
)

set "RECOVERY="
findstr /C:"Can't resolve" /C:"Cannot find module" /C:"ERR_MODULE_NOT_FOUND" /C:"MODULE_NOT_FOUND" "%BUILD_LOG%" >nul 2>&1
if not errorlevel 1 set "RECOVERY=missing-dep"
if not defined RECOVERY (
  findstr /C:"EBUSY" /C:"ETXTBSY" /C:"EPERM" "%BUILD_LOG%" >nul 2>&1
  if not errorlevel 1 set "RECOVERY=file-lock"
)
if not defined RECOVERY set "RECOVERY=unknown"

if "!RECOVERY!"=="missing-dep" (
  echo %LOG% build failed: missing dependency detected - reinstalling and retrying
  call npm install
  if errorlevel 1 (
    echo %LOG% ERROR: npm install failed during recovery
    del "%BUILD_LOG%" 2>nul
    exit /b 1
  )
) else if "!RECOVERY!"=="file-lock" (
  echo %LOG% build failed: file lock detected - killing orphans and retrying
  call :kill_orphan_standalone
  if exist ".next" rmdir /s /q ".next" 2>nul
) else (
  echo %LOG% build failed - attempting auto-recovery ^(kill orphans + wipe + retry^)
  call :kill_orphan_standalone
  if exist ".next" rmdir /s /q ".next" 2>nul
)

echo %LOG% retrying build...
call npm run build > "%BUILD_LOG%" 2>&1
set "BUILD_RC=!errorlevel!"
type "%BUILD_LOG%"
if "!BUILD_RC!"=="0" (
  del "%BUILD_LOG%" 2>nul
  exit /b 0
)

echo %LOG% build still failing - full reinstall ^(node_modules + .next^) and final retry
call :kill_orphan_standalone
if exist "node_modules" rmdir /s /q "node_modules" 2>nul
if exist ".next"        rmdir /s /q ".next"        2>nul
call npm install
if errorlevel 1 (
  echo %LOG% ERROR: npm install failed during full reinstall
  del "%BUILD_LOG%" 2>nul
  exit /b 1
)

call npm run build > "%BUILD_LOG%" 2>&1
set "BUILD_RC=!errorlevel!"
type "%BUILD_LOG%"
if "!BUILD_RC!"=="0" (
  del "%BUILD_LOG%" 2>nul
  exit /b 0
)

del "%BUILD_LOG%" 2>nul
exit /b 1

REM ── list_standalone_pids ─────────────────────────────────────────
REM Write the PIDs of every node.exe running a .next\standalone\server.js
REM (any checkout, any path separator) to the file given as %1, one per
REM line. Empty file if none.
:list_standalone_pids
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('standalone\server.js') -or $_.CommandLine.Contains('standalone/server.js')) }; foreach ($p in $procs) { $p.ProcessId }" > "%~1" 2>nul
exit /b 0

REM ── kill_orphan_standalone ───────────────────────────────────────
REM Force-kill every node.exe running any .next\standalone\server.js
REM on this machine. Used as auto-recovery when file locks block the
REM build (EBUSY) and after the user opts in to restarting.
:kill_orphan_standalone
powershell -NoProfile -Command "$procs = Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" | Where-Object { $_.CommandLine -and ($_.CommandLine.Contains('standalone\server.js') -or $_.CommandLine.Contains('standalone/server.js')) }; foreach ($p in $procs) { Write-Host ('[Ping AIC Studio] killing standalone PID ' + $p.ProcessId); try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }"
if exist "%PID_FILE%" del "%PID_FILE%" 2>nul
REM Give the OS a moment to release file handles
ping -n 2 127.0.0.1 >nul
exit /b 0
