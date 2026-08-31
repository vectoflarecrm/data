@echo off
setlocal
cd /d "%~dp0"

docker-compose up -d postgres
if errorlevel 1 (
  echo Docker 启动失败，请确认 Docker Desktop 正在运行。
  pause
  exit /b 1
)

.venv\Scripts\alembic.exe upgrade head
if errorlevel 1 (
  echo 数据库迁移失败。
  pause
  exit /b 1
)

start "Watersports Dashboard" cmd /k "set PYTHONPATH=src&& .venv\Scripts\uvicorn.exe app.main:app --host 127.0.0.1 --port 8000 --reload"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:8000/dashboard"
