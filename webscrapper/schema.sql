-- ============================================
-- Shared MySQL Schema
-- Render (scraper) aur Hostinger (PHP dashboard)
-- dono isi database ko use karenge.
-- Hostinger hPanel me is DB par "Remote MySQL"
-- enable karna hoga taaki Render se connect ho sake.
-- ============================================

CREATE TABLE IF NOT EXISTS categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,          -- display name, e.g. "Paper Bag Buyers"
    trigger_key VARCHAR(255) NOT NULL,   -- match key, e.g. "paper bag"
    expansions JSON NOT NULL,             -- array of business types
    is_custom BOOLEAN DEFAULT TRUE,       -- user ne khud add kiya (vs built-in)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_trigger (trigger_key)
);

CREATE TABLE IF NOT EXISTS scrape_jobs (
    id VARCHAR(36) PRIMARY KEY,           -- UUID
    category_query VARCHAR(255) NOT NULL, -- jo user ne type/select kiya
    city VARCHAR(255) NOT NULL,
    area VARCHAR(255) DEFAULT NULL,
    mode ENUM('quick', 'deep') DEFAULT 'quick',
    status ENUM('pending', 'running', 'done', 'failed', 'cancelled') DEFAULT 'pending',
    cancel_requested TINYINT(1) DEFAULT 0,
    total_found INT DEFAULT 0,
    total_saved INT DEFAULT 0,
    current_step VARCHAR(255) DEFAULT NULL,  -- live progress text
    cells_total INT DEFAULT 1,               -- deep mode: kitne grid cells
    cells_done INT DEFAULT 0,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP NULL,
    error_message TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS leads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(36) NOT NULL,
    name VARCHAR(500) NOT NULL,
    phone VARCHAR(50) DEFAULT NULL,
    website VARCHAR(1000) DEFAULT NULL,     -- agar normal website hai
    instagram VARCHAR(1000) DEFAULT NULL,   -- agar website hi instagram.com nikla
    address TEXT DEFAULT NULL,
    category VARCHAR(255) DEFAULT NULL,
    rating DECIMAL(2,1) DEFAULT NULL,
    reviews INT DEFAULT NULL,
    city VARCHAR(255) DEFAULT NULL,
    area VARCHAR(255) DEFAULT NULL,
    place_url TEXT DEFAULT NULL,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES scrape_jobs(id) ON DELETE CASCADE,
    INDEX idx_job (job_id),
    INDEX idx_dedup (name(191), address(191))
);

-- Built-in categories seed data
INSERT IGNORE INTO categories (name, trigger_key, expansions, is_custom) VALUES
('Gym & Fitness', 'gym', JSON_ARRAY('gym','fitness center','health club','crossfit','yoga studio','pilates studio','zumba class','aerobics center'), FALSE),
('Restaurant & Food', 'restaurant', JSON_ARRAY('restaurant','dhaba','cafe','food court','fast food','biryani','pizza','burger'), FALSE),
('Salon & Beauty', 'salon', JSON_ARRAY('salon','beauty parlor','hair salon','spa','nail salon','barbershop'), FALSE),
('Hospital & Clinic', 'hospital', JSON_ARRAY('hospital','clinic','nursing home','diagnostic center','medical center'), FALSE),
('Hotel & Stay', 'hotel', JSON_ARRAY('hotel','lodge','guest house','inn','resort','homestay'), FALSE),
('School & Education', 'school', JSON_ARRAY('school','college','coaching center','tuition','academy','institute'), FALSE),
('Shop & Retail', 'shop', JSON_ARRAY('shop','store','showroom','mall','market','boutique'), FALSE),
('Paper Bag Buyers', 'paper bag', JSON_ARRAY('cafe','bakery','sweet shop','mithai shop','clothing store','boutique','garment shop','footwear store','shoe shop','jewellery store','gift shop','flower shop','florist','grocery store','kirana store','supermarket','cosmetic store','beauty store','book store','stationery shop','toy shop','handicraft store','home decor store','restaurant','juice center','ice cream parlor','chocolate shop','pharmacy','medical store','electronics store','mobile shop','watch shop','optical store','perfume shop'), FALSE);
