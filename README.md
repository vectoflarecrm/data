# CRM AI Worker

Cloudflare Workers 上的客户情报 + 销售一体化系统：定时抓取客户信息 → 多引擎搜索补全 → 前置清洗 → AI 分析 → 回写 D1 → 结构化档案驱动开发信 → CRM 销售层（公司/联系人/商机看板/任务）跟进成交。

## 架构

- **Worker + Cron**（`*/5 * * * *`）：研究管线（认领 `pending` 客户，抓取→清洗→分析→写回）；空闲 tick 顺带跑群发自动推进与 Gmail 入站同步
- **D1**（`crm-ai-db`）：客户数据、研究分层、API Key 池、开发信、CRM 销售层（33 个迁移演进）
- **CRM 销售层**：公司/联系人/商机（六段看板状态机）/任务时间线；赢单转客户、输单原因、CSV 导入、加权预测统计、Gmail 入站来信自动匹配时间线
- **AI Provider 池**（9 家，自动故障转移）：Gemini → Groq → Cerebras → Zhipu → NVIDIA → AMD → Mistral → DeepSeek → OpenRouter，全部 429/超时毫秒级熔断切换
- **搜索 Key 池**（4 家）：Tavily（主）→ Exa → Searlo → DuckDuckGo（免 Key 兜底）
- **本地 Gemini Web Pool**：`/v1/chat/completions` 兼容网关（可选备用通道）

## 控制面板

```text
https://<worker-domain>/admin           客户管理 + 评分分布 + CSV 导入 + 海选预过滤（筛选项下拉勾选）
https://<worker-domain>/admin/crm       CRM 销售：公司/联系人列表、商机看板拖拽、
                                        统计仪表、任务分组顺延、CSV 导入、Gmail 来信时间线
https://<worker-domain>/admin/keys      动态 Key 池 / 冷却监控 / 用量 / 凭据加密
https://<worker-domain>/admin/outreach  开发信生成、Gmail 发送、🎯 定向群发
https://<worker-domain>/admin/audit     审计日志（只读，action 过滤 + 分页）
https://<worker-domain>/admin/sessions  活跃会话清单与吊销（super_admin）
https://<worker-domain>/admin/security  WebAuthn 通行密钥自助管理
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
npm test          # vitest（1052 个测试 / 83 个文件）
npm run typecheck
node scripts/check-panel.mjs   # 校验全部 8 个面板模板：JS 可解析、id 唯一、getElementById 有对应元素
npx wrangler dev --test-scheduled
```

## 部署

推送到 `main` 即自动部署：GitHub Actions 依次跑 D1 schema 初始化 → 列迁移（`customers` 增补列、
`api_configs` 凭据列）→ typecheck → 单测 → `wrangler deploy` → 可选同步 Secrets
（`SYNC_SECRETS_FROM_GITHUB` opt-in）。

已存在的线上库用 `crm-ai-worker/migrations/` 升级；全新库直接跑 `schema.sql` 即可。
Secrets 集中在 GitHub 仓库 Actions Secrets 管理；运行时 Key 优先读 D1（面板可动态增删），env Secret 池作为兜底。

## 文档

- [`TECH.md`](TECH.md) —— **当前技术快照**：技术栈、系统架构、模块清单、
  数据模型（含 CRM 销售层与 Gmail 入站同步）、安全摘要、测试与部署
- [`crm-ai-worker/README.md`](crm-ai-worker/README.md) —— 技术文档：管道各阶段、
  参数、评分公式、Schema、设计决策与替代方案评估
- [`crm-ai-worker/docs/`](crm-ai-worker/docs/) —— 阶段推进记录（stages/）、
  Phase 设计文档、Security V2 报告、Gmail 账号配置等

## 默认模型

- Gemini：`gemini-3.5-flash-lite`（30 RPM/Key、高 TPM，批量提取主力），回退 `gemini-3.1-flash-lite → gemini-3.6-flash → gemini-flash-latest`
- 可通过 `GEMINI_MODEL` Secret 或面板按 Key 覆盖
