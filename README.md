# CRM AI Worker

Cloudflare Workers 上的客户情报自动化管道：定时抓取客户信息 → 多引擎搜索补全 → 前置清洗 → AI 分析 → 回写 D1。

## 架构

- **Worker + Cron**（`*/5 * * * *`）：每 5 分钟认领 `pending` 客户，执行 抓取→清洗→分析→写回 全流程
- **D1**（`crm-ai-db`）：客户数据、API Key 池、健康状态、用量统计
- **AI Provider 池**（9 家，自动故障转移）：Gemini → Groq → Cerebras → Zhipu → NVIDIA → AMD → Mistral → DeepSeek → OpenRouter，全部 429/超时毫秒级熔断切换
- **搜索 Key 池**（4 家）：Tavily（主）→ Brave → Searlo → Exa → DuckDuckGo（免 Key 兜底）
- **本地 Gemini Web Pool**：`/v1/chat/completions` 兼容网关（可选备用通道）

## 控制面板

```text
https://<worker-domain>/admin           客户管理 + 评分分布 + CSV 导入 + 海选预过滤
https://<worker-domain>/admin/keys      动态 Key 池 / 冷却监控 / 用量 / 凭据加密
https://<worker-domain>/admin/outreach  开发信生成、Gmail 发送、🎯 定向群发
https://<worker-domain>/admin/secrets   经 Cloudflare API 直写 Worker Secrets
```

- **Key 池**：各平台 API Key 增删改查、批量导入（Excel/CSV 两列直接粘贴：`key,备注`）、自动去重
- **凭据加密**：D1 中的 Key 以 AES-GCM 密文存储（`api_configs.api_key`），面板只显示 `AIzaSy…x7f2` 提示位。
  未配置 `CREDENTIAL_ENC_KEY` 时**拒绝新增/导入**（fail closed），但存量明文 Key 照常可用。
  详见 [`crm-ai-worker/README.md` 凭据加密](crm-ai-worker/README.md#凭据加密d1-中的-key-明文存储)
- **每分钟 RPM 滑动窗口限流**（主动预检，超额自动跳到下一家）+ 🧊 冷却视图 + 📊 本月用量卡片
- **定向群发**：按海选条件圈客、创建时快照名单、分批生成草稿并续跑发送（配额用完按批次中止而非丢弃）

## 安全边界

仓库是公开的，以下三点决定了安全设计的取舍：

| 面 | 现状 |
|---|---|
| 面板登录 | `ADMIN_PANEL_TOKEN` + 常数时间比较；同 IP 5 次失败锁定 15 分钟，全局 30 次兜底（防轮换 IP 的分布式喷洒），计数存 D1 而非 isolate 内存 |
| 错误信息 | 500 一律不回显内部错误（D1 约束名、供应商 URL 等），只返回 `request_id`，完整堆栈进 Worker 日志；操作员可自行修复的 400 保持原文 |
| D1 凭据 | `api_configs.api_key` 密文存储。**边界**：加密密钥存 Worker Secret，与 `ADMIN_PANEL_TOKEN` 同级保护——拿到它的人本就能控制 Worker。因此它挡的是「D1 单独泄露」（CF 凭据泄露、D1 导出、日志外泄），**不挡面板被攻破** |

`wrangler.toml` 只保留 `REPLACE_WITH_D1_DATABASE_ID` 占位符，真实 D1 ID 放在 gitignored 的
`wrangler.local.toml`，以保证仓库可被直接 fork 部署。

## 开发

```bash
cd crm-ai-worker
npm ci
npm test          # vitest（148 个测试 / 10 个文件）
npm run typecheck
node scripts/check-panel.mjs   # 校验全部 5 个面板模板：JS 可解析、id 唯一、getElementById 有对应元素
npx wrangler dev --test-scheduled
```

## 部署

推送到 `main` 即自动部署：GitHub Actions 依次跑 D1 schema 初始化 → 列迁移（`customers` 增补列、
`api_configs` 凭据列）→ typecheck → 单测 → `wrangler deploy` → 可选同步 Secrets
（`SYNC_SECRETS_FROM_GITHUB` opt-in）。

已存在的线上库用 `crm-ai-worker/migrations/` 升级；全新库直接跑 `schema.sql` 即可。
Secrets 集中在 GitHub 仓库 Actions Secrets 管理；运行时 Key 优先读 D1（面板可动态增删），env Secret 池作为兜底。

## 文档

- [`crm-ai-worker/README.md`](crm-ai-worker/README.md) —— 技术文档：管道各阶段、
  参数、评分公式、Schema、设计决策与替代方案评估
- [`crm-ai-worker/docs/gmail-account-setup.md`](crm-ai-worker/docs/gmail-account-setup.md)
  —— Gmail 发送账号配置（OAuth / 服务账号）

## 默认模型

- Gemini：`gemini-3.5-flash-lite`（30 RPM/Key、高 TPM，批量提取主力），回退 `gemini-3.1-flash-lite → gemini-3.6-flash → gemini-flash-latest`
- 可通过 `GEMINI_MODEL` Secret 或面板按 Key 覆盖
