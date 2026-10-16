@echo off
title Mapala Peregrina - WhatsApp Bot Gateway
color 0A
echo ===================================================
echo     MAPALA PEREGRINA - WHATSAPP BOT GATEWAY
echo ===================================================
echo.
echo Menjalankan WhatsApp Multi-Device Gateway di port 3000...
echo.
cd /d "%~dp0"
node server.js
pause
