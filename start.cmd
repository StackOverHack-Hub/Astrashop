@echo off
cd /d "%~dp0"
docker compose up --build --wait --wait-timeout 180
if errorlevel 1 exit /b 1
for /f "tokens=2 delims=:" %%A in ('docker compose port app 8080') do start "" "http://localhost:%%A"
