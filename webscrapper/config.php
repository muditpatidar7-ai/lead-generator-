<?php
// ============================================
// Database config — Local XAMPP testing ke liye
// (Baad me Hostinger pe deploy karte waqt yeh
// values Hostinger hPanel > Databases > MySQL se
// badal dena)
// ============================================

// Render scraper service ka URL
// Local dev me localhost ka use hota hai, production me
// yeh environment variable ya server-side config se set karna.
define('DB_HOST', getenv('DB_HOST') ?: ($_ENV['DB_HOST'] ?? 'localhost'));
define('DB_NAME', getenv('DB_NAME') ?: ($_ENV['DB_NAME'] ?? 'scraper_db'));
define('DB_USER', getenv('DB_USER') ?: ($_ENV['DB_USER'] ?? 'root'));
define('DB_PASS', getenv('DB_PASS') ?: ($_ENV['DB_PASS'] ?? ''));
define('RENDER_API_URL', rtrim((string) (getenv('RENDER_API_URL') ?: ($_ENV['RENDER_API_URL'] ?? 'https://your-node-app-url')), '/'));

function getDB() {
    static $pdo = null;
    if ($pdo === null) {
        $pdo = new PDO(
            "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4",
            DB_USER,
            DB_PASS,
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
    }
    return $pdo;
}