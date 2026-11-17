@echo off
rem Builds dist\DriveReady.exe (run on Windows with Python 3.9+ installed).
python -m pip install -r requirements.txt || exit /b 1
python -m PyInstaller --noconfirm --onefile --windowed --name DriveReady ^
  --add-data "index.html;." --add-data "main.js;." --add-data "lang-ta.js;." --add-data "instructor.html;." --add-data "vendor;vendor" --collect-all sdl2dll app.py || exit /b 1
echo.
echo Done: dist\DriveReady.exe
