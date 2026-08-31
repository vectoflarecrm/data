# Global Watersports B2B Intelligence Database

本项目包含两个部分：

1. 本地优先的 FastAPI + PostgreSQL 客户情报系统；
2. 独立的 Cloudflare Workers + D1 + Gemini AI 定时丰富任务。

## 本地控制面板

启动 PostgreSQL 和 FastAPI：

```bash
bash start_dashboard.sh
```

浏览器访问：

```text
http://127.0.0.1:8000/dashboard
```

健康检查：

```text
http://127.0.0.1:8000/health
```

API 文档：

```text
http://127.0.0.1:8000/docs
```

Windows 可双击：

```text
start_dashboard.bat
```

## 本地系统能力

- 公司、联系人、联系方式、产品、品牌和社交账号管理；
- CSV/Excel 数据导入、标准化、去重和冲突报告；
- PostgreSQL 研究任务队列和 worker heartbeat；
- 网站抓取、证据保存、AI Context 和 Lead Score；
- Outreach 准备、邮箱抑制检查和事件审计；
- 控制面板查看、分页、编辑公司信息和查看数据库结构。

数据库模型位于：

```text
src/app/db/models/
```

迁移位于：

```text
alembic/versions/
```

## Cloudflare D1 + AI CRM Worker

Cloudflare Worker 位于：

```text
crm-ai-worker/
```

Worker 每 5 分钟运行一次，每次从 D1 原子认领最多 3 条 `pending` 客户记录：

```text
pending
  ↓ 原子认领
processing
  ↓ 10 秒网页抓取 + HTMLRewriter
Gemini AI 分析（15 秒超时）
  ↓ D1 batch
completed / failed
```

### Worker 配置

```toml
compatibility_date = "2024-03-01"

[triggers]
crons = ["*/5 * * * *"]
```

D1 绑定配置位于：

```text
crm-ai-worker/wrangler.toml
```

部署时 workflow 会按 `database_name = "crm-ai-db"` 自动查询 D1 ID，并仅在 Actions 运行目录中临时写入 `wrangler.toml`；不会把 D1 ID 或凭据提交到 Git。若本地部署，则需要手动将占位符替换为真实 D1 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "crm-ai-db"
database_id = "你的_D1_database_id"
```

创建 D1：

```bash
cd crm-ai-worker
npx wrangler d1 create crm-ai-db
```

初始化 Schema：

```bash
npx wrangler d1 execute crm-ai-db --remote --file=./schema.sql
```

本地 D1 初始化：

```bash
npx wrangler d1 execute crm-ai-db --local --file=./schema.sql
```

### Cloudflare Secrets

必须填写的 Secret 只有：

```text
GEMINI_API_KEY
```

设置命令：

```bash
cd crm-ai-worker
npx wrangler secret put GEMINI_API_KEY
```

可选 Secret：

```text
GEMINI_MODEL
```

设置命令：

```bash
npx wrangler secret put GEMINI_MODEL
```

如果不设置 `GEMINI_MODEL`，Worker 使用默认模型：

```text
gemini-2.5-flash-lite
```

#### 参数归类

| 参数 | 类型 | 用途 | 设置位置 |
|---|---|---|---|
| `GEMINI_API_KEY` | 必填 Secret | 调用 Gemini AI | Cloudflare Worker Secret |
| `GEMINI_MODEL` | 可选 Secret | 覆盖默认 AI 模型 | Cloudflare Worker Secret |
| `database_id` | 必填配置，不是 Secret | 绑定 D1 数据库 | `crm-ai-worker/wrangler.toml` |
| `CLOUDFLARE_API_TOKEN` | 仅 CI/CD 需要 | GitHub Actions 部署认证 | GitHub Repository Secret |
| `CLOUDFLARE_ACCOUNT_ID` | 仅 CI/CD 需要 | GitHub Actions 指定 Cloudflare 账户 | GitHub Repository Secret |
| `CLOUDFLARE_D1_DATABASE_ID` | CI/CD 必填 | 指定 `crm-ai-db` 的真实 D1 ID | GitHub Repository Secret |

使用本地 `npx wrangler deploy` 时，只需先执行 `npx wrangler login`，不需要设置 `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_ACCOUNT_ID`。

如果通过 GitHub Actions 自动部署，则需要在仓库 **Settings → Secrets and variables → Actions** 中添加：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_D1_DATABASE_ID
GEMINI_API_KEY
```

仓库中的 workflow 文件为：

```text
.github/workflows/deploy-worker.yml
```

只有修改 `crm-ai-worker/**` 或 `.github/workflows/deploy-worker.yml` 并推送到 `main` 时，才会自动执行 Worker 类型检查、发布 Worker 并同步 `GEMINI_API_KEY` Secret；修改 Python 主项目不会触发 Worker 部署。也可以在 GitHub Actions 页面选择 `Deploy CRM AI Worker`，点击 `Run workflow` 手动触发。

Cloudflare API Token 建议创建为 **Account API Token → Custom token**，并将账户资源限制为部署 Worker 的单个 Cloudflare Account。仅运行 `wrangler deploy` 时需要以下最小权限：

```text
Account → Workers Scripts → Edit
```

如果 GitHub Actions 还会执行远程 D1 Schema 或 SQL 命令，再增加：

```text
Account → D1 → Edit
```

只有需要通过 CI 查看实时日志时才增加：

```text
Account → Workers Tail → Read
```

本项目不需要 DNS、Billing、Account Settings Edit 或 User API Tokens Edit 权限。`GEMINI_MODEL` 仅在需要覆盖代码默认模型时添加。

不要把 API Key 或 API Token 写入以下文件或提交到 Git：

```text
.env
.dev.vars
源码
README.md
```


### 本地测试 Worker

```bash
cd crm-ai-worker
npm install
npx wrangler dev --test-scheduled
```

另开终端手动触发 Cron：

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*/5%20*%20*%20*%20*"
```

插入测试客户：

```bash
npx wrangler d1 execute crm-ai-db --local --command="INSERT INTO customers (company_id, domain, remarks) VALUES ('demo-001', 'https://example.com', '测试客户')"
```

### 发布 Worker

先登录 Cloudflare：

```bash
npx wrangler login
```

本地部署时确认 `wrangler.toml` 中已填写真实 `database_id`，并设置 API Key 后发布。GitHub Actions 会自动查询 `crm-ai-db` 的真实 D1 ID；如果找不到该数据库或 Token 没有 D1 读取权限，workflow 会停止并显示具体原因：

```bash
cd crm-ai-worker
npx wrangler deploy
```

GitHub Actions 手动部署：

1. 打开仓库的 **Actions** 页面；
2. 选择 `Deploy CRM AI Worker`；
3. 点击 **Run workflow**，选择 `main`；
4. 查看 `Validate deployment configuration`、`Typecheck` 和 `Deploy Worker` 步骤日志。

如果没有运行记录，通常是因为最近提交没有修改 `crm-ai-worker/**`；部署前请在 GitHub Secrets 添加 `CLOUDFLARE_D1_DATABASE_ID`，值为 Cloudflare 中 `crm-ai-db` 的真实 D1 ID。workflow 不再依赖 D1 列表查询；执行远程 Schema/SQL 时，Cloudflare API Token 仍需要 `D1 → Edit`。

查看日志：

```bash
npx wrangler tail crm-ai-worker
```

### D1 Schema

Schema 文件：

```text
crm-ai-worker/schema.sql
```

表：

```text
customers
```

字段：

```text
id
company_id
domain
status
customer_segment
personas_and_solutions
remarks
updated_at
```

状态值：

```text
pending
processing
completed
failed
```

Worker 会在 `remarks` 末尾自动添加：

```text
【合并数据公司ID: 对应的company_id】
```

### AI 写入规则

- 只发送抓取到的公开网页文本；
- AI 输出必须是纯 JSON；
- `personas_and_solutions` 写入前进行 JSON 校验；
- 每个客户独立处理，单个失败不会阻塞批次；
- 使用 `UPDATE ... RETURNING` 原子认领，避免重复处理；
- 使用 `env.DB.batch()` 批量写回；
- 不执行 AI 生成的 SQL；
- 不保存 Gemini API Key 到数据库。

## GitHub 同步

目标仓库：

```text
https://github.com/vectoflarecrm/data
```

当前本地提交：

```text
614ee85 Add Cloudflare D1 CRM AI worker and dashboard integration
```

如果本机已完成 GitHub 登录，推送命令为：

```bash
git push -u origin main
```

若使用 GitHub CLI：

```bash
gh auth login
git push -u origin main
```

若使用 SSH：

```bash
git remote set-url origin git@github.com:vectoflarecrm/data.git
git push -u origin main
```

当前仓库已配置排除：

```text
.env
node_modules/
.dev.vars
```

## 质量检查

本地 Python 项目：

```bash
.venv/bin/pytest
.venv/bin/ruff check src tests
.venv/bin/mypy src
```

Cloudflare Worker：

```bash
cd crm-ai-worker
npm run typecheck
```
