// GET /api/config — public settings the quote form needs (the spam check's public site key).
import { json } from '../../lib/quote-core.js';

export const onRequestGet = ({ env }) => json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
