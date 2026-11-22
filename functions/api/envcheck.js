// TEMPORARY diagnostic: lists which setting names the site can see (true/false only, never values). Remove after setup.
export const onRequestGet = ({ env }) => new Response(JSON.stringify(
  Object.fromEntries(Object.keys(env).map((k) => [k, typeof env[k] === 'string' ? env[k].length > 0 : typeof env[k]]))
), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
