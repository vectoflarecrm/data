# 客户查找与验证规则

本文件将 `instruction.txt` 的客户查找规范转为系统执行政策。核心原则是：**真实性高于完整度；宁可留空，不得编造。**

## 1. 证据与禁止推断

- 公司、联系人、姓名、职位、邮箱、电话、WhatsApp、社交账号和产品信息只能来自实际抓取或明确提供的公开来源。
- AI 不得根据姓名推断邮箱，不得根据座机推断手机，不得生成网页中不存在的联系人。
- 每条新增事实必须记录 `source_url`、`source_type`、`evidence_text`、`confidence` 和提取方式。
- 没有来源 URL 的 AI 联系人结果不得被视为已核验；系统会使用实际抓取页面 URL 作为最低限度的来源范围，并要求 AI 尽可能返回精确来源 URL。
- 不执行 AI 生成的 SQL，不把 AI 输出当作数据库结构命令。

## 2. 联系方式规则

- 只接受网页原文中实际出现的邮箱、电话和姓名。
- `sales`、`invoice` 及其点号、短横线、下划线、加号变体属于通用邮箱，不进入联系人直邮字段。
- 已退信、已抑制或错误邮箱不能进入可联系客户数据；应写入 `email_suppressions` 或导入质量报告。
- 普通手机号只能进入 `Cellphone/Phone`，不能自动进入 WhatsApp。
- WhatsApp 只有在官网存在 `wa.me`/`api.whatsapp.com` 明确链接，或公开文本明确写出 WhatsApp 号码时才允许记录；不能因为号码“看起来像手机”而推断。
- 电话号码未经独立核验时保持 `UNVERIFIED`；核验结果必须保留证据。

## 3. 公司核验与分类

- 官网、About、Products、Team、Contact、Catalog 页面优先。
- 产品和服务使用英文记录；业务类型映射为 `MANUFACTURER`、`DISTRIBUTOR`、`DEALER/RETAILER`、`RENTAL` 等类型。
- 公司描述由有来源的公开信息汇总；缺失时留空或标记 UNKNOWN。
- Google Maps 的 `Permanently closed`、`Temporarily closed`、地址冲突和官网失效状态只有在真实 Maps/HTTP 证据接入后才能写入；不能由 AI 猜测。
- LinkedIn、Facebook、Instagram 账号只有在实际页面或官网明确链接支持时才记录，不能仅按名称匹配。

## 4. 导入与合并

- 同一公司多名联系人应拆成多行/多条联系人记录，保留同一公司 ID。
- 合并或冲突数据必须保留证据和备注，不静默覆盖高可信记录。
- 导入数据默认为 `IMPORTED_DATA`，不是官网核验结果；附件中标记为错误或退信的邮箱必须先进入抑制清单。

## 5. 当前系统边界

当前研究引擎已实现官网抓取、证据留痕、邮箱/电话/公开 WhatsApp 提取、冲突保护和 AI 结构化分析。Google Maps、LinkedIn 搜索、Facebook/Instagram 页面搜索尚未接入专用 API/浏览器采集器，因此这些渠道不会被伪装成已完成核验。
