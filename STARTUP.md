# 控制面板启动步骤

请在项目根目录按顺序执行以下命令。

## 1. 启动 PostgreSQL 数据库

```bash
docker compose up -d db
```

如果 PostgreSQL 已经运行，可以跳过此步骤。

## 2. 执行数据库迁移

```bash
.venv/bin/alembic upgrade head
```

## 3. 启动 FastAPI 服务

```bash
PYTHONPATH=src .venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 \
  --port 8000 \
  --reload
```

看到以下提示表示服务启动成功：

```text
Uvicorn running on http://127.0.0.1:8000
```

## 4. 打开控制面板

浏览器访问：

```text
http://127.0.0.1:8000/dashboard
```

API 文档：

```text
http://127.0.0.1:8000/docs
```

## 5. 停止服务

在运行 Uvicorn 的终端按：

```text
Ctrl+C
```

如果端口 8000 已被占用，可以改用其他端口，例如：

```bash
PYTHONPATH=src .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

此时控制面板地址为：

```text
http://127.0.0.1:8001/dashboard
```

bash start_dashboard.sh
