# CRM AI Worker

这是一个独立的 Cloudflare Workers + D1 定时任务项目，用于每 5 分钟分批处理最多 3 个客户网址：

```text
D1 pending customers
  ↓ 原子认领 3 条
processing
  ↓ 10 秒网页抓取 + HTMLRewriter
网页纯文本
  ↓ 本地数据清洗（免费、零 token）：去重菜单/页脚/样板文字 + 截断到 token 预算
  ↓ AI 分析（回退链 + RPM 主动限流）
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

本地部署时将命令输出的 `database_id` 填入 `wrangler.toml`；GitHub Actions 会复用 `CLOUDFLARE_D1_DATABASE_ID`，未设置时自动创建 `crm-ai-db` 并临时注入该 ID，不会提交到 Git：

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

写入 AI API Key（不要写入源码或提交到 Git）——三种方式：

**方式 A（推荐）：管理面板动态 Key 池（D1 即时生效）**

打开面板 `https://<worker>/admin/keys`（用 ADMIN_PANEL_TOKEN 登录）：

- 在网页上直接添加/停用/删除任意平台的 Key，可设置单 Key RPM、模型覆盖；
- 平台级设置支持默认模型、总 RPM 上限和一键启用/停用整个平台；
- 🧊 冷却监控：被 429/401/403 暂停的 Key 实时显示剩余冷却时间，可一键清除；过期冷却保留在 📜 历史列表（最近 20 条）；页面每 30 秒自动刷新（输入时暂停）；
- 📦 批量导入（适合 Tavily/Exa/Brave 等大量 Key）：模板格式**每行一条 `API Key,备注/账号`**，也支持 Tab 或 | 分隔（可直接从 Excel/Google Sheets 复制两列粘贴），纯 Key（逗号/分号/空格分隔）也可；面板内置 Tavily/Exa/Brave/通用 一键填充模板；自动去重、跳过已存在的 Key（部分重贴安全）；
- 数据存于 D1 `api_configs` / `provider_settings` 表，下一个请求即生效（同节点即时，全网 30 秒内刷新），**不需要重新部署，也不需要 GitHub 或命令行**；
- Worker 按「D1 优先、env Secrets 兑底」解析 Key，面板清空后自动回退到 Secret 池。

**方式 B：面板直写 Cloudflare Secrets（方案A）**

`https://<worker>/admin/secrets` 页面首次会显示引导表单：粘贴一个仅有 `Workers Scripts: Edit` 权限的 [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens) 与 Account ID，面板自动验证并写入自身凭据；之后可在页面上轮换各平台最多 40 个 Key 槽位。

**方式 C：命令行 / GitHub Secrets**

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN   # 仅方式B引导需要
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put GEMINI_API_KEY         # 直接写入单条
```

在 GitHub 仓库 Secrets 中配置各平台 Key 后，默认 CI **不再**覆盖面板写入的 Key；只有在仓库 Secrets 额外设置 `SYNC_SECRETS_FROM_GITHUB=true` 时，CI 才会强制用 GitHub 侧的值同步覆盖。

Gemini 是首选 Provider；Groq、Cerebras、Zhipu、NVIDIA、Mistral、DeepSeek 和 OpenRouter 按顺序作为备用 Provider。可为每个 Provider 配置多个 Key，限流或服务异常时自动切换，并在恢复前冷却受限 Key。

各 Provider 免费档注册地址：

```text
Groq:       https://console.groq.com/      (免绑卡, ~30 RPM)
Cerebras:   https://cloud.cerebras.ai/     (免绑卡, ~30 RPM, 极速, 70B 级模型)
Zhipu:      https://open.bigmodel.cn/      (GLM-4.7-Flash 永久免费, 200K 上下文)
NVIDIA NIM: https://build.nvidia.com/      (免费额度, ~40 RPM)
AMD Radeon: https://developer.amd.com.cn/radeon/tokenfactory  (免费模型 API, GitHub 登录免绑卡)
Mistral:    https://console.mistral.ai/
DeepSeek:   https://platform.deepseek.com/
OpenRouter: https://openrouter.ai/         (带 :free 后缀的模型免费)
```

AMD Radeon Cloud 免费模型目录（以 API `/models` 实测为准，可在面板按 Key 覆盖模型 ID）：

```text
DeepSeek-V4-Flash                DeepSeek-V4-Flash, 1M 上下文（默认）
DeepSeek-V4-Flash-Vision-Exp     DeepSeek-V4-Flash Vision（多模态）
```

注意：模型 ID 不带 `deepseek/` 等命名空间前缀（models.dev 等第三方目录的前缀写法在该端点会 404）。全局并发上限约 80（所有用户共享），高峰期常见 429；`response_format` JSON 模式在该后端偶发失效，代码已对其禁用（提示词约束 + 解析校验兜底）。限流默认 20 RPM/Key，可在面板调整。

注意：AMD 公共免费端点为体验级（无 SLA），高峰期可能 429/503；`response_format` JSON 模式在该后端不可靠，代码已对其禁用（提示词约束 + 解析校验兜底）。限流默认 20 RPM/Key，可在面板调整。

可选模型配置：

```bash
npx wrangler secret put GEMINI_MODEL
npx wrangler secret put GROQ_MODEL
npx wrangler secret put CEREBRAS_MODEL
npx wrangler secret put ZHIPU_MODEL
npx wrangler secret put NVIDIA_MODEL
npx wrangler secret put MISTRAL_MODEL
npx wrangler secret put DEEPSEEK_MODEL
npx wrangler secret put OPENROUTER_MODEL
```

### RPM 主动限流

Worker 在发起每一次 AI 调用前会先经过本地滑动窗口限流器（`src/rate-limit.ts`）：

- 每家 Provider 的默认上限 = 单 Key 免费档 RPM × 已配置 Key 数量：

```text
Gemini: 10 RPM/Key, Groq: 25 RPM/Key, Cerebras: 25 RPM/Key,
Zhipu: 15 RPM/Key, NVIDIA: 30 RPM/Key, Mistral: 20 RPM/Key,
DeepSeek: 100 RPM/Key（无公开限制）, OpenRouter: 15 RPM/Key
```

- 达到上限时不再硬撞上游 429，而是直接切到回退链中的下一家 Provider；
- 配合既有机制：上游返回 429 时自动故障转移，受限 Key 通过 D1 `api_key_health` 表冷却；
- 限流窗口按 Worker isolate 记账，Cron 任务为单并发顺序执行，足以保护免费档账号；
- 如需覆盖某家 Provider 的总 RPM，可配置可选 Secret（每家一个，值为数字）：

```bash
npx wrangler secret put GEMINI_RPM
npx wrangler secret put GROQ_RPM
npx wrangler secret put CEREBRAS_RPM
npx wrangler secret put ZHIPU_RPM
npx wrangler secret put NVIDIA_RPM
npx wrangler secret put MISTRAL_RPM
npx wrangler secret put DEEPSEEK_RPM
npx wrangler secret put OPENROUTER_RPM
```

这些 `*_RPM` 变量是普通配置（非敏感），CI 会自动同步；不设置时使用默认值。

默认模型为：

```text
Gemini: gemini-2.5-flash-lite
Groq: llama-3.1-70b-versatile
Cerebras: llama-3.3-70b
Zhipu: glm-4.7-flash
NVIDIA: meta/llama-3.3-70b-instruct
Mistral: mistral-large-latest
DeepSeek: deepseek-chat
OpenRouter: google/gemini-2.5-flash
```

### 参数归类

可用的 Worker Secret：

每家 AI 平台均支持 **40 个 Key** 的运行时 Key 池（搜索类 Tavily/Exa 为 60 个），命名规则 `<平台>_API_KEY`、`<平台>_API_KEY_2` … `<平台>_API_KEY_40`，按序轮询使用，受限 Key 自动冷却；面板 `/admin/secrets` 可直接在线维护全部 Key 槽位。

```text
GEMINI_API_KEY, GEMINI_API_KEY_2 … GEMINI_API_KEY_40
GROQ_API_KEY, GROQ_API_KEY_2 … GROQ_API_KEY_40
CEREBRAS_API_KEY, CEREBRAS_API_KEY_2 … CEREBRAS_API_KEY_40
ZHIPU_API_KEY, ZHIPU_API_KEY_2 … ZHIPU_API_KEY_40
NVIDIA_API_KEY, NVIDIA_API_KEY_2 … NVIDIA_API_KEY_40
AMD_API_KEY, AMD_API_KEY_2 … AMD_API_KEY_40  (AMD Radeon Cloud, 默认模型 deepseek/deepseek-v4-flash-0731)
MISTRAL_API_KEY, MISTRAL_API_KEY_2 … MISTRAL_API_KEY_40
DEEPSEEK_API_KEY, DEEPSEEK_API_KEY_2 … DEEPSEEK_API_KEY_40
OPENROUTER_API_KEY, OPENROUTER_API_KEY_2 … OPENROUTER_API_KEY_40
TAVILY_API_KEY, TAVILY_API_KEY_2 … TAVILY_API_KEY_60  (主搜索)
EXA_API_KEY, EXA_API_KEY_2 … EXA_API_KEY_60
BRAVE_API_KEY, BRAVE_API_KEY_2  (备用搜索, https://brave.com/search/api/)
FIRECRAWL_API_KEY  (可选, 反爬降级, https://www.firecrawl.dev/)
CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID  (面板引导凭据, 仅 Workers Scripts: Edit)
```

邮件发送还需要 Google Workspace Gmail 配置：

```text
GMAIL_SERVICE_ACCOUNT_EMAIL
GMAIL_SERVICE_ACCOUNT_KEY
GMAIL_SENDER_EMAIL
GMAIL_DAILY_LIMIT（可选）
GMAIL_SEND_DELAY_MS（可选）
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
GEMINI_API_KEY
```

可选：

```text
CLOUDFLARE_D1_DATABASE_ID
ADMIN_PANEL_TOKEN
```

仓库中的自动部署 workflow 为：

```text
.github/workflows/deploy-worker.yml
```

只有修改 `crm-ai-worker/**` 或 `.github/workflows/deploy-worker.yml` 并推送到 `main` 时，workflow 才会自动执行类型检查、Worker 部署并同步 AI、搜索和 Gmail Secrets；修改 Python 主项目不会触发 Worker 部署。也可以在 GitHub Actions 页面选择 `Deploy CRM AI Worker`，点击 `Run workflow` 手动触发。

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
GEMINI_MODEL
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

本地部署时确认 `wrangler.toml` 中的 `database_id` 已填写真实 D1 ID 后再部署。GitHub Actions 如果设置了 `CLOUDFLARE_D1_DATABASE_ID`，会复用该 D1；如果未设置，workflow 会自动创建名为 `crm-ai-db` 的 D1，并仅在运行目录临时注入 ID。创建和初始化远程 Schema 需要 Cloudflare API Token 的 `D1 → Edit` 权限。

```bash
npm run deploy
```

GitHub Actions 手动部署步骤：

1. 打开仓库的 **Actions** 页面；
2. 选择 `Deploy CRM AI Worker`；
3. 点击 **Run workflow**，选择 `main`；
4. 查看配置检查、类型检查和部署步骤日志。

部署前如需再次同步远程 Schema：

```bash
npx wrangler d1 execute crm-ai-db --remote --file=./schema.sql
```

workflow 会在部署前检查远程 D1 是否存在 `customers` 表，并通过并发锁避免 push 与手动部署同时修改同一个数据库。部署后（或手动）执行一次 `npx wrangler d1 execute crm-ai-db --remote --file=./schema.sql` 以创建 `api_configs` / `provider_settings` 动态 Key 池表。

### D1 客户管理面板

访问已部署 Worker 的：

```text
https://crm-ai-worker.qdu.workers.dev/admin
```

在 GitHub 仓库 Secrets 添加：

```text
ADMIN_PANEL_TOKEN
```

请使用随机长字符串作为值，不要将其写入代码或发送到聊天。部署 workflow 会自动同步该 Secret；未设置时 `/admin` 会保持禁用。

面板支持搜索、分页、查看详情、修改客户字段，以及将客户设为 `pending` 重新处理。`id` 和 `company_id` 始终只读。

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
- AI 分析前会先执行本地数据清洗（`cleanResearchContextForAi`）：剔除导航/页脚/cookie 横幅等样板行、跨来源去重、并按块与全局预算截断（单块 4.5K 字符，总量 30K 字符），显著降低 AI token 消耗；原始研究全文仍保留在 `full_research_text` 供审计；
- 搜索引擎回退链：Tavily → Brave → Searlo → Exa → DuckDuckGo。Brave Search 免费档约 2,000 次/月（无需信用卡），Key 池支持 `BRAVE_API_KEY`、`BRAVE_API_KEY_2`；
- 主网站被反爬拦截（HTTP 403/503）或需 JS 渲染时，自动降级用 Firecrawl 无头渲染抓取一次（可选 Key `FIRECRAWL_API_KEY`，未配置时自动跳过）；
- 确认被反爬拦截且降级失败的客户标记为「需人工复审」并归入 failed，不消耗重试次数；修复后可在管理面板重新置为 pending；
- Gemini 请求超时为 15 秒；
- 单个客户失败不会影响同批其他客户；
- 所有成功或失败结果通过一次 `env.DB.batch()` 批量写回；
- `personas_and_solutions` 始终以 JSON 字符串写入；
- `remarks` 末尾自动追加：

```text
【合并数据公司ID: 对应的company_id】
```

- AI 使用 Gemini → Groq → Cerebras → Zhipu → NVIDIA → Mistral → DeepSeek → OpenRouter 的回退链，Key 被限流时进入冷却，避免重复调用受限 Key；
- AI 只能处理网页文本并写入画像字段，不能执行任意 SQL；
- outreach 面板支持 Afarer（SUPs）和 Neptunor（RIB Boats + Inflatable Boats）两种品牌身份，可分别设置发件人、签名和附件；
- D1 写回使用 `WHERE id = ? AND status = 'processing'`，避免过期任务覆盖新状态。

## D1 Schema

表结构定义在：

```text
schema.sql
```

字段包括：

```text
customers: id, company_id, domain, status, customer_segment, personas_and_solutions, remarks, updated_at
outreach_settings: brand_name, product_category, company_intro, sender_email, sender_name, signature, enabled
outreach_attachments: brand_name, filename, mime_type, size_bytes, content_base64
outreach_emails: customer_id, email_to, brand_name, subject, body, status, sent_at
api_key_health: provider, key_index, exhausted_until, last_error
gmail_send_log: outreach_email_id, recipient, status, detail, sent_at
```

并为 `status` 和 `company_id` 建立索引。
