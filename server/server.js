// ============================================
// Scraper API - Express + puppeteer-core + @sparticuz/chromium
// FIXED VERSION v2 - see FIX2: comments for what changed this round
// ============================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium').default;
const child_process = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { pickBestPhoneCandidate } = require('./phone-utils');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/+/g, '/');
  next();
});

// Limits / flags
const LOW_MEMORY_MODE =
  process.env.LOW_MEMORY_MODE === 'true' ||
  process.env.LOW_MEMORY_MODE === '1' ||
  (process.env.MEMORY_LIMIT_MB ? parseInt(process.env.MEMORY_LIMIT_MB, 10) <= 512 : false);
const MAX_LEADS_QUICK = parseInt(process.env.MAX_LEADS_QUICK || (LOW_MEMORY_MODE ? '20' : '200'));
const MAX_LEADS_DEEP = parseInt(process.env.MAX_LEADS_DEEP || (LOW_MEMORY_MODE ? '30' : '1000'));
const DAILY_LEAD_LIMIT = parseInt(process.env.DAILY_LEAD_LIMIT || (LOW_MEMORY_MODE ? '200' : '2000'));
const DEEP_DEFAULT_GRID_SIZE = parseInt(process.env.DEEP_GRID_SIZE || (LOW_MEMORY_MODE ? '1' : '2'));
const DEEP_MAX_CELLS_PER_TERM = parseInt(process.env.DEEP_MAX_CELLS_PER_TERM || (LOW_MEMORY_MODE ? '1' : '4'));
const DEEP_MAX_CONCURRENCY = parseInt(process.env.DEEP_MAX_CONCURRENCY || '1');
const ENABLE_DETAIL_EXTRACTION =
  process.env.ENABLE_DETAIL_EXTRACTION === 'false'
    ? false
    : true;

// FIX2: `--single-process` and `--no-zygote` REMOVED.
// These merge the browser + renderer into a single OS process. On both
// Render's free tier AND on shared/business Node hosting (Hostinger etc.),
// this mode is inherently unstable with @sparticuz/chromium — any hiccup
// (a slow page, a GC pause, a bad Google Maps DOM state) can take down the
// whole Chromium instance instantly, which Puppeteer surfaces as the vague
// "Protocol error (Target.setDiscoverTargets): Target closed" error you saw,
// with 0 leads and cells stuck at 0/1 (crashed before the first cell finished).
// Removing these two flags is the single biggest stability fix here.
const LOW_MEMORY_ARGS = LOW_MEMORY_MODE
  ? [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-software-rasterizer',
      '--memory-pressure-off',
      '--js-flags=--max-old-space-size=256',
    ]
  : [];

// DB pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER || process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD || process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

const cancellationState = new Map();
const activeBrowsers = new Map();

async function ensureSchema() {
  try {
    await pool.query(`ALTER TABLE scrape_jobs ADD COLUMN IF NOT EXISTS cancel_requested TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (e) {}
  try {
    await pool.query(`ALTER TABLE scrape_jobs MODIFY COLUMN status ENUM('pending','running','done','failed','cancelled') NOT NULL DEFAULT 'pending'`);
  } catch (e) {}
}
ensureSchema().catch(() => {});

function normalize(str) {
  return (str || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,]/g, '');
}

function leadKey(lead) {
  if (lead.placeUrl) return 'url:' + lead.placeUrl.split('?')[0];
  return 'na:' + normalize(lead.name) + '|' + normalize(lead.address);
}

async function leadAlreadyExists(lead, city, area) {
  try {
    if (lead.placeUrl) {
      const [rows] = await pool.query('SELECT id FROM leads WHERE place_url = ? LIMIT 1', [lead.placeUrl.split('?')[0]]);
      if (rows.length) return true;
    }
    const name = (lead.name || '').trim().toLowerCase();
    const address = (lead.address || '').trim().toLowerCase();
    if (!name && !address) return false;
    const [rows] = await pool.query(
      `SELECT id FROM leads WHERE city = ? AND COALESCE(area,'') = COALESCE(?, '') AND ((LOWER(TRIM(name)) = ? AND LOWER(TRIM(address)) = ?) OR (LOWER(TRIM(name)) = ?)) LIMIT 1`,
      [city, area || null, name, address, name]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function saveLeadRecord(jobId, lead, query, city, area) {
  try {
    if (await leadAlreadyExists(lead, city, area)) return false;
    await pool.query(
      `INSERT INTO leads (job_id, name, phone, website, instagram, address, category, rating, reviews, city, area, place_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        lead.name,
        lead.phone || null,
        lead.website || null,
        lead.instagram || null,
        lead.address || null,
        lead.category || query,
        lead.rating || null,
        lead.reviews || null,
        city,
        area || null,
        lead.placeUrl || null,
      ]
    );
    return true;
  } catch (e) {
    return false;
  }
}

async function updateJob(jobId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  await pool.query(`UPDATE scrape_jobs SET ${setClause} WHERE id = ?`, [...keys.map((k) => fields[k]), jobId]);
}

async function isCancelled(jobId) {
  if (cancellationState.get(jobId)) return true;
  try {
    const [rows] = await pool.query('SELECT cancel_requested, status FROM scrape_jobs WHERE id = ?', [jobId]);
    if (!rows.length) return false;
    return rows[0].cancel_requested === 1 || rows[0].status === 'cancelled';
  } catch {
    return false;
  }
}

async function requestCancel(jobId) {
  cancellationState.set(jobId, true);
  try {
    await pool.query(`UPDATE scrape_jobs SET cancel_requested = 1, status = 'cancelled', current_step = 'Cancelling...', finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status NOT IN ('done','failed','cancelled')`, [jobId]);
  } catch {}
  const browser = activeBrowsers.get(jobId);
  if (browser) {
    try { await browser.close().catch(() => {}); } catch {}
    activeBrowsers.delete(jobId);
  }
}

async function runWithCancellation(jobId, task) {
  let interval = null;
  const cancelPromise = new Promise((_, reject) => {
    interval = setInterval(async () => {
      try {
        if (await isCancelled(jobId)) {
          clearInterval(interval);
          reject(new Error('CANCELLED_BY_USER'));
        }
      } catch {}
    }, 500);
  });
  try {
    return await Promise.race([Promise.resolve().then(task), cancelPromise]);
  } finally {
    if (interval) clearInterval(interval);
  }
}

async function getCategoryExpansion(query) {
  try {
    const [rows] = await pool.query('SELECT trigger_key, expansions FROM categories WHERE ? LIKE CONCAT("%", trigger_key, "%") LIMIT 1', [query.toLowerCase()]);
    if (rows.length) {
      const expansions = rows[0].expansions;
      return typeof expansions === 'string' ? JSON.parse(expansions) : expansions;
    }
  } catch {}
  return [query];
}

async function getCityBoundingBox(city) {
  try {
    const [cached] = await pool.query('SELECT south, north, west, east FROM city_bbox_cache WHERE city = ? LIMIT 1', [city.toLowerCase()]);
    if (cached.length) return { south: cached[0].south, north: cached[0].north, west: cached[0].west, east: cached[0].east };
  } catch {}
  const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(city)}&format=json&limit=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'LeadScraperTool/1.0', Accept: 'application/json' } });
    if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json();
      if (!data.length) return null;
      const [south, north, west, east] = data[0].boundingbox.map(parseFloat);
      try { await pool.query('INSERT INTO city_bbox_cache (city,south,north,west,east) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE south = VALUES(south), north = VALUES(north), west = VALUES(west), east = VALUES(east)', [city.toLowerCase(), south, north, west, east]); } catch {}
      return { south, north, west, east };
    }
  } catch {}
  return null;
}

function generateGrid(bbox, gridSize) {
  const cells = [];
  const latStep = (bbox.north - bbox.south) / gridSize;
  const lngStep = (bbox.east - bbox.west) / gridSize;
  for (let i = 0; i < gridSize; i++) for (let j = 0; j < gridSize; j++) cells.push({ lat: bbox.south + latStep * (i + 0.5), lng: bbox.west + lngStep * (j + 0.5) });
  return cells;
}

// Browser launch with global extraction lock to avoid concurrent extraction races
async function launchBrowser() {
  if (!global.__chromiumExtractionPromise) {
    global.__chromiumExtractionPromise = (async () => {
      let execPath = await chromium.executablePath();
      const makeExecutable = async (p) => { try { await fs.promises.chmod(p, 0o755); } catch (e) {} };
      const testExec = (p) => {
        try { const out = child_process.spawnSync(p, ['--version'], { timeout: 5000 }); if (out.error) throw out.error; if (out.status !== 0 && out.status !== null) throw new Error('non-zero'); return true; } catch (e) { return e; }
      };
      await makeExecutable(execPath);
      let tr = testExec(execPath);
      if (tr !== true) {
        try {
          const fallbackDir = path.join(process.cwd(), '.chromium');
          if (!fs.existsSync(fallbackDir)) await fs.promises.mkdir(fallbackDir, { recursive: true });
          const fallbackPath = path.join(fallbackDir, path.basename(execPath));
          await fs.promises.copyFile(execPath, fallbackPath);
          await makeExecutable(fallbackPath);
          const ftr = testExec(fallbackPath);
          if (ftr === true) execPath = fallbackPath;
        } catch (e) {}
      }
      tr = testExec(execPath);
      if (tr !== true) throw new Error('Chromium not runnable: ' + (tr && tr.message ? tr.message : String(tr)));
      return execPath;
    })();
  }
  const executablePath = await global.__chromiumExtractionPromise;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: { width: 1280, height: 800 },
    timeout: 60000,
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--mute-audio',
      '--lang=en-US,en',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees',
      '--disable-blink-features=AutomationControlled',
      ...LOW_MEMORY_ARGS,
    ],
  });

  // FIX2: log the REAL crash reason instead of letting it surface only as
  // "Protocol error: Target closed" three layers up. If it's an OOM kill you'll
  // see signal=SIGKILL; if Chromium itself faulted you'll see a non-zero exit
  // code. This tells us definitively whether it's a memory issue or something else.
  browser.on('disconnected', () => {
    console.error('[chromium] browser disconnected unexpectedly (crash or manual close)');
  });
  const proc = browser.process();
  if (proc) {
    proc.on('exit', (code, signal) => {
      console.error(`[chromium] process exited — code=${code} signal=${signal}`);
    });
  }

  return browser;
}

async function dismissConsentIfPresent(page) {
  try {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target = buttons.find((b) => /accept all|i agree|agree/i.test(b.textContent || ''));
      if (target) { target.click(); return true; }
      return false;
    });
    if (clicked) await new Promise((r) => setTimeout(r, 1000));
    return clicked;
  } catch { return false; }
}

async function preparePage(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => { if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort(); else req.continue(); });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 720 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Upgrade-Insecure-Requests': '1',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} }) });
  });
}

async function detectCaptcha(page) {
  try {
    const url = page.url() || '';
    if (/\/sorry\//i.test(url)) return true;
    const text = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      return (bodyText || '').slice(0, 4000).toLowerCase();
    });
    return /(verify you are human|captcha|sorry|we detected unusual traffic|robot|automated|request blocked)/i.test(text);
  } catch {
    return false;
  }
}

async function navigateWithRetry(page, url, jobId, options = {}) {
  const timeout = options.timeout || 60000;
  const maxAttempts = options.maxAttempts || 3;
  const waitUntil = options.waitUntil || 'domcontentloaded';
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runWithCancellation(jobId, () => page.goto(url, { waitUntil, timeout }));
      await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, attempt === 1 ? 1200 : 2500)));
      if (!(await detectCaptcha(page))) return;
      lastError = new Error('Google blocked / CAPTCHA');
    } catch (err) {
      if (err && err.message === 'CANCELLED_BY_USER') throw err;
      lastError = err || new Error('Google blocked / CAPTCHA');
    }
    if (attempt < maxAttempts) {
      await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 4000 * attempt)));
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {}); } catch {}
    }
  }
  throw lastError || new Error('Google blocked / CAPTCHA');
}

function extractCardData() {
  const cardSelectors = [
    '[role="feed"] > div',
    '[role="feed"] > [role="article"]',
    '[role="list"] > div',
    '[role="list"] > [role="article"]',
    '[role="listitem"]',
    '[data-result-index]',
    '[data-index]'
  ];

  const items = Array.from(document.querySelectorAll(cardSelectors.join(','))).filter((item) => {
    const text = (item.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 6) return false;
    return Boolean(item.querySelector('a[href*="/maps/place/"], a[href*="/maps/search/"], a[href*="/maps/"]'));
  });

  return Array.from(items).map((item) => {
    const linkEl = item.querySelector('a[href*="/maps/place/"], a[href*="/maps/search/"], a[href*="/maps/"]') || item.querySelector('a');
    const name = [
      linkEl?.getAttribute('aria-label'),
      linkEl?.getAttribute('title'),
      linkEl?.getAttribute('data-tooltip'),
      item.querySelector('h3, h2, [role="heading"], .qBF1Pd, .fontHeadlineSmall')?.textContent,
      linkEl?.textContent,
    ].map((value) => (value || '').toString().trim()).find(Boolean) || null;

    if (!name) return null;

    const ratingAria = item.querySelector('span[role="img"][aria-label*="star"], [role="img"][aria-label*="star"]')?.getAttribute('aria-label');
    const ratingMatch = ratingAria?.match(/([\d.]+)\s*star/i);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
    const reviewsMatch = ratingAria?.match(/([\d,]+)\s*review/i);
    const reviews = reviewsMatch ? parseInt(reviewsMatch[1].replace(/,/g, ''), 10) : null;

    const textSegments = Array.from(item.querySelectorAll('div, span, p, h3, h2'))
      .map((el) => (el.textContent || '').trim())
      .filter((text) => text && text.length > 2 && text.length < 90 && !/^\d+(\.\d+)?$/.test(text) && !/(star|review|reviews|open|closed|hours|call|website|share|save)/i.test(text))
      .filter((text, index, arr) => arr.indexOf(text) === index);

    const category = textSegments.find((text) => !/^\+?\d[\d\-\s().]{6,}\d$/.test(text) && !/^(street|road|rd|st|ave|avenue|lane|dr|court|place|town|city|india)$/i.test(text)) || null;
    const address = textSegments.find((text) => /street|road|rd|st|avenue|ave|lane|dr|court|place|town|city|india|no\.|#|,/.test(text)) || textSegments[textSegments.length - 1] || null;
    const placeUrl = linkEl?.href || null;
    return { name, rating, reviews, category, address, placeUrl };
  }).filter(Boolean);
}

async function scrapeViewport(browser, url, maxResults, onProgress, jobId, onLeadDiscovered) {
  const page = await browser.newPage();
  await preparePage(page);

  // FIX2: surface page-level crashes (renderer OOM/crash for THIS tab specifically)
  // instead of letting them bubble up as an opaque Target-closed error later.
  page.on('error', (err) => console.error('[page] crashed:', err && err.message));
  page.on('pageerror', (err) => console.error('[page] uncaught exception in page:', err && err.message));

  let navigated = false;
  for (let attempt = 1; attempt <= 2 && !navigated; attempt++) {
    try {
      await navigateWithRetry(page, url, jobId, { timeout: 60000, maxAttempts: 2 });
      navigated = true;
    } catch (err) {
      if (err && err.message === 'CANCELLED_BY_USER') throw err;
      if (attempt === 2) throw err;
      await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 3000)));
    }
  }
  await dismissConsentIfPresent(page);
  const feedOk = await runWithCancellation(jobId, () => page.waitForSelector('[role="feed"], [role="list"], [data-result-index], [data-index]', { timeout: 20000 }).then(()=>true).catch(()=>false));
  if (!feedOk) {
    await dismissConsentIfPresent(page);
    await runWithCancellation(jobId, () => page.reload({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(()=>{}));
    await runWithCancellation(jobId, () => page.waitForSelector('[role="feed"], [role="list"], [data-result-index], [data-index]', { timeout: 20000 }).catch(()=>{}));
  }

  const leads = [];
  const seenKeys = new Set();
  let lastCount = 0, stale = 0, loopCount = 0;
  while (leads.length < maxResults && stale < 15) {
    loopCount++;
    if (jobId && loopCount % 3 === 0 && (await isCancelled(jobId))) { await page.close().catch(()=>{}); throw new Error('CANCELLED_BY_USER'); }
    const results = await runWithCancellation(jobId, () => page.evaluate(extractCardData));
    if (results.length > lastCount) {
      lastCount = results.length; stale = 0;
      for (const r of results) {
        if (leads.length >= maxResults) break;
        const key = leadKey(r);
        if (!seenKeys.has(key)) { seenKeys.add(key); leads.push(r); if (onLeadDiscovered) try { await onLeadDiscovered(r); } catch {} }
      }
      if (onProgress) await onProgress(leads.length);
    } else { stale++; }
    const reachedEnd = await runWithCancellation(jobId, () => page.evaluate(()=>{ const feed=document.querySelector('[role="feed"]'); if (!feed) return false; return /you've reached the end of the list/i.test(feed.textContent||''); }));
    if (reachedEnd) break;
    await runWithCancellation(jobId, () => page.evaluate(()=>{ const feed=document.querySelector('[role="feed"]'); if (feed) feed.scrollTop = feed.scrollHeight; }));
    await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 2800)));
  }
  await page.close().catch(()=>{});
  return leads;
}

// FIX: `page` is now declared OUTSIDE the try block (with `let`, initialized to null)
// so it is actually reachable inside `catch`. In the original code, `const page`
// was declared inside `try {}`, which made it block-scoped and therefore
// `undefined`/unreachable in `catch {}` -> pages were silently leaking (never
// closed) whenever enrichLead threw, e.g. on a timeout. Under LOW_MEMORY_MODE
// this leak is exactly what causes OOM crashes over a long-running deep scrape.
async function enrichLead(browser, lead, jobId) {
  let page = null;
  try {
    page = await browser.newPage();
    await preparePage(page);
    const targetUrl = lead.placeUrl || `https://www.google.com/maps/search/${encodeURIComponent(lead.name + ' ' + (lead.locationSuffix || ''))}`;
    await navigateWithRetry(page, targetUrl, jobId, { timeout: 15000, maxAttempts: 2 });
    await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 1500)));
    if (!page.url().includes('/maps/place/')) {
      const first = await page.$('[role="feed"] > div:first-child a[href*="/maps/place/"]');
      if (first) {
        await runWithCancellation(jobId, async () => {
          await first.click();
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        });
        await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 2500)));
      }
    }
    await runWithCancellation(jobId, () => page.waitForSelector('a[href^="tel:"], button[aria-label*="phone"], button[aria-label*="call"], button[data-tooltip*="phone"], button[data-tooltip*="call"], [role="button"][aria-label*="phone"], [role="button"][aria-label*="call"]', { timeout: 8000 }).catch(() => {}));
    await runWithCancellation(jobId, async () => {
      await page.evaluate(() => {
        const targets = Array.from(document.querySelectorAll('button, [role="button"], a, div'));
        const target = targets.find((el) => {
          const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-tooltip') || ''} ${el.textContent || ''}`.toLowerCase();
          return /phone|call|contact|tel/i.test(label);
        });
        if (target && typeof target.click === 'function') {
          try { target.click(); } catch {}
        }
      });
      await new Promise((r) => setTimeout(r, 1800));
    });

    const data = await runWithCancellation(jobId, () => page.evaluate(() => {
      const phoneRegex = /(\+?\d[\d\-()\s]{6,}\d)/g;
      const cleanPhone = (value) => {
        if (!value) return null;
        const cleaned = String(value).replace(/[^\d+]/g, '');
        const digitsOnly = cleaned.replace(/\+/g, '');
        if (digitsOnly.length < 7 || digitsOnly.length > 15) return null;
        return cleaned.startsWith('+') ? '+' + digitsOnly : digitsOnly;
      };
      const isPlausiblePhone = (digits) => digits && digits.replace(/^\+/, '').length >= 7 && digits.replace(/^\+/, '').length <= 15;
      const result = { phoneCandidates: [], websiteCandidates: [], instagramCandidates: [] };

      const addPhone = (value, trusted) => {
        if (!value) return;
        const match = value.match(phoneRegex);
        if (!match) return;
        match.forEach((m) => {
          const cleaned = cleanPhone(m);
          if (isPlausiblePhone(cleaned)) {
            if (trusted) result.phoneCandidates.unshift(cleaned);
            else result.phoneCandidates.push(cleaned);
          }
        });
      };

      const phoneControls = Array.from(document.querySelectorAll('a[href^="tel:"], button, [role="button"], a, span, div, p, li'));
      for (const el of phoneControls) {
        try {
          if (el.href && el.href.startsWith('tel:')) addPhone(el.href.replace(/^tel:/, ''), true);
          addPhone(el.getAttribute('aria-label'), true);
          addPhone(el.getAttribute('title'), true);
          addPhone(el.getAttribute('data-tooltip'), true);
          addPhone(el.getAttribute('data-phone'), true);
          addPhone(el.textContent, true);
        } catch (e) {}
      }

      if (result.phoneCandidates.length === 0) {
        const textNodes = Array.from(document.querySelectorAll('div, span, p, li'));
        for (const node of textNodes) {
          const text = (node.textContent || '').trim();
          if (text.length > 10 && text.length < 80) addPhone(text, false);
        }
      }

      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const parsed = JSON.parse(script.textContent || '{}');
          const telephone = Array.isArray(parsed.telephone)
            ? parsed.telephone.find(Boolean)
            : parsed.telephone;
          if (telephone) addPhone(String(telephone), true);
        } catch (e) {}
      }

      const anchors = Array.from(document.querySelectorAll('a[href^="http"]'));
      for (const a of anchors) {
        const href = a.href;
        if (/google\.|maps\.app|accounts\.|policies\./i.test(href)) continue;
        if (/instagram\.com/i.test(href)) result.instagramCandidates.push(href);
        else result.websiteCandidates.push(href);
      }

      const authority = document.querySelector('a[data-item-id="authority"]');
      if (authority && authority.href) result.websiteCandidates.unshift(authority.href);
      const linkRel = document.querySelector('link[rel="canonical"]')?.href || document.querySelector('meta[property="og:url"]')?.content || null;
      if (linkRel && !/google\./i.test(linkRel)) result.websiteCandidates.unshift(linkRel);

      return result;
    }));

    const preferredPhone = pickBestPhoneCandidate(data.phoneCandidates || []);
    if (preferredPhone) {
      lead.phone = preferredPhone;
    }

    if (data.instagramCandidates && data.instagramCandidates.length) {
      lead.instagram = data.instagramCandidates[0];
    } else if (data.websiteCandidates && data.websiteCandidates.length) {
      lead.website = data.websiteCandidates[0];
    }

    if (!lead.phone && (!lead.website && !lead.instagram)) {
      console.log(`enrichLead: no phone/website/instagram for job=${jobId} name=${lead.name} url=${page.url()}`);
      console.log('candidates:', {
        phones: data.phoneCandidates && Array.from(new Set(data.phoneCandidates)).slice(0, 5),
        websites: data.websiteCandidates && Array.from(new Set(data.websiteCandidates)).slice(0, 5),
        instas: data.instagramCandidates && Array.from(new Set(data.instagramCandidates)).slice(0, 5),
      });
    }
    await page.close().catch(()=>{});
  } catch (e) {
    // FIX: `page` is now reachable here because it was declared with `let` above
    // the try block, so this cleanup actually runs instead of throwing a hidden
    // ReferenceError.
    if (page) { try { await page.close().catch(() => {}); } catch {} }
  }
}

async function runScrapeJob({ jobId, query, city, area, mode, gridSize, leadCap }) {
  let browser;
  let allLeads = [];
  let cancelWatchdog = null;
  let savedCount = 0;
  try {
    await updateJob(jobId, { status: 'running', current_step: 'Browser launch ho raha hai' });
    browser = await launchBrowser();
    activeBrowsers.set(jobId, browser);
    cancelWatchdog = setInterval(async () => { try { if (await isCancelled(jobId)) { clearInterval(cancelWatchdog); if (browser) await browser.close().catch(()=>{}); } } catch {} }, 4000);

    const expansions = await getCategoryExpansion(query);
    const locationSuffix = area ? `${area}, ${city}` : city;
    const effectiveQuickCap = Math.max(0, Math.min(MAX_LEADS_QUICK, leadCap));
    const effectiveDeepCap = Math.max(0, Math.min(MAX_LEADS_DEEP, leadCap));

    if (mode === 'deep') {
      await updateJob(jobId, { current_step: 'City ka boundary nikala ja raha hai' });
      const bbox = await getCityBoundingBox(city).catch(()=>null);
      const activeGridSize = Math.max(1, gridSize || DEEP_DEFAULT_GRID_SIZE);
      const grid = bbox ? generateGrid(bbox, activeGridSize) : [null];
      await updateJob(jobId, { cells_total: grid.length * expansions.length });
      const seenGlobalKeys = new Set();
      outer: for (const term of expansions) {
        for (let offset = 0; offset < grid.length; offset += DEEP_MAX_CONCURRENCY) {
          if (allLeads.length >= effectiveDeepCap) break outer;
          if (await isCancelled(jobId)) throw new Error('CANCELLED_BY_USER');
          const batch = grid.slice(offset, offset + DEEP_MAX_CONCURRENCY);
          const batchResults = await Promise.all(batch.map(async (cell) => {
            const q = area ? `${term} in ${area}, ${city}` : `${term} in ${city}`;
            const url = cell ? `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${cell.lat},${cell.lng},14z` : `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
            await updateJob(jobId, { current_step: `Scanning: ${term}` });
            const leads = await scrapeViewport(browser, url, Math.min(120, effectiveDeepCap - allLeads.length), async (count) => { await updateJob(jobId, { total_found: allLeads.length + count, current_step: `${term}: ${count} mili` }); }, jobId, async (lead) => { lead.locationSuffix = locationSuffix; if (ENABLE_DETAIL_EXTRACTION) try { await enrichLead(browser, lead, jobId); } catch {} const inserted = await saveLeadRecord(jobId, lead, query, city, area); if (inserted) { savedCount++; await updateJob(jobId, { total_saved: savedCount }); } });
            return leads;
          }));
          for (const leads of batchResults) for (const l of leads) { if (allLeads.length >= effectiveDeepCap) break; const key = leadKey(l); if (!seenGlobalKeys.has(key)) { seenGlobalKeys.add(key); l.category = l.category || term; allLeads.push(l); } }
          await updateJob(jobId, { cells_done: Math.min(grid.length, allLeads.length), total_found: allLeads.length });
        }
      }
    } else {
      const term = expansions[0];
      const q = area ? `${term} in ${area}, ${city}` : `${term} in ${city}`;
      const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
      await updateJob(jobId, { current_step: 'Quick scan shuru', cells_total: 1 });
      allLeads = await scrapeViewport(browser, url, effectiveQuickCap, async (count) => { await updateJob(jobId, { total_found: count, current_step: `${count} mili...` }); }, jobId, async (lead) => { lead.locationSuffix = locationSuffix; if (ENABLE_DETAIL_EXTRACTION) try { await enrichLead(browser, lead, jobId); } catch {} const inserted = await saveLeadRecord(jobId, lead, query, city, area); if (inserted) { savedCount++; await updateJob(jobId, { total_saved: savedCount }); } });
      await updateJob(jobId, { cells_done: 1 });
    }

    await updateJob(jobId, { status: 'done', total_found: allLeads.length, total_saved: savedCount, current_step: 'Complete', finished_at: new Date() });
  } catch (err) {
    const wasCancelled = err && err.message === 'CANCELLED_BY_USER' || await isCancelled(jobId).catch(()=>false);
    if (wasCancelled) {
      await updateJob(jobId, { status: 'cancelled', total_found: allLeads.length, total_saved: savedCount, current_step: 'User ne cancel kiya (jo leads mili wo save ho gayi)', finished_at: new Date() });
    } else {
      // FIX2: log the full stack trace, not just err.message, so the actual
      // failure point (which line, which call) is visible in Hostinger logs
      // instead of just the generic Puppeteer wrapper message.
      console.error('Job failed:', err && err.stack ? err.stack : err);
      await updateJob(jobId, { status: 'failed', error_message: String(err && err.message ? err.message : err), finished_at: new Date() });
    }
  } finally {
    if (cancelWatchdog) clearInterval(cancelWatchdog);
    if (browser) { try { await browser.close().catch(()=>{}); } catch {} activeBrowsers.delete(jobId); }
  }
}

// API routes
app.post('/api/scrape/start', async (req, res) => {
  const { query, city, area, fullCity } = req.body;
  let { mode = 'quick', gridSize = 3 } = req.body;
  if (!query || !city) return res.status(400).json({ error: 'query aur city required hain' });
  if (fullCity === true) { mode = 'deep'; if (!req.body.gridSize) gridSize = 5; }
  const [usedRows] = await pool.query("SELECT COALESCE(SUM(total_saved),0) AS used FROM scrape_jobs WHERE DATE(started_at) = CURDATE()");
  const usedToday = usedRows[0].used;
  const remainingQuota = DAILY_LEAD_LIMIT - usedToday;
  const [historyRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM scrape_jobs WHERE category_query = ? AND city = ? AND COALESCE(area,'') = COALESCE(?, '') AND mode = ?`, [query, city, area || null, mode]);
  const previousRuns = Number(historyRows[0].cnt || 0);
  if (remainingQuota <= 0) return res.status(429).json({ error: `Aaj ki lead limit (${DAILY_LEAD_LIMIT}) poori ho gayi (${usedToday} use ho chuki hain). Kal try karo.` });
  const jobId = uuidv4();
  await pool.query(`INSERT INTO scrape_jobs (id, category_query, city, area, mode, status, started_at) VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`, [jobId, query, city, area || null, mode]);
  runScrapeJob({ jobId, query, city, area, mode, gridSize, leadCap: remainingQuota });
  res.json({ jobId, message: 'Scrape job shuru ho gaya', historyCount: previousRuns, historyMessage: previousRuns > 0 ? `Ye search pehle bhi ${previousRuns} baar ho chuki hai — history check karo.` : null });
});

app.get('/api/scrape/status/:jobId', async (req, res) => { const [rows] = await pool.query('SELECT * FROM scrape_jobs WHERE id = ?', [req.params.jobId]); if (!rows.length) return res.status(404).json({ error: 'Job nahi mila' }); res.json(rows[0]); });
app.post('/api/scrape/cancel/:jobId', async (req, res) => { const [rows] = await pool.query('SELECT status FROM scrape_jobs WHERE id = ?', [req.params.jobId]); if (!rows.length) return res.status(404).json({ error: 'Job nahi mila' }); if (['done','failed','cancelled'].includes(rows[0].status)) return res.status(400).json({ error: `Job already ${rows[0].status} hai, cancel nahi ho sakta` }); await requestCancel(req.params.jobId); res.json({ message: 'Cancel request bhej di gayi hai, job kuch second me rukega' }); });
app.get('/api/scrape/active', async (req, res) => { const [rows] = await pool.query("SELECT * FROM scrape_jobs WHERE status IN ('pending','running') ORDER BY started_at DESC LIMIT 1"); if (!rows.length) return res.json({ active: false }); res.json({ active: true, job: rows[0] }); });
app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
console.log('LOW_MEMORY_MODE =', LOW_MEMORY_MODE);
console.log('ENABLE_DETAIL_EXTRACTION =', ENABLE_DETAIL_EXTRACTION);
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));