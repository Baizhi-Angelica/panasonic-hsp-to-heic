@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0"
set "PY="
set "PYARGS="

if exist "%ROOT%_tool\python\python.exe" (
  set "PY=%ROOT%_tool\python\python.exe"
  goto run
)

py -3 --version >nul 2>nul
if not errorlevel 1 (
  set "PY=py"
  set "PYARGS=-3"
  goto run
)

python --version >nul 2>nul
if not errorlevel 1 (
  set "PY=python"
  goto run
)

echo [ERROR] Python 3.8+ was not found.
echo.
echo   Install it from https://www.python.org/downloads/
echo   or put a portable runtime at: %ROOT%_tool\python\python.exe
echo.
pause
exit /b 1

:run
set "PYTHONIOENCODING=utf-8"
"%PY%" %PYARGS% "%ROOT%hsp2heic.py" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [OK] Finished.
) else (
  echo [FAILED] Exit code %RC%
)
pause
exit /b %RC%
