@echo off
setlocal
title OPC UA Monitor - Build/Run Helper
color 0A

:menu
cls
echo ==========================================================
echo   OPC UA DIAGNOSTIC MONITOR  -  Build / Run Helper
echo ==========================================================
echo.
echo   [1] Run in DEV mode        (npm start)
echo   [2] Install/update deps    (npm install)
echo   [3] Build Windows EXE      (npm run build-win)
echo   [4] Clean build folder     (deletes dist\)
echo   [5] Open dist folder
echo   [0] Exit
echo.
echo ==========================================================
set /p choice="Choose an option (0-5): "

if "%choice%"=="1" goto dev
if "%choice%"=="2" goto install
if "%choice%"=="3" goto build
if "%choice%"=="4" goto clean
if "%choice%"=="5" goto opendist
if "%choice%"=="0" goto end
goto menu

:dev
cls
echo ----------------------------------------------------------
echo Starting OPC UA Monitor in DEV mode...
echo (Close this window or press Ctrl+C to stop)
echo ----------------------------------------------------------
call npm start
echo.
pause
goto menu

:install
cls
echo ----------------------------------------------------------
echo Installing / updating dependencies...
echo ----------------------------------------------------------
call npm install
echo.
echo Done.
pause
goto menu

:build
cls
echo ----------------------------------------------------------
echo Building Windows installer (.exe)...
echo This produces an NSIS installer in the "dist" folder.
echo ----------------------------------------------------------
call npm run build-win
if errorlevel 1 (
    echo.
    echo ************************************************************
    echo  BUILD FAILED. Common fixes:
    echo   - Run option [2] Install/update deps first
    echo   - Make sure no antivirus is blocking electron-builder
    echo   - Close any running instance of the app before building
    echo ************************************************************
) else (
    echo.
    echo ============================================================
    echo  BUILD SUCCESSFUL!
    echo  Installer is in the "dist" folder (look for *.exe)
    echo ============================================================
)
echo.
pause
goto menu

:clean
cls
echo ----------------------------------------------------------
echo Cleaning dist folder...
echo ----------------------------------------------------------
if exist dist (
    rmdir /s /q dist
    echo Deleted dist folder.
) else (
    echo No dist folder found - nothing to clean.
)
echo.
pause
goto menu

:opendist
if exist dist (
    start explorer dist
) else (
    echo No dist folder yet. Build the app first (option 3).
    pause
)
goto menu

:end
echo Goodbye!
endlocal
exit /b 0
