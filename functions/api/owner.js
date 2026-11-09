// Pixel Purchase · POST /api/owner
// Owner-only actions. Every request must come from:
//   1. a signed-in account with is_admin = true, AND
//   2. a passcode unlock that's still valid (the 8-hour token from the owner sign-in box).
// Both are checked HERE on the server every single time, so a faked screen can't do anything.
//
// Actions:
//   list      → orders waiting for approval (with pictures, captions, buyer), recent decisions, totals
//   approve   → charges the card (only for the spots you keep) and puts those spots live
//   decline   → releases the card hold (never charged), frees the spots, deletes the pictures
//   takedown  → removes a live spot that breaks the rules (no refund), frees it, deletes its picture

const PRICES = { 1: 149, 2: 500, 5: 2900, 10: 11000 }; // cents. Must match PRICES in index.html.

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const readJson = async r => { try { return await r.json(); } catch (e) { return null; } };
const sb = (env, path, init = {}) =>
  fetch(env.SUPABASE_URL + path, { ...init, headers: { apikey: env.SUPABASE_SECRET_KEY, ...(init.headers || {}) } });
const stripe = (env, path, init = {}) =>
  fetch('https://api.stripe.com/v1' + path, { ...init, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(init.headers || {}) } });
const nowIso = () => new Date().toISOString();
const isUuid = s => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);

async function getUser(env, request) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: env.SUPABASE_SECRET_KEY, authorization: auth } });
  if (!r.ok) return null;
  const u = await readJson(r);
  return u && u.id ? u : null;
}

async function isUnlockedOwner(env, userId, token) {
  if (!isUuid(userId) || !isUuid(token)) return false;
  const admin = await readJson(await sb(env, `/rest/v1/account_private?user_id=eq.${userId}&is_admin=is.true&select=user_id`));
  if (!Array.isArray(admin) || !admin.length) return false;
  const sess = await readJson(await sb(env,
    `/rest/v1/owner_sessions?token=eq.${token}&user_id=eq.${userId}&expires_at=gt.${encodeURIComponent(nowIso())}&select=token`));
  return Array.isArray(sess) && sess.length > 0;
}

async function deletePictures(env, paths) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  await sb(env, '/storage/v1/object/pixels', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: list }) });
}

async function getOrder(env, orderId) {
  const rows = await readJson(await sb(env,
    `/rest/v1/orders?id=eq.${orderId}&select=id,status,amount_cents,stripe_payment_intent_id,spots(id,size,status,image_path)`));
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function list(env) {
  const pending = await readJson(await sb(env,
    '/rest/v1/orders?status=eq.pending&order=paid_at.asc&limit=200' +
    '&select=id,buyer_id,amount_cents,paid_at,created_at,spots(id,x,y,size,kind,color,image_path,caption,founding,status)'));
  const recent = await readJson(await sb(env,
    '/rest/v1/orders?status=in.(approved,declined,expired)&order=decided_at.desc.nullslast&limit=40' +
    '&select=id,buyer_id,status,amount_cents,paid_at,decided_at,created_at'));
  const approved = await readJson(await sb(env, '/rest/v1/orders?status=eq.approved&select=amount_cents'));
  const live = await readJson(await sb(env, '/rest/v1/spots?status=eq.live&select=size'));

  const orders = Array.isArray(pending) ? pending : [];
  const done = Array.isArray(recent) ? recent : [];
  const buyerIds = [...new Set([...orders, ...done].map(o => o.buyer_id).filter(isUuid))];
  const people = {};
  if (buyerIds.length) {
    const ps = await readJson(await sb(env, `/rest/v1/profiles?id=in.(${buyerIds.join(',')})&select=id,handle,name`));
    (Array.isArray(ps) ? ps : []).forEach(p => { people[p.id] = { handle: p.handle, name: p.name }; });
    // Buyer emails (private; only you see them here).
    await Promise.all(buyerIds.slice(0, 50).map(async id => {
      const u = await readJson(await sb(env, `/auth/v1/admin/users/${id}`));
      if (u && u.email) people[id] = { ...(people[id] || {}), email: u.email };
    }));
  }
  return {
    pending: orders.map(o => ({ ...o, spots: (o.spots || []).filter(s => s.status === 'pending') })),
    recent: done,
    people,
    totals: {
      charged_cents: (Array.isArray(approved) ? approved : []).reduce((a, o) => a + (o.amount_cents || 0), 0),
      pixels_live: (Array.isArray(live) ? live : []).reduce((a, s) => a + s.size * s.size, 0),
    },
  };
}

async function approve(env, orderId, removeIds) {
  const o = await getOrder(env, orderId);
  if (!o) return json({ error: 'Order not found.' }, 404);
  if (o.status !== 'pending') return json({ error: `This order is already ${o.status}.` }, 409);
  if (!o.stripe_payment_intent_id) return json({ error: 'This order has no card hold.' }, 409);
  const spots = (o.spots || []).filter(s => s.status === 'pending');
  const remove = new Set((Array.isArray(removeIds) ? removeIds : []).map(Number));
  const keep = spots.filter(s => !remove.has(s.id));
  const drop = spots.filter(s => remove.has(s.id));
  if (!keep.length) return decline(env, orderId);

  const amount = keep.reduce((a, s) => a + PRICES[s.size], 0);
  const f = new URLSearchParams();
  if (amount < o.amount_cents) f.set('amount_to_capture', String(amount));
  const r = await stripe(env, `/payment_intents/${encodeURIComponent(o.stripe_payment_intent_id)}/capture`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `pp-capture-${orderId}-${amount}` },
    body: f,
  });
  const pi = await readJson(r);
  if (!r.ok || !pi || pi.status !== 'succeeded') {
    const msg = pi && pi.error && pi.error.code === 'payment_intent_unexpected_state'
      ? 'The card hold has expired or was canceled, so it can’t be charged. Decline this order.'
      : 'Stripe couldn’t charge the card. Try again in a minute.';
    return json({ error: msg }, 502);
  }

  const t = nowIso();
  await sb(env, `/rest/v1/spots?id=in.(${keep.map(s => s.id).join(',')})&status=eq.pending`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'live', live_at: t }),
  });
  if (drop.length) {
    await sb(env, `/rest/v1/spots?id=in.(${drop.map(s => s.id).join(',')})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    await deletePictures(env, drop.map(s => s.image_path));
  }
  await sb(env, `/rest/v1/orders?id=eq.${orderId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'approved', decided_at: t, amount_cents: amount }),
  });
  return json({ ok: true, charged_cents: amount, live: keep.length, removed: drop.length });
}

async function decline(env, orderId) {
  const o = await getOrder(env, orderId);
  if (!o) return json({ error: 'Order not found.' }, 404);
  if (o.status !== 'pending' && o.status !== 'checkout') return json({ error: `This order is already ${o.status}.` }, 409);
  if (o.stripe_payment_intent_id) {
    const r = await stripe(env, `/payment_intents/${encodeURIComponent(o.stripe_payment_intent_id)}/cancel`, { method: 'POST' });
    const pi = await readJson(r);
    if (!r.ok && !(pi && pi.error && pi.error.code === 'payment_intent_unexpected_state'))
      return json({ error: 'Stripe couldn’t release the card hold. Try again in a minute.' }, 502);
  }
  const spots = (o.spots || []).filter(s => s.status === 'pending' || s.status === 'held');
  if (spots.length)
    await sb(env, `/rest/v1/spots?id=in.(${spots.map(s => s.id).join(',')})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
  await sb(env, `/rest/v1/orders?id=eq.${orderId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'declined', decided_at: nowIso() }),
  });
  await deletePictures(env, spots.map(s => s.image_path));
  return json({ ok: true });
}

async function takedown(env, spotId) {
  const rows = await readJson(await sb(env, `/rest/v1/spots?id=eq.${spotId}&status=eq.live&select=id,image_path`));
  const s = Array.isArray(rows) && rows[0];
  if (!s) return json({ error: 'That spot isn’t live.' }, 404);
  await sb(env, `/rest/v1/spots?id=eq.${spotId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'removed', image_path: null, kind: 'color', color: '#000000', caption: null }),
  });
  await deletePictures(env, [s.image_path]);
  return json({ ok: true });
}

export async function onRequestPost({ request, env }) {
  try {
    const user = await getUser(env, request);
    if (!user) return json({ error: 'Please sign in again.', code: 'locked' }, 401);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    if (!(await isUnlockedOwner(env, user.id, body.token)))
      return json({ error: 'The owner panel is locked. Unlock it again.', code: 'locked' }, 403);

    const id = Number(body.order ?? body.spot);
    if (body.action === 'list') return json(await list(env));
    if (!Number.isInteger(id) || id <= 0) return json({ error: 'Bad request.' }, 400);
    if (body.action === 'approve') return approve(env, id, body.remove);
    if (body.action === 'decline') return decline(env, id);
    if (body.action === 'takedown') return takedown(env, id);
    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
}
