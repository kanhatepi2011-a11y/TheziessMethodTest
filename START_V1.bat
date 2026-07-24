@echo off
title HQ Video Compressor V15 - Fast Purple
cd /d "%~dp0"

echo.
echo ==================================================
echo   HQ Video Compressor V15 - Fast Purple Edition
echo ==================================================
echo.
echo Installing/updating required packages...
python -m pip install --upgrade -r requirements.txt
if errorlevel 1 (
    echo.
    echo Installation failed. Check Python and internet connection.
    pause
    exit /b 1
)

echo.
echo Starting V15 at http://localhost:8015
echo Fast mode reads only MP4 head/tail byte ranges whenever possible.
echo Repeated checks of the same URL are cached for 10 minutes.
echo.
start "" "http://localhost:8015"
python server.py

pause
