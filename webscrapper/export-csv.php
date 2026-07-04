<?php
require_once 'config.php';
$db = getDB();

$jobId = $_GET['job'] ?? null;
if (!$jobId) {
    die('Job ID missing');
}

$stmt = $db->prepare("SELECT * FROM leads WHERE job_id = ? ORDER BY id");
$stmt->execute([$jobId]);
$leads = $stmt->fetchAll(PDO::FETCH_ASSOC);

$jobStmt = $db->prepare("SELECT category_query, city, area FROM scrape_jobs WHERE id = ?");
$jobStmt->execute([$jobId]);
$job = $jobStmt->fetch(PDO::FETCH_ASSOC);

$filename = sprintf(
    'leads_%s_%s_%s.csv',
    preg_replace('/[^a-zA-Z0-9]/', '', $job['category_query'] ?? 'leads'),
    preg_replace('/[^a-zA-Z0-9]/', '', $job['city'] ?? ''),
    date('Ymd_His')
);

header('Content-Type: text/csv; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $filename . '"');

$out = fopen('php://output', 'w');

// UTF-8 BOM — Excel me Hindi/special characters sahi khulte hain
fprintf($out, "\xEF\xBB\xBF");

// Header row
fputcsv($out, [
    'Name', 'Phone', 'Website', 'Instagram', 'Address',
    'Category', 'Rating', 'Reviews', 'City', 'Area', 'Google Maps Link', 'Scraped At'
]);

foreach ($leads as $lead) {
    fputcsv($out, [
        $lead['name'],
        $lead['phone'],
        $lead['website'],
        $lead['instagram'],
        $lead['address'],
        $lead['category'],
        $lead['rating'],
        $lead['reviews'],
        $lead['city'],
        $lead['area'],
        $lead['place_url'],
        $lead['scraped_at'],
    ]);
}

fclose($out);
