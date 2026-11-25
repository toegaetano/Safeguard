-- SafeGuard Cleaning Co — database tables (Cloudflare D1 / SQLite).
-- Run once in the Cloudflare dashboard: Storage & Databases > D1 > safeguard-leads > Console.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT,
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'new',          -- new, contacted, walkthrough_scheduled, quote_sent, won, lost
  lost_reason TEXT,
  service_type TEXT NOT NULL,                  -- always 'commercial' (residential dropped 2026-11-21)
  name TEXT NOT NULL,
  business_name TEXT,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  facility_type TEXT,
  size_range TEXT,
  restrooms TEXT,
  frequency TEXT,
  start_date TEXT,
  heard_about TEXT,
  notes TEXT,
  next_follow_up TEXT,
  landing_page TEXT,
  referrer TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  ip_hash TEXT,
  step2_token TEXT,
  notification_status TEXT                     -- sent, failed, skipped
);

CREATE INDEX IF NOT EXISTS idx_leads_ip_created ON leads (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_token ON leads (step2_token);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status);

CREATE TABLE IF NOT EXISTS lead_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,                         -- team member email, or 'system'
  type TEXT NOT NULL,                          -- created, details_added, email_sent, email_failed, note, status_change
  content TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_lead ON lead_activity (lead_id, created_at);
