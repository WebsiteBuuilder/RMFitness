@echo off
echo 🚀 Deploying R&M Fitness to Railway...
echo.

echo ⏳ Adding files to git...
git add .

echo ⏳ Committing changes...
set /p commit_msg="Enter commit message (or press Enter for default): "
if "%commit_msg%"=="" set commit_msg=Update website

git commit -m "%commit_msg%"

echo ⏳ Pushing to GitHub...
git push origin main

echo ⏳ Deploying to Railway...
railway up

echo.
echo ✅ Deployment complete!
echo 🌐 Your site: https://tedious-use-production.up.railway.app
echo.
pause 