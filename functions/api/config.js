// GET /api/config — public settings the quote form needs: whether it can send yet, and the spam
// check's public site key (only when the spam check is fully set up).
import { json, formConfig } from '../../lib/quote-core.js';

export const onRequestGet = ({ env }) => json(formConfig(env));
