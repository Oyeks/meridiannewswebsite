'use strict';

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const RSSParser    = require('rss-parser');
const path         = require('path');

const app    = express();
const parser = new RSSParser({ timeout: 8000, headers: { 'User-Agent': 'TheMeridian/1.0 (+https://themeridian.ng)' } });

// ─── SECURITY MIDDLEWARE ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'fonts.gstatic.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET'], optionsSuccessStatus: 200 }));
app.use(express.json());

// Rate limiting — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});
app.use('/api/', limiter);

// ─── RSS FEED SOURCES ─────────────────────────────────────────────────────────
const FEEDS = [
  // Nigerian sources
  { name: 'Punch',        url: 'https://punchng.com/feed/',                         category: 'nigeria'  },
  { name: 'Vanguard',     url: 'https://www.vanguardngr.com/feed/',                 category: 'nigeria'  },
  { name: 'Channels TV',  url: 'https://www.channelstv.com/feed/',                  category: 'nigeria'  },
  { name: 'BusinessDay',  url: 'https://businessday.ng/feed/',                      category: 'business' },
  { name: 'Nairametrics', url: 'https://nairametrics.com/feed/',                    category: 'markets'  },
  { name: 'TechCabal',    url: 'https://techcabal.com/feed/',                       category: 'tech'     },
  // International sources
  { name: 'BBC News',     url: 'https://feeds.bbci.co.uk/news/rss.xml',             category: 'world'    },
  { name: 'BBC Sport',    url: 'https://feeds.bbci.co.uk/sport/rss.xml',            category: 'sports'   },
  { name: 'Reuters',      url: 'https://feeds.reuters.com/reuters/topNews',         category: 'world'    },
  { name: 'ESPN',         url: 'https://www.espn.com/espn/rss/news',                category: 'sports'   },
  { name: 'TechCrunch',   url: 'https://techcrunch.com/feed/',                      category: 'tech'     },
  { name: 'The Verge',    url: 'https://www.theverge.com/rss/index.xml',            category: 'tech'     },
];

// Category keywords for auto-classification
const CATEGORY_KEYWORDS = {
  sports:   ['football','soccer','nfl','nba','tennis','f1','formula','transfer','league','cup','goal','match','score','player','athlete','game','sport'],
  tech:     ['ai','artificial intelligence','tech','software','app','startup','crypto','bitcoin','ethereum','blockchain','cybersecurity','data','cloud','openai','google','apple','meta','microsoft'],
  markets:  ['stock','market','ngx','nasdaq','s&p','dow','shares','equity','bond','yield','inflation','gdp','cbn','interest rate','naira','dollar','forex','investment','fund','bank earnings'],
  politics: ['election','senate','house','president','governor','minister','government','policy','law','bill','parliament','congress','vote','party','apc','pdp'],
  nigeria:  ['nigeria','lagos','abuja','kano','ibadan','enugu','ph','port harcourt','nnpc','dangote','buhari','tinubu','naira'],
  world:    ['china','us','usa','uk','europe','russia','ukraine','g7','g20','imf','world bank','united nations','nato'],
  business: ['revenue','profit','ceo','merger','acquisition','ipo','quarterly','earnings','fiscal','trade'],
};

function classifyArticle(title, content, feedCategory) {
  const text = (title + ' ' + (content || '')).toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) return cat;
  }
  return feedCategory;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - new Date(date)) / 1000);
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400)return `${Math.floor(secs/3600)}h ago`;
  return `${Math.floor(secs/86400)}d ago`;
}

// ─── IN-MEMORY CACHE ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let cache = {
  articles:    [],
  fetchedAt:   null,
  fetchErrors: [],
};

async function fetchFeed(feed) {
  try {
    const result = await parser.parseURL(feed.url);
    return (result.items || []).slice(0, 12).map(item => ({
      id:          Buffer.from(item.link || item.guid || item.title || Math.random().toString()).toString('base64').slice(0, 16),
      title:       item.title || 'Untitled',
      excerpt:     stripHtml(item.contentSnippet || item.content || item.summary || ''),
      url:         item.link || item.guid || '#',
      source:      feed.name,
      sourceUrl:   new URL(feed.url).origin,
      category:    classifyArticle(item.title, item.contentSnippet, feed.category),
      publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
      timeAgo:     timeAgo(item.pubDate || item.isoDate),
      image:       item.enclosure?.url || item['media:content']?.['$']?.url || null,
    }));
  } catch (err) {
    return { error: true, feed: feed.name, message: err.message };
  }
}

async function refreshAllFeeds() {
  console.log(`[${new Date().toISOString()}] Fetching ${FEEDS.length} feeds...`);
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));

  const articles = [];
  const errors   = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const val = result.value;
      if (Array.isArray(val)) articles.push(...val);
      else if (val?.error)   errors.push(val);
    } else {
      errors.push({ error: true, message: result.reason?.message });
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = articles.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  // Sort newest first
  deduped.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  cache = { articles: deduped, fetchedAt: new Date().toISOString(), fetchErrors: errors };
  console.log(`[${new Date().toISOString()}] Cached ${deduped.length} articles. Errors: ${errors.length}`);
  return cache;
}

// Initial fetch on startup
refreshAllFeeds();
// Auto-refresh every 15 minutes
setInterval(refreshAllFeeds, CACHE_TTL_MS);

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// GET /api/news — all articles (paginated)
app.get('/api/news', (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.min(50, parseInt(req.query.limit) || 20);
  const category = req.query.category || 'all';
  const q        = (req.query.q || '').toLowerCase();

  let articles = [...cache.articles];

  if (category !== 'all') {
    articles = articles.filter(a => a.category === category);
  }

  if (q) {
    articles = articles.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.excerpt.toLowerCase().includes(q) ||
      a.source.toLowerCase().includes(q)
    );
  }

  const total = articles.length;
  const start = (page - 1) * limit;
  const items = articles.slice(start, start + limit);

  // Refresh timeAgo on serve
  items.forEach(a => { a.timeAgo = timeAgo(a.publishedAt); });

  res.json({
    ok:         true,
    total,
    page,
    limit,
    pages:      Math.ceil(total / limit),
    fetchedAt:  cache.fetchedAt,
    articles:   items,
  });
});

// GET /api/news/:category — shortcut
app.get('/api/news/:category', (req, res) => {
  const { category } = req.params;
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const validCats = ['nigeria','world','tech','sports','markets','politics','business'];

  if (!validCats.includes(category)) {
    return res.status(400).json({ ok: false, error: `Invalid category. Valid: ${validCats.join(', ')}` });
  }

  const articles = cache.articles
    .filter(a => a.category === category)
    .slice(0, limit)
    .map(a => ({ ...a, timeAgo: timeAgo(a.publishedAt) }));

  res.json({ ok: true, category, count: articles.length, fetchedAt: cache.fetchedAt, articles });
});

// GET /api/refresh — manual refresh trigger (could be protected by API key in production)
app.post('/api/refresh', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (process.env.REFRESH_API_KEY && apiKey !== process.env.REFRESH_API_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const result = await refreshAllFeeds();
    res.json({ ok: true, count: result.articles.length, fetchedAt: result.fetchedAt, errors: result.fetchErrors.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/status — health check
app.get('/api/status', (req, res) => {
  const lagosTime = new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour12: false });
  res.json({
    ok:           true,
    status:       'running',
    articlesCount: cache.articles.length,
    fetchedAt:    cache.fetchedAt,
    cacheAgeMs:   cache.fetchedAt ? Date.now() - new Date(cache.fetchedAt) : null,
    nextRefreshMs: cache.fetchedAt ? Math.max(0, CACHE_TTL_MS - (Date.now() - new Date(cache.fetchedAt))) : 0,
    lagosTime,
    feeds:        FEEDS.length,
    errors:       cache.fetchErrors.length,
  });
});

// GET /api/sources — list all configured sources
app.get('/api/sources', (req, res) => {
  res.json({ ok: true, sources: FEEDS.map(f => ({ name: f.name, category: f.category, url: new URL(f.url).origin })) });
});

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── ERROR HANDLERS ───────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🌍 The Meridian backend running on http://localhost:${PORT}\n`));

module.exports = app;
