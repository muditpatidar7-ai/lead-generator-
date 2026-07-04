// ============================================
// RENDER SIDE — Express API + Puppeteer scraper
// Yeh service Hostinger PHP dashboard se trigger hoti hai.
// Progress/leads seedha shared MySQL me likhta hai —
// PHP side sirf usi DB ko poll karke dikhata hai.
// ============================================
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const puppeteer = require("puppeteer");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

// -------- Limits (env se configure kar sakte ho, Render dashboard me) --------
// Per-job cap — ek scrape kitni leads tak jaaye (Google block/timeout se bachne ke liye)
const MAX_LEADS_QUICK = parseInt(process.env.MAX_LEADS_QUICK || "200");
const MAX_LEADS_DEEP = parseInt(process.env.MAX_LEADS_DEEP || "1000");
// Client usage cap — din me TOTAL kitni leads mil sakti hain (job count nahi,
// kyunki ek job me kam leads milna client ki galti nahi hai)
const DAILY_LEAD_LIMIT = parseInt(process.env.DAILY_LEAD_LIMIT || "2000");

// -------- DB Connection (Hostinger ka MySQL, Remote MySQL ON hona chahiye) --------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
});

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
  const url = `https://nominatim.openstreetmap.org/search?city=${encodeURIComponent(
    city
  )}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "LeadScraperTool/1.0 (contact: you@example.com)" },
  });
  const data = await res.json();
  if (!data.length) return null;
  const [south, north, west, east] = data[0].boundingbox.map(parseFloat);
  return { south, north, west, east };
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
// NOTE: --single-process hataya gaya hai — yeh flag Windows pe
// Chrome ko unstable bana deta hai aur "Navigating frame was
// detached" jaisi crash errors deta hai. Linux/Render pe iski
// zaroorat nahi thi, isliye hataana safe hai.
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--mute-audio",
      "--lang=en-US,en",
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
async function scrapeViewport(browser, url, maxResults, onProgress) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "stylesheet", "font", "media"].includes(req.resourceType())) req.abort();
    else req.continue();
  });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1280, height: 720 });

  await page.goto(url, { waitUntil: "networkidle2", timeout: 40000 });
  await dismissConsentIfPresent(page);

  const feedOk = await page.waitForSelector('[role="feed"]', { timeout: 15000 }).then(() => true).catch(() => false);
  if (!feedOk) {
    await dismissConsentIfPresent(page);
    await page.reload({ waitUntil: "networkidle2", timeout: 40000 }).catch(() => {});
    await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {});
  }

  const leads = [];
  const seenKeys = new Set();
  let lastCount = 0;
  let stale = 0;

  while (leads.length < maxResults && stale < 8) {
    const results = await page.evaluate(extractCardData);
    if (results.length > lastCount) {
      lastCount = results.length;
      stale = 0;
      for (const r of results) {
        if (leads.length >= maxResults) break; // hard cap — kabhi maxResults se zyada push nahi hoga
        const key = leadKey(r);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          leads.push(r);
        }
      }
      if (onProgress) await onProgress(leads.length);
    } else {
      stale++;
    }
    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]');
      if (feed) feed.scrollTop += 1200;
    });
    await new Promise((r) => setTimeout(r, 1800));
  }

  await page.close();
  return leads;
}

// Website + Instagram nikalne ke liye detail page kholta hai
async function enrichLead(browser, lead) {
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

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await new Promise((r) => setTimeout(r, 1500));

    if (!page.url().includes("/maps/place/")) {
      const first = await page.$('[role="feed"] > div:first-child a[href*="/maps/place/"]');
      if (first) {
        await first.click();
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    await page
      .waitForSelector(
        'button[data-tooltip="Copy phone number"], button[data-item-id^="phone"], a[data-item-id="authority"]',
        { timeout: 6000 }
      )
      .catch(() => {});

    const data = await page.evaluate(() => {
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
    });

    if (data.phone) lead.phone = data.phone.replace(/[^\d+]/g, "");

    // FIX: agar "website" asal me Instagram profile hai, usko instagram field me daalo
    if (data.website) {
      if (/instagram\.com/i.test(data.website)) {
        lead.instagram = data.website;
      } else {
        lead.website = data.website;
      }
    }

    await page.close();
  } catch {
    // skip, agla lead
  }
}

// -------- Main scrape orchestration --------
async function runScrapeJob({ jobId, query, city, area, mode, gridSize, leadCap }) {
  let browser;
  try {
    await updateJob(jobId, { status: "running", current_step: "Browser launch ho raha hai" });
    browser = await launchBrowser();

    const expansions = await getCategoryExpansion(query);
    const locationSuffix = area ? `${area}, ${city}` : city;

    // Effective cap = jo bhi chhota ho, per-job limit ya baaki bacha hua daily quota
    const effectiveQuickCap = Math.max(0, Math.min(MAX_LEADS_QUICK, leadCap));
    const effectiveDeepCap = Math.max(0, Math.min(MAX_LEADS_DEEP, leadCap));

    let allLeads = [];

    if (mode === "deep") {
      await updateJob(jobId, { current_step: "City ka boundary nikala ja raha hai" });
      const bbox = await getCityBoundingBox(city);
      const grid = bbox ? generateGrid(bbox, gridSize || 3) : [null];
      await updateJob(jobId, { cells_total: grid.length * expansions.length });

      let cellsDone = 0;
      const seenGlobalKeys = new Set();
      outerLoop:
      for (const term of expansions) {
        for (const cell of grid) {
          if (allLeads.length >= effectiveDeepCap) {
            await updateJob(jobId, { current_step: `Limit (${effectiveDeepCap}) pahunch gaya, ruk raha hai` });
            break outerLoop;
          }

          const q = area ? `${term} in ${area}, ${city}` : `${term} in ${city}`;
          const url = cell
            ? `https://www.google.com/maps/search/${encodeURIComponent(term)}/@${cell.lat},${cell.lng},14z`
            : `https://www.google.com/maps/search/${encodeURIComponent(q)}`;

          await updateJob(jobId, { current_step: `Scanning: ${term} (cell ${cellsDone + 1})` });

          const remaining = effectiveDeepCap - allLeads.length;
          const leads = await scrapeViewport(browser, url, Math.min(120, remaining), async (count) => {
            await updateJob(jobId, { total_found: allLeads.length + count, current_step: `${term}: ${count} mili` });
          });

          for (const l of leads) {
            if (allLeads.length >= effectiveDeepCap) break;
            const key = leadKey(l);
            if (!seenGlobalKeys.has(key)) {
              seenGlobalKeys.add(key);
              l.category = l.category || term;
              allLeads.push(l);
            }
          }

          cellsDone++;
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
      });
      await updateJob(jobId, { cells_done: 1 });
    }

    // -------- Enrichment: har lead ke liye phone + website/instagram --------
    await updateJob(jobId, { current_step: `Phone/Website nikala ja raha hai (0/${allLeads.length})` });

    for (let i = 0; i < allLeads.length; i++) {
      allLeads[i].locationSuffix = locationSuffix;
      await enrichLead(browser, allLeads[i]);

      if ((i + 1) % 5 === 0 || i === allLeads.length - 1) {
        await updateJob(jobId, { current_step: `Phone/Website nikala ja raha hai (${i + 1}/${allLeads.length})` });
      }

      if ((i + 1) % 20 === 0 && i < allLeads.length - 1) {
        await browser.close();
        browser = await launchBrowser();
      }
    }

    // -------- Save to DB --------
    await updateJob(jobId, { current_step: "Database me save ho raha hai" });
    let saved = 0;
    for (const lead of allLeads) {
      try {
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
        saved++;
      } catch {
        // duplicate ya koi issue, skip
      }
    }

    await updateJob(jobId, {
      status: "done",
      total_found: allLeads.length,
      total_saved: saved,
      current_step: "Complete",
      finished_at: new Date(),
    });
  } catch (err) {
    console.error("Job failed:", err);
    await updateJob(jobId, { status: "failed", error_message: String(err.message || err), finished_at: new Date() });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// -------- API Routes (PHP dashboard yahi call karega) --------

// Naya scrape job start karo
app.post("/api/scrape/start", async (req, res) => {
  const { query, city, area, mode = "quick", gridSize = 3 } = req.body;
  if (!query || !city) return res.status(400).json({ error: "query aur city required hain" });

  // -------- Daily usage limit check (total LEADS, na ki job count) --------
  const [usedRows] = await pool.query(
    "SELECT COALESCE(SUM(total_saved), 0) AS used FROM scrape_jobs WHERE DATE(started_at) = CURDATE()"
  );
  const usedToday = usedRows[0].used;
  const remainingQuota = DAILY_LEAD_LIMIT - usedToday;

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

  res.json({ jobId, message: "Scrape job shuru ho gaya" });
});

// Job ka current status (PHP dashboard isko poll karega)
app.get("/api/scrape/status/:jobId", async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM scrape_jobs WHERE id = ?", [req.params.jobId]);
  if (!rows.length) return res.status(404).json({ error: "Job nahi mila" });
  res.json(rows[0]);
});

// Health check
app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper API running on port ${PORT}`));