'use strict';

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const RSSParser  = require('rss-parser');
const path       = require('path');

// Database layer — gracefully optional
let db = null;
if (process.env.DATABASE_URL) {
  db = require('./database/db');
  console.log('[Server] Mode: PostgreSQL (Supabase)');
} else {
  console.log('[Server] Mode: In-memory cache (add DATABASE_URL to .env for persistence)');
}

const app    = express();
const parser = new RSSParser({
  timeout: 8000,
  headers: { 'User-Agent': 'TheMeridian/1.0 (+https://themeridian.ng)' },
});

// ─── SECURITY ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET','POST'] }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests.' } }));

// ─── SOURCES ─────────────────────────────────────────────────────────────────
const STATIC_SOURCES = [
  { name:'Punch',         url:'https://punchng.com/feed/',                      category:'nigeria',  siteUrl:'https://punchng.com'        },
  { name:'Vanguard',      url:'https://www.vanguardngr.com/feed/',              category:'nigeria',  siteUrl:'https://vanguardngr.com'    },
  { name:'Channels TV',   url:'https://www.channelstv.com/feed/',               category:'nigeria',  siteUrl:'https://channelstv.com'     },
  { name:'BusinessDay',   url:'https://businessday.ng/feed/',                   category:'business', siteUrl:'https://businessday.ng'     },
  { name:'Nairametrics',  url:'https://nairametrics.com/feed/',                 category:'markets',  siteUrl:'https://nairametrics.com'   },
  { name:'TechCabal',     url:'https://techcabal.com/feed/',                    category:'tech',     siteUrl:'https://techcabal.com'      },
  { name:'The Cable',     url:'https://www.thecable.ng/feed',                   category:'nigeria',  siteUrl:'https://thecable.ng'        },
  { name:'Premium Times', url:'https://www.premiumtimesng.com/feed',            category:'nigeria',  siteUrl:'https://premiumtimesng.com' },
  { name:'BBC News',      url:'https://feeds.bbci.co.uk/news/rss.xml',         category:'world',    siteUrl:'https://bbc.com/news'       },
  { name:'BBC Sport',     url:'https://feeds.bbci.co.uk/sport/rss.xml',        category:'sports',   siteUrl:'https://bbc.com/sport'      },
  { name:'Reuters',       url:'https://feeds.reuters.com/reuters/topNews',      category:'world',    siteUrl:'https://reuters.com'        },
  { name:'ESPN',          url:'https://www.espn.com/espn/rss/news',            category:'sports',   siteUrl:'https://espn.com'           },
  { name:'TechCrunch',    url:'https://techcrunch.com/feed/',                   category:'tech',     siteUrl:'https://techcrunch.com'     },
  { name:'The Verge',     url:'https://www.theverge.com/rss/index.xml',        category:'tech',     siteUrl:'https://theverge.com'       },
  { name:'Bloomberg',     url:'https://feeds.bloomberg.com/markets/news.rss',   category:'markets',  siteUrl:'https://bloomberg.com'      },
  { name:'Al Jazeera',    url:'https://www.aljazeera.com/xml/rss/all.xml',     category:'world',    siteUrl:'https://aljazeera.com'      },
];

const KEYWORDS = {
  sports:   ['football','soccer','nfl','nba','tennis','f1','formula','transfer','league','cup','goal','match','score','athlete','sport'],
  tech:     ['ai','artificial intelligence','tech','software','app','startup','crypto','bitcoin','ethereum','blockchain','cloud','openai','google','apple'],
  markets:  ['stock','market','ngx','nasdaq','shares','equity','bond','yield','inflation','gdp','cbn','interest rate','naira','forex','investment','earnings'],
  politics: ['election','senate','president','governor','minister','government','policy','bill','parliament','vote','party','apc','pdp'],
  nigeria:  ['nigeria','lagos','abuja','kano','ibadan','enugu','port harcourt','nnpc','dangote','tinubu'],
  world:    ['china','europe','russia','ukraine','g7','g20','imf','world bank','united nations','nato'],
  business: ['revenue','profit','ceo','merger','acquisition','ipo','quarterly','fiscal','trade'],
};

function classify(title, content, fallback) {
  const t = (title + ' ' + (content||'')).toLowerCase();
  for (const [cat, kws] of Object.entries(KEYWORDS)) if (kws.some(k => t.includes(k))) return cat;
  return fallback;
}
function stripHtml(h) { return (h||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,300); }
function timeAgo(d) {
  const s = Math.floor((Date.now()-new Date(d))/1000);
  if (s<60) return s+'s ago'; if (s<3600) return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago';
}

// ─── MEMORY CACHE ─────────────────────────────────────────────────────────────
let memCache = { articles:[], fetchedAt:null, errors:[] };

async function fetchOneFeed(src) {
  try {
    const feed  = await parser.parseURL(src.url);
    const items = (feed.items||[]).slice(0,15).map(item => ({
      sourceId:    src.id||null,
      title:       (item.title||'Untitled').trim(),
      excerpt:     stripHtml(item.contentSnippet||item.content||item.summary||''),
      url:         item.link||item.guid||'#',
      imageUrl:    item.enclosure?.url||null,
      author:      item.creator||item.author||null,
      category:    classify(item.title, item.contentSnippet, src.category),
      tags:        [],
      publishedAt: item.pubDate||item.isoDate||new Date().toISOString(),
      source:      src.name,
      sourceUrl:   src.siteUrl,
      timeAgo:     timeAgo(item.pubDate||item.isoDate),
    }));
    // Persist to DB if available
    if (db && src.id) await db.bulkUpsertArticles(items).catch(()=>{});
    return { success:true, articles:items };
  } catch(e) {
    return { success:false, name:src.name, error:e.message, articles:[] };
  }
}

async function refreshAllFeeds() {
  console.log(`[${new Date().toISOString()}] Refreshing feeds...`);
  let sources = STATIC_SOURCES;
  if (db) {
    const dbSrcs = await db.getActiveSources().catch(()=>[]);
    if (dbSrcs.length) sources = dbSrcs.map(s=>({ id:s.id, name:s.name, url:s.feed_url, category:s.category, siteUrl:s.site_url }));
  }
  const results  = await Promise.allSettled(sources.map(fetchOneFeed));
  const all=[], errors=[];
  for (const r of results) {
    if (r.status==='fulfilled') { all.push(...(r.value.articles||[])); if(!r.value.success) errors.push(r.value); }
  }
  const seen = new Set();
  const deduped = all.filter(a=>{ if(seen.has(a.url)) return false; seen.add(a.url); return true; })
    .sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
  memCache = { articles:deduped, fetchedAt:new Date().toISOString(), errors };
  if (db) await db.recomputeTrending(24).catch(()=>{});
  console.log(`[${new Date().toISOString()}] Done — ${deduped.length} articles, ${errors.length} errors`);
  return memCache;
}

refreshAllFeeds();
setInterval(refreshAllFeeds, 15*60_000);

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/news', async (req,res) => {
  try {
    const page = Math.max(1,parseInt(req.query.page)||1);
    const limit= Math.min(50,parseInt(req.query.limit)||20);
    const cat  = req.query.category||'all';
    const q    = (req.query.q||'').toLowerCase().trim();
    const offset=(page-1)*limit;
    if (db) {
      const [articles,total] = await Promise.all([
        db.getArticles({category:cat!=='all'?cat:null,limit,offset,search:q||null}),
        db.countArticles({category:cat!=='all'?cat:null,search:q||null}),
      ]);
      return res.json({ok:true,total,page,limit,pages:Math.ceil(total/limit),fetchedAt:memCache.fetchedAt,source:'database',articles});
    }
    let arts=[...memCache.articles];
    if(cat!=='all') arts=arts.filter(a=>a.category===cat);
    if(q) arts=arts.filter(a=>a.title.toLowerCase().includes(q)||(a.excerpt||'').toLowerCase().includes(q));
    arts.forEach(a=>{a.timeAgo=timeAgo(a.publishedAt);});
    res.json({ok:true,total:arts.length,page,limit,pages:Math.ceil(arts.length/limit),fetchedAt:memCache.fetchedAt,source:'memory',articles:arts.slice(offset,offset+limit)});
  } catch(e){res.status(500).json({ok:false,error:'Failed to fetch articles'});}
});

app.get('/api/news/:category', async (req,res) => {
  const valid=['nigeria','world','tech','sports','markets','politics','business'];
  const {category}=req.params;
  if(!valid.includes(category)) return res.status(400).json({ok:false,error:`Invalid category. Valid: ${valid.join(', ')}`});
  const limit=Math.min(50,parseInt(req.query.limit)||20);
  try {
    const arts = db
      ? await db.getArticles({category,limit})
      : memCache.articles.filter(a=>a.category===category).slice(0,limit).map(a=>({...a,timeAgo:timeAgo(a.publishedAt)}));
    res.json({ok:true,category,count:arts.length,fetchedAt:memCache.fetchedAt,articles:arts});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/trending', async (req,res) => {
  try {
    const arts = db ? await db.getTrending(24,10) : memCache.articles.slice(0,10);
    res.json({ok:true,articles:arts});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/markets', async (req,res) => {
  try {
    const markets = db ? await db.getLatestMarketSnapshots() : [];
    res.json({ok:true,markets});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/sources', async (req,res) => {
  try {
    const sources = db
      ? await db.getActiveSources()
      : STATIC_SOURCES.map(s=>({name:s.name,category:s.category,url:s.siteUrl}));
    res.json({ok:true,count:sources.length,sources});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.post('/api/refresh', async (req,res) => {
  const key=req.headers['x-api-key'];
  if(process.env.REFRESH_API_KEY && key!==process.env.REFRESH_API_KEY)
    return res.status(401).json({ok:false,error:'Unauthorized'});
  try {
    const r=await refreshAllFeeds();
    res.json({ok:true,count:r.articles.length,fetchedAt:r.fetchedAt,errors:r.errors.length});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/status', async (req,res) => {
  const lagosTime=new Date().toLocaleString('en-NG',{timeZone:'Africa/Lagos',hour12:false});
  let dbStats=null, dbTime=null;
  if(db){ [dbStats,dbTime]=await Promise.all([db.getStats().catch(()=>null),db.ping().catch(()=>null)]); }
  res.json({
    ok:true, status:'running',
    mode: db?'database':'memory',
    lagosTime,
    fetchedAt:memCache.fetchedAt,
    articlesCount:memCache.articles.length,
    feedErrors:memCache.errors.length,
    nextRefreshMs:memCache.fetchedAt?Math.max(0,15*60_000-(Date.now()-new Date(memCache.fetchedAt))):0,
    database:dbStats, dbTime:dbTime?.toISOString()||null,
  });
});

app.use(express.static(path.join(__dirname,'public')));
app.get('/{*splat}', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.use((req,res) => res.status(404).json({ok:false,error:'Not found'}));
app.use((err,req,res,_next) => { console.error(err.stack); res.status(500).json({ok:false,error:'Internal server error'}); });

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n🌍 The Meridian — http://localhost:${PORT}`);
  console.log(`   DB: ${db?'PostgreSQL (Supabase)':'In-memory (no DATABASE_URL)'}\n`);
});
module.exports=app;
