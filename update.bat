@echo off
chcp 65001 >nul
echo.
echo ========================================
echo   KakaoClassBot Knowledge Base Update
echo ========================================
echo.

cd /d "%~dp0"

echo [1/4] Ingesting source files...
call npm run ingest
if errorlevel 1 (
    echo.
    echo [ERROR] Ingest failed. Check the error above.
    echo         If files are scanned/image-based, run "npm run ocr" first.
    pause
    exit /b 1
)

echo.
echo [2/4] Staging chunks.json...
git add data\chunks.json

echo.
echo [3/4] Committing...
git commit -m "Update knowledge base"

echo.
echo [4/4] Pushing to GitHub (Vercel auto-deploys)...
git push

echo.
echo ========================================
echo   Done! Vercel will redeploy in ~60s.
echo ========================================
echo.
pause
