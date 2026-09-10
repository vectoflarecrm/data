# CRM AI Worker

Cloudflare Workers 上的客户情报自动化管道：定时抓取客户信息 → 多引擎搜索补全 → 前置清洗 → AI 分析 → 回写 D1。

## 架构

- **Worker + Cron**（`*/5 * * * *`）：每 5 分钟认领 `pending` 客户，执行 抓取→清洗→分析→写回 全流程
- **D1**（`crm-ai-db`）：客户数据、API Key 池、健康状态、用量统计
- **AI Provider 池**（9 家，自动故障转移）：Gemini → Groq → Cerebras → Zhipu → NVIDIA → AMD → Mistral → DeepSeek → OpenRouter，全部 429/超时毫秒级熔断切换
- **搜索 Key 池**（4 家）：Tavily（主）→ Brave → Searlo → Exa → DuckDuckGo（免 Key 兜底）
- **本地 Gemini Web Pool**：`/v1/chat/completions` 兼容网关（可选备用通道）

## 控制面板

```
https://<worker-domain>/admin/keys
```

- 各平台 API Key 增删改查、批量导入（Excel/CSV 两列直接粘贴：`key,备注`）
- 每分钟 RPM 滑动窗口限流（主动预检，超额自动跳到下一家）
- 🧊 冷却视图（429/配额耗尽的 Key 自动停用）+ 📊 本月用量卡片

## 开发

```bash
cd crm-ai-worker
npm ci
npm test        # vitest
npm run typecheck
npx wrangler dev
```

## 部署

推送到 `main` 即自动部署（GitHub Actions：测试 → typecheck → `wrangler deploy` → 同步 Secrets）。
Secrets 集中在 GitHub 仓库 Actions Secrets 管理；运行时 Key 优先读 D1（面板可动态增删），env Secret 池作为兜底。

## 默认模型

- Gemini：`gemini-3.5-flash-lite`（30 RPM/Key、高 TPM，批量提取主力），回退 `gemini-3.1-flash-lite → gemini-3.6-flash → gemini-flash-latest`
- 可通过 `GEMINI_MODEL` Secret 或面板按 Key 覆盖
