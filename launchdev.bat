@echo off
color 0B
echo =========================================
echo Starting V.I.C.T.O.R. / LTM Brainstorm...
echo =========================================

:: Start Ollama in the background (if it isn't already running)
echo [1/2] Waking up Ollama...
start /B ollama serve

:: Give Ollama 3 seconds to spin up its API
timeout /t 3 /nobreak > NUL

:: Launch the Electron App
echo [2/2] Launching User Interface...
npm start

exit