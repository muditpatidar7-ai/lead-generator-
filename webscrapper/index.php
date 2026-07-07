<?php
require_once 'config.php';
$db = getDB();
$categories = $db->query("SELECT * FROM categories ORDER BY name")->fetchAll(PDO::FETCH_ASSOC);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>LeadGrid — New Scrape</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="assets/style.css">
</head>
<body>

<div class="mobile-topbar">
  <button class="menu-btn" id="menuBtn" aria-label="Menu">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
  </button>
  <div class="brand-name" style="font-size:15px;">LeadGrid</div>
</div>
<div class="sidebar-overlay" id="sidebarOverlay"></div>

<div class="shell">
  <aside class="sidebar" id="sidebar">
    <div class="brand">
      <div class="grid-mark"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
      <div>
        <div class="brand-name">LeadGrid</div>
        <div class="brand-sub">Maps lead scraper</div>
      </div>
    </div>
    <a class="nav-link active" href="index.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      New Scrape
    </a>
    <a class="nav-link" href="history.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
      History
    </a>
    <a class="nav-link" href="categories.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.2H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.82z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>
      Categories
    </a>
  </aside>

  <main class="main">
    <h1 class="page-title">Naya Lead Scrape</h1>
    <p class="page-sub">Category, city aur mode choose karo — scraper background me leads collect karega.</p>

    <div class="card">
      <form id="scrapeForm">
        <label class="field-label">Category</label>
        <select class="input" name="query" id="query">
          <?php foreach ($categories as $cat): ?>
            <option value="<?= htmlspecialchars($cat['trigger_key']) ?>"><?= htmlspecialchars($cat['name']) ?></option>
          <?php endforeach; ?>
          <option value="__custom__">✏️ Custom (type below)</option>
        </select>
        <input class="input" type="text" id="customQuery" placeholder="Custom category type karo..." style="display:none; margin-top:8px;">

        <label class="field-label">City</label>
        <input class="input" type="text" name="city" id="city" placeholder="jaise: Jabalpur" required>

        <label class="field-label">Area / Locality (optional)</label>
        <input class="input" type="text" name="area" id="area" placeholder="jaise: Wright Town">

        <label class="field-label">Mode</label>
        <div class="mode-grid">
          <label class="mode-card checked" id="modeQuickCard">
            <input type="radio" name="mode" value="quick" checked>
            <div class="mode-mini-grid"><span style="background:var(--signal)"></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
            <div class="mode-title">Quick</div>
            <div class="mode-desc">Fast single search, ~100–120 leads</div>
          </label>
          <label class="mode-card" id="modeDeepCard">
            <input type="radio" name="mode" value="deep">
            <div class="mode-mini-grid"><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span><span style="background:var(--signal)"></span></div>
            <div class="mode-title">Deep Dive</div>
            <div class="mode-desc">City ko grid me todke poori scan</div>
          </label>
        </div>

        <div style="margin-top:22px;">
          <button type="submit" class="btn" id="startBtn">Scrape Shuru Karo</button>
        </div>
      </form>

      <div id="progress" class="progress-panel">
        <div class="progress-head">
          <strong class="progress-text" id="progressText">Starting...</strong>
          <div class="progress-scan-grid" id="scanGrid"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        </div>
        <div class="bar-outer"><div class="bar-inner" id="progressBar"></div></div>
        <div class="progress-count" id="progressCount"></div>
        <div id="historyNotice" style="margin-top:8px; color:var(--text-dim); font-size:13px;"></div>
        <div id="etaNotice" style="margin-top:6px; color:var(--text-dim); font-size:13px;">Estimated time: slow mode, 5–15 mins depending on network and results.</div>
        <!-- NEW: Cancel button — sirf tab visible hoga jab koi job running/pending ho -->
        <button type="button" id="cancelBtn" class="btn btn-cancel" style="display:none; margin-top:12px;">
          Cancel Scraping
        </button>
      </div>
    </div>
  </main>
</div>

<script>
const menuBtn = document.getElementById('menuBtn');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebarOverlay');
if (menuBtn) {
  menuBtn.addEventListener('click', () => { sidebar.classList.add('open'); overlay.classList.add('open'); });
  overlay.addEventListener('click', () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); });
}

const RENDER_API = "<?= rtrim(RENDER_API_URL, '/') ?>";

function ensureBackendConfigured() {
  if (!RENDER_API || RENDER_API.includes('your-node-app-url')) {
    throw new Error('Backend URL set nahi hai. config.php me RENDER_API_URL ko apne Node app ka real URL de do.');
  }
}

document.getElementById('query').addEventListener('change', function() {
  document.getElementById('customQuery').style.display = this.value === '__custom__' ? 'block' : 'none';
});

// mode card visual toggle
document.querySelectorAll('.mode-card input').forEach(function(radio) {
  radio.addEventListener('change', function() {
    document.getElementById('modeQuickCard').classList.toggle('checked', document.querySelector('input[value="quick"]').checked);
    document.getElementById('modeDeepCard').classList.toggle('checked', document.querySelector('input[value="deep"]').checked);
  });
});

let pollTimer = null;
let currentJobId = null;
const cancelBtn = document.getElementById('cancelBtn');

document.getElementById('scrapeForm').addEventListener('submit', async function(e) {
  e.preventDefault();

  const querySelect = document.getElementById('query').value;
  const query = querySelect === '__custom__' ? document.getElementById('customQuery').value : querySelect;
  const city = document.getElementById('city').value;
  const area = document.getElementById('area').value;
  const mode = document.querySelector('input[name="mode"]:checked').value;

  document.getElementById('startBtn').disabled = true;
  document.getElementById('historyNotice').textContent = '';
  document.getElementById('etaNotice').textContent = 'Estimated time: slow mode, 5–15 mins depending on network and results.';
  const panel = document.getElementById('progress');
  panel.classList.remove('done', 'failed', 'cancelled');
  panel.style.display = 'block';
  document.getElementById('progressText').textContent = 'Job shuru ho raha hai...';

  try {
    ensureBackendConfigured();

    const res = await fetch(RENDER_API + '/api/scrape/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, city, area, mode, gridSize: 3 })
    });

    let data = {};
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(text || 'Backend se valid response nahi mila');
    }

    if (!res.ok) {
      throw new Error(data.error || 'Job start nahi ho saka');
    }

    if (data.jobId) {
      currentJobId = data.jobId;
      if (data.historyMessage) {
        document.getElementById('historyNotice').textContent = data.historyMessage;
      }
      cancelBtn.style.display = 'inline-block';
      pollStatus(data.jobId);
    } else {
      throw new Error(data.error || 'Job start nahi hua');
    }
  } catch (err) {
    const panel = document.getElementById('progress');
    panel.classList.add('failed');
    document.getElementById('progressText').textContent = 'Error: ' + (err.message || 'Backend se connect nahi ho pa raha');
    document.getElementById('startBtn').disabled = false;
    cancelBtn.style.display = 'none';
  }
});

// NEW: Cancel button click — job ko cancel request bhejta hai
cancelBtn.addEventListener('click', async function() {
  if (!currentJobId) return;
  if (!confirm('Scraping cancel karni hai?')) return;

  cancelBtn.disabled = true;
  cancelBtn.textContent = 'Cancelling...';
  document.getElementById('progressText').textContent = 'Cancelling...';

  try {
    const res = await fetch(RENDER_API + '/api/scrape/cancel/' + currentJobId, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Cancel nahi ho paya');
    }
    // Status poll khud hi 'cancelled' pakad lega aur UI update kar dega
  } catch (err) {
    alert('Cancel request fail: ' + err.message);
  } finally {
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Cancel Scraping';
  }
});

function pollStatus(jobId) {
  currentJobId = jobId;
  pollTimer = setInterval(async () => {
    try {
      ensureBackendConfigured();

      const res = await fetch(RENDER_API + '/api/scrape/status/' + jobId);
      if (!res.ok) {
        throw new Error('Status check fail');
      }
      const job = await res.json();

      document.getElementById('progressText').textContent = job.current_step || job.status;
      document.getElementById('progressCount').textContent =
        `${job.total_found || 0} leads mili · Cells: ${job.cells_done || 0}/${job.cells_total || 1}`;

      const pct = job.cells_total ? Math.round((job.cells_done / job.cells_total) * 100) : 0;
      document.getElementById('progressBar').style.width = pct + '%';

      const panel = document.getElementById('progress');

      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        clearInterval(pollTimer);
        document.getElementById('startBtn').disabled = false;
        cancelBtn.style.display = 'none';
        currentJobId = null;

        if (job.status === 'done') {
          panel.classList.add('done');
          document.getElementById('progressText').textContent =
            `Done — ${job.total_saved} leads save hui.`;
          setTimeout(() => window.location.href = 'history.php?job=' + jobId, 1500);
        } else if (job.status === 'cancelled') {
          panel.classList.add('cancelled');
          document.getElementById('progressText').textContent =
            `Cancelled — ${job.total_saved || 0} leads save ho chuki thi cancel hone tak.`;
          setTimeout(() => window.location.href = 'history.php?job=' + jobId, 1500);
        } else {
          panel.classList.add('failed');
          document.getElementById('progressText').textContent = 'Failed: ' + job.error_message;
        }
      }
    } catch (err) {
      clearInterval(pollTimer);
      const panel = document.getElementById('progress');
      panel.classList.add('failed');
      document.getElementById('progressText').textContent = 'Error: ' + (err.message || 'Backend se connect nahi ho pa raha');
      document.getElementById('startBtn').disabled = false;
      cancelBtn.style.display = 'none';
      currentJobId = null;
    }
  }, 3000);
}

// NEW: Page load hote hi check karo koi job already running/pending to nahi hai —
// isse tab switch/reload karne par bhi progress dobara dikh jaayegi, khoti nahi jaayegi.
async function resumeActiveJobIfAny() {
  try {
    ensureBackendConfigured();

    const res = await fetch(RENDER_API + '/api/scrape/active');
    const data = await res.json();
    if (data.active && data.job) {
      document.getElementById('startBtn').disabled = true;
      const panel = document.getElementById('progress');
      panel.classList.remove('done', 'failed', 'cancelled');
      panel.style.display = 'block';
      cancelBtn.style.display = 'inline-block';
      pollStatus(data.job.id);
    }
  } catch (err) {
    console.error('Active job check fail:', err);
  }
}
resumeActiveJobIfAny();
</script>

</body>
</html>