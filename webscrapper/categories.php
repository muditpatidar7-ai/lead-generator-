<?php
require_once 'config.php';
$db = getDB();

// -------- Handle actions --------
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'add') {
        $name = trim($_POST['name']);
        $triggerKey = strtolower(trim($_POST['trigger_key']));
        $expansionsRaw = trim($_POST['expansions']); // comma-separated
        $expansions = array_map('trim', explode(',', $expansionsRaw));
        $expansions = array_filter($expansions);

        $stmt = $db->prepare("INSERT INTO categories (name, trigger_key, expansions, is_custom) VALUES (?, ?, ?, TRUE)
                               ON DUPLICATE KEY UPDATE name = VALUES(name), expansions = VALUES(expansions)");
        $stmt->execute([$name, $triggerKey, json_encode(array_values($expansions))]);
        header('Location: categories.php?added=1');
        exit;
    }

    if ($action === 'delete') {
        $id = (int)$_POST['id'];
        $stmt = $db->prepare("DELETE FROM categories WHERE id = ? AND is_custom = TRUE");
        $stmt->execute([$id]);
        header('Location: categories.php?deleted=1');
        exit;
    }
}

$categories = $db->query("SELECT * FROM categories ORDER BY is_custom ASC, name ASC")->fetchAll(PDO::FETCH_ASSOC);
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>LeadGrid — Categories</title>
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
    <a class="nav-link" href="history.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
      History
    </a>
    <a class="nav-link active" href="categories.php">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.2H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.58 9.59a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.82z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>
      Categories
    </a>
  </aside>

  <main class="main">
    <h1 class="page-title">Category Manager</h1>
    <p class="page-sub">Naye business-type categories add karo ya purani hatao.</p>

    <?php if (isset($_GET['added'])): ?><div class="msg msg-ok">Category add ho gayi</div><?php endif; ?>
    <?php if (isset($_GET['deleted'])): ?><div class="msg msg-ok">Category delete ho gayi</div><?php endif; ?>

    <div class="card">
      <form method="POST">
        <input type="hidden" name="action" value="add">

        <label class="field-label">Category Naam (display ke liye)</label>
        <input class="input" type="text" name="name" placeholder="jaise: Wedding Vendors" required>

        <label class="field-label">Trigger Word</label>
        <input class="input" type="text" name="trigger_key" placeholder="jaise: wedding" required>

        <label class="field-label">Business Types (comma se separate karo)</label>
        <textarea class="input" name="expansions" rows="3" placeholder="wedding hall, banquet, caterer, wedding photographer, mehendi artist, decorator" required></textarea>

        <div style="margin-top:20px;">
          <button type="submit" class="btn">Add Category</button>
        </div>
      </form>
    </div>

    <div class="section-heading">All Categories</div>
    <div class="card">
      <table class="data-table">
        <tr><th>Naam</th><th>Trigger</th><th>Business Types</th><th>Type</th><th></th></tr>
        <?php foreach ($categories as $cat):
          $expansions = json_decode($cat['expansions'], true) ?: [];
        ?>
        <tr>
          <td><?= htmlspecialchars($cat['name']) ?></td>
          <td><code><?= htmlspecialchars($cat['trigger_key']) ?></code></td>
          <td>
            <?php foreach (array_slice($expansions, 0, 6) as $exp): ?>
              <span class="tag"><?= htmlspecialchars($exp) ?></span>
            <?php endforeach; ?>
            <?php if (count($expansions) > 6): ?>
              <span class="tag">+<?= count($expansions) - 6 ?> more</span>
            <?php endif; ?>
          </td>
          <td>
            <?php if ($cat['is_custom']): ?>
              <span class="badge badge-custom">Custom</span>
            <?php else: ?>
              <span class="badge badge-builtin">Built-in</span>
            <?php endif; ?>
          </td>
          <td>
            <?php if ($cat['is_custom']): ?>
            <form method="POST" onsubmit="return confirm('Delete karna hai?')">
              <input type="hidden" name="action" value="delete">
              <input type="hidden" name="id" value="<?= $cat['id'] ?>">
              <button type="submit" class="btn btn-sm btn-danger">Delete</button>
            </form>
            <?php endif; ?>
          </td>
        </tr>
        <?php endforeach; ?>
      </table>
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
</script>

</body>
</html>