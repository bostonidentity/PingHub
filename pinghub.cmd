@echo off
REM pinghub.cmd — Windows entry. Detects Node, installs deps, builds, launches.
REM Each step is check-then-do; safe to re-run.

setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "APP_DIR=%REPO_ROOT%\aic-pipeline"
set "LOG=[pinghub]"

if not exist "%APP_DIR%" (
  echo %LOG% ERROR: expected aic-pipeline directory at %APP_DIR%
  exit /b 1
)

REM ── Parse flags ───────────────────────────────────────────────────
set "BUNDLED_NODE=0"
set "SKIP_UPDATE=0"
set "REINSTALL=0"
set "LAUNCHER_ARGS="
:parse_args
if "%~1"=="" goto parse_done
if "%~1"=="--bundled-node" (set "BUNDLED_NODE=1" & shift & goto parse_args)
if "%~1"=="--skip-update"  (set "SKIP_UPDATE=1"  & shift & goto parse_args)
if "%~1"=="--reinstall"    (set "REINSTALL=1"    & shift & goto parse_args)
set "LAUNCHER_ARGS=!LAUNCHER_ARGS! %~1"
shift
goto parse_args
:parse_done

REM ── 1. OS detect ──────────────────────────────────────────────────
echo %LOG% detected: windows-x64

REM ── Optional --reinstall ──────────────────────────────────────────
if "%REINSTALL%"=="1" (
  echo %LOG% --reinstall: wiping node_modules and .next
  if exist "%APP_DIR%\node_modules" rmdir /s /q "%APP_DIR%\node_modules"
  if exist "%APP_DIR%\.next"        rmdir /s /q "%APP_DIR%\.next"
)

REM ── 2. Ensure Node 20+ ────────────────────────────────────────────
set "NODE_PIN_VERSION=20.18.0"
set "LOCAL_NODE_DIR=%APP_DIR%\.pinghub-node"
set "LOCAL_NODE_BIN=%LOCAL_NODE_DIR%\node.exe"

set "NODE_EXE="

REM Priority 1: bundled
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

REM Priority 2: system Node
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

REM Priority 3: download
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

REM ── 3. npm install ────────────────────────────────────────────────
pushd "%APP_DIR%"

set "DEPS_STALE=0"
if not exist "node_modules" set "DEPS_STALE=1"
if not exist "node_modules\.package-lock.json" set "DEPS_STALE=1"

if "%DEPS_STALE%"=="1" (
  echo %LOG% installing dependencies (npm install)...
  call npm install
  if errorlevel 1 (
    echo %LOG% ERROR: npm install failed
    popd
    exit /b 3
  )
) else (
  echo %LOG% dependencies up to date
)

REM ── 4. Build ──────────────────────────────────────────────────────
if not exist ".next\standalone\server.js" (
  echo %LOG% building app (npm run build)...
  call npm run build
  if errorlevel 1 (
    echo %LOG% ERROR: build failed
    popd
    exit /b 4
  )
) else (
  echo %LOG% build present
)

popd

REM ── 5. Check for updates ──────────────────────────────────────────
if "%SKIP_UPDATE%"=="0" (
  pushd "%REPO_ROOT%"
  git rev-parse --is-inside-work-tree >nul 2>&1
  if !errorlevel! EQU 0 (
    echo %LOG% checking for updates...
    git fetch --quiet origin >nul 2>&1
    if !errorlevel! EQU 0 (
      for /f %%a in ('git rev-list --count HEAD..@{u} 2^>nul') do set "AHEAD=%%a"
      if defined AHEAD (
        if !AHEAD! GTR 0 (
          echo %LOG% !AHEAD! update^(s^) available
          echo %LOG%   Run 'git pull' to update, then re-run pinghub
          set /p "ANS=%LOG% Continue without updating? [Y/n] "
          if /i "!ANS!"=="n" (
            echo %LOG% aborted by user
            popd
            exit /b 5
          )
        ) else (
          echo %LOG% up to date
        )
      )
    )
  )
  popd
)

REM ── 6. Launch ─────────────────────────────────────────────────────
pushd "%APP_DIR%"
echo %LOG% launching...
"%NODE_EXE%" launcher\launcher.mjs %LAUNCHER_ARGS%
set "EXIT_CODE=!errorlevel!"
popd
exit /b %EXIT_CODE%
