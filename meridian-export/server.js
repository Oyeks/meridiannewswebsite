'use strict';

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const RSSParser = require('rss-parser');
const path      = require('path');

// ─── DATABASE (optional) ──────────────────────────────────────────────────────
let db = null;
if (process.env.DATABASE_URL) {
  try {
    db = require('./database/db');
    console.log('[DB] PostgreSQL mode enabled');
  } catch (e) {
    console.warn('[DB] Could not load db module:', e.message);
  }
} else {
  console.log('[DB] No DATABASE_URL — running in memory-only mode');
}

// ─── APP SETUP ────────────────────────────────────────────────────────────────
const app    = express();
const parser = new RSSParser({
  timeout: 10000,
  headers: { 'User-Agent': 'TheMeridian/1.0' },
});

app.set('trust proxy', 1);

// Security headers
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS
app.use(cors({
  origin:  process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// Rate limiting
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please slow down.' },
}));

// ─── RSS FEED SOURCES ─────────────────────────────────────────────────────────
const SOURCES = [
  // Nigeria
  { name: 'Punch',          url: 'https://punchng.com/feed/',                      category: 'nigeria',  site: 'https://punchng.com'        },
  { name: 'Vanguard',       url: 'https://www.vanguardngr.com/feed/',              category: 'nigeria',  site: 'https://vanguardngr.com'    },
  { name: 'Channels TV',    url: 'https://www.channelstv.com/feed/',               category: 'nigeria',  site: 'https://channelstv.com'     },
  { name: 'BusinessDay',    url: 'https://businessday.ng/feed/',                   category: 'business', site: 'https://businessday.ng'     },
  { name: 'Nairametrics',   url: 'https://nairametrics.com/feed/',                 category: 'markets',  site: 'https://nairametrics.com'   },
  { name: 'TechCabal',      url: 'https://techcabal.com/feed/',                    category: 'tech',     site: 'https://techcabal.com'      },
  { name: 'The Cable',      url: 'https://www.thecable.ng/feed',                   category: 'nigeria',  site: 'https://thecable.ng'        },
  { name: 'Premium Times',  url: 'https://www.premiumtimesng.com/feed',            category: 'nigeria',  site: 'https://premiumtimesng.com' },
  // International
  { name: 'BBC News',       url: 'https://feeds.bbci.co.uk/news/rss.xml',         category: 'world',    site: 'https://bbc.com/news'       },
  { name: 'BBC Sport',      url: 'https://feeds.bbci.co.uk/sport/rss.xml',        category: 'sports',   site: 'https://bbc.com/sport'      },
  { name: 'Reuters',        url: 'https://feeds.reuters.com/reuters/topNews',      category: 'world',    site: 'https://reuters.com'        },
  { name: 'ESPN',           url: 'https://www.espn.com/espn/rss/news',            category: 'sports',   site: 'https://espn.com'           },
  { name: 'TechCrunch',     url: 'https://techcrunch.com/feed/',                   category: 'tech',     site: 'https://techcrunch.com'     },
  { name: 'The Verge',      url: 'https://www.theverge.com/rss/index.xml',        category: 'tech',     site: 'https://theverge.com'       },
  { name: 'Al Jazeera',     url: 'https://www.aljazeera.com/xml/rss/all.xml',     category: 'world',    site: 'https://aljazeera.com'      },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const KEYWORDS = {
  sports:   ['football','soccer','nfl','nba','tennis','formula 1','f1','transfer','league','cup','goal','match','athlete','sport','cricket','rugby'],
  tech:     ['artificial intelligence','ai ','tech','software','startup','crypto','bitcoin','ethereum','blockchain','cloud','openai','google','apple','microsoft','cybersecurity'],
  markets:  ['stock market','ngx','nasdaq','shares','equity','bond','yield','inflation','gdp','cbn','interest rate','naira','forex','investment','earnings','fund'],
  politics: ['election','senate','house of rep','president','governor','minister','government','policy','legislation','parliament','vote','apc','pdp','inec'],
  nigeria:  ['nigeria','lagos','abuja','kano','ibadan','enugu','port harcourt','nnpc','dangote','tinubu','okonjo'],
  world:    ['china','europe','russia','ukraine','g7','g20','imf','world bank','united nations','nato','middle east','us president'],
  business: ['revenue','profit','ceo','merger','acquisition','ipo','quarterly results','fiscal','trade deal'],
};

function classify(title, snippet, fallback) {
  const text = ((title || '') + ' ' + (snippet || '')).toLowerCase();
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => text.includes(w))) return cat;
  }
  return fallback || 'world';
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
}

function timeAgo(dateStr) {
  const secs = Math.floor((Date.now() - new Date(dateStr)) / 1000);
  if (secs < 60)    return secs + 's ago';
  if (secs < 3600)  return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
let cache = {
  articles:  [],
  fetchedAt: null,
  errorCount: 0,
};

// ─── FEED FETCH ───────────────────────────────────────────────────────────────
async function fetchOneFeed(source) {
  try {
    const feed  = await parser.parseURL(source.url);
    const items = (feed.items || []).slice(0, 12);
    return items.map(item => ({
      id:          Buffer.from(item.link || item.guid || item.title || String(Math.random())).toString('base64').slice(0, 16),
      title:       (item.title || 'Untitled').trim(),
      excerpt:     stripHtml(item.contentSnippet || item.content || item.summary || ''),
      url:         item.link || item.guid || source.site,
      imageUrl:    (item.enclosure && item.enclosure.url) || null,
      author:      item.creator || item.author || null,
      category:    classify(item.title, item.contentSnippet, source.category),
      publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
      timeAgo:     timeAgo(item.pubDate || item.isoDate),
      source:      source.name,
      sourceUrl:   source.site,
    }));
  } catch (err) {
    console.warn('[Feed error]', source.name + ':', err.message);
    return [];
  }
}

async function refreshAll() {
  console.log('[' + new Date().toISOString() + '] Fetching ' + SOURCES.length + ' feeds...');

  const results = await Promise.allSettled(SOURCES.map(fetchOneFeed));

  const all   = [];
  let errors  = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') all.push.apply(all, r.value);
    else errors++;
  }

  // Deduplicate by URL
  const seen    = new Set();
  const deduped = [];
  for (const a of all) {
    if (!seen.has(a.url)) { seen.add(a.url); deduped.push(a); }
  }

  // Sort newest first
  deduped.sort(function(a, b) {
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });

  cache = { articles: deduped, fetchedAt: new Date().toISOString(), errorCount: errors };

  // Persist to DB if connected
  if (db) {
    try {
      const dbSources = await db.getActiveSources();
      const sourceMap = {};
      dbSources.forEach(function(s) { sourceMap[s.name] = s.id; });

      const toInsert = deduped.map(function(a) {
        return Object.assign({}, a, { sourceId: sourceMap[a.source] || null });
      });
      await db.bulkUpsertArticles(toInsert);
      await db.recomputeTrending(24);
    } catch (e) {
      console.warn('[DB] Persist error:', e.message);
    }
  }

  console.log('[' + new Date().toISOString() + '] Cached ' + deduped.length + ' articles (' + errors + ' feed errors)');
  return cache;
}

// Initial fetch then every 15 minutes
refreshAll();
setInterval(refreshAll, 15 * 60 * 1000);

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// GET /api/news
app.get('/api/news', function(req, res) {
  try {
    var page     = Math.max(1, parseInt(req.query.page)  || 1);
    var limit    = Math.min(50, parseInt(req.query.limit) || 20);
    var category = req.query.category || 'all';
    var q        = (req.query.q || '').toLowerCase().trim();
    var offset   = (page - 1) * limit;

    var articles = cache.articles.slice();

    if (category !== 'all') {
      articles = articles.filter(function(a) { return a.category === category; });
    }
    if (q) {
      articles = articles.filter(function(a) {
        return a.title.toLowerCase().indexOf(q) !== -1 ||
               (a.excerpt || '').toLowerCase().indexOf(q) !== -1 ||
               a.source.toLowerCase().indexOf(q) !== -1;
      });
    }

    // Refresh timeAgo on serve
    articles.forEach(function(a) { a.timeAgo = timeAgo(a.publishedAt); });

    var total = articles.length;
    res.json({
      ok:        true,
      total:     total,
      page:      page,
      limit:     limit,
      pages:     Math.ceil(total / limit),
      fetchedAt: cache.fetchedAt,
      articles:  articles.slice(offset, offset + limit),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to load articles' });
  }
});

// GET /api/news/:category
app.get('/api/news/:category', function(req, res) {
  var valid = ['nigeria','world','tech','sports','markets','politics','business'];
  var cat   = req.params.category;
  if (valid.indexOf(cat) === -1) {
    return res.status(400).json({ ok: false, error: 'Invalid category. Use: ' + valid.join(', ') });
  }
  var limit    = Math.min(50, parseInt(req.query.limit) || 20);
  var articles = cache.articles.filter(function(a) { return a.category === cat; }).slice(0, limit);
  articles.forEach(function(a) { a.timeAgo = timeAgo(a.publishedAt); });
  res.json({ ok: true, category: cat, count: articles.length, fetchedAt: cache.fetchedAt, articles: articles });
});

// GET /api/trending — top 10 most recent as proxy for trending
app.get('/api/trending', function(req, res) {
  var articles = cache.articles.slice(0, 10).map(function(a) {
    return Object.assign({}, a, { timeAgo: timeAgo(a.publishedAt) });
  });
  res.json({ ok: true, articles: articles });
});

// GET /api/sources
app.get('/api/sources', function(req, res) {
  var sources = SOURCES.map(function(s) {
    return { name: s.name, category: s.category, url: s.site };
  });
  res.json({ ok: true, count: sources.length, sources: sources });
});

// POST /api/refresh
app.post('/api/refresh', function(req, res) {
  var apiKey = req.headers['x-api-key'];
  if (process.env.REFRESH_API_KEY && apiKey !== process.env.REFRESH_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  refreshAll().then(function(result) {
    res.json({ ok: true, count: result.articles.length, fetchedAt: result.fetchedAt, errors: result.errorCount });
  }).catch(function(e) {
    res.status(500).json({ ok: false, error: e.message });
  });
});

// GET /api/status
app.get('/api/status', function(req, res) {
  var lagosTime = new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false });
  res.json({
    ok:            true,
    status:        'running',
    lagosTime:     lagosTime,
    fetchedAt:     cache.fetchedAt,
    articlesCount: cache.articles.length,
    feedErrors:    cache.errorCount,
    sources:       SOURCES.length,
    nextRefreshMs: cache.fetchedAt
      ? Math.max(0, 15 * 60 * 1000 - (Date.now() - new Date(cache.fetchedAt)))
      : 0,
    dbConnected:   db !== null,
  });
});

// ─── STATIC FILES + CATCH-ALL ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 catch-all (NOT Express 5 syntax)
app.use(function(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use(function(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[Error]', err.message);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────────────────────
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('\n The Meridian running on port ' + PORT);
  console.log(' DB: ' + (db ? 'PostgreSQL connected' : 'Memory-only mode') + '\n');
});

module.exports = app;
