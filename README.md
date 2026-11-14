# Safeguard Cleaning website

The live website and quote form for Safeguard Cleaning.

- `public/`: the pages visitors see (home, quote form, privacy policy, 404)
- `functions/api/`: the quote form's server (runs on Cloudflare)
- `lib/quote-core.js`: the form logic (validation, spam check, saving, email)
- `schema.sql`: the database tables
- `tests/`: automated tests (`npm test`) and a local preview (`node --no-warnings tests/preview-server.js`)

Nothing needs to be installed or built. Cloudflare serves `public/` and runs `functions/` automatically.

## How the quote form works

1. A visitor fills in step 1 and the Cloudflare spam check (Turnstile) runs in the background.
2. The server checks the details, confirms the spam check, blocks anyone sending more than 5 requests an hour, and ignores bots that fill in a hidden trap field.
3. The request is **saved to the database first**, then emailed to the team (reply to the email to answer the customer).
4. Optional step 2 details are added to the same request and emailed as a second message.

If an email ever fails, the request is still saved.

---

## One-time setup (about 30 minutes)

You need three free accounts. Use **safeguardcleaningco@gmail.com** for all of them and turn on two-factor login.

### 1. Put the code on GitHub
1. Sign in to github.com and click **New repository**. Name it `safeguard-cleaning-website`, choose **Private**, and click **Create repository**.
2. On the new page, click **uploading an existing file**.
3. Open this folder on your computer, select everything inside it, and drag it onto the page. Click **Commit changes**.

### 2. Create the Cloudflare account and the site
1. Sign up at dash.cloudflare.com (free plan).
2. Go to **Workers & Pages → Create → Pages → Connect to Git**, connect GitHub, and pick `safeguard-cleaning-website`.
3. Build settings: Framework preset **None**, Build command **(leave empty)**, Build output directory **`public`**. Click **Save and Deploy**.
4. Your site will be live at an address like `safeguard-cleaning-website.pages.dev`.

### 3. Create the database
1. In Cloudflare, go to **Storage & Databases → D1 → Create database**. Name it `safeguard-leads`.
2. Open it, click **Console**, paste everything from `schema.sql`, and click **Execute**.
3. Go to your Pages project → **Settings → Bindings → Add → D1 database**. Variable name **`DB`**, database `safeguard-leads`. Save.

### 4. Create the spam check (Turnstile)
1. In Cloudflare, go to **Turnstile → Add widget**. Name: `Safeguard quote form`. Hostname: your `.pages.dev` address (add your real domain later). Mode: **Managed**.
2. Copy the **Site Key** and **Secret Key**.

### 5. Create the email account (Resend)
1. Sign up at resend.com **with safeguardcleaningco@gmail.com**.
2. Go to **API Keys → Create API Key** (permission: Sending access). Copy the key.

Until you own a domain, Resend can only send to the email address you signed up with. That's fine: team alerts go to safeguardcleaningco@gmail.com.

### 6. Add the settings to the site
Pages project → **Settings → Variables and Secrets → Add** (Production). Add each as an **encrypted secret**:

| Name | Value |
|---|---|
| `TURNSTILE_SITE_KEY` | the Turnstile Site Key |
| `TURNSTILE_SECRET_KEY` | the Turnstile Secret Key |
| `RESEND_API_KEY` | the Resend API key |
| `IP_HASH_SALT` | any long random phrase (scrambles visitor addresses) |

Optional: `LEAD_ALERT_TO` (who gets alerts, comma-separated; default safeguardcleaningco@gmail.com).

Then go to **Deployments**, open the latest one's menu, and click **Retry deployment** so the settings take effect.

### 7. Test it
Open your site, go to **Get my free quote**, and send a test request with your own details. You should get the email within a minute. To see saved requests: D1 → `safeguard-leads` → Console → `SELECT * FROM leads ORDER BY id DESC;`

Optional: Pages project → **Metrics → Web Analytics → Enable** for privacy-friendly visit counts.

---

## Later, once you buy the domain
1. Add the domain to Cloudflare and connect it to the Pages project (**Custom domains**).
2. Add the domain to the Turnstile widget's hostnames.
3. In Resend, add and verify the domain, then set:
   - `EMAIL_FROM` = `Safeguard Cleaning <quotes@yourdomain.com>`
   - `LEAD_ALERT_TO` = all three team emails, comma-separated
   - `SEND_CUSTOMER_CONFIRMATION` = `true` (customers get a "we got your request" email)
4. Retry the deployment.

## Making changes
Edit the files, then upload the changed files to GitHub the same way (drag onto the repository page → **Commit changes**). Cloudflare redeploys automatically in about a minute.
