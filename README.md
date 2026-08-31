
## Cloudflare D1 + AI CRM Worker

独立的 Cloudflare Workers 定时任务位于 `crm-ai-worker/`，每 5 分钟从 D1 原子认领最多 3 条客户记录，抓取网页并调用 OpenRouter 生成客户画像。

```bash
cd crm-ai-worker
npm install
npx wrangler d1 create crm-ai-db
# 将返回的 database_id 填入 wrangler.toml
npx wrangler d1 execute crm-ai-db --remote --file=./schema.sql
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler dev --test-scheduled
```

详细的本地测试、D1 初始化、Cron 手动触发和 Worker 发布步骤见：

```text
crm-ai-worker/README.md
```
