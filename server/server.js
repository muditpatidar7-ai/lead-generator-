// ============================================
// RENDER SIDE — Express API + Puppeteer scraper
// Yeh service Hostinger PHP dashboard se trigger hoti hai.
// Progress/leads seedha shared MySQL me likhta hai —
// PHP side sirf usi DB ko poll karke dikhata hai.
// ============================================
require("dotenv").config();
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium").default;
const child_process = require('child_process');
const path = require('path');
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.url.includes("//")) {
    req.url = req.url.replace(/\/+/g, "/");
  }
  next();
});

// -------- Limits (env se configure kar sakte ho, Render dashboard me) --------
const LOW_MEMORY_MODE =
  process.env.LOW_MEMORY_MODE === "true" ||
  process.env.LOW_MEMORY_MODE === "1" ||
  parseInt(process.env.MEMORY_LIMIT_MB || "0", 10) <= 512;

// Per-job cap — ek scrape kitni leads tak jaaye (Google block/timeout se bachne ke liye)
const MAX_LEADS_QUICK = parseInt(process.env.MAX_LEADS_QUICK || (LOW_MEMORY_MODE ? "20" : "200"));
const MAX_LEADS_DEEP = parseInt(process.env.MAX_LEADS_DEEP || (LOW_MEMORY_MODE ? "30" : "1000"));
// Client usage cap — din me TOTAL kitni leads mil sakti hain (job count nahi,
// kyunki ek job me kam leads milna client ki galti nahi hai)
const DAILY_LEAD_LIMIT = parseInt(process.env.DAILY_LEAD_LIMIT || (LOW_MEMORY_MODE ? "200" : "2000"));
const DEEP_DEFAULT_GRID_SIZE = parseInt(process.env.DEEP_GRID_SIZE || (LOW_MEMORY_MODE ? "1" : "2"));
const DEEP_MAX_CELLS_PER_TERM = parseInt(process.env.DEEP_MAX_CELLS_PER_TERM || (LOW_MEMORY_MODE ? "1" : "4"));
const DEEP_MAX_CONCURRENCY = parseInt(process.env.DEEP_MAX_CONCURRENCY || "1");
const ENABLE_DETAIL_EXTRACTION = !LOW_MEMORY_MODE && process.env.ENABLE_DETAIL_EXTRACTION !== "false";
const LOW_MEMORY_ARGS = LOW_MEMORY_MODE
  ? [
      "--single-process",
      "--no-zygote",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-software-rasterizer",
      "--memory-pressure-off",
    ]
  : [];

// -------- DB Connection (Hostinger ka MySQL, Remote MySQL ON hona chahiye) --------
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
    await pool.query(`ALTER TABLE scrape_jobs
      ADD COLUMN IF NOT EXISTS cancel_requested TINYINT(1) NOT NULL DEFAULT 0`);
  } catch (err) {
    console.warn("Schema migration (cancel_requested) skipped:", err.message);
  }

  try {
    await pool.query(`ALTER TABLE scrape_jobs
      MODIFY COLUMN status ENUM('pending','running','done','failed','cancelled') NOT NULL DEFAULT 'pending'`);
  } catch (err) {
    console.warn("Schema migration (status enum) skipped:", err.message);
  }
}

ensureSchema().catch((err) => console.warn("Schema ensure failed:", err.message));

// -------- Dedup helpers --------
// Normalize karta hai taaki chhoti spacing/case differences se
// duplicate slip na ho. placeUrl available ho toh usi ko primary
// key banate hain (Google ka unique identifier), warna name+address.
function normalize(str) {
  return (str || "").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,]/g, "");
}

function leadKey(lead) {
  if (lead.placeUrl) return "url:" + lead.placeUrl.split("?")[0];
  return "na:" + normalize(lead.name) + "|" + normalize(lead.address);
}

async function leadAlreadyExists(lead, city, area) {
  try {
    if (lead.placeUrl) {
      const [rows] = await pool.query("SELECT id FROM leads WHERE place_url = ? LIMIT 1", [lead.placeUrl.split("?")[0]]);
      if (rows.length) return true;
    }

    const name = (lead.name || "").trim().toLowerCase();
    const address = (lead.address || "").trim().toLowerCase();
    if (!name && !address) return false;

    const [rows] = await pool.query(
      `SELECT id FROM leads
       WHERE city = ? AND COALESCE(area, '') = COALESCE(?, '')
         AND (
           (LOWER(TRIM(name)) = ? AND LOWER(TRIM(address)) = ?)
           OR (LOWER(TRIM(name)) = ?)
         ) LIMIT 1`,
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
      `INSERT INTO leads (job_id, name, phone, website, instagram, address, category, rating, reviews, city, area, place_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  } catch {
    return false;
  }
}

// -------- Helpers --------
async function updateJob(jobId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  await pool.query(`UPDATE scrape_jobs SET ${setClause} WHERE id = ?`, [
    ...keys.map((k) => fields[k]),
    jobId,
  ]);
}

// FIX: Job ko beech me rokne ke liye — DB me flag check karte hain,
// aur agar DB schema abhi old hai to in-memory fallback use hota hai.
async function isCancelled(jobId) {
  if (cancellationState.get(jobId)) return true;

  try {
    const [rows] = await pool.query("SELECT cancel_requested, status FROM scrape_jobs WHERE id = ?", [jobId]);
    if (!rows.length) return false;
    return rows[0].cancel_requested === 1 || rows[0].status === "cancelled";
  } catch {
    return false;
  }
}

async function requestCancel(jobId) {
  cancellationState.set(jobId, true);
  try {
    await pool.query(
      `UPDATE scrape_jobs
       SET cancel_requested = 1,
           status = 'cancelled',
           current_step = 'Cancelling...',
           finished_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled')`,
      [jobId]
    );
  } catch (err) {
    console.warn("Cancel flag update failed:", err.message);
  }

  const browser = activeBrowsers.get(jobId);
  if (browser) {
    try {
      await browser.close().catch(() => {});
    } catch {}
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
          reject(new Error("CANCELLED_BY_USER"));
        }
      } catch {
        // ignore transient DB/read issues
      }
    }, 500);
  });

  try {
    return await Promise.race([Promise.resolve().then(task), cancelPromise]);
  } finally {
    if (interval) clearInterval(interval);
  }
}

async function getCategoryExpansion(query) {
  const [rows] = await pool.query(
    "SELECT trigger_key, expansions FROM categories WHERE ? LIKE CONCAT('%', trigger_key, '%') LIMIT 1",
    [query.toLowerCase()]
  );
  if (rows.length) {
    const expansions = rows[0].expansions;
    return typeof expansions === "string" ? JSON.parse(expansions) : expansions;
  }
  return [query]; // koi match nahi mila, jaisa hai waisa use karo
}

// -------- Geocoding (city bounding box, deep mode ke liye) --------
async function getCityBoundingBox(city) {
  // FIX: Pehle seedha Nominatim call karke .json() parse ho jaata tha,
  // lekin Nominatim kabhi "Access denied" jaisa PLAIN TEXT bhi bhej
  // deta hai (rate-limit / generic User-Agent / datacenter IP block
  // hone par) — us waqt .json() crash kar deta tha poore job ko.
  // Ab: (1) pehle DB cache check karo, (2) response.ok + content-type
  // verify karo JSON parse karne se pehle, (3) result DB me cache
  // kar do taaki same city ke liye dobara Nominatim hit hi na ho,
  // aur agar rate-limit ho to quietly fallback kar jaaye.
  try {
    const [cached] = await pool.query(
      "SELECT south, north, west, east FROM city_bbox_cache WHERE city = ? LIMIT 1",
      [city.toLowerCase()]
    );
    if (cached.length) {
      const c = cached[0];
      return { south: c.south, north: c.north, west: c.west, east: c.east };
    }
  } catch {
    // cache table shayad abhi exist nahi karti, ignore aur aage badho
  }

  const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(
    city
  )}&format=json&limit=1`;

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "LeadScraperTool/1.0 (business lead scraper)",
          Accept: "application/json",
        },
      });
    } catch (err) {
      lastError = err;
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    if (res.ok && contentType.includes("application/json")) {
      try {
        const data = await res.json();
        if (!data.length) return null;
        const [south, north, west, east] = data[0].boundingbox.map(parseFloat);

        try {
          await pool.query(
            `INSERT INTO city_bbox_cache (city, south, north, west, east) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE south = VALUES(south), north = VALUES(north), west = VALUES(west), east = VALUES(east)`,
            [city.toLowerCase(), south, north, west, east]
          );
        } catch {
          // caching fail ho jaye to bhi scrape rukna nahi chahiye
        }

        return { south, north, west, east };
      } catch (err) {
        lastError = err;
      }
    } else {
      const text = await res.text().catch(() => "");
      lastError = new Error(`Nominatim ne city boundary dene se mana kar diya (status ${res.status}): ${text.slice(0, 100)}`);
    }

    if (attempt < 3 && (lastError?.message || "").includes("status 429")) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    } else if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  console.warn(`City bbox unavailable for ${city}:`, lastError?.message || "unknown error");
  return null;
}

function generateGrid(bbox, gridSize) {
  const cells = [];
  const latStep = (bbox.north - bbox.south) / gridSize;
  const lngStep = (bbox.east - bbox.west) / gridSize;
  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      cells.push({
        lat: bbox.south + latStep * (i + 0.5),
        lng: bbox.west + lngStep * (j + 0.5),
      });
    }
  }
  return cells;
}

// -------- Browser launch --------
// Render container environment me system Chrome nahi hota.
// @sparticuz/chromium package bundled Chromium binary provide karta hai.
async function launchBrowser() {
  if (LOW_MEMORY_MODE) {
    console.log("Low memory mode enabled: lighter browser limits and reduced scrape caps are active.");
  }

  // Ensure extraction and chmod happen under a single lock so concurrent
  // requests don't race while the Chromium binary is being extracted into
  // the filesystem. This avoids partially-written binaries and EACCES.
  if (!global.__chromiumExtractionPromise) {
    global.__chromiumExtractionPromise = (async () => {
      let execPath = await chromium.executablePath();

      async function makeExecutable(p) {
        try {
          await fs.promises.chmod(p, 0o755);
        } catch (err) {
          console.warn("chmod failed for", p, err && err.message ? err.message : err);
        }
      }

      function testExec(p) {
        try {
          const out = child_process.spawnSync(p, ["--version"], { timeout: 5000 });
          if (out.error) throw out.error;
          if (out.status !== 0 && out.status !== null) {
            throw new Error(`non-zero exit (${out.status})`);
          }
          return true;
        } catch (err) {
          return err;
        }
      }

      // Try initial path, chmod and test
      await makeExecutable(execPath);
      let testResult = testExec(execPath);
      if (testResult !== true) {
        console.warn('Chromium exec test failed on initial path:', testResult && testResult.message ? testResult.message : testResult);

        // Fallback attempt: copy the binary into project folder where exec is usually allowed
        try {
          const fallbackDir = path.join(process.cwd(), '.chromium');
          if (!fs.existsSync(fallbackDir)) await fs.promises.mkdir(fallbackDir, { recursive: true });
          const fallbackPath = path.join(fallbackDir, path.basename(execPath));
          try {
            await fs.promises.copyFile(execPath, fallbackPath);
            await makeExecutable(fallbackPath);
            console.log('Copied chromium binary to fallback path:', fallbackPath);
            const fallbackTest = testExec(fallbackPath);
            if (fallbackTest === true) execPath = fallbackPath;
            else console.warn('Fallback binary test failed:', fallbackTest && fallbackTest.message ? fallbackTest.message : fallbackTest);
          } catch (copyErr) {
            console.warn('Failed to copy chromium to fallback path:', copyErr && copyErr.message ? copyErr.message : copyErr);
          }
        } catch (err) {
          console.warn('Fallback preparation failed:', err && err.message ? err.message : err);
        }
      }

      // Final validation before returning
      testResult = testExec(execPath);
      if (testResult !== true) {
        const errMsg = `Chromium executable not runnable at ${execPath} — last error: ${testResult && testResult.message ? testResult.message : JSON.stringify(testResult)}`;
        console.error(errMsg);
        throw new Error(errMsg + " — check filesystem permissions or mount options (noexec). See https://pptr.dev/troubleshooting");
      }

      return execPath;
    })();
  }

  const executablePath = await global.__chromiumExtractionPromise;
  console.log("Launching browser with executable (locked):", executablePath);

  return puppeteer.launch({
    headless: true,
    executablePath,
    defaultViewport: { width: 1280, height: 800 },
    timeout: 60000,
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--mute-audio",
      "--lang=en-US,en",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      ...LOW_MEMORY_ARGS,
    ],
  });
}

async function dismissConsentIfPresent(page) {
  try {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((b) => /accept all|i agree|agree/i.test(b.textContent || ""));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    if (clicked) await new Promise((r) => setTimeout(r, 1000));
    return clicked;
  } catch {
    return false;
  }
}

function extractCardData() {
  const items = document.querySelectorAll('[role="feed"] > div');
  return Array.from(items)
    .map((item) => {
      const linkEl = item.querySelector('a[href*="/maps/place/"]');
      const name = linkEl?.getAttribute("aria-label")?.trim() || item.querySelector(".qBF1Pd")?.textContent?.trim();
      if (!name) return null;

      const ratingAria = item.querySelector('span[role="img"][aria-label*="star"]')?.getAttribute("aria-label");
      const ratingMatch = ratingAria?.match(/([\d.]+)\s*star/i);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

      const reviewsMatch = ratingAria?.match(/([\d,]+)\s*review/i);
      const reviews = reviewsMatch ? parseInt(reviewsMatch[1].replace(/,/g, "")) : null;

      const spans = item.querySelectorAll(".W4Efsd span");
      const category = spans[0]?.textContent?.trim() || null;
      const address = spans[spans.length - 1]?.textContent?.trim() || null;
      const placeUrl = linkEl?.href || null;

      return { name, rating, reviews, category, address, placeUrl };
    })
    .filter(Boolean);
}

// Ek viewport (single URL) ko poora scroll karke saari leads nikalta hai
async function scrapeViewport(browser, url, maxResults, onProgress, jobId, onLeadDiscovered) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 720 });

  // FIX: "networkidle2" Google Maps pe kabhi reliably resolve nahi hota
  // (background tiles/analytics calls chalte rehte hain), isliye ye
  // navigation timeout deta rehta tha. "domcontentloaded" use karo —
  // faster aur zyada reliable — aur ek retry bhi rakho slow network
  // ya temporary Google-side slowness ke liye.
  let navigated = false;
  for (let attempt = 1; attempt <= 2 && !navigated; attempt++) {
    try {
      await runWithCancellation(jobId, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }));
      navigated = true;
    } catch (err) {
      if (err.message === "CANCELLED_BY_USER") throw err;
      if (attempt === 2) throw err;
      await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 3000)));
    }
  }

  // FIX: Agar Google ne block/CAPTCHA/consent-wall page pe bheja hai,
  // to yahi pe pakad lo — warna aage feed selector dhoondhte hue
  // silently fail hota rehta hai aur asli reason samajh nahi aata.
  if (/\/sorry\//i.test(page.url())) {
    throw new Error("Google ne temporary block/CAPTCHA page dikhaya (IP rate-limited lag raha hai)");
  }
  await dismissConsentIfPresent(page);

  const feedOk = await runWithCancellation(jobId, () =>
    page.waitForSelector('[role="feed"]', { timeout: 15000 }).then(() => true).catch(() => false)
  );
  if (!feedOk) {
    await dismissConsentIfPresent(page);
    await runWithCancellation(jobId, () => page.reload({ waitUntil: "networkidle2", timeout: 40000 }).catch(() => {}));
    await runWithCancellation(jobId, () => page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {}));
  }

  const leads = [];
  const seenKeys = new Set();
  let lastCount = 0;
  let stale = 0;
  let loopCount = 0;

  // FIX: pehle stale threshold (8) aur scroll wait (1800ms) bahut kam the —
  // Google Maps ko naye results lazy-load karne me thoda time lagta hai,
  // is wajah se list 20 (pehla default batch) pe hi ruk jaati thi.
  // Threshold aur wait dono badhaye, aur "end of list" wala Google ka
  // apna message bhi detect kar rahe hain taaki genuinely list khatam
  // hone par turant ruk jaye (bina 15 stale cycles waste kiye).
  while (leads.length < maxResults && stale < 15) {
    loopCount++;
    // FIX: har 3 scroll-cycle me ek baar cancel-flag check karo —
    // lambi list wale viewport bhi jaldi rukein, cancel dabane ke baad.
    if (jobId && loopCount % 3 === 0 && (await isCancelled(jobId))) {
      await page.close().catch(() => {});
      throw new Error("CANCELLED_BY_USER");
    }

    const results = await runWithCancellation(jobId, () => page.evaluate(extractCardData));
    if (results.length > lastCount) {
      lastCount = results.length;
      stale = 0;
      for (const r of results) {
        if (leads.length >= maxResults) break; // hard cap — kabhi maxResults se zyada push nahi hoga
        const key = leadKey(r);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          leads.push(r);
          if (onLeadDiscovered) {
            try {
              await onLeadDiscovered(r);
            } catch {}
          }
        }
      }
      if (onProgress) await onProgress(leads.length);
    } else {
      stale++;
    }

    const reachedEnd = await runWithCancellation(jobId, () => page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (!feed) return false;
      return /you've reached the end of the list/i.test(feed.textContent || "");
    }));
    if (reachedEnd) break;

    await runWithCancellation(jobId, () => page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (feed) feed.scrollTop = feed.scrollHeight;
    }));
    await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 2800)));
  }

  await page.close().catch(() => {});
  return leads;
}

// Website + Instagram nikalne ke liye detail page kholta hai
async function enrichLead(browser, lead, jobId) {
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

    const targetUrl =
      lead.placeUrl ||
      `https://www.google.com/maps/search/${encodeURIComponent(lead.name + " " + (lead.locationSuffix || ""))}`;

    await runWithCancellation(jobId, () => page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 }));
    await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 1500)));

    if (!page.url().includes("/maps/place/")) {
      const first = await page.$('[role="feed"] > div:first-child a[href*="/maps/place/"]');
      if (first) {
        await runWithCancellation(jobId, () => first.click());
        await runWithCancellation(jobId, () => new Promise((r) => setTimeout(r, 2000)));
      }
    }

    await runWithCancellation(jobId, () =>
      page
        .waitForSelector(
          'button[data-tooltip="Copy phone number"], button[data-item-id^="phone"], a[data-item-id="authority"]',
          { timeout: 6000 }
        )
        .catch(() => {})
    );

    const data = await runWithCancellation(jobId, () => page.evaluate(() => {
      const result = { phone: null, website: null };

      const phoneEl = document.querySelector('button[data-tooltip="Copy phone number"] div div:last-child');
      if (phoneEl) result.phone = phoneEl.textContent.trim();
      else {
        const phoneBtns = document.querySelectorAll('button[aria-label*="Phone"], button[data-item-id*="phone"]');
        for (const btn of phoneBtns) {
          const cand = btn.getAttribute("aria-label") || btn.textContent.trim();
          if (/[\d+\-() ]{7,}/.test(cand)) {
            result.phone = cand;
            break;
          }
        }
      }

      // Website link — Google Maps me "authority" data-item-id wale <a> tag me hota hai
      const websiteEl = document.querySelector('a[data-item-id="authority"]');
      if (websiteEl) result.website = websiteEl.href;

      return result;
    }));

    if (data.phone) lead.phone = data.phone.replace(/[^\d+]/g, "");

    // FIX: agar "website" asal me Instagram profile hai, usko instagram field me daalo
    if (data.website) {
      if (/instagram\.com/i.test(data.website)) {
        lead.instagram = data.website;
      } else {
        lead.website = data.website;
      }
    }

    await page.close().catch(() => {});
  } catch {
    // skip, agla lead
  }
}

// -------- Main scrape orchestration --------
async function runScrapeJob({ jobId, query, city, area, mode, gridSize, leadCap }) {
  let browser;
  // FIX: allLeads ko try block se bahar hoist kiya hai — cancel hone
  // par catch block ko ye pata chal sake ab tak kitni leads mil chuki
  // thi, taaki wo discard na ho balki DB me save ho jaayen.
  let allLeads = [];
  let cancelWatchdog = null;
  let savedCount = 0;
  try {
    await updateJob(jobId, { status: "running", current_step: "Browser launch ho raha hai" });
    browser = await launchBrowser();
    activeBrowsers.set(jobId, browser);

    // FIX: Ab tak cancel-check sirf specific checkpoints (har 3 scroll,
    // har naya cell, har 5 leads) pe hota tha — agar job kisi lambi
    // operation (jaise page.goto, jo 60s tak wait kar sakta hai) me
    // atka ho, to cancel button dabane ke baad bhi kaafi der (ya lagta
    // hai "kaam nahi kar raha") kuch nahi hota tha. Ye watchdog har 4
    // second background me DB check karta hai — cancel dikha to seedha
    // browser hi force-close kar deta hai, jisse jo bhi operation chal
    // rahi ho wo turant error de ke reject ho jaati hai (near-instant
    // cancellation, chahe process kahin bhi atka ho).
    cancelWatchdog = setInterval(async () => {
      try {
        if (await isCancelled(jobId)) {
          clearInterval(cancelWatchdog);
          if (browser) await browser.close().catch(() => {});
        }
      } catch {
        // DB hiccup, agla interval try karega
      }
    }, 4000);

    const expansions = await getCategoryExpansion(query);
    const locationSuffix = area ? `${area}, ${city}` : city;

    // Effective cap = jo bhi chhota ho, per-job limit ya baaki bacha hua daily quota
    const effectiveQuickCap = Math.max(0, Math.min(MAX_LEADS_QUICK, leadCap));
    const effectiveDeepCap = Math.max(0, Math.min(MAX_LEADS_DEEP, leadCap));

    if (mode === "deep") {
      await updateJob(jobId, { current_step: "City ka boundary nikala ja raha hai" });
      let bbox = null;
      try {
        bbox = await getCityBoundingBox(city);
      } catch (err) {
        console.warn("City bbox lookup failed, falling back to single city search:", err.message);
      }
      const activeGridSize = Math.max(1, gridSize || DEEP_DEFAULT_GRID_SIZE);
      const grid = bbox ? generateGrid(bbox, activeGridSize) : [null];
      const maxCellsPerTerm = Math.max(1, Math.min(DEEP_MAX_CELLS_PER_TERM, grid.length));
      const cellsToScan = grid.slice(0, maxCellsPerTerm);
      await updateJob(jobId, { cells_total: cellsToScan.length * expansions.length });

      let cellsDone = 0;
      const seenGlobalKeys = new Set();
      outerLoop:
      for (const term of expansions) {
        for (let offset = 0; offset < cellsToScan.length; offset += DEEP_MAX_CONCURRENCY) {
          if (allLeads.length >= effectiveDeepCap) {
            await updateJob(jobId, { current_step: `Limit (${effectiveDeepCap}) pahunch gaya, ruk raha hai` });
            break outerLoop;
          }

          if (await isCancelled(jobId)) {
            throw new Error("CANCELLED_BY_USER");
          }

          const batch = cellsToScan.slice(offset, offset + DEEP_MAX_CONCURRENCY);
          const batchResults = await Promise.all(
            batch.map(async (cell, batchIndex) => {
              if (await isCancelled(jobId)) {
                throw new Error("CANCELLED_BY_USER");
              }

              const q = area ? `${term} in ${area}, ${city}` : `${term} in ${city}`;
              const url = cell
                ? `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${cell.lat},${cell.lng},14z`
                : `https://www.google.com/maps/search/${encodeURIComponent(q)}`;

              const currentCellNo = cellsDone + batchIndex + 1;
              await updateJob(jobId, { current_step: `Scanning: ${term} (cell ${currentCellNo})` });

              const remaining = effectiveDeepCap - allLeads.length;
              const leads = await scrapeViewport(browser, url, Math.min(120, remaining), async (count) => {
                await updateJob(jobId, { total_found: allLeads.length + count, current_step: `${term}: ${count} mili` });
              }, jobId, async (lead) => {
                lead.locationSuffix = locationSuffix;
                if (ENABLE_DETAIL_EXTRACTION) {
                  try {
                    await enrichLead(browser, lead, jobId);
                  } catch {}
                }
                const inserted = await saveLeadRecord(jobId, lead, query, city, area);
                if (inserted) {
                  savedCount += 1;
                  await updateJob(jobId, { total_saved: savedCount });
                }
              });

              return leads;
            })
          );

          for (const leads of batchResults) {
            for (const l of leads) {
              if (allLeads.length >= effectiveDeepCap) break;
              const key = leadKey(l);
              if (!seenGlobalKeys.has(key)) {
                seenGlobalKeys.add(key);
                l.category = l.category || term;
                allLeads.push(l);
              }
            }
          }

          cellsDone += batchResults.length;
          await updateJob(jobId, { cells_done: cellsDone, total_found: allLeads.length });
        }
      }
    } else {
      // Quick mode — sirf pehla expansion term, single city-wide search
      const term = expansions[0];
      const q = area ? `${term} in ${area}, ${city}` : `${term} in ${city}`;
      const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;

      await updateJob(jobId, { current_step: "Quick scan shuru", cells_total: 1 });
      allLeads = await scrapeViewport(browser, url, effectiveQuickCap, async (count) => {
        await updateJob(jobId, { total_found: count, current_step: `${count} mili...` });
      }, jobId, async (lead) => {
        lead.locationSuffix = locationSuffix;
        if (ENABLE_DETAIL_EXTRACTION) {
          try {
            await enrichLead(browser, lead, jobId);
          } catch {}
        }
        const inserted = await saveLeadRecord(jobId, lead, query, city, area);
        if (inserted) {
          savedCount += 1;
          await updateJob(jobId, { total_saved: savedCount });
        }
      });
      await updateJob(jobId, { cells_done: 1 });
    }

    await updateJob(jobId, { current_step: "Leads collect ho rahe hain" });

    await updateJob(jobId, {
      status: "done",
      total_found: allLeads.length,
      total_saved: savedCount,
      current_step: "Complete",
      finished_at: new Date(),
    });
  } catch (err) {
    // FIX: watchdog ab browser ko force-close karta hai jab cancel ho,
    // isliye error message "CANCELLED_BY_USER" nahi bhi ho sakta —
    // Puppeteer apna generic error dega (jaise "Protocol error",
    // "Target closed", "Session closed"). Isliye sirf error message
    // pe depend nahi karte, DB ka cancel_requested flag bhi check
    // karte hain — dono me se koi bhi true ho to "cancelled" maano.
    const wasCancelled = err.message === "CANCELLED_BY_USER" || (await isCancelled(jobId).catch(() => false));

    if (wasCancelled) {
      await updateJob(jobId, {
        status: "cancelled",
        total_found: allLeads.length,
        total_saved: savedCount,
        current_step: "User ne cancel kiya (jo leads mili wo save ho gayi)",
        finished_at: new Date(),
      });
    } else {
      console.error("Job failed:", err);
      await updateJob(jobId, { status: "failed", error_message: String(err.message || err), finished_at: new Date() });
    }
  } finally {
    if (cancelWatchdog) clearInterval(cancelWatchdog);
    if (browser) {
      try {
        await browser.close().catch(() => {});
      } catch {}
      activeBrowsers.delete(jobId);
    }
  }
}


// -------- API Routes (PHP dashboard yahi call karega) --------

// Naya scrape job start karo
app.post("/api/scrape/start", async (req, res) => {
  const { query, city, area, fullCity } = req.body;
  let { mode = "quick", gridSize = 3 } = req.body;
  if (!query || !city) return res.status(400).json({ error: "query aur city required hain" });

  // FIX: pehle "area blank ho to automatically deep force karo" wala
  // logic tha — isse "quick" kabhi explicitly chalta hi nahi tha jab
  // area na diya ho, jo confusing tha. Ab decision fully explicit hai:
  // frontend "fullCity: true" bheje tabhi deep force hoga. Warna jo
  // mode bheja gaya hai (quick/deep) wahi respect hoga, area ho ya na ho.
  if (fullCity === true) {
    mode = "deep";
    if (!req.body.gridSize) gridSize = 5;
  }

  // -------- Daily usage limit check (total LEADS, na ki job count) --------
  const [usedRows] = await pool.query(
    "SELECT COALESCE(SUM(total_saved), 0) AS used FROM scrape_jobs WHERE DATE(started_at) = CURDATE()"
  );
  const usedToday = usedRows[0].used;
  const remainingQuota = DAILY_LEAD_LIMIT - usedToday;

  const [historyRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM scrape_jobs
     WHERE category_query = ? AND city = ? AND COALESCE(area, '') = COALESCE(?, '') AND mode = ?`,
    [query, city, area || null, mode]
  );
  const previousRuns = Number(historyRows[0].cnt || 0);

  if (remainingQuota <= 0) {
    return res.status(429).json({
      error: `Aaj ki lead limit (${DAILY_LEAD_LIMIT}) poori ho gayi (${usedToday} use ho chuki hain). Kal try karo.`,
    });
  }

  const jobId = uuidv4();
  await pool.query(
    `INSERT INTO scrape_jobs (id, category_query, city, area, mode, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
    [jobId, query, city, area || null, mode]
  );

  // Job background me chalao, response turant bhej do (PHP polling karega)
  runScrapeJob({ jobId, query, city, area, mode, gridSize, leadCap: remainingQuota });

  res.json({
    jobId,
    message: "Scrape job shuru ho gaya",
    historyCount: previousRuns,
    historyMessage: previousRuns > 0 ? `Ye search pehle bhi ${previousRuns} baar ho chuki hai — history check karo.` : null,
  });
});

// Job ka current status (PHP dashboard isko poll karega)
app.get("/api/scrape/status/:jobId", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM scrape_jobs WHERE id = ?", [req.params.jobId]);
  if (!rows.length) return res.status(404).json({ error: "Job nahi mila" });
  res.json(rows[0]);
});

// Job ko cancel karo (PHP dashboard "Cancel" button se call karega)
app.post("/api/scrape/cancel/:jobId", async (req, res) => {
  const [rows] = await pool.query("SELECT status FROM scrape_jobs WHERE id = ?", [req.params.jobId]);
  if (!rows.length) return res.status(404).json({ error: "Job nahi mila" });
  if (["done", "failed", "cancelled"].includes(rows[0].status)) {
    return res.status(400).json({ error: `Job already ${rows[0].status} hai, cancel nahi ho sakta` });
  }

  await requestCancel(req.params.jobId);
  res.json({ message: "Cancel request bhej di gayi hai, job kuch second me rukega" });
});

// FIX: Tab switch/page reload hone par frontend ko pata nahi chalta
// kaunsa job abhi running hai (jobId sirf JS memory me hota tha).
// Ye endpoint sabse recent running/pending job return karta hai —
// PHP dashboard page load hote hi isko call karke seedha usi job
// ki polling resume kar sakta hai, chahe beech me kitni bhi der
// tab band rakha ho ya switch kiya ho.
app.get("/api/scrape/active", async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM scrape_jobs WHERE status IN ('pending', 'running') ORDER BY started_at DESC LIMIT 1"
  );
  if (!rows.length) return res.json({ active: false });
  res.json({ active: true, job: rows[0] });
});

// Health check
app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));