@echo off
REM pi-remote launcher with shared PI_REMOTE_NOTIFY_TOKEN
setlocal
set /p PI_REMOTE_NOTIFY_TOKEN=<C:\Tools\pi-billing-window\NOTIFY_TOKEN.txt
cd /d C:\Tools\pi-remote
echo [start-with-token] token loaded, len=%PI_REMOTE_NOTIFY_TOKEN:~0,4%...
node server.js 7681 "C:\Users\r.edokov\AppData\Roaming\npm\pi.cmd" "C:\MyProjects"
endlocal
