// Pixel Purchase · POST /api/checkout
// Runs on Cloudflare (not in the browser). It:
//   1. checks who is buying (their sign-in), their age rules, and how many checkouts they have open
//   2. re-checks every spot and works out the price HERE, so nobody can change the price in their browser
//   3. saves pictures to Supabase storage
//   4. creates the order and holds the spots for 35 minutes (all or nothing)
//   5. opens a Stripe payment page that only CHECKS the card (manual capture); you charge it on approval
// Secret keys come from Cloudflare > Settings > Variables and secrets. They never reach the browser.

const PRICES = { 1: 149, 2: 500, 5: 2900, 10: 11000 }; // cents. Must match PRICES in index.html.
const WALL = 1000;
const MAX_ITEMS = 25;               // spots per checkout
const MAX_OPEN = 3;                 // unfinished checkouts per person
const MAX_IMG = 512 * 1024;         // per picture (matches the storage limit)
const MAX_IMG_TOTAL = 3 * 1024 * 1024;

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// Supabase with the secret key. New sb_secret_ keys go in the apikey header only.
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

function decodeBase64(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function removeFiles(env, paths) {
  if (!paths.length) return;
  try {
    await sb(env, '/storage/v1/object/pixels', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths }),
    });
  } catch (e) {}
}

async function releaseOrder(env, orderId) {
  try {
    await sb(env, `/rest/v1/spots?order_id=eq.${orderId}&status=eq.held`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    await sb(env, `/rest/v1/orders?id=eq.${orderId}&status=eq.checkout`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'expired' }),
    });
  } catch (e) {}
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.STRIPE_SECRET_KEY)
      return json({ error: 'Checkout is not set up yet.' }, 500);

    const user = await getUser(env, request);
    if (!user) return json({ error: 'Please sign in again, then try once more.' }, 401);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json({ error: 'Your cart is empty.' }, 400);
    if (items.length > MAX_ITEMS) return json({ error: `Check out up to ${MAX_ITEMS} spots at a time.` }, 400);

    // Account rules (age group lives in a private table only the server can read here).
    const pv = await readJson(await sb(env, `/rest/v1/account_private?user_id=eq.${user.id}&select=age_group,banned`));
    if (!Array.isArray(pv) || !pv[0]) return json({ error: 'Your profile isn’t finished. Sign out and back in.' }, 403);
    if (pv[0].banned) return json({ error: 'This account can’t buy spots right now.' }, 403);
    if (pv[0].age_group === 'teen' && body.parentOk !== true)
      return json({ error: 'A parent or guardian’s OK is needed for this order.' }, 403);

    // Don't let one person tie up lots of spots with unfinished checkouts.
    const open = await readJson(await sb(env,
      `/rest/v1/orders?buyer_id=eq.${user.id}&status=eq.checkout&hold_expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id`));
    if (Array.isArray(open) && open.length >= MAX_OPEN)
      return json({ error: 'You already have a few checkouts open. Finish or cancel one, or wait about 35 minutes.' }, 429);

    // Re-check every spot and price it here.
    let total = 0, imgBytes = 0;
    const clean = [], uploads = [];
    for (const it of items) {
      const x = Number(it.x), y = Number(it.y), size = Number(it.size);
      if (!Number.isInteger(x) || !Number.isInteger(y) || !PRICES[size] || x < 0 || y < 0 || x + size > WALL || y + size > WALL)
        return json({ error: 'One of your spots doesn’t fit on the wall.' }, 400);
      const caption = typeof it.caption === 'string' ? it.caption.trim().slice(0, 40) : '';
      const row = { x, y, size, kind: it.kind, caption };
      if (it.kind === 'color') {
        if (!/^#[0-9a-fA-F]{6}$/.test(it.color || '')) return json({ error: 'Pick a color for every color spot.' }, 400);
        row.color = it.color;
      } else if (it.kind === 'draw' || it.kind === 'image') {
        const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(it.image || '');
        if (!m) return json({ error: 'One of your pictures couldn’t be read. Try a JPG or PNG.' }, 400);
        const bytes = decodeBase64(m[3]);
        imgBytes += bytes.length;
        if (bytes.length > MAX_IMG || imgBytes > MAX_IMG_TOTAL) return json({ error: 'Your pictures are too big. Try fewer or smaller ones.' }, 400);
        const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
        uploads.push({ path, bytes, type: m[1] });
        row.image_path = path;
      } else {
        return json({ error: 'One of your spots is missing its design.' }, 400);
      }
      clean.push(row);
      total += PRICES[size];
    }
    for (let i = 0; i < clean.length; i++)
      for (let j = i + 1; j < clean.length; j++) {
        const a = clean[i], b = clean[j];
        if (a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size)
          return json({ error: 'Two spots in your cart overlap. Remove one.' }, 400);
      }

    // Save pictures.
    const saved = [];
    for (const u of uploads) {
      const r = await sb(env, `/storage/v1/object/pixels/${u.path}`, {
        method: 'POST', headers: { 'content-type': u.type, 'x-upsert': 'false', 'cache-control': '31536000' }, body: u.bytes,
      });
      if (!r.ok) { await removeFiles(env, saved); return json({ error: 'A picture couldn’t be saved. Try again.' }, 502); }
      saved.push(u.path);
    }

    // Create the order and hold the spots (the database refuses taken spots).
    const r = await sb(env, '/rest/v1/rpc/pp_start_order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_buyer: user.id, p_items: clean, p_amount_cents: total }),
    });
    if (!r.ok) {
      await removeFiles(env, saved);
      const t = await r.text();
      if (/no_double_sell|exclusion|23P01/i.test(t))
        return json({ error: 'One of your spots was just taken. Remove it and pick another.', code: 'taken' }, 409);
      if (/pp_text_ok|check constraint|23514/i.test(t))
        return json({ error: 'A caption can’t be used. Try different words.' }, 400);
      return json({ error: 'Couldn’t start your order. Try again.' }, 502);
    }
    const orderId = await readJson(r);
    if (!Number.isInteger(orderId)) { await removeFiles(env, saved); return json({ error: 'Couldn’t start your order. Try again.' }, 502); }

    // Stripe payment page: card is checked now, charged only when you approve.
    const origin = new URL(request.url).origin;
    const f = new URLSearchParams();
    f.set('mode', 'payment');
    f.set('client_reference_id', String(orderId));
    f.set('success_url', `${origin}/?paid=${orderId}#wall`);
    f.set('cancel_url', `${origin}/?canceled=${orderId}#wall`);
    f.set('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60)); // spots are held 35 minutes
    if (user.email) f.set('customer_email', user.email);
    f.set('metadata[order_id]', String(orderId));
    f.set('payment_intent_data[capture_method]', 'manual');
    f.set('payment_intent_data[metadata][order_id]', String(orderId));
    f.set('payment_intent_data[description]', `Pixel Purchase order ${orderId}`);
    clean.forEach((c, i) => {
      f.set(`line_items[${i}][quantity]`, '1');
      f.set(`line_items[${i}][price_data][currency]`, 'usd');
      f.set(`line_items[${i}][price_data][unit_amount]`, String(PRICES[c.size]));
      f.set(`line_items[${i}][price_data][product_data][name]`,
        c.size === 1 ? `Pixel at column ${c.x + 1}, row ${c.y + 1}` : `${c.size}×${c.size} block at column ${c.x + 1}, row ${c.y + 1}`);
    });
    const sr = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `pp-order-${orderId}` },
      body: f,
    });
    const s = (await readJson(sr)) || {};
    if (!sr.ok || !s.url) {
      await releaseOrder(env, orderId);
      await removeFiles(env, saved);
      return json({ error: 'The payment page couldn’t open. Try again.' }, 502);
    }
    await sb(env, `/rest/v1/orders?id=eq.${orderId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ stripe_session_id: s.id }),
    });
    return json({ url: s.url, order: orderId });
  } catch (e) {
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
}
