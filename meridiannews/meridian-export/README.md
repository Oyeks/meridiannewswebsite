# The Meridian — Backend

Real-time news aggregator pulling live RSS feeds from 12 Nigerian and international sources.

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure (optional)
cp .env.example .env
# edit .env as needed

# 3. Run
npm start
# → http://localhost:3000
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/news` | All articles (paginated) |
| GET | `/api/news/:category` | By category |
| GET | `/api/status` | Server health + cache info |
| GET | `/api/sources` | List all RSS sources |
| POST | `/api/refresh` | Force feed refresh |

### Query Parameters (`/api/news`)
- `?category=nigeria|world|tech|sports|markets|politics`
- `?q=search+term`
- `?page=1&limit=20`

## News Sources

**Nigeria:** Punch, Vanguard, Channels TV, BusinessDay, Nairametrics, TechCabal  
**International:** BBC News, BBC Sport, Reuters, ESPN, TechCrunch, The Verge

## Cache & Refresh

- Feeds are cached for **15 minutes**
- Auto-refresh runs every 15 minutes via `setInterval`
- Manual refresh via the Refresh button in the UI (calls `POST /api/refresh`)
- `GET /api/status` shows `nextRefreshMs` — time until next auto-refresh

## Security Features

- **Helmet.js** — sets all security headers (CSP, HSTS, X-Frame-Options, etc.)
- **Rate limiting** — 60 requests/minute per IP
- **CORS** — configurable via `ALLOWED_ORIGIN` env var
- **Input validation** — category enum validation, safe JSON responses
- **No SQL** — in-memory cache only, no injection surface
- **Error handling** — stack traces never exposed to clients
- **noopener** — all external links open with `rel="noopener"`

## Run Security Tests

```bash
# In one terminal:
npm start

# In another:
npm test
```

## Production Checklist

- [ ] Set `ALLOWED_ORIGIN=https://yourdomain.com` in .env
- [ ] Set `REFRESH_API_KEY=some-secret` in .env
- [ ] Run behind HTTPS reverse proxy (nginx/Caddy)
- [ ] Add process manager (PM2): `pm2 start server.js --name meridian`
- [ ] Set up log rotation

## Deploy to Railway / Render / Fly.io

```bash
# Railway
railway init && railway up

# Render — connect GitHub repo, set build command: npm install, start: npm start

# Fly.io
fly launch && fly deploy
```
