# TECH — 技术架构文档

> 本文是整个仓库的**当前**技术快照：技术栈、系统架构、模块结构、数据模型、
> 四条自动化链路与质量保障。深度细节（安全 V2 全量报告、各 Phase 设计文档、
> 阶段推进记录）见 [`crm-ai-worker/docs/`](crm-ai-worker/docs/)，
> 历史脉络型的长文档见 [`crm-ai-worker/README.md`](crm-ai-worker/README.md)。
>
> 最近一次大规模更新：CRM 销售层 + 七项销售增强（详见 §7）。

## 1. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 运行时 | Cloudflare Workers（免费档） | 全 I/O 等待型负载，CPU 每请求数 ms |
| 存储 | Cloudflare D1（SQLite 方言） | 单库 `crm-ai-db`，研究/开发信/CRM 共享 |
| 调度 | Cron Trigger `*/5 * * * *` | 研究、自动推进、Gmail 入站同步共用一个 tick |
| 全局限流 | Durable Object（可选 `RATE_LIMITER` 绑定） | 每 provider-key 一个 DO 实例的全局滑动窗口 |
| AI 分析 | 9 家 Provider 回退链 | Gemini → Groq → Cerebras → Zhipu → NVIDIA → AMD → Mistral → DeepSeek → OpenRouter，429/超时毫秒级熔断切换 |
| 相关性预检 | Workers AI `@cf/meta/llama-3.1-8b-instruct-fast` | 免费额度，不相关客户零付费 token，fail-open |
| 搜索 | Tavily → Exa → Searlo → DuckDuckGo | Key 池轮询，429/额度耗尽自动冷却切换 |
| 邮件 | Gmail API（OAuth refresh token / 服务账号全域委托） | 账号池 + 每日配额原子预留 + 发送状态机 |
| 语言 | TypeScript（严格模式，`tsc --noEmit` 零错误） | 无前端框架：8 个面板均为服务端模板字符串 + 手写 JS |
| 测试 | Vitest + `node:sqlite`（`:memory:` FakeD1） | 83 文件 / 1052 测试，全离线 |
| CI/CD | GitHub Actions（push `main` 即部署） | D1 schema 初始化 → 迁移 → typecheck → 测试 → deploy |

## 2. 系统架构总览

一个 Worker（`crm-ai-worker`）承载四条业务链路，共享同一 D1：

```text
                    ┌──────────────────────────────────────────────┐
                    │  Cloudflare Worker (crm-ai-worker)           │
                    │                                              │
 Cron */5 * * * * ─▶│  ① 研究管线：认领 pending 客户 → 抓取/搜索 →   │
                    │     清洗 → 相关性预检 → AI 分析 → 写回评分     │
                    │     （空闲 tick 让位给 ②③④）                  │
                    │                                              │
 管理面板 ─────────▶│  ② 开发信/群发：结构化档案生成草稿 → Gmail 发送 │
 (8 个 HTML 面板)   │     状态机 + 配额预留 + ⚡自动推进             │
                    │                                              │
                    │  ③ CRM 销售层：公司/联系人/商机/任务 CRUD、    │
                    │     看板拖拽、CSV 导入、统计、审计             │
                    │                                              │
                    │  ④ Gmail 入站同步：空闲 tick 拉发件邮箱收件箱，│
                    │     客户回复匹配成 CRM 时间线                  │
                    └───────────────┬──────────────────────────────┘
                                    │
                                    ▼
                    D1 (crm-ai-db)：33 个迁移演进至今的单库
```

链路间的联动（`src/crm-hooks.ts` + `src/crm-gmail-sync.ts`）：

- 研究完成 → 客户可提升为 CRM 销售公司（`lead_promoted` 时间线）；
- 开发信发出 → CRM 时间线 `cold_email_sent` + lead_status 推进；
- CRM 标记淘汰（disqualified）→ 研究快照/生成/发送全部跳过该客户；
- 客户回复邮件 → CRM 时间线 `email_received`。

## 3. 仓库结构

```text
vectoflarecrm/
├── README.md                 项目概览（架构 / 快速开始 / 部署）
├── TECH.md                   本文：当前技术快照
├── crm-ai-worker/            Worker 项目（全部业务代码）
│   ├── src/                  源码（见 §4 模块清单）
│   ├── tests/                83 个测试文件（1052 测试）
│   ├── migrations/           0001–0033 D1 增量迁移
│   ├── schema.sql            全新库一次性建表脚本
│   ├── docs/                 设计文档：stages/（阶段推进）、phases、
│   │                         security-v2、gmail-account-setup、backup…
│   ├── scripts/              check-panel.mjs（面板自检）、
│   │                         get-gmail-refresh-token.py（OAuth 授权）
│   └── wrangler.toml         D1 ID 占位符（真实 ID 在 gitignored
│                             wrangler.local.toml / CI Secret）
└── .github/workflows/deploy-worker.yml   push 即部署
```

## 4. 核心模块（`crm-ai-worker/src/`）

| 模块 | 行数 | 职责 |
|---|---:|---|
| `index.ts` | 2857 | Worker 入口：Cron 调度、研究管线（认领→抓取→分析→写回）、相关性预检、空闲 tick 汇聚（自动推进/逾期任务日志/Gmail 入站同步） |
| `admin.ts` | 6307 | 面板路由 + 8 个 HTML 面板模板（含 CRM 销售面板）+ 全部 `/admin/api/*` REST 端点 |
| `crm.ts` | 1437 | **CRM 销售层 API**：公司/联系人/商机/任务 CRUD、看板排序/归档、联系人合并、CSV 导入、聚合统计（见 §7） |
| `crm-gmail-sync.ts` | 332 | **Gmail 入站同步**：收件箱拉取 → 联系人/域名匹配 → 时间线（见 §7.4） |
| `crm-hooks.ts` | 129 | 流水线 ↔ CRM 联动挂钩（提升/发信回写/淘汰过滤/逾期任务），全部 fail-open |
| `campaigns.ts` | 1384 | 定向群发：筛选 DSL、客群 CRUD、生成/发送两步状态机、⚡自动推进、per-person 多触点 |
| `outreach.ts` / `outreach-send.ts` | 1189 / 294 | 开发信生成（结构化档案驱动）；crash-safe 发送状态机 |
| `gmail.ts` / `gmail-quota.ts` | 716 / 122 | OAuth/服务账号令牌、账号池、冷却；配额原子预留（INSERT…SELECT + TTL 回收） |
| `research-run.ts` | 740 | 研究分层落库：runs/sources/facts/signals/personas/profiles（append+supersede 版本链） |
| `contact-merge.ts` | 259 | 同人合并规划器（渠道身份 + 姓名相容） |
| `lead-score-dims.ts` / `lead-score-engine.ts` / `lead-score-config.ts` | 37 / 159 / 186 | 六维评分：维度定义、比例引擎、可调权重（单行配置表 + 存量重算） |
| `facets.ts` / `provider-keys.ts` / `key-pool.ts` / `bulk-keys.ts` | 314 / 242 / 50 / 77 | 筛选候选、Key 池解析（D1 优先/env 兜底）、回退链、批量粘贴解析 |
| `credential-crypto.ts` | 209 | AES-GCM 加密 + HMAC 指纹 + HKDF 派生（`enc:v1:` 前缀协议） |
| `rate-limit.ts` / `rate-limiter.ts` | 153 / 233 | 三层限流：per-isolate 滑窗 → D1 固定窗 / DO 全局滑窗 → 429 反应式冷却 |
| `campaign-lock.ts` / `data-retention.ts` / `security-headers.ts` | 90 / 264 / 87 | 群发单飞锁；DATA_RETENTION_DAYS 清理；nonce-CSP 等安全响应头 |
| `src/auth/`（3 文件） | | RBAC 五角色权限门、WebAuthn 零依赖验证器、会话卫生 |
| `src/security/`（7 文件） | | cf-access、SSRF 守卫、csv-limits、origin-guard、脱敏、safe-log、request-context |
| `src/audit/`（2 文件） | | 审计写入与保留清理 |

## 5. 数据模型（D1）

表分组（完整 DDL 见 [`schema.sql`](crm-ai-worker/schema.sql)）：

```text
研究管线    customers, research_runs/sources/facts/signals/personas/profiles,
            evidence, customer_imports, contacts, lead_score_config
开发信      outreach_settings, outreach_attachments, outreach_emails,
            outreach_groups, outreach_campaigns, outreach_campaign_members,
            gmail_accounts, gmail_send_log, gmail_send_reservations,
            campaign_locks
CRM 销售层  crm_companies, crm_contacts, crm_deals, crm_activities,
            crm_mail_sync, crm_mail_seen
Key 池      api_configs, provider_settings, api_key_health, api_key_usage,
            rate_limit_windows
安全/运维   admin_users, admin_sessions, admin_login_attempts,
            webauthn_credentials/challenges/recovery_codes, audit_logs
```

迁移索引（`crm-ai-worker/migrations/`，CI 每次部署幂等重放）：

| 迁移 | 内容 |
|---|---|
| `0001`–`0003` | 发送主体、附件语言、Gmail 账号池 |
| `0004`–`0006` | 定向群发三表、登录限流表、api_configs 凭据列 |
| `0007`–`0019` | Security V2：会话、审计、发送状态机+幂等索引、配额预留、群发锁、research 分层、评分分离列、D1 限流窗、contacts、WebAuthn、request_id、FK 重建 |
| `0020`–`0025` | Phase 3/4：research_sources/facts/signals/personas/profiles |
| `0026` / `0029` | Phase 5/10：六维评分分解列、可调权重单行表 |
| `0027` / `0028` | Phase 8/9：联系人粒度、campaign_members 粒度重建 |
| `0030_campaign_auto_advance.sql` | 群发 ⚡自动推进（cron 空闲续跑列） |
| `0031_crm_sales_layer.sql` | **CRM 销售层四表**（companies/contacts/deals/activities） |
| `0032_crm_sales_ext.sql` | **销售增强**：customer_since、lost_reason、won_at、position REAL、archived_at + 回填 |
| `0033_crm_gmail_inbound.sql` | **入站同步**：crm_mail_sync 游标 + crm_mail_seen 去重 |

## 6. 研究管线（链路 ①）

每 5 分钟一个 tick，`UPDATE … RETURNING` 原子认领 3 条 pending 客户：

```text
原子认领(3条) → 主站抓取(HTMLRewriter 流式抽取) → 社媒 HEAD 验证
→ 6 查询多引擎搜索（身份核验：页面须提及目标公司，宁空勿混）
→ 子页/社交页补抓 → research_sources 逐源落库（append+supersede）
→ 规则清洗（零 token：导航/页脚/哈希去重 + 22k 预算截断）
→ 相关性预检（Workers AI 免费 llama-3.1-8b，不相关短路，~30-40% 零付费 token）
→ AI 结构化分析（Gemini responseSchema 硬约束；9 家回退；60s 共享超时）
→ 联系人同人合并 → 一次 DB.batch 写回（评分/画像/证据，WHERE status='processing' 防过期覆盖）
```

评分两轴正交：`lead_score`（六维 V2，权重面板可调，0-100，「值不值得追」）与
`data_completeness_score`（0-100，「资料全不全」），输入/列/用途互不相交。

## 7. CRM 销售层（链路 ③④，最新交付）

### 7.1 数据模型

```text
crm_companies   id(c_前缀), name, domain(唯一), industry, country, tier(A/B/C/VIP/
                unqualified), lead_status, customer_since(首次赢单日期，首赢即定
                不再覆盖), chinese_remarks, merged_from_ids
crm_contacts    company_id, full_name, job_title, email, whatsapp_or_phone,
                linkedin_url, is_primary(首位提升联系人)
crm_deals       company_id, title, stage(inquiry→sample_quoted→pi_sent→
                deposit_paid→won|lost 六段状态机), amount, incoterms,
                expected_close_date, lost_reason, won_at,
                position(REAL 分数排序，看板拖拽), archived_at
crm_activities  统一时间线 + 任务：type(note/task/call/meeting/lead_promoted/
                company_merged/cold_email_sent/ai_enrichment/email_received),
                summary, deal_id(非 FK，删除商机不丢时间线), due_date, is_completed
crm_mail_sync / crm_mail_seen   Gmail 入站同步的游标与去重（§7.4）
```

### 7.2 API 与面板

REST 前缀 `/admin/api/crm/`（会话 + RBAC 鉴权，写操作全审计）：
companies / contacts / deals / activities CRUD，`deals/:id/move`（看板移动），
`contacts/merge`（合并），`import`（CSV），`stats`（聚合统计）。

面板 `/admin/crm`（第 7 个业务面板，模板字符串 + CSP nonce）：

- **列表/看板双视图**：公司列表（客户徽章、open_deals/open_tasks 计数）+ 商机六列看板（列金额小计、拖拽改阶段、输单原因 prompt、赢单/输单卡归档按钮、won/lost 列内排序）
- **统计仪表**：7 张卡（公司总数/成交客户/开放商机/管线金额/加权预测/待办/逾期）+ 近 6 个月成交走势 CSS 柱图
- **任务区**：按 逾期/今天/明天/未来 7 天/更晚/无期限 分组，逾期高亮，一键「→明天」顺延
- **CSV 导入**：公司/联系人/商机三实体，中英文表头别名，行内错误回报
- **详情弹窗**：时间线（全类型标签）、联系人（主联系人徽章、合并 UI）、商机表格、待办

### 7.3 销售增强 ①–⑦

| # | 特性 | 机制要点 |
|---|---|---|
| ① | 赢单转客户 + 输单原因 | 商机置 won → 公司打「客户」徽章并记 `customer_since`（首赢即定）；置 lost 必填 `lost_reason`（400 校验），reopen 自动清残留 |
| ② | 看板列金额/排序/归档 | 列小计 SQL 聚合；拖拽落点取前后卡 `position` 中点（REAL 无上限细分）；won/lost 完结卡可归档（`archived_at`）进「已归档」区，可恢复/删除 |
| ③ | 任务分组 + 顺延 | 服务端按 due_date 分组渲染；PATCH `due_date` 一键顺延到明天（仅任务类型，非任务 400） |
| ④ | 联系人合并 | COALESCE 空位回填 + is_primary 提升 + 时间线备注 + 源删除，单 batch，审计 MERGE_CRM_CONTACT |
| ⑤ | CSV 导入 | RFC4180 解析（引号/BOM/CRLF），≤1000 行/400KB，公司按名称/域名去重自动建，联系人按 公司+邮箱 去重，商机未知阶段兜底 inquiry，分块 50 条 batch，审计 CRM_CSV_IMPORT |
| ⑥ | 聚合统计 | `crmStats`：加权预测按阶段权重 inquiry 0.1 / sample_quoted 0.3 / pi_sent 0.5 / deposit_paid 0.8；won_monthly 按月分组喂柱图 |
| ⑦ | Gmail 入站同步 | 见 §7.4 |

### 7.4 Gmail 入站同步（`src/crm-gmail-sync.ts`）

cron 空闲 tick 顺带执行，读取**各品牌发件邮箱**（`outreach_settings.sender_email`，
凭据解析与发信完全同链路 `chooseGmailAccount`）的收件箱：

```text
每个邮箱（≤3）:
  crm_mail_sync 游标(after:internalDate) → Gmail messages.list
  → 每条消息 metadata（≤5 条/tick，由旧到新）
  → 匹配：① 联系人邮箱精确匹配 ② 发件域名匹配公司
  → 命中：crm_activities 写 email_received（与去重行同 batch，原子）
  → 未命中：只记 crm_mail_seen（与 CRM 无关的来信不写时间线）
  → 游标推进到已处理最新一条
幂等:  crm_mail_seen(mailbox, message_id) 主键去重，交叠 tick 零重复
退避:  连续 5 次失败暂停该邮箱 6h；成功即清零
前置:  服务账号需在 Workspace 管理后台域级委派中授权 gmail.readonly；
       OAuth 令牌邮箱需授权时勾选读取权限。未配置 → 403 → 自动退避，fail-open
预算:  每 tick ≤ 3 邮箱 × (1 list + 5 取信) ≈ 18 外部子请求
```

## 8. 开发信与群发（链路 ②）

- **生成**：结构化档案（company_profile / outreach_context / personas）驱动，
  按收件人国家语言；公司粒度或联系人粒度。
- **发送状态机**：`draft → reserved → sending → sent/uncertain/failed`；
  配额调 Gmail 前原子预留；幂等键 + 唯一索引防重发；`sending` 卡死隔离为
  `uncertain` 由操作员裁决；`OUTREACH_DRY_RUN` 全链路空跑。
- **群发**：快照名单（`outreach_campaign_members`，contact_norm 生成列钉死粒度）、
  两步续跑（生成 pending → 发送 generated）、配额尽按批次中止（成员留
  generated 明日续发，绝不标 failed）、`campaign_locks` 单飞锁。
- **⚡自动推进**：管理员开启后 cron 空闲 tick 自动小批推进（复用手动锁/配额，
  管理员手动点击只是锁竞争者）。
- **配额语义**：Gmail 每日上限 = 账号池各账号之和；429/超时/5xx 可重试，
  其余 failed 让任务收尾。

## 9. 安全架构（Security V2 摘要）

```text
周界      Cloudflare Access（可选，代码内 JWKS 验签 fail-closed）
会话      随机 256-bit token 只存 SHA-256；HttpOnly/SameSite=Strict/1h/可吊销
2FA       WebAuthn 通行密钥 + 10 个一次性恢复码（激活后关闭 Bearer token 路径）
RBAC      super_admin/operator/researcher/sender/readonly，deny-by-default，
          角色每请求从会话行重读
Origin    变更请求同源校验，403 在鉴权之前
响应      nonce-CSP（无 unsafe-inline）/HSTS/XFO/Referrer-Policy；500 只回
          request_id（堆栈进日志），400 操作员提示保持原文
凭据      D1 内 Key/PEM/refresh_token 全部 AES-GCM 密文（enc:v1:），HKDF 派生
          加密与指纹子密钥；未配 CREDENTIAL_ENC_KEY 时拒绝新增（fail-closed）
限流      登录 IP 5 次/15min + 全局 30 次；provider 三层限流（本地滑窗 →
          D1/DO 权威层 → 429 冷却）
审计      每次变更/登录/权限拒绝写 audit_logs（fail-open，默认保留 180 天）
```

完整报告：[`crm-ai-worker/docs/security-v2-final-report.md`](crm-ai-worker/docs/security-v2-final-report.md)。

## 10. 测试与质量保障

```text
npx vitest run          83 文件 / 1052 测试，全离线（不花 token/不发邮件/不需真密钥）
npx tsc --noEmit        严格模式零错误
node scripts/check-panel.mjs   8 个面板模板自检（JS 可解析、id 唯一、
                        getElementById 有对应元素）

测试分层：
tests/security/     10 文件：经真实 handleAdminRequest 的安全验收
tests/concurrency/   5 文件：10/50/100 并发风暴（配额/幂等/认领/限流）
tests/crm*.test.ts   CRM 层：API CRUD、看板移动/归档、合并、CSV 导入、
                    统计、Gmail 入站同步（fetch 全 mock）
其余顶层            研究分层、群发状态机、评分引擎/配置、凭据加密端到端、
                    WebAuthn、配额、限流、facets …

测试基建：FakeD1 = node:sqlite DatabaseSync(":memory:") 适配 D1 接口
（prepare/bind/all/first/run/batch），面板脚本另有整行 <script> 提取解析器。
```

面板 HTML 是 TS 模板字符串，内嵌手写 JS：字面换行必须写 `\\n`，禁止裸
`` ` ``、`${`、`\n`（CSP nonce 替换会破坏）；改面板后必跑 check-panel。

## 11. 部署

push `main` → GitHub Actions（`.github/workflows/deploy-worker.yml`）：

```text
Ensure D1 → 注入真实 database_id → schema.sql 幂等初始化
→ 逐条 ALTER 容忍重复列 → typecheck → 83 文件单测 → wrangler deploy
→ （opt-in）SYNC_SECRETS_FROM_GITHUB 同步 Secrets
```

- 全新库跑 `schema.sql`；存量库靠 `migrations/0001–0033`（幂等，CI 自动重放）。
- `wrangler.toml` 只含 D1 ID 占位符；真实 ID 在 gitignored `wrangler.local.toml`
  或 CI Secret `CLOUDFLARE_D1_DATABASE_ID`。
- 本地开发：`npx wrangler dev --test-scheduled` +
  `curl "http://127.0.0.1:8787/__scheduled?cron=*/5%20*%20*%20*%20*"`。
