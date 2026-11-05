@echo off
title Upload Gateway ke GitHub untuk Render
color 0b
echo ============================================================
echo   MENGUNGGAH GATEWAY KE GITHUB UNTUK DEPLOYMENT DI RENDER
echo ============================================================
echo.
cd /d "%~dp0"
git add .
git commit -m "feat: configure render.yaml and optimize for render cloud" 2>nul
echo Mengirim perubahan ke GitHub...
git push -u origin main
echo.
if %errorlevel% equ 0 (
    echo ============================================================
    echo   [BERHASIL] File gateway sudah terunggah ke GitHub!
    echo   Render akan otomatis memproses deployment Anda.
    echo ============================================================
) else (
    echo ============================================================
    echo   [INFO] Terjadi kendala saat push ke GitHub.
    echo   Pastikan koneksi internet aktif dan login GitHub valid.
    echo ============================================================
)
echo.
pause
