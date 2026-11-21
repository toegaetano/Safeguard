// Tests for the quote form server. Run with: npm test  (Node 22.5+; no packages needed)
// Uses a real SQLite database with schema.sql and fake Turnstile / Resend services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleQuote, escapeHtml, validateStep2, formConfig, signToken, RATE_LIMIT_PER_HOUR } from '../lib/quote-core.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

// Minimal stand-in for Cloudflare D1 on top of node:sqlite.
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const wrap = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
      async first() { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
      async all() { return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; }
    };
    return api;
  };
  return { prepare: wrap, raw: db };
}

function makeFetch({ turnstileOk = true, resendStatus = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('turnstile')) return new Response(JSON.stringify({ success: turnstileOk }));
    if (url.includes('resend')) return new Response(JSON.stringify({ id: 'x' }), { status: resendStatus });
    throw new Error('unexpected fetch ' + url);
  };
  fn.calls = calls;
  return fn;
}

function env(db, extra = {}) {
  return { DB: db, TURNSTILE_SECRET_KEY: 'secret', RESEND_API_KEY: 're_test', ...extra };
}

function req(body, { ip = '203.0.113.7', method = 'POST' } = {}) {
  return new Request('https://example.test/api/quote', {
    method,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
}

const good = {
  step: 1, serviceType: 'commercial', name: 'Dana Smith', businessName: 'Smith Dental',
  email: 'Dana@Example.com', phone: '(816) 555-0142', city: 'Independence', website: '',
  turnstileToken: 'tok', source: { landingPage: '/', referrer: 'https://www.google.com/', utmSource: '' }
};

test('valid step 1 saves the lead, emails the team, returns a token', async () => {
  const db = makeD1(); const f = makeFetch();
  const res = await handleQuote(req(good), env(db), { fetch: f });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.match(data.token, /^[a-f0-9]{48}$/);

  const row = db.raw.prepare('SELECT * FROM leads').get();
  assert.equal(row.name, 'Dana Smith');
  assert.equal(row.email, 'dana@example.com');
  assert.equal(row.business_name, 'Smith Dental');
  assert.equal(row.notification_status, 'sent');
  assert.equal(row.referrer, 'https://www.google.com/');
  assert.ok(row.ip_hash && !row.ip_hash.includes('203.0.113.7'), 'IP is stored hashed only');

  const email = f.calls.find((c) => c.url.includes('resend'));
  const sent = JSON.parse(email.init.body);
  assert.deepEqual(sent.to, ['safeguardcleaningco@gmail.com']);
  assert.equal(sent.reply_to, 'dana@example.com');
  assert.equal(sent.subject, 'Website quote request: Smith Dental (Independence)');
  assert.equal(email.init.headers.Authorization, 'Bearer re_test');
});

test('alert goes to every address in LEAD_ALERT_TO', async () => {
  const db = makeD1(); const f = makeFetch();
  await handleQuote(req(good), env(db, { LEAD_ALERT_TO: 'a@x.com, b@x.com,c@x.com' }), { fetch: f });
  const sent = JSON.parse(f.calls.find((c) => c.url.includes('resend')).init.body);
  assert.deepEqual(sent.to, ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('missing or invalid fields return errors under each field and save nothing', async () => {
  const db = makeD1(); const f = makeFetch();
  const res = await handleQuote(req({ ...good, name: ' ', email: 'nope', phone: '123', city: '', businessName: '' }), env(db), { fetch: f });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.deepEqual(Object.keys(errors).sort(), ['businessName', 'city', 'email', 'name', 'phone']);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM leads').get().n, 0);
  assert.equal(f.calls.length, 0, 'no spam check or email for invalid input');
});

test('businesses only: a "residential" request still needs a business name and is saved as commercial', async () => {
  const db = makeD1(); const f = makeFetch();
  const bad = await handleQuote(req({ ...good, serviceType: 'residential', businessName: '' }), env(db), { fetch: f });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).errors.businessName);
  const ok = await handleQuote(req({ ...good, serviceType: 'residential' }), env(db), { fetch: f });
  assert.equal(ok.status, 200);
  assert.equal(db.raw.prepare('SELECT service_type FROM leads').get().service_type, 'commercial');
});

test('"Home" is no longer an accepted facility type', () => {
  assert.equal(validateStep2({ facilityType: 'Home' }).facilityType, '');
  assert.equal(validateStep2({ facilityType: 'Office' }).facilityType, 'Office');
});

test('spam trap filled: pretends success, saves and sends nothing', async () => {
  const db = makeD1(); const f = makeFetch();
  const res = await handleQuote(req({ ...good, website: 'http://spam.example' }), env(db), { fetch: f });
  assert.equal(res.status, 200);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM leads').get().n, 0);
  assert.equal(f.calls.length, 0);
});

test('failed spam check is rejected and nothing is saved', async () => {
  const db = makeD1(); const f = makeFetch({ turnstileOk: false });
  const res = await handleQuote(req(good), env(db), { fetch: f });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).errors.turnstile);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM leads').get().n, 0);
});

test('missing spam-check token is rejected without calling Turnstile', async () => {
  const db = makeD1(); const f = makeFetch();
  const res = await handleQuote(req({ ...good, turnstileToken: '' }), env(db), { fetch: f });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test(`rate limit: request ${RATE_LIMIT_PER_HOUR + 1} from one address within an hour is refused`, async () => {
  const db = makeD1(); const f = makeFetch();
  for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
    const r = await handleQuote(req(good), env(db), { fetch: f });
    assert.equal(r.status, 200);
  }
  const blocked = await handleQuote(req(good), env(db), { fetch: f });
  assert.equal(blocked.status, 429);
  const other = await handleQuote(req(good, { ip: '198.51.100.9' }), env(db), { fetch: f });
  assert.equal(other.status, 200, 'other visitors are unaffected');
});

test('email failure still keeps the lead and tells the visitor it worked', async () => {
  const db = makeD1(); const f = makeFetch({ resendStatus: 500 });
  const res = await handleQuote(req(good), env(db), { fetch: f });
  assert.equal(res.status, 200);
  const row = db.raw.prepare('SELECT notification_status FROM leads').get();
  assert.equal(row.notification_status, 'failed');
  const act = db.raw.prepare("SELECT type FROM lead_activity WHERE type = 'email_failed'").get();
  assert.ok(act);
});

test('no email key yet: lead is saved and marked skipped', async () => {
  const db = makeD1(); const f = makeFetch();
  const res = await handleQuote(req(good), env(db, { RESEND_API_KEY: '' }), { fetch: f });
  assert.equal(res.status, 200);
  assert.equal(db.raw.prepare('SELECT notification_status FROM leads').get().notification_status, 'skipped');
});

test('customer confirmation is only sent when switched on', async () => {
  const db = makeD1(); const f = makeFetch();
  await handleQuote(req(good), env(db), { fetch: f });
  assert.equal(f.calls.filter((c) => c.url.includes('resend')).length, 1);
  const f2 = makeFetch();
  await handleQuote(req(good, { ip: '198.51.100.1' }), env(db, { SEND_CUSTOMER_CONFIRMATION: 'true' }), { fetch: f2 });
  const mails = f2.calls.filter((c) => c.url.includes('resend')).map((c) => JSON.parse(c.init.body));
  assert.equal(mails.length, 2);
  assert.deepEqual(mails[1].to, ['dana@example.com']);
});

test('step 2 saves allowed details once, emails the team, and the token stops working', async () => {
  const db = makeD1(); const f = makeFetch();
  const { token } = await (await handleQuote(req(good), env(db), { fetch: f })).json();
  const details = { facilityType: 'Office', sizeRange: '5,000–10,000 sq ft', restrooms: '3–4', frequency: 'Weekly',
    startDate: '2026-12-01', heardAbout: 'Referral', notes: 'Front lobby needs extra care.' };
  const r2 = await handleQuote(req({ step: 2, token, details }), env(db), { fetch: f });
  assert.equal(r2.status, 200);
  const row = db.raw.prepare('SELECT * FROM leads').get();
  assert.equal(row.facility_type, 'Office');
  assert.equal(row.notes, 'Front lobby needs extra care.');
  assert.equal(row.step2_token, null);
  const mails = f.calls.filter((c) => c.url.includes('resend'));
  assert.equal(mails.length, 2);
  assert.equal(JSON.parse(mails[1].init.body).subject, 'Website quote request, more details: Smith Dental (Independence)');

  const again = await handleQuote(req({ step: 2, token, details }), env(db), { fetch: f });
  assert.equal(again.status, 404, 'token can only be used once');
});

test('step 2 ignores values that are not on the form', async () => {
  const db = makeD1(); const f = makeFetch();
  const { token } = await (await handleQuote(req(good), env(db), { fetch: f })).json();
  await handleQuote(req({ step: 2, token, details: { facilityType: 'Castle', startDate: 'tomorrow', restrooms: '2' } }), env(db), { fetch: f });
  const row = db.raw.prepare('SELECT facility_type, start_date, restrooms FROM leads').get();
  assert.equal(row.facility_type, null);
  assert.equal(row.start_date, null);
  assert.equal(row.restrooms, '2');
});

test('step 2 with a made-up token is refused', async () => {
  const db = makeD1(); const f = makeFetch();
  const r = await handleQuote(req({ step: 2, token: 'a'.repeat(48), details: {} }), env(db), { fetch: f });
  assert.equal(r.status, 404);
  const bad = await handleQuote(req({ step: 2, token: "x' OR 1=1 --", details: {} }), env(db), { fetch: f });
  assert.equal(bad.status, 400);
});

test('broken, oversized and wrong-method requests are rejected', async () => {
  const db = makeD1(); const f = makeFetch();
  assert.equal((await handleQuote(req('{not json'), env(db), { fetch: f })).status, 400);
  assert.equal((await handleQuote(req({ ...good, name: 'x'.repeat(30000) }), env(db), { fetch: f })).status, 413);
  assert.equal((await handleQuote(req(null, { method: 'GET' }), env(db), { fetch: f })).status, 405);
});

test('missing setup is reported as a server error, not a crash', async () => {
  const f = makeFetch();
  const r = await handleQuote(req(good), {}, { fetch: f });
  assert.equal(r.status, 500);
  assert.equal(f.calls.length, 0);
});

test('names with HTML are escaped in the team email', async () => {
  const db = makeD1(); const f = makeFetch();
  await handleQuote(req({ ...good, name: '<script>alert(1)</script>' }), env(db), { fetch: f });
  const html = JSON.parse(f.calls.find((c) => c.url.includes('resend')).init.body).html;
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes(escapeHtml('<script>')));
});

// ----- Email-only setup: just RESEND_API_KEY (no database, no spam check) -----
const emailOnly = (extra = {}) => ({ RESEND_API_KEY: 're_test', ...extra });
const resendCalls = (f) => f.calls.filter((c) => c.url.includes('resend')).map((c) => JSON.parse(c.init.body));

test('email-only: the form reports ready with just the email key; nothing set up reports not ready', () => {
  assert.deepEqual(formConfig(emailOnly()), { formReady: true, turnstileSiteKey: null });
  assert.equal(formConfig({}).formReady, false);
  assert.equal(formConfig({ RESEND_API_KEY: 'k', TURNSTILE_SITE_KEY: 'site' }).turnstileSiteKey, null, 'no site key without the secret');
  assert.equal(formConfig({ RESEND_API_KEY: 'k', TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 's' }).turnstileSiteKey, 'site');
});

test('email-only: step 1 emails everything the customer typed, with a clear website subject', async () => {
  const f = makeFetch();
  const res = await handleQuote(req({ ...good, turnstileToken: '' }), emailOnly(), { fetch: f });
  assert.equal(res.status, 200);
  const { ok, token } = await res.json();
  assert.equal(ok, true);
  assert.ok(token && token.includes('.'), 'a signed token for step 2');
  assert.equal(f.calls.filter((c) => c.url.includes('turnstile')).length, 0, 'no spam-check call when it is not set up');
  const [mail] = resendCalls(f);
  assert.equal(mail.subject, 'Website quote request: Smith Dental (Independence)');
  assert.deepEqual(mail.to, ['safeguardcleaningco@gmail.com']);
  assert.equal(mail.reply_to, 'dana@example.com');
  assert.match(mail.from, /Website/);
  for (const v of ['Dana Smith', 'Smith Dental', 'dana@example.com', '(816) 555-0142', 'Independence', 'website']) assert.ok(mail.text.includes(v), `text has ${v}`);
});

test('email-only: a failed email tells the visitor instead of pretending it worked', async () => {
  const f = makeFetch({ resendStatus: 500 });
  const res = await handleQuote(req(good), emailOnly(), { fetch: f });
  assert.equal(res.status, 502);
});

test('email-only: step 2 emails the details and repeats who they are from', async () => {
  const f = makeFetch();
  const { token } = await (await handleQuote(req(good), emailOnly(), { fetch: f })).json();
  const details = { facilityType: 'Office', restrooms: '2', frequency: 'Weekly', notes: 'Back door code at front desk.' };
  const r2 = await handleQuote(req({ step: 2, token, details }), emailOnly(), { fetch: f });
  assert.equal(r2.status, 200);
  const mail = resendCalls(f)[1];
  assert.equal(mail.subject, 'Website quote request, more details: Smith Dental (Independence)');
  assert.equal(mail.reply_to, 'dana@example.com');
  for (const v of ['Office', 'Weekly', 'Back door code', 'Dana Smith', '(816) 555-0142']) assert.ok(mail.text.includes(v), `text has ${v}`);
});

test('email-only: step 2 with nothing filled in sends no second email', async () => {
  const f = makeFetch();
  const { token } = await (await handleQuote(req(good), emailOnly(), { fetch: f })).json();
  const r2 = await handleQuote(req({ step: 2, token, details: {} }), emailOnly(), { fetch: f });
  assert.equal(r2.status, 200);
  assert.equal(resendCalls(f).length, 1);
});

test('email-only: a changed, foreign or expired step-2 token is refused', async () => {
  const f = makeFetch();
  const { token } = await (await handleQuote(req(good), emailOnly(), { fetch: f })).json();
  const [body, sig] = token.split('.');
  const forged = body.slice(0, -2) + (body.endsWith('AA') ? 'BB' : 'AA') + '.' + sig;
  assert.equal((await handleQuote(req({ step: 2, token: forged, details: { notes: 'x' } }), emailOnly(), { fetch: f })).status, 404);
  assert.equal((await handleQuote(req({ step: 2, token, details: { notes: 'x' } }), emailOnly({ RESEND_API_KEY: 'other' }), { fetch: f })).status, 404, 'signed with another key');
  const old = await signToken({ name: 'A', businessName: 'B', email: 'a@b.co', phone: '1', city: 'C' }, emailOnly(), Date.now() - 48 * 3600 * 1000);
  assert.equal((await handleQuote(req({ step: 2, token: old, details: { notes: 'x' } }), emailOnly(), { fetch: f })).status, 404, 'expired after 24 hours');
  assert.equal(resendCalls(f).length, 1, 'no email for any refused token');
});

test('email-only: the spam trap still stops bots', async () => {
  const f = makeFetch();
  const res = await handleQuote(req({ ...good, website: 'http://spam.example' }), emailOnly(), { fetch: f });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});
