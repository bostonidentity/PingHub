@echo off
REM PingHub updater (Windows).
REM
REM Args:
REM   %1 = install dir (the dist root containing app/, launcher/, start.cmd, version.json)
REM   %2 = path to the downloaded release archive (.zip)
REM   %3 = PID of the old server process to wait for
REM   %4 = port to relaunch on
REM
REM This script is copied to %TEMP% before execution so the install dir
REM can be moved out from under it without locking.

setlocal enabledelayedexpansion

set "INSTALL=%~1"
set "NEWZIP=%~2"
set "OLDPID=%~3"
set "PORT=%~4"

if "%INSTALL%"=="" ( echo [updater] missing install dir arg & exit /b 10 )
if "%NEWZIP%"=="" ( echo [updater] missing zip arg & exit /b 11 )
if "%OLDPID%"=="" ( echo [updater] missing pid arg & exit /b 12 )
if "%PORT%"=="" set "PORT=3000"

set "LOG=%TEMP%\pinghub-updater-%RANDOM%.log"
echo [updater] %DATE% %TIME% > "%LOG%"
echo [updater] install=%INSTALL% > "%LOG%"
echo [updater] zip=%NEWZIP% >> "%LOG%"
echo [updater] oldpid=%OLDPID% port=%PORT% >> "%LOG%"

REM 1. Wait for the old server to exit (up to ~60s), then force-kill.
echo [updater] waiting for PID %OLDPID% to exit >> "%LOG%"
for /l %%i in (1,1,60) do (
  tasklist /FI "PID eq %OLDPID%" 2>nul | findstr /C:"%OLDPID%" >nul
  if errorlevel 1 goto :exited
  ping -n 2 127.0.0.1 >nul
)
echo [updater] PID %OLDPID% still running after 60s; force-killing >> "%LOG%"
taskkill /F /PID %OLDPID% >nul 2>&1

:exited
echo [updater] PID released; giving OS 3s to release file handles >> "%LOG%"
ping -n 4 127.0.0.1 >nul

REM 2. Extract the new archive to a sibling stage dir.
for %%i in ("%INSTALL%") do set "PARENT=%%~dpi"
if "%PARENT:~-1%"=="\" set "PARENT=%PARENT:~0,-1%"
set "STAGE=%PARENT%\.pinghub-stage-%RANDOM%"
echo [updater] extracting to %STAGE% >> "%LOG%"
mkdir "%STAGE%" 2>nul
powershell -NoProfile -Command "Expand-Archive -Path '%NEWZIP%' -DestinationPath '%STAGE%' -Force" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [updater] ERROR: extract failed >> "%LOG%"
  goto :fail
)

REM The zip contains exactly one top-level folder.
set "NEWDIR="
for /d %%d in ("%STAGE%\*") do set "NEWDIR=%%d"
if not defined NEWDIR (
  echo [updater] ERROR: no top-level dir found in stage >> "%LOG%"
  goto :fail
)
echo [updater] new dir: %NEWDIR% >> "%LOG%"

REM 3. Move old install aside, then move new in place.
set "BACKUP=%INSTALL%.bak-%RANDOM%"
echo [updater] %INSTALL% -^> %BACKUP% >> "%LOG%"
move "%INSTALL%" "%BACKUP%" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [updater] ERROR: move-aside failed >> "%LOG%"
  goto :fail
)

echo [updater] %NEWDIR% -^> %INSTALL% >> "%LOG%"
move "%NEWDIR%" "%INSTALL%" >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [updater] ERROR: move-in failed; rolling back >> "%LOG%"
  move "%BACKUP%" "%INSTALL%" >> "%LOG%" 2>&1
  goto :fail
)
rmdir /s /q "%STAGE%" 2>nul

REM 4. Relaunch.
echo [updater] launching %INSTALL%\start.cmd --port %PORT% --no-open >> "%LOG%"
cd /d "%INSTALL%"
start "" /b cmd /c ""%INSTALL%\start.cmd" --port %PORT% --no-open >> "%LOG%" 2>&1"
echo [updater] OK (backup at %BACKUP%) >> "%LOG%"
exit /b 0

:fail
echo [updater] FAILED — log: %LOG%
exit /b 1
