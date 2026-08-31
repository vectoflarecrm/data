# 控制面板启动步骤

## 一键启动

### Linux / macOS

在项目根目录执行：

```bash
bash start_dashboard.sh
```

脚本会：

1. 启动 PostgreSQL Docker 容器；
2. 执行数据库迁移；
3. 启动 FastAPI 服务；
4. 尝试自动打开浏览器控制面板。

### Windows

双击项目根目录的：

```text
start_dashboard.bat
```

脚本会启动 Docker、执行迁移、打开服务窗口，并尝试打开浏览器。

## 手动启动

```bash
docker-compose up -d postgres
.venv/bin/alembic upgrade head
PYTHONPATH=src .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

浏览器访问：

```text
http://127.0.0.1:8000/dashboard
```

API 文档：

```text
http://127.0.0.1:8000/docs
```

## 停止服务

运行服务的终端按：

```text
Ctrl+C
```

如需停止 PostgreSQL 容器：

```bash
docker compose stop postgres
```

如果端口 8000 已被占用，可改用其他端口：

```bash
PYTHONPATH=src .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```
