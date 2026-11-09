// Pixel Purchase · POST /api/stripe-webhook
// Stripe calls this (not visitors). Every message is checked against your webhook signing secret,
// so nobody can fake a "paid" message. It handles:
//   checkout.session.completed  → buyer finished paying: order becomes "pending" (waiting for your approval)
//   checkout.session.expired    → buyer never paid: spots are freed and their pictures deleted
//   payment_intent.canceled     → a card hold was canceled or ran out (7 days): spots are freed
// Needs these in Cloudflare > Settings > Variables and secrets:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_...), SUPABASE_URL, SUPABASE_SECRET_KEY

const TOLERANCE_SECONDS = 300;

const readJson = async r => { try { return await r.json(); } catch (e) { return null; } };
const sb = (env, path, init = {}) =>
  fetch(env.SUPABASE_URL + path, { ...init, headers: { apikey: env.SUPABASE_SECRET_KEY, ...(init.headers || {}) } });
const stripe = (env, path, init = {}) =>
  fetch('https://api.stripe.com/v1' + path, { ...init, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(init.headers || {}) } });
const ok = (msg = 'ok') => new Response(msg, { status: 200 });

// Stripe signature check: HMAC-SHA256 of "timestamp.body" with the signing secret.
async function verify(env, raw, header) {
  if (!header || !env.STRIPE_WEBHOOK_SECRET) return false;
  const parts = Object.create(null);
  const sigs = [];
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === 'v1') sigs.push(v); else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`)));
  const expected = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => {
    if (s.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

async function freeOrder(env, orderId, fromStatuses) {
  // Remove the order's spots (so they're open again), mark the order expired, delete its pictures.
  const statusList = fromStatuses.join(',');
  const spots = await readJson(await sb(env, `/rest/v1/spots?order_id=eq.${orderId}&status=in.(held,pending)&select=image_path`));
  await sb(env, `/rest/v1/spots?order_id=eq.${orderId}&status=in.(held,pending)`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  await sb(env, `/rest/v1/orders?id=eq.${orderId}&status=in.(${statusList})`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'expired', decided_at: new Date().toISOString() }),
  });
  const paths = (Array.isArray(spots) ? spots : []).map(s => s.image_path).filter(Boolean);
  if (paths.length)
    await sb(env, '/storage/v1/object/pixels', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) });
}

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  if (!(await verify(env, raw, request.headers.get('stripe-signature'))))
    return new Response('bad signature', { status: 400 });

  let event;
  try { event = JSON.parse(raw); } catch (e) { return new Response('bad body', { status: 400 }); }
  const obj = (event.data && event.data.object) || {};

  try {
    if (event.type === 'checkout.session.completed') {
      const orderId = Number(obj.metadata && obj.metadata.order_id);
      if (!Number.isInteger(orderId)) return ok('no order');
      const piId = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent && obj.payment_intent.id;
      if (!piId) return ok('no payment');
      const pi = await readJson(await stripe(env, `/payment_intents/${encodeURIComponent(piId)}`));
      if (!pi || pi.status !== 'requires_capture') return ok('not authorized');

      // Move the order from "checkout" to "pending". If it's no longer in checkout (it expired and the
      // spots were freed), release the card hold so the buyer isn't left with money on hold.
      const upd = await sb(env, `/rest/v1/orders?id=eq.${orderId}&status=eq.checkout`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
        body: JSON.stringify({ status: 'pending', stripe_payment_intent_id: piId, stripe_session_id: obj.id, paid_at: new Date().toISOString() }),
      });
      const rows = await readJson(upd);
      if (!Array.isArray(rows) || !rows.length) {
        const cur = await readJson(await sb(env, `/rest/v1/orders?id=eq.${orderId}&select=status,stripe_payment_intent_id`));
        const st = Array.isArray(cur) && cur[0] ? cur[0].status : null;
        if (st === 'pending' || st === 'approved') return ok('already done'); // Stripe sent it twice
        await stripe(env, `/payment_intents/${encodeURIComponent(piId)}/cancel`, { method: 'POST' });
        return ok('order gone, hold released');
      }
      await sb(env, `/rest/v1/spots?order_id=eq.${orderId}&status=eq.held`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'pending' }),
      });
      return ok('pending');
    }

    if (event.type === 'checkout.session.expired') {
      const orderId = Number(obj.metadata && obj.metadata.order_id);
      if (Number.isInteger(orderId)) await freeOrder(env, orderId, ['checkout']);
      return ok('expired');
    }

    if (event.type === 'payment_intent.canceled') {
      const orderId = Number(obj.metadata && obj.metadata.order_id);
      if (Number.isInteger(orderId)) await freeOrder(env, orderId, ['checkout', 'pending']);
      return ok('canceled');
    }

    return ok('ignored');
  } catch (e) {
    // A 500 makes Stripe retry later, which is what we want if Supabase hiccups.
    return new Response('error', { status: 500 });
  }
}
