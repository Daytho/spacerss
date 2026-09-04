@echo off
title SpaceRSS

REM Run from the folder this script lives in, regardless of where it was
REM launched from. This is the whole point of the script: npm looks for
REM package.json in the current folder and upward, so a double-click from
REM anywhere else would fail with a confusing "Could not read package.json".
cd /d "%~dp0"

echo.
echo   SpaceRSS
echo   ========
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js does not appear to be installed.
  echo.
  echo   Install the LTS version from https://nodejs.org
  echo   then close this window and double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   First run - installing dependencies. This takes about a minute.
  echo.
  call npm ci --ignore-scripts
  if errorlevel 1 (
    echo.
    echo   Dependency install failed. The messages above say why.
    echo.
    pause
    exit /b 1
  )
  echo.
)

REM Match whatever port the server will actually use, so an overridden PORT
REM does not send the browser to the wrong address.
if "%PORT%"=="" set "PORT=4000"

echo   Starting SpaceRSS. Your browser will open in a few seconds.
echo   If it does not, go to http://localhost:%PORT%
echo.
echo   Leave this window open while you use it.
echo   Close this window, or press Ctrl+C, to stop.
echo.

REM Open the browser slightly behind the server so the first request does not
REM land before it is listening. Runs detached so it does not block startup.
start "" /b powershell -NoProfile -Command "Start-Sleep 4; Start-Process 'http://localhost:%PORT%'"

call npm start

echo.
echo   SpaceRSS has stopped.
echo.
pause
