// POST /api/quote — the quote form's server. All logic lives in lib/quote-core.js.
import { handleQuote, json } from '../../lib/quote-core.js';

export const onRequestPost = ({ request, env }) => handleQuote(request, env);
export const onRequest = () => json({ ok: false, error: 'method_not_allowed' }, 405);
