#!/usr/bin/env node
'use strict';

/**
 * The Meridian — Database Migration Runner
 * Usage:
 *   node database/migrate.js              → run all pending migrations
 *   node database/migrate.js --reset      → DROP everything and rebuild (⚠️ destructive)
 *   node database/migrate.js --seed-only  → seed sources only
 *   node database/migrate.js --status     → show migration status
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

const args  = process.argv.slice(2);
const RESET = args.includes('--reset');
const SEED  = args.includes('--seed-only');
const STATUS= args.includes('--status');

if (!process.env.DATABASE_URL) {
  console.error('\n❌  DATABASE_URL not set in .env\n');
  console.error('    Get it from: Supabase → Project Settings → Database → Connection string → URI\n');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();

  try {
    console.log('\n🗄️  The Meridian — Database Migration\n');

    // ── STATUS ──────────────────────────────────────────────────────────────
    if (STATUS) {
      const { rows } = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      if (rows.length === 0) {
        console.log('  No tables found — database is empty. Run: node database/migrate.js\n');
      } else {
        console.log('  Tables in public schema:');
        rows.forEach(r => console.log('   ✓', r.table_name));
        const { rows: counts } = await client.query(`
          SELECT
            (SELECT COUNT(*) FROM sources)  AS sources,
            (SELECT COUNT(*) FROM articles) AS articles
        `).catch(() => ({ rows: [{ sources: '?', articles: '?' }] }));
        console.log(`\n  sources: ${counts[0].sources}  |  articles: ${counts[0].articles}\n`);
      }
      return;
    }

    // ── RESET ───────────────────────────────────────────────────────────────
    if (RESET) {
      console.log('  ⚠️  RESET MODE — dropping all tables...');
      await client.query(`
        DROP TABLE IF EXISTS bookmarks, trending, market_snapshots, fetch_log, articles, sources CASCADE;
        DROP TYPE  IF EXISTS article_category, feed_status CASCADE;
        DROP FUNCTION IF EXISTS set_updated_at, increment_view_count, increment_bookmark_count CASCADE;
        DROP VIEW  IF EXISTS v_live_feed, v_source_health, v_trending_24h CASCADE;
      `);
      console.log('  ✓ All tables dropped\n');
    }

    // ── SEED ONLY ───────────────────────────────────────────────────────────
    if (SEED) {
      console.log('  Seeding sources...');
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      // Extract just the INSERT block
      const seedMatch = schema.match(/INSERT INTO sources[\s\S]+?ON CONFLICT[^;]+;/);
      if (seedMatch) {
        await client.query(seedMatch[0]);
        const { rows } = await client.query('SELECT COUNT(*) FROM sources');
        console.log(`  ✓ Sources in DB: ${rows[0].count}\n`);
      } else {
        console.log('  No seed data found in schema.sql\n');
      }
      return;
    }

    // ── FULL MIGRATION ──────────────────────────────────────────────────────
    console.log('  Running schema.sql...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

    // Split into individual statements (handle $$ function bodies)
    await client.query(schema);

    console.log('  ✓ Schema applied\n');

    // Verify tables
    const { rows: tables } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('  Tables created:');
    tables.forEach(t => console.log('   ✓', t.table_name));

    // Verify views
    const { rows: views } = await client.query(`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    if (views.length) {
      console.log('\n  Views created:');
      views.forEach(v => console.log('   ✓', v.table_name));
    }

    // Count seeded sources
    const { rows: srcCount } = await client.query('SELECT COUNT(*) FROM sources');
    console.log(`\n  ✓ Sources seeded: ${srcCount[0].count}`);

    console.log('\n  🟢 Migration complete!\n');
    console.log('  Next step: add DATABASE_URL to your .env and start the server:\n');
    console.log('    npm start\n');

  } catch (err) {
    console.error('\n  ❌ Migration failed:', err.message);
    if (err.hint)   console.error('  Hint:', err.hint);
    if (err.detail) console.error('  Detail:', err.detail);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
