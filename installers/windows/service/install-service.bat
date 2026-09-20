@echo off
REM Register Fenrir as a Windows service via NSSM.
REM
REM Called from Inno Setup's [Run] section. Arguments:
REM   %1 = install dir (e.g. C:\Program Files\Fenrir)
REM   %2 = data dir   (e.g. C:\ProgramData\Fenrir)
REM   %3 = port       (e.g. 8000)
REM
REM If the service already exists (re-install / upgrade), remove and
REM re-create it so config changes from this build apply.

setlocal

set "INSTALL_DIR=%~1"
set "DATA_ROOT=%~2"
set "PORT=%~3"

set "NSSM=%INSTALL_DIR%\bin\nssm.exe"
set "PYTHON=%INSTALL_DIR%\python\python.exe"
set "APP_DIR=%INSTALL_DIR%\app"
set "BIN_DIR=%INSTALL_DIR%\bin"
set "DATA_DIR=%DATA_ROOT%\data"
set "LOG_DIR=%DATA_ROOT%\logs"

REM Stop and remove any previous registration. Errors are non-fatal —
REM "service not found" returns non-zero and we want to proceed.
"%NSSM%" stop Fenrir 2>nul
"%NSSM%" remove Fenrir confirm 2>nul

REM Register the service. NSSM wraps uvicorn so Windows treats it as a
REM proper service (autostart, recovery, supervised restart).
REM --loop asyncio required: uvloop can truncate VP FTP uploads (#1896).
REM --timeout-graceful-shutdown required: uvicorn otherwise waits forever for
REM in-flight requests, and an MJPEG camera stream is a response that never
REM completes — one open camera tile hangs the stop until NSSM force-kills,
REM skipping the WAL checkpoint and the MQTT / virtual-printer teardown.
"%NSSM%" install Fenrir "%PYTHON%" "-m uvicorn backend.app.main:app --host 0.0.0.0 --port %PORT% --loop asyncio --timeout-graceful-shutdown 5"
if errorlevel 1 (
    echo [install-service] nssm install failed
    exit /b 1
)

REM Service configuration
"%NSSM%" set Fenrir AppDirectory "%APP_DIR%"
"%NSSM%" set Fenrir DisplayName "Fenrir"
"%NSSM%" set Fenrir Description "Fenrir — local-first Bambu Lab printer manager"
"%NSSM%" set Fenrir Start SERVICE_AUTO_START

REM Shutdown behaviour. NSSM's stop sequence is Ctrl-C, then WM_CLOSE, then a
REM thread message, then TerminateProcess — each with a 1500 ms default wait.
REM Uvicorn shuts down on the Ctrl-C, but needs longer than 1.5 seconds to
REM finish: it drains in-flight requests (bounded at 5s by the flag above) and
REM then runs the app teardown — WAL checkpoint, MQTT disconnect, virtual-
REM printer stop. At the default timeout Windows force-killed it mid-teardown.
REM
REM Skip=6 drops the WM_CLOSE (2) and thread-message (4) methods: uvicorn is a
REM console app with no window and no message loop, so both were only burning
REM another 3 seconds before the kill. Ctrl-C is the one that works.
"%NSSM%" set Fenrir AppStopMethodSkip 6
"%NSSM%" set Fenrir AppStopMethodConsole 15000

REM Environment: point DATA_DIR + LOG_DIR at ProgramData, prepend our
REM bin/ to PATH so ffmpeg/ffprobe are found by the shutil.which() lookup
REM in backend/app/services/layer_timelapse.py.
"%NSSM%" set Fenrir AppEnvironmentExtra ^
    "DATA_DIR=%DATA_DIR%" ^
    "LOG_DIR=%LOG_DIR%" ^
    "PORT=%PORT%" ^
    "PATH=%BIN_DIR%;%PATH%"

REM Stdout / stderr capture. Rotate at 10MB.
"%NSSM%" set Fenrir AppStdout "%LOG_DIR%\service-stdout.log"
"%NSSM%" set Fenrir AppStderr "%LOG_DIR%\service-stderr.log"
"%NSSM%" set Fenrir AppRotateFiles 1
"%NSSM%" set Fenrir AppRotateOnline 1
"%NSSM%" set Fenrir AppRotateBytes 10485760

REM Run as LocalSystem (default). Required for binding 322/990/8883 if
REM the user later enables the Virtual Printer feature. Most non-VP
REM workloads would work as a less-privileged account, but service
REM identity changes are disruptive — pick the broader one once.

REM Start the service. If it fails to start, NSSM exits non-zero and
REM Inno Setup will surface this to the user.
"%NSSM%" start Fenrir
if errorlevel 1 (
    echo [install-service] nssm start failed — check %LOG_DIR%\service-stderr.log
    exit /b 1
)

echo [install-service] Fenrir service registered and started on port %PORT%
endlocal
exit /b 0
