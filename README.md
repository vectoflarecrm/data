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

Worker 每 5 分钟运行一次，每次从 D1 认领 1 条 `pending` 客户记录，进行深度多源研究：

```text
pending
  ↓ 原子认领（每次1条，质量优先）
processing
  ↓ Step 1: 抓取主网站（15秒超时）
  ↓ Step 2: Searlo/Tavily/Exa/DuckDuckGo 多引擎搜索（Tavily 主力，最多 20 Key 轮换）
  ↓         搜索公司名+国家+行业关键词（3次查询）
  ↓         自动轮询多个API Key
  ↓ Step 3: 抓取搜索结果页面内容
  ↓ Step 4: 抓取子页面（/about, /contact, /team）
  ↓ Step 5: 抓取社交媒体（LinkedIn, Facebook, Instagram）
  ↓ Step 6: AI 深度分析（30秒超时，交叉验证多源数据）
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

部署时 workflow 会复用 GitHub Secret `CLOUDFLARE_D1_DATABASE_ID`；如果该 Secret 未设置，则自动创建名为 `crm-ai-db` 的 D1，并仅在 Actions 运行目录中临时写入 `wrangler.toml`。不会把 D1 ID 或凭据提交到 Git。若本地部署，则需要手动将占位符替换为真实 D1 ID：

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
| `CLOUDFLARE_D1_DATABASE_ID` | 可选 CI/CD 配置 | 指定已有 `crm-ai-db` 的 D1 ID；不设置时由 workflow 自动创建 | GitHub Repository Secret |
| `ADMIN_PANEL_TOKEN` | 可选管理 Secret | 登录 D1 客户管理面板 | GitHub Repository Secret，并同步到 Worker |

使用本地 `npx wrangler deploy` 时，只需先执行 `npx wrangler login`，不需要设置 `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_ACCOUNT_ID`。

如果通过 GitHub Actions 自动部署，则需要在仓库 **Settings → Secrets and variables → Actions** 中添加：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
GEMINI_API_KEY
```

可选：

```text
CLOUDFLARE_D1_DATABASE_ID
ADMIN_PANEL_TOKEN
```

### 多搜索引擎 API 配置（可选）

Worker 支持多个搜索引擎与 AI Provider 的多 Key 池调度，用于深度研究公司信息。已移除 Google Custom Search；主力引擎为 **Tavily（最多 60 个 Key）**，AI 分析主力为 **Gemini（AI Studio 免费 Key，最多 40 个）**，无需配置搜索 Key 也能工作（DuckDuckGo 作为最终备用，无需 Key）。

#### 搜索引擎免费额度

| 引擎 | 免费额度 | 需要注册 | 注册地址 |
|------|---------|---------|----------|
| Tavily（主力） | 1000次/月/Key，支持最多 60 个 Key | 是 | https://tavily.com |
| Searlo | 3000次/月/Key | 是 | https://searlo.com |
| Exa | 1000次/月/Key | 是 | https://exa.ai |
| DuckDuckGo | 无限次 | 否 | 无需注册 |

#### 推荐配置（Gemini 40 + Tavily 60 + Exa 60）

在 GitHub **Settings → Secrets and variables → Actions** 中添加：

```text
# Gemini（AI 分析主力，AI Studio 免费 Key，最多 40 个）
GEMINI_API_KEY              = AIza...
GEMINI_API_KEY_2            = AIza...（第二个 Key）
GEMINI_API_KEY_3            = AIza...
...
GEMINI_API_KEY_40           = AIza...

# Tavily（搜索主力，每个 Key 1000次/月，最多 60 个 Key）
TAVILY_API_KEY              = tvly-...
TAVILY_API_KEY_2            = tvly-...（第二个 Key）
TAVILY_API_KEY_3            = tvly-...
TAVILY_API_KEY_4            = tvly-...
TAVILY_API_KEY_5            = tvly-...
TAVILY_API_KEY_6            = tvly-...
TAVILY_API_KEY_7            = tvly-...
TAVILY_API_KEY_8            = tvly-...
TAVILY_API_KEY_9            = tvly-...
TAVILY_API_KEY_10           = tvly-...
...
TAVILY_API_KEY_58           = tvly-...
TAVILY_API_KEY_59           = tvly-...
TAVILY_API_KEY_60           = tvly-...

# Exa（可选备用搜索，每个 Key 1000次/月，最多 60 个 Key）
EXA_API_KEY                 = ...
EXA_API_KEY_2               = ...
...
EXA_API_KEY_60              = ...

# Searlo（可选，每个 Key 3000次/月，作为 Tavily 之后的备用引擎）
SEARLO_API_KEY              = sl-...
SEARLO_API_KEY_2            = sl-...（第二个 Key）

```

Key 数量可少于上限，只配置前 N 个即可，Worker 自动识别已配置的 Key。未配置任何搜索 Key 时仍可运行（DuckDuckGo 兜底）。

#### 多 Key 池与防封杀原则（Gemini 40 / Tavily 60 / Exa 60）

Worker 内置统一的多 Key 池调度（`api_key_health` 表），核心思路是 **不要在单个任务里频繁切换账号**，并且 **额度用完的 Key 立即停用**，让每个账号的行为看起来像正常用户：

1. **一家公司 = 一个固定 Key**：每家公司按其 `customer.id` 确定性分配一个 Gemini Key、一个 Tavily Key、一个 Exa Key。该公司任务内的全部搜索查询和 AI 分析都用同一个 Key，不会在任务中途来回切换账号；
2. **公司间均匀分散**：不同公司自动落到不同 Key 上，配额均摊（例如 6 次搜索 × 每月 N 家公司 ÷ 60 个 Tavily Key）；
3. **额度用完立即停用**：Key 返回 `429/401/403` 时写入 `api_key_health` 表进入冷却期（Tavily/Exa 冷却 24 小时，覆盖月度配额；Gemini 冷却 60 秒，覆盖每分钟限流），冷却期内 **完全不再调用** 该 Key，后续任务自动跳到健康 Key；
4. **仅必要时才切换**：只有分配的 Key 被拒绝/限流时才降级到下一个健康 Key，正常情况下整个任务始终用一个账号；
5. **查询间延时**：每次搜索之间间隔 2 秒（`INTER_SOURCE_DELAY_MS`），每家公司之间间隔 5 秒（`INTER_CUSTOMER_DELAY_MS`），模拟人类节奏，避免瞬时高频请求；
6. **全部 Key 耗尽即静默停止**：若某引擎所有 Key 都在冷却期，直接跳过该引擎（返回空结果），不会反复敲打已耗尽的账号；
7. **多引擎/AI 分流**：搜索 Tavily → Searlo → Exa → DuckDuckGo；AI Gemini → Groq → Mistral → DeepSeek → OpenRouter，进一步降低单 provider 压力；
8. **无 Key 也可运行**：不配置任何搜索 Key 时自动降级为 DuckDuckGo，不会报错。

#### Gemini（AI Studio 免费 Key）设置

1. 打开 https://aistudio.google.com/apikey ，每个 Google 账号创建一个 API Key；
2. 注意 AI Studio 免费 Key 的使用限制：免费层按 **每分钟请求数（RPM）和每日请求数（RPD）** 限流，不同模型额度不同（如 `gemini-2.5-flash-lite` 免费层约 15 RPM / 1000 RPD，以官方额度页为准）；
3. 需要 40 个 Key 时准备 40 个 Google 账号，各自在 AI Studio 创建一个 Key；
4. 将 Key 按序号填入 GitHub Secrets：`GEMINI_API_KEY`、`GEMINI_API_KEY_2` … `GEMINI_API_KEY_40`；
5. Worker 每 5 分钟只处理 1 家公司（每任务 1 次 AI 调用 + 最多 4 次模型重试），单 Key 每日消耗远低于免费 RPD 上限；429 限流时该 Key 冷却 60 秒后自动恢复。

#### OpenRouter（统一网关备用 AI）设置

OpenRouter（https://openrouter.ai）聚合了各家模型（Gemini/Claude/GPT/Llama 等），一个 Key 即可调用多种模型，适合作为 Gemini 全部限流时的兜底：

1. 注册 https://openrouter.ai → Keys 页面创建 API Key（`sk-or-` 开头）；
2. 部分模型（如 `google/gemini-2.5-flash`）带 `:free` 后缀的免费版本，免费模型有每分钟/每日限额，付费模型按量计费（可设置月度限额防超支）；
3. 填入 GitHub Secrets：

```text
OPENROUTER_API_KEY          = sk-or-...
OPENROUTER_API_KEY_2        = sk-or-...（第二个 Key，可选）
OPENROUTER_API_KEY_3        = sk-or-...（第三个 Key，可选）
OPENROUTER_MODEL            = google/gemini-2.5-flash   # 可选，默认 google/gemini-2.5-flash；免费模型如 google/gemini-2.0-flash-exp:free
```

4. OpenRouter 在 AI 降级链中的位置：Gemini → Groq → Mistral → DeepSeek → **OpenRouter**；仅在前面所有 Provider 都不可用时才会调用。

#### Tavily 设置步骤

1. 打开 https://tavily.com ，每个账号注册后获取一个 API Key（`tvly-` 开头）；
2. 需要 60 个 Key 时用不同邮箱注册 60 个账号，各取一个 Key；
3. 将 Key 按序号填入 GitHub Secrets：`TAVILY_API_KEY`、`TAVILY_API_KEY_2` … `TAVILY_API_KEY_60`；
4. 免费额度：每个 Key 1000次/月，60 个 Key 合计约 60000次/月；用完（429）后该 Key 冷却 24 小时不再调用，直到下月配额恢复。

#### Exa 设置步骤

1. 打开 https://exa.ai
2. 注册账号 → 获取 API Key
3. 免费额度：1000次/月

#### 搜索工作原理

每家公司会执行 6 次搜索查询：

```text
查询1: "公司名" 国家 water sports company email phone contact
查询2: "公司名" email whatsapp cellphone contact person
查询3: site:linkedin.com/company "公司名"
查询4: site:linkedin.com/in "公司名" CEO owner manager
查询5: site:linkedin.com "公司名" purchasing buyer manager
查询6: "公司名" about products services inflatable boat SUP
```

Tavily/Exa/Gemini Key 按公司 ID 固定分配（一家公司始终用同一组 Key，耗尽的 Key 自动停用），搜索结果自动去重，抓取页面内容后与网站数据一起送入 AI 深度分析。

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

本地部署时确认 `wrangler.toml` 中已填写真实 `database_id`，并设置 API Key 后发布。GitHub Actions 会复用已有的 `CLOUDFLARE_D1_DATABASE_ID`，没有该 Secret 时自动创建 `crm-ai-db`；创建、Schema 初始化和发布需要 Token 具备目标账户的 `D1 → Edit` 权限：

```bash
cd crm-ai-worker
npx wrangler deploy
```

GitHub Actions 手动部署：

1. 打开仓库的 **Actions** 页面；
2. 选择 `Deploy CRM AI Worker`；
3. 点击 **Run workflow**，选择 `main`；
4. 查看 `Validate deployment configuration`、`Typecheck` 和 `Deploy Worker` 步骤日志。

如果没有运行记录，通常是因为最近提交没有修改 `crm-ai-worker/**`。workflow 使用并发锁避免 push 与手动部署同时操作 D1，并在发布前检查远程 `customers` 表是否存在；如果已有 `crm-ai-db`，可在 GitHub Secrets 添加 `CLOUDFLARE_D1_DATABASE_ID`，否则 workflow 会自动创建。

查看日志：

```bash
npx wrangler tail crm-ai-worker
```

### 双仓库数据隔离与 D1 备份

本项目采用代码与真实数据分离的双仓库模式：

- 公共代码仓库：`https://github.com/vectoflarecrm/data`，只存放代码、Schema、部署脚本和不含客户资料的文档；
- 私有备份仓库：`https://github.com/vectoflarecrm/crm-db-backup`，只存放 Cloudflare D1 的 AES-256 加密快照。

私有仓库中的 `.github/workflows/backup.yml` 每天自动导出 `crm-ai-db`，加密后只提交 `*.sql.enc`，并保留最近 30 个快照。明文 SQL 和加密密钥不会提交到任何仓库。

在私有仓库的 **Settings → Secrets and variables → Actions** 中分别添加：

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
BACKUP_ENCRYPTION_KEY
```

其中 `BACKUP_ENCRYPTION_KEY` 在本机生成：

```bash
openssl rand -base64 48
```

不要把密钥发送到聊天或提交到 Git。配置完成后，在私有仓库的 **Actions → Encrypted D1 Database Backup → Run workflow** 手动运行一次，确认只生成加密的 `backups/*.sql.enc` 文件。

### 将本地 PostgreSQL 公司同步到 D1

D1 数据库和本地 PostgreSQL 是两个独立数据库；Worker 部署只创建表，不会自动复制本地公司的 781 条记录。使用以下命令生成并分批导入本地公司数据：

```bash
cd ~/global-watersports-intelligence
bash scripts/sync_d1_customers.sh
```

脚本会：

- 从本地 PostgreSQL 读取公司、联系人、产品和联系方式；
- 使用小批次 SQL 写入远程 `crm-ai-db`；
- 以本地公司的 UUID 作为 D1 `company_id`；
- 保留已有 D1 的 AI 分析字段，不覆盖已完成的结果；
- 没有官网或域名的公司不会进入待抓取队列，并在导出统计中列出；
- 生成的客户数据只保存在被 Git 忽略的 `data/exports/`，不会提交到 GitHub。

执行前需要先登录 Cloudflare：

```bash
cd ~/global-watersports-intelligence/crm-ai-worker
npx wrangler login
cd ..
bash scripts/sync_d1_customers.sh
```

导入完成后验证数量：

```bash
cd crm-ai-worker
npx wrangler d1 execute crm-ai-db --remote --command="SELECT COUNT(*) AS total FROM customers;" --yes
```

预计有官网或规范域名的公司约 `752` 条；没有官网的 `29` 条本地公司会被跳过，因为当前 `customers.domain` 是必填且 Worker 无法抓取空网址。若本地存在被忽略的 `crm-ai-worker/wrangler.local.toml`，同步脚本会自动使用它；否则使用 `wrangler.toml`。

### 邮件发送：Google Workspace Gmail（Service Account）

开发信通过 **Google Workspace Gmail API** 发送，使用 Service Account + 域级委派（Domain-wide Delegation），服务器端全自动，无需人工刷新 token。

#### 防封杀发送机制

- **每日配额**：默认 400 封/天（低于 Gmail 免费层 500 封/天上限，可通过 `GMAIL_DAILY_LIMIT` 调整），配额记录在 D1 `gmail_send_log` 表，用完自动拒绝发送；
- **发送间隔**：每封默认间隔 3 秒（`GMAIL_SEND_DELAY_MS` 可调），模拟人工节奏；
- **发送审计**：每封邮件的发送结果（成功/失败 + 原因）记录在 `gmail_send_log`；
- **失败不中断**：批量发送时单封失败不影响后续，配额用完自动停止。

#### 配置步骤

1. **创建 Service Account**：
   - 打开 https://console.cloud.google.com → 选择 Workspace 同组织项目；
   - API和服务 → 启用 **Gmail API**；
   - IAM 和管理 → 服务账号 → 创建服务账号 → 密钥 → 新建 **JSON** 密钥并下载。
2. **域级委派**：
   - 打开 https://admin.google.com → 安全性 → 访问和数据控制 → API 控制方 → **管理域范围委派**；
   - 新增，填入 Service Account 的 **Client ID**（OAuth2 客户端 ID，不是邮箱）；
   - 授权范围填：`https://www.googleapis.com/auth/gmail.send`
3. **填写 GitHub Secrets**：
   ```text
   GMAIL_SERVICE_ACCOUNT_EMAIL = xxx@xxx.iam.gserviceaccount.com（Service Account 邮箱）
   GMAIL_SERVICE_ACCOUNT_KEY   = JSON 私钥文件中的 private_key 字段值（PEM 格式，含 BEGIN/END 行）
   GMAIL_SENDER_EMAIL          = 发件邮箱（Workspace 中真实用户的邮箱地址）
   GMAIL_DAILY_LIMIT           = 400（可选，默认 400）
   GMAIL_SEND_DELAY_MS         = 3000（可选，默认 3000 毫秒）
   ```
4. 推送后部署 workflow 自动同步到 Worker。

#### 双品牌发件身份、签名和附件

在管理面板的 **开发信管理 → 品牌配置** 中分别维护品牌设置：

- **Afarer**：默认使用 `Toby | Afarer Team <toby@afarer.com>`，面向 SUP 客户；
- **Neptunor**：默认使用 `Helen | Neptunor Team <helen@neptunor.com>`，面向 RIB Boats 和 Inflatable Boats 客户；
- 可为每个品牌填写签名，生成开发信时会原样附加到正文末尾；
- 可为每个品牌上传最多 5 个小型附件，每个不超过 1.4 MB。附件存储在 D1 中，因此不适合上传大型目录；发送草稿时会自动附加该品牌的附件。

发送前建议先发送 1 封草稿验证发件身份、签名和附件是否符合预期。

#### 面板操作

在 `https://crm-ai-worker.<子域>.workers.dev/admin/outreach` 的 **开发信管理 → 邮件列表** 页：

- 顶部显示 **Gmail 今日配额**（已发/上限/剩余）；
- 点击 **📤 批量发送草稿**，输入本次发送数量（1-50），Worker 按配额和间隔逐封通过 Gmail 发出；
- 发送成功的草稿自动标记为 **已发送**；失败会弹出前 3 条原因。

#### 注意事项

- Service Account 只能以 **同 Workspace 域内真实用户** 的身份发信（`sub` 声明），个人 Gmail 账号不支持域级委派；
- 私钥是敏感凭据，只存 GitHub Secret 和 Worker Secret，不要提交到 Git；
- 新部署后建议先发 1-2 封验证送达，再逐步放量；新发信域名/账号大量发送冷邮件容易触发 Gmail 限流（429），遇限流等待即可，配额逻辑不会重试已失败的发送。

### D1 客户管理面板

Worker 部署后访问：

```text
https://crm-ai-worker.qdu.workers.dev/admin
```

登录前，在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 添加：

```text
ADMIN_PANEL_TOKEN
```

Secret 值请使用随机长字符串，不要发送到聊天或提交到 Git。部署 workflow 会将它同步为 Cloudflare Worker Secret。未配置该 Secret 时，`/admin` 不允许登录。

面板支持：

- 搜索、分页查看 `customers` 表；
- 查看单个客户详情；
- 修改网址、状态、客户细分、画像 JSON 和中文备注；
- 将客户设为 `pending`，等待下一次 Cron 重新处理；
- `id` 和 `company_id` 只读，不能通过面板修改。

### D1 Schema

Schema 文件：

```text
crm-ai-worker/schema.sql
```

表：

```text
customers （客户主表，47个字段）
contacts （联系人表，支持多联系人）
```

customers 核心字段：

```text
id               数据库ID
display_id       客户ID（格式: 国家代号-序号，如 ES-0001）
company_id       内部UUID
domain           企业网址
status           状态（pending/processing/completed/failed）
company_name     公司名称
legal_name       法人名称
first_name       联系人名
last_name        联系人姓
full_name        全名
email            邮箱
cellphone        手机
tel              电话
whatsapp         WhatsApp
country          国家
city             城市
street_address   街道地址
products_services 产品与服务
customer_segment 客户细分（Distributor/Dealer/Manufacturer/User/OEM/Service Provider/E-commerce/不相关）
product_categories 产品类别（Inflatable Boats/Paddle Boards/Kayaks/Yachts/Kitesurfing/Windsurfing/Accessories/Apparel）
company_size     公司规模（Small/Medium/Large/Enterprise）
geographic_coverage 地理覆盖（Local/National/International）
personas_and_solutions  AI分析结果JSON
remarks          中文备注
is_manufacturer  制造商
is_distributor   分销商
is_retailer      零售商
is_rental        租赁
social_accounts  社交账号JSON
updated_at       更新时间

### 分类体系说明

#### 客户细分 (Customer Segment)
- **Distributor**：批发/分销商，主营批发、分销inflatable boat, RIB boat, SUP, paddle board, kayak, Yacht
- **Dealer**：多品牌零售商，多品牌零售inflatable boat, SUP, paddle board, kayak, Yacht，提供维修服务
- **Manufacturer**：制造商，自主生产inflatable boat, RIB boat, SUP, paddle board, kayak, Yacht产品
- **User**：终端用户，租赁或使用inflatable boat, SUP, paddle board, kayak, Yacht，开设水上运动课程培训
- **OEM**：代工厂，为其他品牌代工生产水上运动产品
- **Service Provider**：服务提供商，提供水上运动相关服务（培训、维修、租赁等）
- **E-commerce**：电商，在线销售水上运动产品
- **不相关**：该公司不销售、使用水上运动产品

#### 产品类别 (Product Categories)
- **Inflatable Boats**：充气船（RIB boats, inflatable dinghy, inflatable tender）
- **Paddle Boards**：桨板（SUP, standup paddle board, inflatable SUP）
- **Kayaks**：皮划艇（inflatable kayak, hard shell kayak, sit-on-top kayak）
- **Yachts**：游艇（motor yacht, sailing yacht, luxury yacht）
- **Kitesurfing**：风筝冲浪装备（kite, board, harness, wetsuit）
- **Windsurfing**：帆板装备（sail, board, rig）
- **Accessories**：配件（paddle, pump, fin, repair kit, life jacket）
- **Apparel**：水上运动服装（wetsuit, rash guard, swimwear）

#### 公司规模 (Company Size)
- **Small**：1-10人
- **Medium**：11-50人
- **Large**：51-200人
- **Enterprise**：200+人

#### 地理覆盖 (Geographic Coverage)
- **Local**：仅在本国/本地区经营
- **National**：在多个国家经营
- **International**：在全球多个国家经营
```

contacts 联系人字段：

```text
contact_id       联系人ID（格式: 客户ID_序号，如 ES-0001_001）
company_id       所属客户UUID
seq              序号
first_name       名
last_name        姓
full_name        全名
title            职位
email            邮箱
cellphone        手机
tel              电话
whatsapp         WhatsApp
linkedin_url     LinkedIn
social_accounts  社交账号JSON
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
