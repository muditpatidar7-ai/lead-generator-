<?php
require_once 'config.php';
$db = getDB();

$selectedJob = $_GET['job'] ?? null;
$deleteJob = $_POST['delete_job'] ?? null;

if ($deleteJob) {
    $stmt = $db->prepare("DELETE FROM scrape_jobs WHERE id = ?");
    $stmt->execute([$deleteJob]);
    header('Location: history.php');
    exit;
}

$jobs = $db->query("SELECT * FROM scrape_jobs ORDER BY started_at DESC LIMIT 50")->fetchAll(PDO::FETCH_ASSOC);

$leads = [];
if ($selectedJob) {
    $stmt = $db->prepare("SELECT * FROM leads WHERE job_id = ? ORDER BY id");
    $stmt->execute([$selectedJob]);
    $leads = $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function statusBadge($status) {
    $map = [
        'done' => 'badge-done',
        'running' => 'badge-running',
        'failed' => 'badge-failed',
        'pending' => 'badge-pending',
        // NEW: cancelled status ke liye badge (style.css me .badge-cancelled already add kiya hai)
        'cancelled' => 'badge-cancelled',
    ];
    $cls = $map[$status] ?? 'badge-pending';
    return '<span class="badge ' . $cls . '">' . htmlspecialchars($status) . '</span>';
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>LeadGrid — History</title>
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
    <a class="nav-link" href="index.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      New Scrape
    </a>
    <a class="nav-link active" href="history.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
      History
    </a>
    <a class="nav-link" href="categories.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.2H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.82z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>
      Categories
    </a>
  </aside>

  <main class="main" style="max-width:1080px;">
    <h1 class="page-title">Scrape History</h1>
    <p class="page-sub">Pichli saari scrape jobs aur unke results.</p>

    <div class="card">
      <table class="data-table">
        <tr>
          <th>Category</th><th>City / Area</th><th>Mode</th><th>Status</th>
          <th>Leads</th><th>Started</th><th></th>
        </tr>
        <?php foreach ($jobs as $job): ?>
        <tr>
          <td><?= htmlspecialchars($job['category_query']) ?></td>
          <td><?= htmlspecialchars($job['city'] . ($job['area'] ? ' / ' . $job['area'] : '')) ?></td>
          <td class="mono"><?= htmlspecialchars($job['mode']) ?></td>
          <td><?= statusBadge($job['status']) ?></td>
          <td class="mono"><?= (int)$job['total_saved'] ?></td>
          <td class="mono" style="color:var(--text-dim)"><?= htmlspecialchars($job['started_at']) ?></td>
          <td>
            <a class="link-pill" href="history.php?job=<?= urlencode($job['id']) ?>">View</a>
            <?php if ($job['total_saved'] > 0): ?>
              &nbsp;·&nbsp;<a class="link-pill" href="export-csv.php?job=<?= urlencode($job['id']) ?>">CSV</a>
            <?php endif; ?>
            <form method="post" style="display:inline;" onsubmit="return confirm('Is job ko delete karna hai?');">
              <input type="hidden" name="delete_job" value="<?= htmlspecialchars($job['id']) ?>">
              <button type="submit" class="link-pill" style="border:none; background:none; color:var(--coral); cursor:pointer; padding:0;">Delete</button>
            </form>
            <?php if (in_array($job['status'], ['pending', 'running'])): ?>
              &nbsp;·&nbsp;<a class="link-pill" href="index.php" style="color:var(--coral)">Running — cancel index.php se karo</a>
            <?php endif; ?>
          </td>
        </tr>
        <?php endforeach; ?>
        <?php if (!$jobs): ?>
        <tr><td colspan="7" style="color:var(--text-faint); text-align:center; padding:24px;">Abhi tak koi scrape nahi hui.</td></tr>
        <?php endif; ?>
      </table>
    </div>

    <?php if ($selectedJob): ?>
      <div class="section-heading" style="display:flex; align-items:center; justify-content:space-between;">
        Leads (<?= count($leads) ?>)
        <a class="btn btn-sm btn-ghost" href="export-csv.php?job=<?= urlencode($selectedJob) ?>">⬇ Download CSV</a>
      </div>
      <div class="card">
        <table class="data-table">
          <tr>
            <th>Name</th><th>Phone</th><th>Website</th><th>Instagram</th><th>Address</th>
          </tr>
          <?php foreach ($leads as $lead): ?>
          <tr>
            <td><?= htmlspecialchars($lead['name']) ?></td>
            <td class="mono"><?= htmlspecialchars($lead['phone'] ?? '-') ?></td>
            <td><?= $lead['website'] ? '<a class="link-pill" href="' . htmlspecialchars($lead['website']) . '" target="_blank">Link</a>' : '<span style="color:var(--text-faint)">-</span>' ?></td>
            <td><?= $lead['instagram'] ? '<a class="link-pill" href="' . htmlspecialchars($lead['instagram']) . '" target="_blank">Insta</a>' : '<span style="color:var(--text-faint)">-</span>' ?></td>
            <td style="color:var(--text-dim)"><?= htmlspecialchars($lead['address'] ?? '-') ?></td>
          </tr>
          <?php endforeach; ?>
        </table>
      </div>
    <?php endif; ?>
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
</script>

</body>
</html>