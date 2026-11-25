// SafeGuard Cleaning Co — quote request handling (runs on Cloudflare).
//
// The only setup the form needs is an email key (RESEND_API_KEY). Two more pieces switch on by
// themselves when they are added in Cloudflare:
//   - DB (the D1 database): every request is also saved, rate-limited per visitor, and a failed
//     email never loses a lead (the database write happens before the email).
//   - TURNSTILE_SECRET_KEY (Cloudflare's spam check): the visitor's spam-check token is verified.
// Without them: the hidden spam-trap field still stops simple bots, and the email is the record.
//
// One inquiry, one email. Step 1 (contact details) checks the visitor and returns a token; nothing is
// emailed yet. Step 2 (optional details) sends the single team email with everything, whether the
// visitor fills it in, skips it, or closes the page (the browser then sends step 2 in the background).
// With a database the token is a random id stored with the lead; without one it is a signed summary of
// the contact details, so step 2 can still say who the request is from.

export const LIMITS = { name: 100, businessName: 120, email: 200, phone: 30, city: 80, notes: 2000, short: 300 };
export const MAX_BODY_BYTES = 20000;
export const RATE_LIMIT_PER_HOUR = 5;
export const STEP2_WINDOW_HOURS = 24;
// A signed token can't be marked "used" without a database, so it is kept short-lived to limit replays.
export const SIGNED_TOKEN_HOURS = 2;

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
const DEFAULT_FROM = 'SafeGuard Cleaning Co Website <onboarding@resend.dev>';

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
  const payload = { ...contact, x: now + SIGNED_TOKEN_HOURS * 3600 * 1000 };
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

// ----- The team email: one per inquiry, built to read at a glance -----
const C = { navy: '#0E2948', blue: '#0E64BB', green: '#7FB03B', ink: '#0E2948', muted: '#4A5868', soft: '#F3F6FA', line: '#DCE3EC', page: '#E9EEF4' };
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";

/** "(816) 555-0142" -> "+18165550142" for tap-to-call links. */
export function telHref(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `tel:+${digits}`;
  return digits ? `tel:+${digits}` : '';
}

function formatStartDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatReceived(now) {
  return new Date(now).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago'
  }) + ' CT';
}

/** Where the visitor came from, in plain words. */
export function cameFrom(source) {
  const s = source || {};
  if (s.utmSource) return [s.utmSource, s.utmMedium, s.utmCampaign].filter(Boolean).join(' / ');
  if (!s.referrer) return 'Typed the address or a saved link';
  try {
    const host = new URL(s.referrer).hostname.replace(/^www\./, '');
    if (/(^|\.)google\./.test(host)) return 'Google';
    if (/(^|\.)bing\.com$/.test(host)) return 'Bing';
    if (/facebook\.com$|fb\.com$/.test(host)) return 'Facebook';
    if (/instagram\.com$/.test(host)) return 'Instagram';
    if (/safeguard-cleaning\.pages\.dev$|safeguardcleaning/.test(host)) return 'Another page on the website';
    return host;
  } catch {
    return '';
  }
}

const esc = (v) => escapeHtml(v).replace(/\n/g, '<br>');
const label = (t) => `<div style="font:700 11px/1.3 ${FONT};letter-spacing:1.2px;text-transform:uppercase;color:${C.muted}">${escapeHtml(t)}</div>`;

function tile(name, value) {
  const v = value
    ? `<div style="font:700 16px/1.35 ${FONT};color:${C.ink};margin-top:4px">${esc(value)}</div>`
    : `<div style="font:400 15px/1.35 ${FONT};color:#8A97A6;margin-top:4px">Not given</div>`;
  return `<td width="50%" valign="top" style="padding:5px"><div style="background:${C.soft};border-radius:12px;padding:12px 14px">${label(name)}${v}</div></td>`;
}

function contactRow(name, valueHtml, last) {
  return `<tr><td style="padding:10px 0;${last ? '' : `border-bottom:1px solid ${C.line};`}font:400 14px/1.4 ${FONT};color:${C.muted};width:96px" valign="top">${escapeHtml(name)}</td>
<td style="padding:10px 0;${last ? '' : `border-bottom:1px solid ${C.line};`}font:700 15px/1.4 ${FONT};color:${C.ink}" valign="top">${valueHtml}</td></tr>`;
}

/**
 * The one email the team gets for each website inquiry.
 * contact: name, businessName, email, phone, city. d: the optional step-2 details (may be empty).
 * meta: { id (database lead id, optional), source, now }.
 */
export function quoteEmail(contact, d = {}, meta = {}) {
  const now = meta.now || Date.now();
  const who = contact.businessName || contact.name;
  const first = String(contact.name || '').split(/\s+/)[0] || contact.name;
  const subject = `Website quote request: ${who} (${contact.city})`;
  const received = formatReceived(now);
  const came = cameFrom(meta.source);
  const ref = meta.id ? `Lead #${meta.id}` : '';
  const start = formatStartDate(d.startDate);
  const space = [['Facility', d.facilityType], ['Size', d.sizeRange], ['Restrooms', d.restrooms], ['How often', d.frequency], ['Start date', start], ['Heard about us', d.heardAbout]];
  const anyDetails = space.some(([, v]) => v) || Boolean(d.notes);

  const summary = [d.facilityType, d.sizeRange, d.frequency].filter(Boolean).join(' · ');
  const preheader = `${contact.name} · ${contact.city}${summary ? ' · ' + summary : ''}`;
  const tel = telHref(contact.phone);
  const mailto = `mailto:${contact.email}?subject=${encodeURIComponent('Your SafeGuard Cleaning Co quote request')}`;

  const spaceHtml = anyDetails
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr>${tile(space[0][0], space[0][1])}${tile(space[1][0], space[1][1])}</tr>
<tr>${tile(space[2][0], space[2][1])}${tile(space[3][0], space[3][1])}</tr>
<tr>${tile(space[4][0], space[4][1])}${tile(space[5][0], space[5][1])}</tr>
</table>`
    : `<div style="background:${C.soft};border-radius:12px;padding:14px 16px;font:400 15px/1.5 ${FONT};color:${C.muted}">They skipped the optional details. Ask about their space when you reach out.</div>`;

  const notesHtml = d.notes
    ? `<tr><td style="padding:8px 32px 0">${label('Their notes')}
<div style="margin-top:8px;background:${C.soft};border-left:4px solid ${C.blue};border-radius:0 12px 12px 0;padding:14px 16px;font:400 15px/1.55 ${FONT};color:${C.ink}">${esc(d.notes)}</div></td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#FFFFFF;border-radius:18px;overflow:hidden">

<tr><td style="background:${C.navy};padding:26px 32px 28px">
<div style="font:700 11px/1.3 ${FONT};letter-spacing:1.6px;text-transform:uppercase;color:#9CC3EA">New quote request · From the website</div>
<div style="font:800 28px/1.2 ${FONT};color:#FFFFFF;margin-top:12px">${escapeHtml(who)}</div>
<div style="font:400 16px/1.5 ${FONT};color:#C9D8EA;margin-top:6px">${escapeHtml(contact.name)} &nbsp;·&nbsp; ${escapeHtml(contact.city)}</div>
</td></tr>
<tr><td style="background:${C.green};height:5px;line-height:5px;font-size:0">&nbsp;</td></tr>

<tr><td style="padding:24px 32px 6px">
<a href="${escapeHtml(mailto)}" style="display:inline-block;background:${C.blue};color:#FFFFFF;text-decoration:none;font:700 15px/1 ${FONT};padding:14px 22px;border-radius:999px;margin:0 8px 10px 0">Email ${escapeHtml(first)}</a>${tel ? `<a href="${escapeHtml(tel)}" style="display:inline-block;background:#FFFFFF;color:${C.blue};text-decoration:none;font:700 15px/1 ${FONT};padding:12px 20px;border-radius:999px;border:2px solid ${C.blue};margin:0 0 10px 0">Call ${escapeHtml(contact.phone)}</a>` : ''}
</td></tr>

<tr><td style="padding:14px 27px 4px"><div style="padding:0 5px 6px">${label('Their space')}</div>${spaceHtml}</td></tr>
${notesHtml}

<tr><td style="padding:22px 32px 8px">${label('Contact')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:4px">
${contactRow('Name', escapeHtml(contact.name))}
${contactRow('Business', escapeHtml(contact.businessName || '—'))}
${contactRow('Email', `<a href="${escapeHtml(mailto)}" style="color:${C.blue};text-decoration:none">${escapeHtml(contact.email)}</a>`)}
${contactRow('Phone', tel ? `<a href="${escapeHtml(tel)}" style="color:${C.blue};text-decoration:none">${escapeHtml(contact.phone)}</a>` : escapeHtml(contact.phone))}
${contactRow('City', escapeHtml(contact.city), true)}
</table></td></tr>

<tr><td style="padding:18px 32px 26px">
<div style="border-top:1px solid ${C.line};padding-top:14px;font:400 13px/1.6 ${FONT};color:${C.muted}">
Received ${escapeHtml(received)} from the quote form on the SafeGuard Cleaning Co website.${came ? `<br>How they found the site: ${escapeHtml(came)}` : ''}${ref ? `<br>${escapeHtml(ref)}` : ''}<br>Hit reply to answer ${escapeHtml(first)} directly.
</div></td></tr>

</table>
</td></tr></table>
</body></html>`;

  const lines = (pairs) => pairs.map(([k, v]) => `${k}: ${v || 'Not given'}`).join('\n');
  const text = [
    `NEW QUOTE REQUEST FROM THE WEBSITE`,
    `${who} · ${contact.name} · ${contact.city}`,
    '',
    'CONTACT',
    lines([['Name', contact.name], ['Business', contact.businessName], ['Email', contact.email], ['Phone', contact.phone], ['City', contact.city]]),
    '',
    'THEIR SPACE',
    anyDetails ? lines(space) : 'They skipped the optional details.',
    ...(d.notes ? ['', 'THEIR NOTES', d.notes] : []),
    '',
    `Received ${received} from the quote form on the SafeGuard Cleaning Co website.`,
    ...(came ? [`How they found the site: ${came}`] : []),
    ...(ref ? [ref] : []),
    `Hit reply to answer ${first} directly.`
  ].join('\n');

  return { subject, html, text };
}

export function customerEmail(lead) {
  const first = lead.name.split(/\s+/)[0];
  return {
    subject: 'We got your quote request',
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#0E2948">
<p>Hi ${escapeHtml(first)},</p>
<p>Thanks for reaching out to SafeGuard Cleaning Co. We've received your request and a member of our team will contact you to schedule your free walkthrough.</p>
<p>If you have questions in the meantime, just reply to this email.</p>
<p>SafeGuard Cleaning Co<br>Blue Springs, Missouri</p></div>`,
    text: `Hi ${first},\n\nThanks for reaching out to SafeGuard Cleaning Co. We've received your request and a member of our team will contact you to schedule your free walkthrough.\n\nIf you have questions in the meantime, just reply to this email.\n\nSafeGuard Cleaning Co\nBlue Springs, Missouri`
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

  // Email only: nothing is sent yet. The signed token carries the contact details to step 2, which
  // sends the one email (and tells the visitor if it fails, since the email is the only record).
  if (!env.DB) {
    const s = lead.source;
    const contact = {
      name: lead.name, businessName: lead.businessName, email: lead.email, phone: lead.phone, city: lead.city,
      s: { referrer: s.referrer, utmSource: s.utmSource, utmMedium: s.utmMedium, utmCampaign: s.utmCampaign }
    };
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
  // The team email goes out at step 2 with everything in it; the lead stays 'pending' until then.

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

  // Signed token (email-only setup): send the one email; if it fails, the visitor is told.
  if (/^[A-Za-z0-9_-]{20,3000}\.[A-Za-z0-9_-]{20,100}$/.test(token)) {
    const contact = await readToken(token, env);
    if (!contact) return json({ ok: false, error: 'expired' }, 404);
    const status = await sendEmail(env, fetchFn, { to: recipients(env), reply_to: contact.email, ...quoteEmail(contact, d, { source: contact.s }) });
    if (status !== 'sent') return json({ ok: false, error: 'email_failed' }, 502);
    return json({ ok: true });
  }

  // Database token
  if (!/^[a-f0-9]{48}$/.test(token)) return json({ ok: false, error: 'bad_token' }, 400);
  if (!env.DB) return json({ ok: false, error: 'expired' }, 404);
  const db = env.DB;
  const lead = await db.prepare(`SELECT id, name, business_name, email, phone, city, referrer, utm_source, utm_medium, utm_campaign FROM leads
    WHERE step2_token = ? AND created_at > datetime('now', '-${STEP2_WINDOW_HOURS} hours')`).bind(token).first();
  if (!lead) return json({ ok: false, error: 'expired' }, 404);

  await db.prepare(`UPDATE leads SET facility_type = ?, size_range = ?, restrooms = ?, frequency = ?, start_date = ?,
    heard_about = ?, notes = ?, step2_token = NULL, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ?`)
    .bind(d.facilityType || null, d.sizeRange || null, d.restrooms || null, d.frequency || null, d.startDate || null,
      d.heardAbout || null, d.notes || null, lead.id)
    .run();
  await logActivity(db, lead.id, 'details_added', null);

  // The lead is already saved, so a failed email is recorded (for a retry later) rather than shown to the visitor.
  const contact = { name: lead.name, businessName: lead.business_name, email: lead.email, phone: lead.phone, city: lead.city };
  const source = { referrer: lead.referrer, utmSource: lead.utm_source, utmMedium: lead.utm_medium, utmCampaign: lead.utm_campaign };
  const status = await sendEmail(env, fetchFn, { to: recipients(env), reply_to: lead.email, ...quoteEmail(contact, d, { id: lead.id, source }) });
  await db.prepare('UPDATE leads SET notification_status = ? WHERE id = ?').bind(status, lead.id).run();
  await logActivity(db, lead.id, status === 'sent' ? 'email_sent' : status === 'failed' ? 'email_failed' : 'email_skipped', 'Team alert');
  return json({ ok: true });
}
