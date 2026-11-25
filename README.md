# SafeGuard Cleaning Co website

The live website and quote form for SafeGuard Cleaning Co.

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
   - `EMAIL_FROM` = `SafeGuard Cleaning Co <quotes@yourdomain.com>`
   - `LEAD_ALERT_TO` = all three team emails, comma-separated
   - `SEND_CUSTOMER_CONFIRMATION` = `true` (customers get a "we got your request" email)
4. Retry the deployment.

## Getting on Google

Two free Google accounts do two different jobs. Sign in to both with **safeguardcleaningco@gmail.com** so the business owns them.

| | What it does |
|---|---|
| **Google Business Profile** | Your listing on Google Maps and the box on the right of Google search ("commercial cleaning near me"). This is the big one for a local business. |
| **Google Search Console** | Tells Google your website exists, shows which searches find it, and warns you about problems. |

### A. Google Business Profile (about 20 minutes, then verification)
1. Go to **business.google.com** → **Manage now**.
2. **Business name:** your real name exactly as customers see it (logo, invoices, email). No extra words like "Best Commercial Cleaning KC". Google suspends profiles that stuff keywords into the name.
3. **Category:** `Commercial cleaning service`. You can add extra categories later (for example `Janitorial service`), but only ones that are true.
4. **"Do you want to add a location customers can visit?"** → **No.** You go to your customers, so you're a "service-area business." Your address stays hidden from the public.
5. **Service areas:** add Kansas City MO, Kansas City KS, Overland Park KS, Blue Springs MO, Independence MO, Lee's Summit MO, Olathe KS, and other metro cities you'll actually drive to (up to 20).
6. **Contact:** phone is optional, so leave it blank (it's on hold). **Website:** `https://safeguard-cleaning.pages.dev/`
7. **Mailing address:** Google asks for a real address to verify you, usually the Blue Springs home address. It is **not shown** publicly. No P.O. boxes or virtual offices.
8. **Verification:** Google will most likely ask for a short **video**. Have these ready to film in one take: the street sign or outside of the address, your work vehicle or cleaning equipment, and something with the business name on it (a business card, a branded shirt or a supply closet label). Verification can take a few days.
9. Once verified, fill in:
   - **Description:** paste the one below.
   - **Hours:** the hours you're open to take inquiries.
   - **Services:** list the kinds of commercial cleaning you do.
   - **Photos:** your logo, plus **real** photos of your team at work or spaces you've cleaned (no faces without consent). Don't use stock photos here. Google wants real ones, and they help ranking.
   - **Booking / quote link:** `https://safeguard-cleaning.pages.dev/quote.html`

**Description to paste:**
> SafeGuard Cleaning Co provides commercial cleaning for businesses across the Kansas City metro and Overland Park, KS. Instead of fixed packages, we walk through your building with you and build a cleaning plan around what actually needs to be cleaned. Free walkthrough and free quote. New customers get a discount on their first clean, and a percentage of every job goes to charity. Based in Blue Springs, MO. We clean businesses only.

**Reviews:** reviews on this profile matter more than anything else for showing up in Maps. After a job goes well, send the customer your review link (in the profile: **Ask for reviews**). Don't offer discounts or gifts for reviews, and don't write your own. Both break Google's rules and can get the profile removed. Reply to every review, good or bad.

### B. Google Search Console (about 10 minutes)
1. Go to **search.google.com/search-console** → **Add property** → choose **URL prefix** → enter `https://safeguard-cleaning.pages.dev/`
2. Pick **HTML tag** as the verification method and send the tag to Claude. Claude adds it to the site; after it deploys, click **Verify**.
3. Go to **Sitemaps**, enter `sitemap.xml`, click **Submit**.
4. Check back in a week or two. **Performance** shows which searches found you.

### When you buy the domain
Change the website link on the Business Profile, add the new domain as a second Search Console property, and use Search Console's **Change of address** tool. Claude updates the site's links and sitemap.

## Making changes
Edit the files, then upload the changed files to GitHub the same way (drag onto the repository page → **Commit changes**). Cloudflare redeploys automatically in about a minute.
