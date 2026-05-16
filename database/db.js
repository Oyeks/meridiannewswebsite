'use strict';

/**
 * The Meridian — Database Layer
 * Connects to Supabase (PostgreSQL) via the pg client
 * All queries the server needs are in this file.
 */

const { Pool } = require('pg');

// ─── CONNECTION POOL ─────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }   // Supabase requires SSL
    : false,
  max:              10,               // max connections in pool
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Test connection on startup
pool.query('SELECT 1').then(() => {
  console.log('[DB] PostgreSQL connected ✓');
}).catch(err => {
  console.warn('[DB] PostgreSQL not connected — running in RSS-only mode:', err.message);
});

const db = {
  // ── RAW QUERY ───────────────────────────────────────────────
  query: (text, params) => pool.query(text, params),

  // ── ARTICLES ────────────────────────────────────────────────

  /** Get latest articles, optionally filtered by category */
  async getArticles({ category = null, limit = 20, offset = 0, search = null } = {}) {
    let q = `
      SELECT
        id, title, excerpt, url, image_url, author,
        category, tags, published_at, time_ago,
        is_breaking, is_featured, view_count, bookmark_count,
        source_name, source_url, source_country
      FROM v_live_feed
      WHERE 1=1
    `;
    const params = [];
    let i = 1;

    if (category && category !== 'all') {
      q += ` AND category = $${i++}`;
      params.push(category);
    }

    if (search) {
      q += ` AND (
        search_vector @@ plainto_tsquery('english', $${i})
        OR title ILIKE $${i+1}
      )`;
      params.push(search);
      params.push(`%${search}%`);
      i += 2;
    }

    q += ` ORDER BY published_at DESC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);

    const { rows } = await pool.query(q, params);
    return rows;
  },

  /** Count articles for pagination */
  async countArticles({ category = null, search = null } = {}) {
    let q = `SELECT COUNT(*) FROM v_live_feed WHERE 1=1`;
    const params = [];
    let i = 1;
    if (category && category !== 'all') { q += ` AND category = $${i++}`; params.push(category); }
    if (search) { q += ` AND (search_vector @@ plainto_tsquery('english', $${i}) OR title ILIKE $${i+1})`; params.push(search, `%${search}%`); }
    const { rows } = await pool.query(q, params);
    return parseInt(rows[0].count, 10);
  },

  /** Get a single article by ID */
  async getArticleById(id) {
    const { rows } = await pool.query(
      `SELECT a.*, s.name AS source_name, s.site_url AS source_url
       FROM articles a
       JOIN sources s ON s.id = a.source_id
       WHERE a.id = $1 AND a.is_deleted = FALSE`,
      [id]
    );
    return rows[0] || null;
  },

  /** Upsert an article (insert or skip duplicate URLs) */
  async upsertArticle({ sourceId, title, excerpt, url, imageUrl, author, category, tags, publishedAt, isBreaking = false }) {
    const { rows } = await pool.query(
      `INSERT INTO articles
         (source_id, title, excerpt, url, image_url, author, category, tags, published_at, is_breaking)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (url) DO NOTHING
       RETURNING id, (xmax = 0) AS is_new`,
      [sourceId, title, excerpt, url, imageUrl || null, author || null,
       category, tags || [], publishedAt, isBreaking]
    );
    return rows[0] || null;   // null = duplicate (skipped)
  },

  /** Bulk upsert articles — returns counts */
  async bulkUpsertArticles(articles) {
    let inserted = 0, dupes = 0;
    for (const a of articles) {
      const result = await db.upsertArticle(a).catch(() => null);
      if (result?.is_new) inserted++;
      else dupes++;
    }
    return { inserted, dupes };
  },

  /** Mark article as breaking */
  async setBreaking(id, value = true) {
    await pool.query(`UPDATE articles SET is_breaking=$1 WHERE id=$2`, [value, id]);
  },

  /** Soft-delete an article */
  async deleteArticle(id) {
    await pool.query(`UPDATE articles SET is_deleted=TRUE WHERE id=$1`, [id]);
  },

  /** Increment view count */
  async incrementViewCount(id) {
    await pool.query(`SELECT increment_view_count($1)`, [id]);
  },

  // ── SOURCES ─────────────────────────────────────────────────

  /** Get all active sources */
  async getActiveSources() {
    const { rows } = await pool.query(
      `SELECT id, name, feed_url, site_url, category, country, language
       FROM sources
       WHERE status = 'active'
       ORDER BY name`
    );
    return rows;
  },

  /** Update source after a fetch attempt */
  async updateSourceFetchStatus({ sourceId, success, errorMessage = null }) {
    if (success) {
      await pool.query(
        `UPDATE sources
         SET last_fetched=$1, last_success=$1, error_count=0, last_error=NULL, updated_at=NOW()
         WHERE id=$2`,
        [new Date(), sourceId]
      );
    } else {
      await pool.query(
        `UPDATE sources
         SET last_fetched=$1, error_count=error_count+1, last_error=$2, updated_at=NOW(),
             status = CASE WHEN error_count+1 >= 10 THEN 'error'::feed_status ELSE status END
         WHERE id=$3`,
        [new Date(), errorMessage, sourceId]
      );
    }
  },

  // ── FETCH LOG ────────────────────────────────────────────────

  async logFetchStart(sourceId, sourceName) {
    const { rows } = await pool.query(
      `INSERT INTO fetch_log (source_id, source_name) VALUES ($1,$2) RETURNING id`,
      [sourceId, sourceName]
    );
    return rows[0].id;
  },

  async logFetchComplete({ logId, articlesFound, articlesNew, articlesDupe, success, errorMessage, durationMs }) {
    await pool.query(
      `UPDATE fetch_log SET
         completed_at=NOW(), articles_found=$1, articles_new=$2, articles_dupe=$3,
         success=$4, error_message=$5, duration_ms=$6
       WHERE id=$7`,
      [articlesFound, articlesNew, articlesDupe, success, errorMessage || null, durationMs, logId]
    );
  },

  // ── MARKET SNAPSHOTS ─────────────────────────────────────────

  /** Insert a market data snapshot */
  async insertMarketSnapshot({ symbol, label, price, changePct, changeAbs, direction, currency = 'NGN', source }) {
    await pool.query(
      `INSERT INTO market_snapshots (symbol,label,price,change_pct,change_abs,direction,currency,source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [symbol, label, price, changePct, changeAbs, direction, currency, source || null]
    );
  },

  /** Get latest snapshot for each symbol */
  async getLatestMarketSnapshots() {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (symbol)
         symbol, label, price, change_pct, change_abs, direction, currency, snapped_at
       FROM market_snapshots
       ORDER BY symbol, snapped_at DESC`
    );
    return rows;
  },

  // ── TRENDING ─────────────────────────────────────────────────

  /** Recompute trending scores (call every 30 min) */
  async recomputeTrending(windowHours = 24) {
    // Score = view_count * 1 + bookmark_count * 3, weighted by recency
    await pool.query(
      `INSERT INTO trending (article_id, score, rank, window_hours, computed_at)
       SELECT
         id AS article_id,
         (view_count * 1.0 + bookmark_count * 3.0)
           * EXP(-0.1 * EXTRACT(EPOCH FROM (NOW() - published_at)) / 3600) AS score,
         ROW_NUMBER() OVER (ORDER BY
           (view_count * 1.0 + bookmark_count * 3.0)
           * EXP(-0.1 * EXTRACT(EPOCH FROM (NOW() - published_at)) / 3600) DESC
         ) AS rank,
         $1 AS window_hours,
         NOW() AS computed_at
       FROM articles
       WHERE is_deleted = FALSE
         AND published_at > NOW() - ($1 || ' hours')::INTERVAL
       ON CONFLICT (article_id, window_hours) DO UPDATE
         SET score=EXCLUDED.score, rank=EXCLUDED.rank, computed_at=EXCLUDED.computed_at`,
      [windowHours]
    );
  },

  async getTrending(windowHours = 24, limit = 10) {
    const { rows } = await pool.query(
      `SELECT * FROM v_trending_24h LIMIT $1`,
      [limit]
    );
    return rows;
  },

  // ── BOOKMARKS ────────────────────────────────────────────────

  async addBookmark(userId, articleId) {
    await pool.query(
      `INSERT INTO bookmarks (user_id, article_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, articleId]
    );
    await pool.query(`SELECT increment_bookmark_count($1, 1)`, [articleId]);
  },

  async removeBookmark(userId, articleId) {
    const { rowCount } = await pool.query(
      `DELETE FROM bookmarks WHERE user_id=$1 AND article_id=$2`,
      [userId, articleId]
    );
    if (rowCount > 0) await pool.query(`SELECT increment_bookmark_count($1, -1)`, [articleId]);
  },

  async getUserBookmarks(userId, limit = 20) {
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.excerpt, a.url, a.category, a.published_at,
              s.name AS source_name, b.created_at AS bookmarked_at
       FROM bookmarks b
       JOIN articles a ON a.id = b.article_id
       JOIN sources  s ON s.id = a.source_id
       WHERE b.user_id = $1 AND a.is_deleted = FALSE
       ORDER BY b.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return rows;
  },

  // ── STATS ────────────────────────────────────────────────────

  async getStats() {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM articles WHERE is_deleted=FALSE)          AS total_articles,
        (SELECT COUNT(*) FROM articles WHERE published_at > NOW()-INTERVAL '24h' AND is_deleted=FALSE) AS articles_24h,
        (SELECT COUNT(*) FROM articles WHERE is_breaking=TRUE AND is_deleted=FALSE) AS breaking_count,
        (SELECT COUNT(*) FROM sources  WHERE status='active')           AS active_sources,
        (SELECT COUNT(*) FROM sources  WHERE status='error')            AS errored_sources,
        (SELECT MAX(published_at) FROM articles WHERE is_deleted=FALSE) AS latest_article_at,
        (SELECT COUNT(*) FROM fetch_log WHERE started_at > NOW()-INTERVAL '1h') AS fetches_last_hour
    `);
    return rows[0];
  },

  // ── HEALTHCHECK ──────────────────────────────────────────────
  async ping() {
    const { rows } = await pool.query('SELECT NOW() AS db_time');
    return rows[0].db_time;
  },

  // ── CLEANUP ─────────────────────────────────────────────────
  /** Delete articles older than N days to keep DB lean */
  async pruneOldArticles(daysToKeep = 30) {
    const { rowCount } = await pool.query(
      `UPDATE articles SET is_deleted=TRUE
       WHERE published_at < NOW() - ($1 || ' days')::INTERVAL
         AND is_featured=FALSE AND is_deleted=FALSE`,
      [daysToKeep]
    );
    return rowCount;
  },

  async close() {
    await pool.end();
  },
};

module.exports = db;
