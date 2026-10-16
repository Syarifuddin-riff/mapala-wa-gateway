@echo off
title Upload WhatsApp Gateway ke GitHub
color 0a
echo ============================================================
echo      MENGUNGGAH WHATSAPP GATEWAY KE GITHUB
echo ============================================================
echo.
cd /d "%~dp0"
git add .
git commit -m "feat: whatsapp gateway multi-device cloud 24/7" 2>nul
echo Mengirim file ke GitHub...
git push -u origin main
echo.
if %errorlevel% equ 0 (
    echo ============================================================
    echo   [BERHASIL] File bot sudah terunggah ke GitHub Abang!
    echo ============================================================
) else (
    echo ============================================================
    echo   [INFO] Jika diminta login di jendela browser/pop-up,
    echo   silakan klik "Sign in with your browser" / "Authorize".
    echo ============================================================
)
echo.
pause
