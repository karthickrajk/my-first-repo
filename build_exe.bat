@echo off
rem Builds dist\DriveReady.exe (run on Windows with Python 3.9+ installed).
python -m pip install -r requirements.txt || exit /b 1
python -m PyInstaller --noconfirm --onefile --windowed --name DriveReady ^
  --add-data "index.html;." --add-data "main.js;." --add-data "vendor;vendor" app.py || exit /b 1
echo.
echo Done: dist\DriveReady.exe
