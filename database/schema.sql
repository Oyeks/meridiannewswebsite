-- ============================================================
--  THE MERIDIAN — DATABASE SCHEMA
--  Platform: Supabase (PostgreSQL 15+)
--  Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";      -- UUID generation
CREATE EXTENSION IF NOT EXISTS "pg_trgm";         -- Fuzzy text search
CREATE EXTENSION IF NOT EXISTS "unaccent";         -- Accent-insensitive search

-- ─────────────────────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────────────────────
CREATE TYPE article_category AS ENUM (
  'nigeria',
  'world',
  'tech',
  'sports',
  'markets',
  'politics',
  'business',
  'entertainment',
  'health',
  'uncategorised'
);

CREATE TYPE feed_status AS ENUM (
  'active',
  'paused',
  'error'
);

-- ─────────────────────────────────────────────────────────────
-- TABLE: sources
--   Tracks every RSS/API feed we pull from
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT        NOT NULL,
  feed_url       TEXT        NOT NULL UNIQUE,
  site_url       TEXT        NOT NULL,
  category       article_category NOT NULL DEFAULT 'uncategorised',
  country        CHAR(2)     NOT NULL DEFAULT 'NG',   -- ISO 3166-1 alpha-2
  language       CHAR(2)     NOT NULL DEFAULT 'en',
  status         feed_status NOT NULL DEFAULT 'active',
  last_fetched   TIMESTAMPTZ,
  last_success   TIMESTAMPTZ,
  error_count    INT         NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE sources IS 'RSS/API feed sources for The Meridian';

-- ─────────────────────────────────────────────────────────────
-- TABLE: articles
--   Every news article fetched from any source
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS articles (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id      UUID        NOT NULL REFERENCES sources(id) ON DELETE CASCADE,

  -- Core content
  title          TEXT        NOT NULL,
  excerpt        TEXT,
  content        TEXT,
  url            TEXT        NOT NULL UNIQUE,   -- canonical dedupe key
  image_url      TEXT,
  author         TEXT,

  -- Classification
  category       article_category NOT NULL DEFAULT 'uncategorised',
  tags           TEXT[]      NOT NULL DEFAULT '{}',

  -- Timing
  published_at   TIMESTAMPTZ,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Engagement (future)
  view_count     INT         NOT NULL DEFAULT 0,
  share_count    INT         NOT NULL DEFAULT 0,
  bookmark_count INT         NOT NULL DEFAULT 0,

  -- Full-text search vector
  search_vector  TSVECTOR    GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')),   'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(author, '')),  'C')
  ) STORED,

  -- Flags
  is_breaking    BOOLEAN     NOT NULL DEFAULT FALSE,
  is_featured    BOOLEAN     NOT NULL DEFAULT FALSE,
  is_deleted     BOOLEAN     NOT NULL DEFAULT FALSE
);

COMMENT ON TABLE articles IS 'All fetched news articles across all sources';
COMMENT ON COLUMN articles.search_vector IS 'Auto-generated tsvector for full-text search';

-- ─────────────────────────────────────────────────────────────
-- TABLE: fetch_log
--   Audit trail for every feed fetch attempt
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fetch_log (
  id             BIGSERIAL   PRIMARY KEY,
  source_id      UUID        REFERENCES sources(id) ON DELETE SET NULL,
  source_name    TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  articles_found INT         NOT NULL DEFAULT 0,
  articles_new   INT         NOT NULL DEFAULT 0,
  articles_dupe  INT         NOT NULL DEFAULT 0,
  success        BOOLEAN     NOT NULL DEFAULT FALSE,
  error_message  TEXT,
  duration_ms    INT
);

COMMENT ON TABLE fetch_log IS 'Audit log for every RSS fetch attempt';

-- ─────────────────────────────────────────────────────────────
-- TABLE: trending
--   Materialised trending scores updated by the server
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trending (
  id             BIGSERIAL   PRIMARY KEY,
  article_id     UUID        NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  score          NUMERIC(10,4) NOT NULL DEFAULT 0,
  rank           INT,
  window_hours   INT         NOT NULL DEFAULT 24,
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(article_id, window_hours)
);

-- ─────────────────────────────────────────────────────────────
-- TABLE: bookmarks  (future — user saved articles)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmarks (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID        NOT NULL,   -- Supabase auth.users.id
  article_id     UUID        NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, article_id)
);

-- ─────────────────────────────────────────────────────────────
-- TABLE: market_snapshots
--   Periodic market data snapshots (NGX, FX, Crypto)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_snapshots (
  id             BIGSERIAL   PRIMARY KEY,
  symbol         TEXT        NOT NULL,   -- e.g. NGX_ASI, USDNGN, BTC
  label          TEXT        NOT NULL,   -- e.g. 'NGX All-Share Index'
  price          NUMERIC(18,4),
  change_pct     NUMERIC(8,4),
  change_abs     NUMERIC(18,4),
  direction      CHAR(1)     CHECK (direction IN ('U','D','F')),  -- Up/Down/Flat
  currency       CHAR(3)     DEFAULT 'NGN',
  source         TEXT,
  snapped_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE market_snapshots IS 'Point-in-time market price snapshots';

-- ─────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────

-- Articles — most common query patterns
CREATE INDEX IF NOT EXISTS idx_articles_category
  ON articles(category)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_articles_published_at
  ON articles(published_at DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_articles_source_id
  ON articles(source_id);

CREATE INDEX IF NOT EXISTS idx_articles_is_breaking
  ON articles(is_breaking)
  WHERE is_breaking = TRUE AND is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_articles_is_featured
  ON articles(is_featured)
  WHERE is_featured = TRUE AND is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_articles_category_published
  ON articles(category, published_at DESC)
  WHERE is_deleted = FALSE;

-- Full-text search
CREATE INDEX IF NOT EXISTS idx_articles_search_vector
  ON articles USING GIN(search_vector);

-- Trigram index for ILIKE / fuzzy search on title
CREATE INDEX IF NOT EXISTS idx_articles_title_trgm
  ON articles USING GIN(title gin_trgm_ops);

-- Fetch log
CREATE INDEX IF NOT EXISTS idx_fetch_log_source_id
  ON fetch_log(source_id);

CREATE INDEX IF NOT EXISTS idx_fetch_log_started_at
  ON fetch_log(started_at DESC);

-- Market snapshots
CREATE INDEX IF NOT EXISTS idx_market_symbol_time
  ON market_snapshots(symbol, snapped_at DESC);

-- Trending
CREATE INDEX IF NOT EXISTS idx_trending_rank
  ON trending(window_hours, rank);

-- Bookmarks
CREATE INDEX IF NOT EXISTS idx_bookmarks_user
  ON bookmarks(user_id);

-- ─────────────────────────────────────────────────────────────
-- FUNCTIONS & TRIGGERS
-- ─────────────────────────────────────────────────────────────

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_articles_updated_at
  BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_sources_updated_at
  BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Increment view count safely (called from API)
CREATE OR REPLACE FUNCTION increment_view_count(p_article_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE articles
  SET view_count = view_count + 1
  WHERE id = p_article_id AND is_deleted = FALSE;
END;
$$;

-- Increment bookmark count
CREATE OR REPLACE FUNCTION increment_bookmark_count(p_article_id UUID, delta INT DEFAULT 1)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE articles
  SET bookmark_count = GREATEST(0, bookmark_count + delta)
  WHERE id = p_article_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────
-- VIEWS
-- ─────────────────────────────────────────────────────────────

-- Live feed view — what the API serves by default
CREATE OR REPLACE VIEW v_live_feed AS
SELECT
  a.id,
  a.title,
  a.excerpt,
  a.url,
  a.image_url,
  a.author,
  a.category,
  a.tags,
  a.published_at,
  a.fetched_at,
  a.is_breaking,
  a.is_featured,
  a.view_count,
  a.bookmark_count,
  s.name        AS source_name,
  s.site_url    AS source_url,
  s.country     AS source_country,
  -- Human-readable time ago (computed in SQL for caching)
  CASE
    WHEN a.published_at > NOW() - INTERVAL '1 hour'
      THEN EXTRACT(EPOCH FROM (NOW() - a.published_at))::INT / 60 || 'm ago'
    WHEN a.published_at > NOW() - INTERVAL '24 hours'
      THEN EXTRACT(EPOCH FROM (NOW() - a.published_at))::INT / 3600 || 'h ago'
    ELSE
      EXTRACT(EPOCH FROM (NOW() - a.published_at))::INT / 86400 || 'd ago'
  END           AS time_ago
FROM articles a
JOIN sources   s ON s.id = a.source_id
WHERE a.is_deleted = FALSE
  AND s.status     = 'active'
ORDER BY a.published_at DESC;

COMMENT ON VIEW v_live_feed IS 'Primary API view — latest non-deleted articles with source info';

-- Source health view
CREATE OR REPLACE VIEW v_source_health AS
SELECT
  s.id,
  s.name,
  s.category,
  s.status,
  s.last_fetched,
  s.last_success,
  s.error_count,
  s.last_error,
  COUNT(a.id)                           AS total_articles,
  COUNT(a.id) FILTER (
    WHERE a.published_at > NOW() - INTERVAL '24 hours'
  )                                     AS articles_last_24h,
  MAX(a.published_at)                   AS latest_article_at
FROM sources s
LEFT JOIN articles a ON a.source_id = s.id AND a.is_deleted = FALSE
GROUP BY s.id
ORDER BY s.name;

-- Trending view (24h)
CREATE OR REPLACE VIEW v_trending_24h AS
SELECT
  a.id,
  a.title,
  a.url,
  a.category,
  a.published_at,
  a.view_count,
  a.bookmark_count,
  s.name AS source_name,
  t.score,
  t.rank
FROM trending t
JOIN articles a ON a.id = t.article_id
JOIN sources  s ON s.id = a.source_id
WHERE t.window_hours = 24
  AND t.computed_at > NOW() - INTERVAL '1 hour'
  AND a.is_deleted = FALSE
ORDER BY t.rank ASC
LIMIT 10;

-- ─────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (Supabase)
-- ─────────────────────────────────────────────────────────────

-- Enable RLS
ALTER TABLE articles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources           ENABLE ROW LEVEL SECURITY;
ALTER TABLE fetch_log         ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookmarks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_snapshots  ENABLE ROW LEVEL SECURITY;

-- Public read access on articles (anyone can read news)
CREATE POLICY "Public can read articles"
  ON articles FOR SELECT
  USING (is_deleted = FALSE);

-- Public read on sources
CREATE POLICY "Public can read sources"
  ON sources FOR SELECT
  USING (status = 'active');

-- Public read on trending
CREATE POLICY "Public can read trending"
  ON trending FOR SELECT
  USING (TRUE);

-- Public read on market snapshots
CREATE POLICY "Public can read market snapshots"
  ON market_snapshots FOR SELECT
  USING (TRUE);

-- Only service role can write articles (the backend server)
CREATE POLICY "Service role can insert articles"
  ON articles FOR INSERT
  WITH CHECK (TRUE);  -- enforced at API key level

CREATE POLICY "Service role can update articles"
  ON articles FOR UPDATE
  USING (TRUE);

CREATE POLICY "Service role can write sources"
  ON sources FOR ALL
  USING (TRUE);

CREATE POLICY "Service role can write fetch_log"
  ON fetch_log FOR ALL
  USING (TRUE);

CREATE POLICY "Service role can write trending"
  ON trending FOR ALL
  USING (TRUE);

CREATE POLICY "Service role can write market snapshots"
  ON market_snapshots FOR ALL
  USING (TRUE);

-- Bookmarks: users can only see/manage their own
CREATE POLICY "Users manage own bookmarks"
  ON bookmarks FOR ALL
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────
-- SEED DATA — News Sources
-- ─────────────────────────────────────────────────────────────
INSERT INTO sources (name, feed_url, site_url, category, country, language) VALUES

-- Nigerian Sources
('Punch',           'https://punchng.com/feed/',                        'https://punchng.com',        'nigeria',   'NG', 'en'),
('Vanguard',        'https://www.vanguardngr.com/feed/',                 'https://vanguardngr.com',    'nigeria',   'NG', 'en'),
('Channels TV',     'https://www.channelstv.com/feed/',                  'https://channelstv.com',     'nigeria',   'NG', 'en'),
('BusinessDay',     'https://businessday.ng/feed/',                      'https://businessday.ng',     'business',  'NG', 'en'),
('Nairametrics',    'https://nairametrics.com/feed/',                    'https://nairametrics.com',   'markets',   'NG', 'en'),
('TechCabal',       'https://techcabal.com/feed/',                       'https://techcabal.com',      'tech',      'NG', 'en'),
('The Cable',       'https://www.thecable.ng/feed',                      'https://thecable.ng',        'nigeria',   'NG', 'en'),
('Premium Times',   'https://www.premiumtimesng.com/feed',               'https://premiumtimesng.com', 'nigeria',   'NG', 'en'),

-- International Sources
('BBC News',        'https://feeds.bbci.co.uk/news/rss.xml',            'https://bbc.com/news',       'world',     'GB', 'en'),
('BBC Sport',       'https://feeds.bbci.co.uk/sport/rss.xml',           'https://bbc.com/sport',      'sports',    'GB', 'en'),
('Reuters',         'https://feeds.reuters.com/reuters/topNews',         'https://reuters.com',        'world',     'US', 'en'),
('ESPN',            'https://www.espn.com/espn/rss/news',               'https://espn.com',           'sports',    'US', 'en'),
('TechCrunch',      'https://techcrunch.com/feed/',                      'https://techcrunch.com',     'tech',      'US', 'en'),
('The Verge',       'https://www.theverge.com/rss/index.xml',           'https://theverge.com',       'tech',      'US', 'en'),
('Bloomberg',       'https://feeds.bloomberg.com/markets/news.rss',      'https://bloomberg.com',      'markets',   'US', 'en'),
('Al Jazeera',      'https://www.aljazeera.com/xml/rss/all.xml',        'https://aljazeera.com',      'world',     'QA', 'en')

ON CONFLICT (feed_url) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- USEFUL QUERIES (reference)
-- ─────────────────────────────────────────────────────────────

-- Latest 20 articles across all categories:
-- SELECT * FROM v_live_feed LIMIT 20;

-- Latest Nigeria news:
-- SELECT * FROM v_live_feed WHERE category = 'nigeria' LIMIT 10;

-- Full-text search:
-- SELECT title, excerpt, source_name, time_ago
-- FROM v_live_feed
-- WHERE search_vector @@ plainto_tsquery('english', 'CBN inflation rate')
-- ORDER BY published_at DESC LIMIT 10;

-- Source health check:
-- SELECT * FROM v_source_health;

-- Articles from last hour:
-- SELECT title, source_name, time_ago FROM v_live_feed
-- WHERE published_at > NOW() - INTERVAL '1 hour';

-- Breaking news:
-- SELECT * FROM v_live_feed WHERE is_breaking = TRUE LIMIT 5;

-- Trending today:
-- SELECT * FROM v_trending_24h;
