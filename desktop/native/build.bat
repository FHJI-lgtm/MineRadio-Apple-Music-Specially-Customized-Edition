@echo off
rem ============================================================
rem Build MineRadioAudioCapture.exe (native process-loopback helper)
rem Reference: microsoft/Windows-classic-samples ApplicationLoopback
rem Toolchain: w64devkit (self-contained mingw-w64) or any g++/cl.
rem The SDK's audioclientactivationparams.h is NOT required: the
rem source carries self-contained fallbacks for the process-loopback
rem types and loads ActivateAudioInterfaceAsync via GetProcAddress.
rem ============================================================
setlocal
cd /d "%~dp0"

set "GXX="
rem 工具链定位: 1) 环境变量覆盖 2) 常见 w64devkit 安装位置 3) PATH 中的 g++
if defined W64DEVKIT_GXX set "GXX=%W64DEVKIT_GXX%"
if not defined GXX if exist "C:\w64devkit\w64devkit\bin\g++.exe" set "GXX=C:\w64devkit\w64devkit\bin\g++.exe"
if not defined GXX for /f "delims=" %%i in ('where g++ 2^>nul') do set "GXX=%%i"

if defined GXX (
  "%GXX%" -O2 -static -municode -o MineRadioAudioCapture.exe MineRadioAudioCapture.cpp -lole32 -luuid
  if %errorlevel%==0 (
    echo [build] OK: MineRadioAudioCapture.exe
    exit /b 0
  )
  echo [build] g++ failed
  exit /b 1
)

where cl >nul 2>nul
if %errorlevel%==0 (
  cl /nologo /O2 /EHsc MineRadioAudioCapture.cpp /Fe:MineRadioAudioCapture.exe /link ole32.lib
  if %errorlevel%==0 (
    echo [build] MSVC OK: MineRadioAudioCapture.exe
    exit /b 0
  )
)

echo [build] No C++ compiler found. Install MinGW-w64:  winget install -e --id niXman.Mingw-w64.GCC
exit /b 1
