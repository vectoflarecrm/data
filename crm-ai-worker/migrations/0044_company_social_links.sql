-- 0044 公司社交媒体链接列（用户需求：新导入公司的 Facebook/Instagram/
-- LinkedIn/YouTube/TikTok 等社媒链接此前无对应字段，导入时被安全忽略）。
-- crm_companies 新增 6 列（平台与 /admin 研究管线 SOCIAL_PLATFORMS 一致：
-- LinkedIn/Facebook/Instagram/Twitter(X)/YouTube/TikTok），Excel 导入表头
-- 映射（crm-excel-import IMPORT_HEADERS）、公司 PATCH、合并保全、管线
-- 提升（social_accounts_verified JSON → 各平台列）全部接入。
-- 兼容：新列全部可空，回滚安全（还原代码即可，列留在库里无副作用）。

ALTER TABLE crm_companies ADD COLUMN facebook_url TEXT;  -- Facebook 主页链接
ALTER TABLE crm_companies ADD COLUMN instagram_url TEXT; -- Instagram 主页链接
ALTER TABLE crm_companies ADD COLUMN linkedin_url TEXT;  -- LinkedIn 公司主页链接
ALTER TABLE crm_companies ADD COLUMN youtube_url TEXT;   -- YouTube 频道链接
ALTER TABLE crm_companies ADD COLUMN tiktok_url TEXT;    -- TikTok 主页链接
ALTER TABLE crm_companies ADD COLUMN twitter_url TEXT;   -- Twitter/X 主页链接
