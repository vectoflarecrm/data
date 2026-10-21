-- 开发信自动推进 (campaign auto-advance)：逐任务的可选开关。
-- cron 每 5 分钟的 scheduled tick 在调研管线空闲（本次没有待研究客户）时，
-- 为 auto_advance = 1 且 status = 'draft' 的群发任务自动生成并发送一小批
-- 草稿（各 5 封/次，受 Gmail 每日配额限制）。暂停的任务不会被推进。
--
-- 全新数据库无需本文件：schema.sql 的 CREATE TABLE 已包含该列。线上已有库
-- 由 .github/workflows/deploy-worker.yml 的 per-statement ALTER 步骤添加
-- （ADD COLUMN 不幂等，不能进 D1 batch 文件）。默认 0 = 不自动推进，
-- 升级后行为与旧版完全一致，直到管理员在面板点「⚡ 自动推进」。

ALTER TABLE outreach_campaigns ADD COLUMN auto_advance INTEGER NOT NULL DEFAULT 0;
