@echo off
chcp 65001 >nul
echo.
echo ========================================
echo   KakaoClassBot Knowledge Base Update
echo ========================================
echo.

cd /d "%~dp0"

echo [1/5] OCR pass (processes new scanned/image files, skips cached)...
call npm run ocr
if errorlevel 1 (
    echo.
    echo [WARN] OCR step had failures. Continuing with available caches.
    echo.
)

echo.
echo [2/5] Ingesting source files...
call npm run ingest
if errorlevel 1 (
    echo.
    echo [ERROR] Ingest failed. Check the error above.
    pause
    exit /b 1
)

echo.
echo [3/5] Staging chunks.json...
git add data\chunks.json

echo.
echo [4/5] Committing...
git commit -m "Update knowledge base"

echo.
echo [5/5] Pushing to GitHub (Vercel auto-deploys)...
git push

echo.
echo ========================================
echo   Done! Vercel will redeploy in ~60s.
echo ========================================
echo.
pause
