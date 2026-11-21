// Safeguard Cleaning — quote request handling (runs on Cloudflare).
//
// The only setup the form needs is an email key (RESEND_API_KEY). Two more pieces switch on by
// themselves when they are added in Cloudflare:
//   - DB (the D1 database): every request is also saved, rate-limited per visitor, and a failed
//     email never loses a lead (the database write happens before the email).
//   - TURNSTILE_SECRET_KEY (Cloudflare's spam check): the visitor's spam-check token is verified.
// Without them: the hidden spam-trap field still stops simple bots, and the email is the record.
//
// Step 1 (contact details) emails the team and returns a token; step 2 (optional details) sends a
// second email with the token. With a database the token is a random id stored with the lead; without
// one it is a signed summary of the contact details, so the second email can still say who it is from.

export const LIMITS = { name: 100, businessName: 120, email: 200, phone: 30, city: 80, notes: 2000, short: 300 };
export const MAX_BODY_BYTES = 20000;
export const RATE_LIMIT_PER_HOUR = 5;
export const STEP2_WINDOW_HOURS = 24;

export const OPTIONS = {
  facilityType: ['Office', 'Retail', 'Medical or dental', 'Warehouse or industrial', 'Church', 'Gym or fitness', 'Restaurant', 'Other'],
  sizeRange: ['Under 2,500 sq ft', '2,500–5,000 sq ft', '5,000–10,000 sq ft', '10,000–25,000 sq ft', 'Over 25,000 sq ft', 'Not sure'],
  restrooms: ['1', '2', '3–4', '5 or more', 'Not sure'],
  frequency: ['One-time', 'Daily', 'Several times a week', 'Weekly', 'Every other week', 'Monthly', 'Not sure'],
  heardAbout: ['Google search', 'Google Maps', 'Referral', 'Flyer', 'Social media', 'Other']
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_ALERT_TO = 'safeguardcleaningco@gmail.com';
const DEFAULT_FROM = 'Safeguard Cleaning Website <onboarding@resend.dev>';

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/** What the quote form needs to know before it can send (used by GET /api/config). */
export function formConfig(env) {
  return {
    formReady: Boolean(env.RESEND_API_KEY || env.DB),
    turnstileSiteKey: env.TURNSTILE_SECRET_KEY ? (env.TURNSTILE_SITE_KEY || null) : null
  };
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  // Remove control characters (keep normal spaces and line breaks in notes), trim, cap length.
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function validateStep1(body) {
  // Businesses only (no residential since 2026-11-21). Any serviceType sent by a client is ignored.
  const lead = {
    serviceType: 'commercial',
    name: str(body.name, LIMITS.name),
    businessName: str(body.businessName, LIMITS.businessName),
    email: str(body.email, LIMITS.email).toLowerCase(),
    phone: str(body.phone, LIMITS.phone),
    city: str(body.city, LIMITS.city)
  };
  const errors = {};
  if (!lead.name) errors.name = 'Please enter your name.';
  if (!lead.businessName) errors.businessName = 'Please enter your business name.';
  if (!EMAIL_RE.test(lead.email)) errors.email = 'Please enter a valid email address.';
  const digits = lead.phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) errors.phone = 'Please enter a phone number we can reach you at.';
  if (!lead.city) errors.city = 'Please enter your city.';

  const src = body.source && typeof body.source === 'object' ? body.source : {};
  lead.source = {
    landingPage: str(src.landingPage, LIMITS.short),
    referrer: str(src.referrer, LIMITS.short),
    utmSource: str(src.utmSource, 100),
    utmMedium: str(src.utmMedium, 100),
    utmCampaign: str(src.utmCampaign, 100)
  };
  return { lead, errors };
}

export function validateStep2(details) {
  const d = details && typeof details === 'object' ? details : {};
  const clean = {};
  for (const key of Object.keys(OPTIONS)) {
    const v = str(d[key], LIMITS.short);
    clean[key] = OPTIONS[key].includes(v) ? v : '';
  }
  const date = str(d.startDate, 10);
  clean.startDate = DATE_RE.test(date) ? date : '';
  clean.notes = str(d.notes, LIMITS.notes);
  return clean;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ----- Signed step-2 token (used when there is no database) -----
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmacKey(env) {
  const secret = `${env.RESEND_API_KEY || ''}:${env.IP_HASH_SALT || 'safeguard'}:step2`;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(contact, env, now = Date.now()) {
  const payload = { ...contact, x: now + STEP2_WINDOW_HOURS * 3600 * 1000 };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function readToken(token, env, now = Date.now()) {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), fromB64url(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (!payload || typeof payload.x !== 'number' || payload.x < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function verifyTurnstile(token, ip, env, fetchFn) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetchFn(TURNSTILE_URL, { method: 'POST', body: form });
    const data = await res.json();
    return data && data.success === true;
  } catch (err) {
    console.error('Turnstile check failed to run', err);
    return false;
  }
}

function recipients(env) {
  return String(env.LEAD_ALERT_TO || DEFAULT_ALERT_TO).split(',').map((s) => s.trim()).filter(Boolean);
}

async function sendEmail(env, fetchFn, msg) {
  if (!env.RESEND_API_KEY) return 'skipped';
  try {
    const res = await fetchFn(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM || DEFAULT_FROM, ...msg })
    });
    if (!res.ok) {
      console.error('Resend error', res.status, await res.text().catch(() => ''));
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('Resend request failed', err);
    return 'failed';
  }
}

function row(label, value) {
  return value
    ? `<tr><td style="padding:6px 16px 6px 0;color:#4A5868;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 0;color:#0E2948;font-weight:600">${escapeHtml(value).replace(/\n/g, '<br>')}</td></tr>`
    : '';
}
const textLines = (pairs) => pairs.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
const wrapHtml = (inner) => `<div style="font-family:Arial,sans-serif;max-width:560px">${inner}</div>`;

/** Email 1: the contact details from step 1. */
export function teamAlertEmail(lead, id) {
  const who = lead.businessName || lead.name;
  const subject = `Website quote request: ${who} (${lead.city})`;
  const ref = id ? ` · Lead #${id}` : '';
  const came = lead.source && (lead.source.utmSource || lead.source.referrer);
  const pairs = [['Name', lead.name], ['Business', lead.businessName], ['Email', lead.email], ['Phone', lead.phone], ['City', lead.city], ['Came from', came]];
  const html = wrapHtml(`
<h2 style="color:#0E2948;margin:0 0 4px">New quote request from the website</h2>
<p style="color:#4A5868;margin:0 0 16px">Sent from the quote form on the Safeguard Cleaning website${ref}. Reply to this email to answer ${escapeHtml(lead.name)} directly.</p>
<table style="border-collapse:collapse;font-size:15px">${pairs.map(([k, v]) => row(k, v)).join('')}</table>
<p style="color:#4A5868;font-size:13px;margin-top:20px">They may add optional details about their space next. If they do, you'll get a second email.</p>`);
  const text = `New quote request from the Safeguard Cleaning website${ref}\n\n${textLines(pairs)}\n\nReply to this email to answer ${lead.name} directly.`;
  return { subject, html, text };
}

/** Email 2: the optional details from step 2, repeating who it is from so it stands on its own. */
export function detailsEmail(contact, d, id) {
  const who = contact.businessName || contact.name;
  const subject = `Website quote request, more details: ${who} (${contact.city})`;
  const ref = id ? ` · Lead #${id}` : '';
  const who_ = [['Name', contact.name], ['Business', contact.businessName], ['Email', contact.email], ['Phone', contact.phone], ['City', contact.city]];
  const det = [['Facility', d.facilityType], ['Size', d.sizeRange], ['Restrooms', d.restrooms], ['How often', d.frequency], ['Start date', d.startDate], ['Heard about us', d.heardAbout], ['Notes', d.notes]];
  const html = wrapHtml(`
<h2 style="color:#0E2948;margin:0 0 4px">More details for a website quote request</h2>
<p style="color:#4A5868;margin:0 0 16px">${escapeHtml(who)} added details about their space on the website${ref}.</p>
<table style="border-collapse:collapse;font-size:15px">${det.map(([k, v]) => row(k, v)).join('')}</table>
<h3 style="color:#0E2948;margin:20px 0 4px;font-size:15px">Contact</h3>
<table style="border-collapse:collapse;font-size:15px">${who_.map(([k, v]) => row(k, v)).join('')}</table>`);
  const text = `More details for a website quote request${ref}\n\n${textLines(det)}\n\nContact\n${textLines(who_)}`;
  return { subject, html, text };
}

export function customerEmail(lead) {
  const first = lead.name.split(/\s+/)[0];
  return {
    subject: 'We got your quote request',
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#0E2948">
<p>Hi ${escapeHtml(first)},</p>
<p>Thanks for reaching out to Safeguard Cleaning. We've received your request and a member of our team will contact you to schedule your free walkthrough.</p>
<p>If you have questions in the meantime, just reply to this email.</p>
<p>Safeguard Cleaning<br>Blue Springs, Missouri</p></div>`,
    text: `Hi ${first},\n\nThanks for reaching out to Safeguard Cleaning. We've received your request and a member of our team will contact you to schedule your free walkthrough.\n\nIf you have questions in the meantime, just reply to this email.\n\nSafeguard Cleaning\nBlue Springs, Missouri`
  };
}

async function logActivity(db, leadId, type, content) {
  try {
    await db.prepare('INSERT INTO lead_activity (lead_id, actor, type, content) VALUES (?, ?, ?, ?)')
      .bind(leadId, 'system', type, content || null).run();
  } catch (err) {
    console.error('Activity log failed', err);
  }
}

export async function handleQuote(request, env, deps = {}) {
  const fetchFn = deps.fetch || fetch;

  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!formConfig(env).formReady) {
    console.error('Quote form is missing configuration: add RESEND_API_KEY (and optionally the DB binding)');
    return json({ ok: false, error: 'not_configured' }, 500);
  }
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) return json({ ok: false, error: 'too_large' }, 413);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: 'too_large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'bad_request' }, 400);

  if (body.step === 2) return handleStep2(body, env, fetchFn);
  return handleStep1(body, request, env, fetchFn);
}

async function handleStep1(body, request, env, fetchFn) {
  // Spam trap: real people never see this field. Pretend it worked so bots learn nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') return json({ ok: true, token: null });

  const { lead, errors } = validateStep1(body);
  if (Object.keys(errors).length) return json({ ok: false, errors }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (env.TURNSTILE_SECRET_KEY) {
    const human = await verifyTurnstile(body.turnstileToken, ip, env, fetchFn);
    if (!human) return json({ ok: false, errors: { turnstile: 'The spam check didn\'t pass. Please try again.' } }, 400);
  }

  const contact = { name: lead.name, businessName: lead.businessName, email: lead.email, phone: lead.phone, city: lead.city };

  // Email only: the email is the record, so a failed send must tell the visitor.
  if (!env.DB) {
    const status = await sendEmail(env, fetchFn, { to: recipients(env), reply_to: lead.email, ...teamAlertEmail(lead) });
    if (status !== 'sent') return json({ ok: false, error: 'email_failed' }, 502);
    return json({ ok: true, token: await signToken(contact, env) });
  }

  const db = env.DB;
  const ipHash = ip ? await sha256Hex(`${env.IP_HASH_SALT || 'safeguard'}:${ip}`) : null;
  if (ipHash) {
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM leads WHERE ip_hash = ? AND created_at > datetime('now', '-1 hour')")
      .bind(ipHash).first();
    if (recent && recent.n >= RATE_LIMIT_PER_HOUR) return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const token = randomToken();
  const result = await db.prepare(`INSERT INTO leads
    (service_type, name, business_name, email, phone, city, landing_page, referrer, utm_source, utm_medium, utm_campaign, ip_hash, step2_token, notification_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .bind(lead.serviceType, lead.name, lead.businessName || null, lead.email, lead.phone, lead.city,
      lead.source.landingPage || null, lead.source.referrer || null, lead.source.utmSource || null,
      lead.source.utmMedium || null, lead.source.utmCampaign || null, ipHash, token)
    .run();
  const id = result && result.meta ? result.meta.last_row_id : null;
  await logActivity(db, id, 'created', null);

  const status = await sendEmail(env, fetchFn, { to: recipients(env), reply_to: lead.email, ...teamAlertEmail(lead, id) });
  await db.prepare('UPDATE leads SET notification_status = ? WHERE id = ?').bind(status, id).run();
  await logActivity(db, id, status === 'sent' ? 'email_sent' : status === 'failed' ? 'email_failed' : 'email_skipped', 'Team alert');

  // Customer confirmation only once a verified sending domain exists (Resend test mode can't email customers).
  if (env.SEND_CUSTOMER_CONFIRMATION === 'true') {
    const replyTo = recipients(env)[0];
    const c = await sendEmail(env, fetchFn, { to: [lead.email], reply_to: replyTo, ...customerEmail(lead) });
    await logActivity(db, id, c === 'sent' ? 'email_sent' : 'email_failed', 'Customer confirmation');
  }

  return json({ ok: true, token });
}

async function handleStep2(body, env, fetchFn) {
  const token = typeof body.token === 'string' ? body.token : '';
  const d = validateStep2(body.details);
  const anything = Object.values(d).some(Boolean);

  // Signed token (email-only setup)
  if (/^[A-Za-z0-9_-]{20,1500}\.[A-Za-z0-9_-]{20,100}$/.test(token)) {
    const contact = await readToken(token, env);
    if (!contact) return json({ ok: false, error: 'expired' }, 404);
    if (anything) {
      const status = await sendEmail(env, fetchFn, { to: recipients(env), reply_to: contact.email, ...detailsEmail(contact, d) });
      if (status !== 'sent') return json({ ok: false, error: 'email_failed' }, 502);
    }
    return json({ ok: true });
  }

  // Database token
  if (!/^[a-f0-9]{48}$/.test(token)) return json({ ok: false, error: 'bad_token' }, 400);
  if (!env.DB) return json({ ok: false, error: 'expired' }, 404);
  const db = env.DB;
  const lead = await db.prepare(`SELECT id, name, business_name, email, phone, city FROM leads
    WHERE step2_token = ? AND created_at > datetime('now', '-${STEP2_WINDOW_HOURS} hours')`).bind(token).first();
  if (!lead) return json({ ok: false, error: 'expired' }, 404);

  await db.prepare(`UPDATE leads SET facility_type = ?, size_range = ?, restrooms = ?, frequency = ?, start_date = ?,
    heard_about = ?, notes = ?, step2_token = NULL, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ?`)
    .bind(d.facilityType || null, d.sizeRange || null, d.restrooms || null, d.frequency || null, d.startDate || null,
      d.heardAbout || null, d.notes || null, lead.id)
    .run();
  await logActivity(db, lead.id, 'details_added', null);

  if (anything) {
    const contact = { name: lead.name, businessName: lead.business_name, email: lead.email, phone: lead.phone, city: lead.city };
    const status = await sendEmail(env, fetchFn, { to: recipients(env), reply_to: lead.email, ...detailsEmail(contact, d, lead.id) });
    await logActivity(db, lead.id, status === 'sent' ? 'email_sent' : status === 'failed' ? 'email_failed' : 'email_skipped', 'Details email');
  }
  return json({ ok: true });
}
