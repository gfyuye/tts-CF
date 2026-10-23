-- D1 初始化脚本（幂等，可重复执行）
-- 方式一：CI 自动执行
-- 方式二：手动执行 npx wrangler d1 execute tts-db --remote --file=schema.sql

-- 端点表
CREATE TABLE IF NOT EXISTS endpoint_table (
  region TEXT PRIMARY KEY,
  priority INTEGER NOT NULL,
  voices_data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- token 缓存
CREATE TABLE IF NOT EXISTS token_cache (
  region TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_cache_expiry ON token_cache(expiry);

-- 语音列表
CREATE TABLE IF NOT EXISTS voice_list (
  voice_name TEXT PRIMARY KEY,
  voice_data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
