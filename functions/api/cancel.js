// Pixel Purchase · POST /api/cancel
// When a buyer leaves Stripe's page without paying, this frees their spots right away
// (instead of waiting 35 minutes), closes that payment page so it can't be paid later,
// and deletes the pictures they uploaded for it. Only the buyer can cancel their own order.

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const readJson = async r => { try { return await r.json(); } catch (e) { return null; } };
const sb = (env, path, init = {}) =>
  fetch(env.SUPABASE_URL + path, { ...init, headers: { apikey: env.SUPABASE_SECRET_KEY, ...(init.headers || {}) } });

async function getUser(env, request) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: env.SUPABASE_SECRET_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

export async function onRequestPost({ request, env }) {
  try {
    const user = await getUser(env, request);
    if (!user) return json({ error: 'Please sign in again.' }, 401);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    const orderId = Number(body.order);
    if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: 'Bad request.' }, 400);

    const rows = await readJson(await sb(env, `/rest/v1/orders?id=eq.${orderId}&select=id,buyer_id,status,stripe_session_id`));
    const o = Array.isArray(rows) && rows[0];
    if (!o || o.buyer_id !== user.id) return json({ error: 'Order not found.' }, 404);
    if (o.status !== 'checkout') return json({ ok: true, status: o.status }); // already paid, expired, or decided

    // Close the Stripe page first. If it was already paid, keep the order.
    if (o.stripe_session_id) {
      const sr = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(o.stripe_session_id)}/expire`, {
        method: 'POST', headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      if (!sr.ok) {
        const s = await readJson(await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(o.stripe_session_id)}`, {
          headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        }));
        if (s && s.status === 'complete') return json({ ok: true, status: 'paid' });
      }
    }

    const spots = await readJson(await sb(env, `/rest/v1/spots?order_id=eq.${orderId}&status=eq.held&select=image_path`));
    await sb(env, `/rest/v1/spots?order_id=eq.${orderId}&status=eq.held`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    await sb(env, `/rest/v1/orders?id=eq.${orderId}&status=eq.checkout`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'expired' }),
    });
    const paths = (Array.isArray(spots) ? spots : []).map(s => s.image_path).filter(Boolean);
    if (paths.length)
      await sb(env, '/storage/v1/object/pixels', {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths }),
      });
    return json({ ok: true, status: 'canceled' });
  } catch (e) {
    return json({ error: 'Something went wrong.' }, 500);
  }
}
