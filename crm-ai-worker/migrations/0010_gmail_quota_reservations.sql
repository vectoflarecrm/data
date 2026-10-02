-- Security V2 Stage 11 (spec §12): Gmail 配额原子预留.
--
-- 旧流程 check → send → increment 存在读后写窗口：并发批次都能读到"还剩 1 个
-- 名额"然后全部放行，日配额被击穿（对 Gmail 池意味着账号被封）。新流程
-- reserve → send → commit：
--   reserve  单条 INSERT…SELECT，仅当 sent_today + reserved_today < daily_limit
--            时落行 —— D1 单语句原子，没有检查与占用之间的缝隙（§12.2）
--   send     持有一个预留槽位调用 Gmail API
--   commit   成功 → 删除预留，配额改由 gmail_send_log 的 'sent' 行记账；
--            确定失败 → 立即删除释放槽位；
--            结果未知 → 预留保留到 TTL 由 reaper 释放（保守：未知发送可能
--            已消耗 Gmail 侧配额）
--
-- 行只在"持有槽位"期间存在（commit/release/过期一律 DELETE 而非改状态）：
-- 残留行会占用 UNIQUE 键，导致同一邮件合法重试时无法再次预留。spec DDL 的
-- status 列保留（活跃行恒为 'reserved'）。
--
-- 预留按发信账号计数（§12.2 的 gmail_account_id），UNIQUE(idempotency_key)
-- 保证一封邮件永远不会占两个槽位。

CREATE TABLE IF NOT EXISTS gmail_send_reservations (
    id TEXT PRIMARY KEY,
    gmail_account_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    reserved_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    outreach_email_id TEXT NOT NULL
);

-- 每账号活跃预留计数扫描（reserve 守卫与账号挑选都用它）。
CREATE INDEX IF NOT EXISTS idx_reservations_account
ON gmail_send_reservations(gmail_account_id, status);
