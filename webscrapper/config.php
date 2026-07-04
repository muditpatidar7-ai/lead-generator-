<?php
// ============================================
// Database config — Local XAMPP testing ke liye
// (Baad me Hostinger pe deploy karte waqt yeh
// values Hostinger hPanel > Databases > MySQL se
// badal dena)
// ============================================

define('DB_HOST', 'localhost');
define('DB_NAME', 'scraper_db');
define('DB_USER', 'root');
define('DB_PASS', '');

// Render scraper service ka URL
// Abhi local pe test karenge, isliye localhost
// Jab Render pe deploy karo, isko update karna:
// https://your-scraper.onrender.com
define('RENDER_API_URL', 'http://localhost:3000');

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