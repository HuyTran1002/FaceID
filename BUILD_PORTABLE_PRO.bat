@echo off
color 0B
echo =======================================================
echo FACEID SECURITY - PRO PACKAGER TOOL (ONE-FILE PORTABLE)
echo =======================================================
echo.
echo [1/3] Don dep rác (dist, build, python_core)...
if exist dist rmdir /s /q dist
if exist build rmdir /s /q build
if exist python_core rmdir /s /q python_core

echo.
echo [2/3] Khoi dong PyInstaller, compile Python Core 3D...
call .venv\Scripts\pyinstaller --noconfirm --onedir --console --clean ^
  --name "face_logic" ^
  --hidden-import "face_recognition" ^
  --hidden-import "mediapipe" ^
  --collect-data "face_recognition_models" ^
  --collect-all "mediapipe" ^
  --distpath "python_core" ^
  face_logic.py

echo.
echo [3/3] Dong goi he sinh thai Node.js thanh Portable .EXE...
call npm run build

echo.
echo =======================================================
echo HOAN TAT! TEP PORTABLE DANG CHO TRONG THU MUC "dist\"
echo (Chi viec copy thu muc nay va xai moi luc moi noi)
echo =======================================================
pause
