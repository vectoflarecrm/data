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

## 分层清洗与开发信上下文（结构化档案）

管道遵循「机械清洗 → 语义提取 → 入库关联 → 开发信调用」四层设计：

1. **规则预清洗**（`cleanResearchContextForAi`）：零 token 成本剔除导航/页脚/重复块；`full_research_text` 保留原始多源文本供审计。
2. **语义提取**（AI Structured Output）：每条客户额外产出两份 JSON 列——
   - `company_profile`：公司背景、主营产品线、下游客户群体、核心卖点；
   - `outreach_context`：推荐切入角度 + 可引用的具体事实（开发信素材）。
   全部要求基于证据，无据可依的字段留空，严禁臆测。
3. **入库关联**：合并数据在 `remarks` 中带【合并数据公司ID: xxx】标记，可追溯。
4. **开发信生成**（outreach 模块）：prompt 优先引用 `company_profile`/`outreach_context` 结构化档案，原始研究文本降级为 2000 字符的兜底参考——开发信引用的都是清洗后的高信号内容，不再需要现读原始网页。

## 技术架构与流程详解（供方案评估）

### 运行环境与硬约束

```text
运行时:      Cloudflare Workers 免费版（无 CPU 超时问题：全流程为 I/O 等待，
             CPU 时间每请求仅数 ms，远低于免费档上限）
调度:        Cron Trigger "*/5 * * * *"，每 tick 处理 BATCH_SIZE=3 个客户
存储:        D1 (crm-ai-db)，SQLite 方言，免费档 500 万行读/10 万行写每天
子请求上限:  免费版单次调用 50 个 fetch 子请求 —— 这是 BATCH_SIZE=3 的
             决定性约束（每客户约 15-20 个子请求：6 搜索 + 5 结果页 +
             子页面/社媒 + AI 调用），已达上限边缘
 wall clock: 单客户约 3-4 分钟（研究 2-3 min + AI 0.5-1 min），3 个并行
```

### 管道各阶段（输入/输出/成本/失败模式）

```text
阶段 0  原子认领
        一条 UPDATE ... RETURNING 认领 id 最小的 3 条 pending（无 SELECT-
        then-UPDATE 竞态）；processing 超 30 分钟的任务自动回收为 pending。
        失败模式：无（纯 SQL）。

阶段 1  主站抓取（免费）
        fetchWebsite（15s 超时、浏览器 UA）→ HTMLRewriter 流式抽取
        title/meta/p/h1/h2/li + mailto:/tel: href + JSON-LD 结构化数据。
        403/503 反爬 → Firecrawl 无头渲染降级（1 次）。
        输出：pageText ≤15k 字符 + 社媒链接 + wa.me 链接。
        失败模式：DNS/SSL/404 永久失败；403 走降级；其余跳过主站仅用搜索。

阶段 2  社媒验证（免费）
        extractLinks 抓到的社媒/wa.me 链接逐个 HEAD 校验（1s 间隔），
        结果写 social_accounts_verified（JSON）。

阶段 3  多引擎搜索（Tavily Credits / 免费）
        6 条查询模板（联系方式×2、LinkedIn×3、业务×1），每条独立走
        Tavily→Brave→Searlo→Exa→DuckDuckGo 链；结果去噪（维基/视频页）、
        剔除自有域名、跨查询 URL 去重、内容前缀去重（不同查询命中同页只
        抓一次）；取前 5 个结果页抓正文（LinkedIn 优先，6k 字符预算，其余
        4k），并对其做规则级联系方式提取（[直接提取] 行）。
        成本：Tavily advanced=2 Credits/查询（主消耗，Key 池 500 次/Key/月）；
        重试行命中研究复用路径时整段跳过（0 Credits）。

阶段 4  子页面抓取（免费）
        /about /contact /team /products 等最多 3 页，与主站文本前缀去重
        （首页介绍原文重复的子页直接跳过）；社交页最多 3 页。

阶段 5  研究文本落库
        全部来源拼装 ≤50k 字符存 full_research_text（审计 + 重试复用依据）。

阶段 6  清洗与事实预提取（免费，零 token）
        cleanResearchContextForAi：行级噪声模式剔除（导航/页脚/cookie）、
        块内去重、跨块哈希去重、单块 4k/总量 22k 字符预算截断。
        buildFactsBlock：正则提取邮箱/电话/社媒/wa.me + JSON-LD 公司名/
        电话/邮箱/sameAs/地址，作为「规则预提取事实」块置顶 —— AI 不必在
        正文里重复扫描联系方式。

阶段 7  AI 结构化分析（token 主要消耗点）
        输入：事实块 + 清洗后正文 ≤24k 字符（≈5-6k tokens）。
        路径 A（主）：Gemini 原生 API，responseMimeType=application/json +
        responseSchema 硬约束输出结构（profile/evidence/signals 均在
        schema 内）；温度 0.1。
        路径 B（备）：OpenAI 兼容 /chat/completions，json_object 模式
        （AMD 后端不可靠，已对该平台禁用，用提示词约束 + 解析校验兜底）。
        Provider 链：Gemini → Groq → Cerebras → Zhipu → NVIDIA → AMD →
        Mistral → DeepSeek → OpenRouter；共享 60s AbortController，超时
        如实上报（不伪装成「全部 Provider 不可用」）。
        输出 JSON：segment/categories/size/coverage/personas/found_contacts/
        company_profile/outreach_context/field_evidence/buying_signals/remarks。

阶段 8  写回（一次 env.DB.batch()）
        联系人指纹去重（姓名|邮箱|电话|wa 全小写拼接）→ contacts 表；
        field_evidence 删旧插新 → evidence 表（字段级来源 URL + 原文引用
        + 置信度 0-1）；lead_score（0-100 确定性公式）与画像列写入
        customers；WHERE id=? AND status='processing' 防过期覆盖。
```

### lead_score 评分公式（确定性，无 AI 参与）

```text
客户细分命中目标行业   +30   产品类别命中        +25
找到联系方式           +15   找到邮箱             +5
有姓名联系人           +10   有采购信号           +10
规模/地理覆盖完整      +5+5                       上限 100
用途：面板直查 SQL 筛选高分客户，无需重跑 AI；
面板柱状图（≥80 / 60-79 / 40-59 / <40 / 未评分）实时展示分布。
```

### 状态与用量可观测性

```text
customers.status:   pending → processing → completed / failed
重试语义:           限流/超时 = 无限重试（环境性）；其余 ≤3 次
                    （remarks 内 [retry:N] 标签）；403 反爬 = 人工复审
api_key_usage:      provider × key_index × day 的成功计数（面板 📊 卡片）
api_key_health:     被限 Key 的冷却截止时间与最近错误（面板 🧊 可一键清除）
evidence 表:        每条核心判断的 source_url + evidence_text + confidence
                    （详情弹窗「证据链」区展示，无需重爬即可核验）
```

### 面板端点一览

```text
/admin                 客户 CRUD + 评分分布卡 + CSV 导入 + 海选预过滤
/admin/keys            动态 Key 池（D1，即时生效）/ 冷却监控 / 用量卡片
/admin/secrets         经 Cloudflare API 直写 Worker Secrets（40 槽位）
/admin/outreach        开发信生成与 Gmail 发送（结构化档案驱动，按国家语言）
GET  /admin/api/customers?min_lead_score=   列表/筛选
POST /admin/api/customers/import            CSV 原始层 → 去重入队
GET  /admin/api/customers/pre-filter        SQL 海选（不花 AI token）
GET  /admin/api/customers/lead-score-histogram  评分分布
GET  /admin/api/customers/:id               详情（含 contacts + evidence）
GET  /admin/api/keys/usage                  平台用量/容量汇总
```

### 关键设计决策与理由（评估替代方案时的对照基线）

```text
1. Cron 拉取而非消息队列   D1 单条 UPDATE 认领已消除并发重复，免排队
   运维；代价是吞吐受 50 子请求/调用硬上限约束（BATCH_SIZE=3 封顶）。
2. 研究文本落库 + 重试复用  管道中搜索 Credits 最稀缺（1k/月/Key），
   所有可重试失败都发生在研究之后，重试只补 AI 调用 —— 回填 186 行
   实测 0 Tavily 消耗。
3. 规则优先、AI 兜底       邮箱/电话/JSON-LD/去重全部零 token 完成；
   AI 只做语义判断，输入预算 30k→22k 字符后同额度池可服务约 2 倍请求。
4. per-isolate 滑动窗口限流 无需 Durable Objects：Cron 单并发 + 免费档
   低流量下足够；若未来多 Worker 并发写同一上游，需迁移到 DO 全局限流。
5. D1 即 Key 池 + 冷却状态  面板改 Key 即时生效、免部署；env Secrets
   兜底保证面板清空不停服。
6. 结构化输出双路径        Gemini 用 responseSchema 硬约束；OpenAI 兼容
   平台用 json_object + 提示词 + parseAnalysis 校验 —— 保证任何一家
   顶上时输出结构一致。
```

## 现有瓶颈与替代方案评估（持续优化清单）

按「收益/成本」排序，供评估更好的方案或工具时对照：

| # | 现状与瓶颈 | 候选替代方案 | 收益 | 代价 |
|---|---|---|---|---|
| 1 | 吞吐受 50 子请求/调用限制，BATCH_SIZE=3 封顶 | **Cloudflare Queues**：每客户一条消息，消费者逐条处理，天然并行且无子请求聚合问题 | 吞吐与队列深度线性扩展，不再受单调用限制 | 付费计划（$5/月起，Queues 需 Workers Paid） |
| 2 | per-isolate 限流窗口在多 Worker/多区域并发时会低估真实 RPM | **Durable Objects** 全局限流器（强一致单例） | 精准保护上游免费档，杜绝多节点叠加 429 | 增加一跳 DO 调用延迟；免费额度够用但代码复杂度上升 |
| 3 | 同一域名重新研究时仍会重新抓主站（仅复用 full_research_text） | **KV 页面缓存**：URL→文本 24h TTL | 跨行去重（同集团多客户）、人工复审后重跑省抓取 | KV 读免费档 10 万次/天充裕；需失效策略 |
| 4 | AI 每客户一次全量分析（约 5-6k input tokens） | **Workers AI 两级过滤**：先用 @cf/meta/llama（免费 Neurons）做「是否相关行业」粗分类，不相关直接跳过 Gemini | 不相关客户（实测约 30-40%）零付费 token | 需维护两级 prompt；粗分类错误会漏掉边缘客户 |
| 5 | 文本清洗基于行模式与哈希去重，近似重复（同一新闻多站转载）仍会通过 | **Embedding 近似去重**（Workers AI bge-m3 + Vectorize） | 再省 10-20% 输入 token；可顺带做客户相似度聚类 | 首条需入库向量；增加一次 embedding 调用/来源块 |
| 6 | 开发信个性化依赖单客户档案，无跨客户记忆 | **Vectorize RAG**：把 company_profile 向量化，写开发信时召回同细分/同区域客户案例做风格参考 | 开发信质量提升 | 存储/查询成本低，但收益偏质量而非省钱 |
| 7 | Firecrawl 降级仅 1 次且配额有限（免费 500 次/月） | **Cloudflare Browser Rendering** 绑定（付费计划含免费额度）替代/并列 Firecrawl | 同账号内闭环，无第三方配额 | 需 Workers Paid；冷启动略高 |
| 8 | 搜索依赖 SaaS（Tavily/Exa/Brave）月额度 | **SearXNG 自托管**（VPS）作最后兜底（现已用 DuckDuckGo HTML 兜底，稳定性一般） | 搜索无额度上限 | 需维护一台 VPS；自托管引擎有被封锁风险 |
| 9 | 研究文本 50k 字符全量存 D1（行数多后表体积大） | **R2 归档**：>30 天的 full_research_text 移到 R2，D1 只留摘要 | D1 行读成本与体积下降 | 需归档 cron 与读取回源逻辑 |
| 10 | 回退链固定顺序，未按「每 token 实际产出质量」动态排序 | 按 provider 记录 lead_score 达成率，动态调整链序 | 同 token 产出更高分客户 | 需要统计窗口与再平衡逻辑 |

**结论基线**：当前架构在免费额度内的单位成本约为「每客户 1 次搜索消耗 + 5-6k AI input tokens」；上述 1/3/4/5 任一落地都可再降 30%+ 成本或翻倍吞吐。若项目升级为生产级批量（>5 万客户/月），优先做 #1（Queues）+ #4（两级过滤）组合。

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
- 📊 本月用量卡片：每个平台的成功调用次数（本月/累计）、活动 Key 数、冷却数、以及搜索平台的免费容量估算进度条（Tavily 500 次深度搜索/Key、Exa ~2000 次/Key、Brave 2000 次/Key）；
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
Gemini: gemini-3.5-flash-lite
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
AMD_API_KEY, AMD_API_KEY_2 … AMD_API_KEY_40  (AMD Radeon Cloud, 默认模型 DeepSeek-V4-Flash)
MISTRAL_API_KEY, MISTRAL_API_KEY_2 … MISTRAL_API_KEY_40
DEEPSEEK_API_KEY, DEEPSEEK_API_KEY_2 … DEEPSEEK_API_KEY_40
OPENROUTER_API_KEY, OPENROUTER_API_KEY_2 … OPENROUTER_API_KEY_40
TAVILY_API_KEY, TAVILY_API_KEY_2 … TAVILY_API_KEY_60  (主搜索)
EXA_API_KEY, EXA_API_KEY_2 … EXA_API_KEY_60
BRAVE_API_KEY, BRAVE_API_KEY_2  (备用搜索, https://brave.com/search/api/)
FIRECRAWL_API_KEY  (可选, 反爬降级, https://www.firecrawl.dev/)
CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID  (面板引导凭据, 仅 Workers Scripts: Edit)
```

### 搜索平台免费额度与重置（2026-09 核实）

| 平台 | 免费额度 | 计费规则 | 重置时间 |
|---|---|---|---|
| Tavily | 1,000 Credits / 月/账号 | `basic` 搜索 1 Credit/次；`advanced` 搜索 2 Credits/次（即 500 次）；`extract` 每 5 个网页扣 1 Credit | 自然月每月 1 号 UTC 0:00，所有账号统一 |
| Exa | **$10 额度 / 月/账号**（注册另送 $20，约 2,800 次搜索） | 按 $ 计费：搜索约 $5/千次（`auto`），抓取正文按结果条数另计 | 滚动账单周期：按各账号注册日每 30 天重置（Dashboard → Usage & Billing 显示 *Resets on 日期*） |
| Brave Search | 2,000 次 / 月/账号 | 网页搜索 1 次/请求 | 自然月 1 号 |

多账号（Key 池）额度线性叠加：例如 10 个 Tavily Key = 10,000 Credits/月；本项目 `advanced` 深度搜索为主，单个 Tavily Key 实际可用约 **500 次深度搜索/月**。Exa 按 $ 扣费且周期独立于自然月，适合作为 Tavily 额度耗尽后的接力层（面板冷却机制会在 429/额度耗尽时自动切换到下一个 Key/平台）。每次成功调用的用量计入 D1 `api_key_usage` 表（按天分 Key 统计），面板 📊 卡片实时汇总。

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
