@echo off
rem ============================================================
rem Build MineRadioCoverResolver.exe (Apple Music local artwork resolver)
rem   - read-only one-shot CLI; no runtime dependency beyond system DLLs
rem   - vendored SQLite amalgamation: vendor\sqlite\sqlite3.c
rem Toolchain: w64devkit (self-contained mingw-w64) or any g++/gcc.
rem ============================================================
setlocal
cd /d "%~dp0"

set "GXX="
set "GCC="
if defined W64DEVKIT_GXX set "GXX=%W64DEVKIT_GXX%"
if not defined GXX if exist "C:\w64devkit\w64devkit\bin\g++.exe" set "GXX=C:\w64devkit\w64devkit\bin\g++.exe"
if not defined GXX for /f "delims=" %%i in ('where g++ 2^>nul') do set "GXX=%%i"
if defined GXX for %%d in ("%GXX%") do set "GCC=%%~dpdgcc.exe"
if not defined GCC for /f "delims=" %%i in ('where gcc 2^>nul') do set "GCC=%%i"

rem w64devkit gcc/g++ need as.exe/ld.exe from the same bin directory on PATH
if defined GXX for %%d in ("%GXX%") do set "PATH=%%~dpd;%PATH%"
if defined GCC for %%d in ("%GCC%") do set "PATH=%%~dpd;%PATH%"

if not defined GXX goto noc

set "SQLITE_FLAGS=-DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_OMIT_DEPRECATED -DSQLITE_DQS=0"

echo [build] gcc:  %GCC%
echo [build] g++:  %GXX%
echo [build] compiling vendored sqlite3.c (this takes a while)...
"%GCC%" -O2 -c vendor\sqlite\sqlite3.c -o sqlite3.o %SQLITE_FLAGS%
if not %errorlevel%==0 (
  echo [build] sqlite3.c compile FAILED
  exit /b 1
)

echo [build] compiling MineRadioCoverResolver.cpp...
"%GXX%" -O2 -std=c++17 -static -Ivendor\sqlite -o MineRadioCoverResolver.exe MineRadioCoverResolver.cpp sqlite3.o -lbcrypt -lshell32
if not %errorlevel%==0 (
  echo [build] link FAILED
  exit /b 1
)

del /q sqlite3.o 2>nul
echo [build] OK: MineRadioCoverResolver.exe
exit /b 0

:noc
echo [build] No C++ compiler found. Install w64devkit or MinGW-w64 (winget install -e --id niXman.Mingw-w64.GCC)
exit /b 1
