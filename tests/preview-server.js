// Local preview with stand-in services: node --no-warnings tests/preview-server.js  → http://localhost:8788
// Serves public/ like Cloudflare Pages does, runs the real quote handler against an in-memory database,
// and fakes Turnstile (always passes) and Resend (logs the email instead of sending it).
// Default: the email-only setup (no database, no spam check), as the live site runs it.
// PREVIEW_FULL=1 adds the database and the spam check.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleQuote, formConfig } from '../lib/quote-core.js';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(schema);
const DB = {
  prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
      async first() { const r = sqlite.prepare(sql).get(...args); return r ? { ...r } : null; }
    };
    return api;
  }
};
export const sentEmails = [];
const fakeFetch = async (url, init) => {
  if (url.includes('turnstile')) return new Response(JSON.stringify({ success: true }));
  if (url.includes('resend')) { const m = JSON.parse(init.body); sentEmails.push(m); console.log('\n[email] ' + m.subject + '  ->  ' + m.to.join(', ') + '\n' + m.text + '\n'); return new Response('{}'); }
  throw new Error('blocked ' + url);
};
const FULL = process.env.PREVIEW_FULL === '1';
const env = FULL
  ? { DB, TURNSTILE_SECRET_KEY: 'test', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', RESEND_API_KEY: 're_preview' }
  : { RESEND_API_KEY: 're_preview' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(formConfig(env)));
  }
  if (url.pathname === '/api/leads') { // preview only: see what was saved
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ leads: sqlite.prepare('SELECT * FROM leads').all(), emails: sentEmails }));
  }
  if (url.pathname === '/api/quote') {
    const chunks = []; for await (const c of req) chunks.push(c);
    const request = new Request('http://localhost' + req.url, {
      method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '127.0.0.1' },
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined
    });
    const out = await handleQuote(request, env, { fetch: fakeFetch });
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    return res.end(await out.text());
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, p);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  else if (!extname(file) && existsSync(file + '.html')) file += '.html';
  if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': TYPES['.html'] }); return res.end(readFileSync(join(root, '404.html'))); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
const port = Number(process.env.PORT || 8788);
server.listen(port, () => {
  console.log(`\nSafeguard Cleaning preview is running at http://localhost:${port}`);
  console.log(FULL ? 'Full setup: database + spam check (simulated).' : 'Email-only setup, like the live site.');
  console.log('Emails print here instead of being sent.');
  console.log('Saved requests: http://localhost:' + port + '/api/leads');
  console.log('Close this window to stop the preview.\n');
});
