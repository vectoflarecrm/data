# CRM AI Worker

这是一个独立的 Cloudflare Workers + D1 定时任务项目，用于每 5 分钟分批处理最多 3 个客户网址：

```text
D1 pending customers
  ↓ 原子认领 3 条
processing
  ↓ 10 秒网页抓取 + HTMLRewriter
网页纯文本
  ↓ 15 秒 OpenRouter AI 分析
completed / failed
  ↓ D1 batch 一次性写回
```

## 配置

先安装依赖：

```bash
cd crm-ai-worker
npm install
```

创建 D1 数据库：

```bash
npx wrangler d1 create crm-ai-db
```

将命令输出的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "crm-ai-db"
database_id = "你的_D1_database_id"
```

初始化远程 D1 Schema：

```bash
npx wrangler d1 execute crm-ai-db --remote --file=./schema.sql
```

本地开发数据库初始化：

```bash
npx wrangler d1 execute crm-ai-db --local --file=./schema.sql
```

写入 OpenRouter API Key（不要写入源码或提交到 Git）：

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

可选模型配置：

```bash
npx wrangler secret put OPENROUTER_MODEL
```

默认模型为：

```text
meta-llama/llama-3.1-8b-instruct:free
```

### 参数归类

Worker 运行时必须使用的 Secret：

```text
OPENROUTER_API_KEY
```

可选的 Worker Secret：

```text
OPENROUTER_MODEL
```

D1 的 `database_id` 不是 Secret，而是写入 `wrangler.toml` 的数据库绑定配置。使用本地 Wrangler 登录部署时，不需要额外填写 Cloudflare API Token：

```bash
npx wrangler login
npm run deploy
```

如果使用 GitHub Actions 自动部署，则在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中配置：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
OPENROUTER_API_KEY
```

仓库中的自动部署 workflow 为：

```text
.github/workflows/deploy-worker.yml
```

推送到 `main` 分支或在 Actions 页面手动运行后，workflow 会先同步 `OPENROUTER_API_KEY`，再执行类型检查和 Worker 部署。

Cloudflare API Token 建议创建为 **Account API Token → Custom token**，并限制到部署 Worker 的单个 Cloudflare Account。仅运行 `wrangler deploy` 时需要：

```text
Account → Workers Scripts → Edit
```

如果 CI 还运行以下远程 D1 命令：

```bash
wrangler d1 execute crm-ai-db --remote --file=./schema.sql
```

再增加：

```text
Account → D1 → Edit
```

只有 CI 需要查看实时日志时才需要：

```text
Account → Workers Tail → Read
```

不需要 DNS、Billing、Account Settings Edit 或 User API Tokens Edit 权限。需要覆盖默认模型时，再添加：

```text
OPENROUTER_MODEL
```

不要将任何 Secret 写入源码、`wrangler.toml`、README 或提交到 Git。Cloudflare API Token 应使用最小权限。

## 本地测试

启动支持 Cron Trigger 的本地开发服务器：

```bash
npx wrangler dev --test-scheduled
```

另开一个终端手动触发 scheduled 事件：

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*/5%20*%20*%20*%20*"
```

开发服务器使用本地 D1 数据库；先用 `--local` 初始化 Schema 并插入测试数据：

```bash
npx wrangler d1 execute crm-ai-db --local --command="INSERT INTO customers (company_id, domain, remarks) VALUES ('demo-001', 'https://example.com', '测试客户')"
```

类型检查：

```bash
npm run typecheck
```

## 部署

确认 `wrangler.toml` 中的 `database_id` 已填写后：

```bash
npm run deploy
```

部署前如需再次同步远程 Schema：

```bash
npx wrangler d1 execute crm-ai-db --remote --file=./schema.sql
```

查看 Worker 日志：

```bash
npx wrangler tail crm-ai-worker
```

## 数据状态和写入规则

Worker 使用以下状态：

```text
pending → processing → completed
                       ↘ failed
```

- 使用单条 `UPDATE ... RETURNING` 原子认领 3 条 pending 记录，避免 Cron 并发重复处理；
- 网页请求超时为 10 秒；
- OpenRouter 请求超时为 15 秒；
- 单个客户失败不会影响同批其他客户；
- 所有成功或失败结果通过一次 `env.DB.batch()` 批量写回；
- `personas_and_solutions` 始终以 JSON 字符串写入；
- `remarks` 末尾自动追加：

```text
【合并数据公司ID: 对应的company_id】
```

- AI Key 只从 `OPENROUTER_API_KEY` Secret 读取；
- AI 只能处理网页文本并写入画像字段，不能执行任意 SQL；
- D1 写回使用 `WHERE id = ? AND status = 'processing'`，避免过期任务覆盖新状态。

## D1 Schema

表结构定义在：

```text
schema.sql
```

字段包括：

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

并为 `status` 和 `company_id` 建立索引。
