# 📮 Gmail 发信账号池 — 添加指南

> 面板入口：`https://crm-ai-worker.qdu.workers.dev/admin/outreach` → 「📮 发信账号」标签页
> 更新于 2026-09-30：支持两种凭据类型。**组织政策禁止创建服务账号密钥时，用方式一（OAuth 令牌）**。

---

## 背景两种凭据的区别

| | 🟢 方式一：OAuth 令牌（推荐） | 🟡 方式二：服务账号 + 全域委托 |
|---|---|---|
| 是否需要服务账号密钥 | ❌ 不需要（政策封禁时唯一可用） | ✅ 需要 |
| 是否需要全域委托 | ❌ 不需要 | ✅ 需要 |
| 凭据形式 | 每个发件邮箱一个 refresh_token | 一个服务账号代发全域名邮箱 |
| From 地址 | 固定为授权的那个邮箱 | 任意已委托域名邮箱 |
| 长期有效性 | 长期有效（用户可撤销） | 长期有效 |
| 适合 | 少量固定发件邮箱（我们的场景） | 大量动态发件人 |

两者都进同一个账号池，配额、冷却、自动分配逻辑完全一致，可混用。

---

## 方式一：OAuth 令牌（无需服务账号密钥）✅ 推荐

### 第 1 步：创建 OAuth 客户端（一次性，约 5 分钟，不受组织政策限制）

1. [Google Cloud Console](https://console.cloud.google.com/) → **API 和服务 → 库** → 搜索 **Gmail API** → 启用；
2. **API 和服务 → OAuth 同意屏幕**：
   - User Type 选 **内部**（Workspace 域内用户，免 Google 审核）→ 创建；
   - 应用名称随意（如 CRM Mailer）；**Scopes** 添加 `.../auth/gmail.send`；
3. **API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID**：
   - 应用类型选 **桌面应用**；
   - 创建后记下 **客户端 ID**（`…apps.googleusercontent.com`）和 **客户端密钥**。

> ⚠️ 组织政策 `iam.managed.disableServiceAccountKeyCreation` 只封服务账号**密钥**，
> OAuth 客户端 ID 完全不受影响。

### 第 2 步：把客户端 ID 配到 Worker（一次性）

```bash
cd crm-ai-worker
export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808
npx wrangler secret put GMAIL_OAUTH_CLIENT_ID      # 粘贴客户端 ID
npx wrangler secret put GMAIL_OAUTH_CLIENT_SECRET  # 粘贴客户端密钥（桌面应用有时为空，则跳过）
```

### 第 3 步：为每个发件邮箱取 refresh_token（每个邮箱一次，1 分钟）

```bash
cd crm-ai-worker
python3 scripts/get-gmail-refresh-token.py --client-id "xxxxx.apps.googleusercontent.com" --client-secret "GOCSPX-…"
```

- 浏览器自动打开 Google 授权页 → **登录要作为发件人的那个邮箱**（如 `helen@isupfactory.com`）→ 点「允许」；
- 终端打印出 `refresh_token`，复制下来。

> 提示 `redirect_uri_mismatch`：确认创建的是「桌面应用」类型客户端；
> 提示 `access_denied`：同意屏幕必须是「内部」且登录的是同域账号。

### 第 4 步：面板添加账号

「📮 发信账号」→ 凭据类型选 **OAuth 令牌** → 填：

| 字段 | 填什么 |
|---|---|
| 备注 | 随意，如 `Helen 主邮箱` |
| 邮箱 | **刚才授权登录的发件邮箱**（如 `helen@isupfactory.com`） |
| 凭据 | 粘贴 `refresh_token` |
| 每日配额 | 留空 = 400 |

→ **➕ 添加账号** → 点 **🔌 测试**，提示「refresh token 有效」即完成。

要多个发件邮箱就重复第 3、4 步（每个邮箱一个 refresh_token）。

---

## 方式二：服务账号 + 全域委托（需能创建密钥时用）

> ⚠️ 当前组织政策 `iam.managed.disableServiceAccountKeyCreation` 已禁止创建服务账号密钥。
> 如需走此路：Cloud Console → IAM 和管理 → **组织政策** → 搜 `disableServiceAccountKeyCreation`
> → 修改政策 → 替换 → 强制执行设为「停用」→ 保存后创建密钥，**创建完可把政策改回原样**
> （政策只拦创建，不影响已有密钥使用）。需要 Organization Policy Administrator 角色，
> 自己组织的 owner 账号通常就有。

1. **Google Cloud**：启用 Gmail API → 创建服务账号 → 密钥 → JSON，取 `client_email` 和 `private_key`；
2. **Workspace 管理控制台**：安全性 → API 权限 → **全域委托** → 新增：
   - 客户端 ID：服务账号的 OAuth 2 客户端 ID（数字串）；
   - 范围：`https://www.googleapis.com/auth/gmail.send`；
3. **面板添加**：凭据类型选 **服务账号** → 填服务账号邮箱 + 私钥 PEM → 添加 → 测试。

---

## 发信时的账号选择逻辑（自动，无需干预）

```
品牌绑定的账号（品牌设置里「发信服务账号」填了值）
  ↓ 没绑定
面板账号池 → 选「今日剩余配额最多」的健康账号（多账号自动分摊）
  ↓ 池子为空
服务器 Secrets：GMAIL_SERVICE_ACCOUNT_EMAIL / KEY / SENDER_EMAIL（旧配置兜底）
```

- **配额**：面板配额卡片显示所有启用账号之和（如 3 个账号 = 1200 封/天）；
- **故障冷却**：账号被 Google 拒绝（401/403/invalid_grant/失效 token）自动停用 6 小时并记录最近错误，期间不参与发信；冷却到期自动恢复，也可在面板手动「停用→启用」立即恢复；
- **From 地址**：OAuth 令牌账号固定发自己；服务账号账号由品牌设置里的「发件身份」决定（如 `helen@isupfactory.com`）。

---

## 常见错误排查

| 面板测试/发送错误 | 原因 | 解决 |
|---|---|---|
| `invalid_grant`（OAuth） | refresh_token 粘贴不完整/失效 | 重新跑脚本取一次；确认授权时用了 `prompt=consent` |
| `unauthorized_client`（OAuth） | 客户端 ID/Secret 与取 token 时不一致 | 检查 `GMAIL_OAUTH_CLIENT_ID` Secret |
| `invalid_grant` / `Invalid JWT`（服务账号） | 私钥粘贴错误 | 重新复制 JSON 里的 `private_key` |
| `unauthorized_client`（服务账号） | 全域委托没做或客户端 ID 填错 | 重做全域委托，客户端 ID 用数字串 |
| `403` 发送时 | 委托范围没含 `gmail.send` / From 域名未委托 | 检查委托范围和域名 |
| `404` / `Mail service not enabled` | From 邮箱不属于已授权域名 | OAuth 账号 From 固定为自己，不会出现；服务账号需给该域名做委托 |
| `429` | 当日配额用完 | 等 UTC 零点，或添加更多账号 |
| `has not been used… Gmail API` | 项目没启用 Gmail API | Cloud Console → 库 → 启用 |

---

## 命令行方式（可选，不走面板）

```bash
curl -X POST https://crm-ai-worker.qdu.workers.dev/admin/api/gmail/accounts \
  -H "Authorization: Bearer $ADMIN_PANEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "Helen 主邮箱",
    "credential_type": "oauth_refresh",
    "client_email": "helen@isupfactory.com",
    "private_key": "1//0abc…refresh_token…",
    "daily_limit": 400
  }'
```

> 本机直连 Cloudflare 会被 DNS 污染，curl/wrangler 命令前加
> `export HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808`（本地 xray 代理）。

---

## 安全提醒

- ❌ 不要把 refresh_token / private_key 写进源码、聊天记录或提交到 Git；
- ✅ token 泄露时：OAuth 账号到 https://myaccount.google.com/permissions 移除应用授权 → 重新跑脚本取新 token → 面板更新；服务账号密钥则去 Cloud 删除重建；
- ✅ 账号不用了在面板停用或删除即可。
