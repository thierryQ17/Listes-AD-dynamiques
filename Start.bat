@echo off

:: Fermer toutes les fenêtres PowerShell 7 existantes (serveur précédent inclus)
taskkill /F /IM pwsh.exe >nul 2>&1

pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1"
pause

