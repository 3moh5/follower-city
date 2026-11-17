// server.js - خادم مدينة المتابعين
// التشغيل: node server.js   (يتطلب Node 18 أو أحدث، بدون أي حزم إضافية)
//
// متغيرات البيئة:
//   PORT            منفذ الخادم (الافتراضي 3000)
//   ADMIN_KEY       مفتاح المدير لحفظ تخطيط القرية من الموقع (اجعله طويلاً وسرياً)
//   IG_APP_ID       Meta App ID
//   IG_APP_SECRET   Meta App Secret
//   IG_CONFIG_ID    Configuration ID من API setup with Unified Login
//   IG_REDIRECT_URI عنوان callback المسجل حرفياً في Meta
//   IG_USER_ID      اختياري: معرّف حساب Instagram إذا لم يتم اكتشافه تلقائياً
//   VERIFY_TOKEN    كلمة تحقق تختارها لإعداد Webhook
//   APP_SECRET      سر تطبيق Meta للتحقق من توقيع الـ Webhook (موصى به)
//   POLL_SECONDS    كل كم ثانية يقرأ التعليقات (الافتراضي 120)
//   MEDIA_LIMIT     عدد آخر المنشورات التي تُفحص (الافتراضي 12)
//
// ما الذي تتيحه واجهة إنستغرام الرسمية؟
//   - عدد المتابعين (followers_count): نعم.
//   - من علّق ونص التعليق: نعم (للحسابات المهنية).
//   - قائمة المتابعين بالأسماء: لا. لهذا يوجد استيراد ملف المتابعين في لوحة التحكم.
//   - من وضع إعجاباً بالاسم: لا. يظهر فقط عدد الإعجابات الإجمالي لكل منشور.
//   لذلك يُبنى البيت تلقائياً لكل من يعلّق، ويُضاف المتابعون الآخرون من ملف التصدير أو يدوياً.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const IG_APP_ID = process.env.IG_APP_ID || process.env.META_APP_ID || '';
const IG_APP_SECRET = process.env.IG_APP_SECRET || process.env.META_APP_SECRET || '';
const IG_CONFIG_ID = process.env.IG_CONFIG_ID || process.env.META_CONFIG_ID || '';
const IG_REDIRECT_URI = process.env.IG_REDIRECT_URI || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost'}/auth/instagram/callback`;
const IG_BUSINESS_ID = process.env.IG_BUSINESS_ID || '';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const APP_SECRET = process.env.APP_SECRET || IG_APP_SECRET;
const POLL_SECONDS = +process.env.POLL_SECONDS || 120;
const MEDIA_LIMIT = +process.env.MEDIA_LIMIT || 12;
const ANON_HOUSES = process.env.ANON_HOUSES === '1';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

let db = { igUser: '', igUserId: '', followers: null, villagers: {}, layout: null, seen: {}, updated: 0, baseline: null, anonSeq: 0, claims: {}, token: '', tokenAt: 0, tokenExpiresAt: null, oauthStates: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
let IG_USER_ID = (/^\d{5,}$/.test(process.env.IG_USER_ID || '') ? process.env.IG_USER_ID : '') || db.igUserId || '';
const legacyToken = (process.env.IG_TOKEN || '').length > 50 ? process.env.IG_TOKEN : '';
const storedToken = typeof db.token === 'string' && db.token.length > 50 ? db.token : '';
let TOKEN = legacyToken || storedToken || '';
if (legacyToken && db.token !== legacyToken) { db.token = legacyToken; db.tokenAt = Date.now(); }
else if (!storedToken) { db.token = ''; }
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFile(DATA_FILE, JSON.stringify(db), () => {});
    } catch (e) { console.error('data save error:', e.message); }
  }, 300);
}

const norm = (u) => String(u || '').trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9._]/g, '');

function addComment(username, commentId, timestamp) {
  const u = norm(username);
  if (!u || u === norm(db.igUser)) return false;
  if (commentId) {
    if (db.seen[commentId]) return false;
    db.seen[commentId] = 1;
  }
  let v = db.villagers[u];
  if (!v) {
    v = db.villagers[u] = {
      username: u, name: u, comments: 0, likes: 0,
      since: timestamp ? Date.parse(timestamp) || Date.now() : Date.now(),
    };
    // إن وُجد بيت مجهول غير مطالَب به، يصبح هذا الشخص صاحبه
    const anon = Object.values(db.villagers).filter((x) => x.anon).sort((a, b) => a.since - b.since)[0];
    if (anon) { db.claims[anon.username] = u; v.since = anon.since; delete db.villagers[anon.username]; }
  }
  v.comments += 1;
  db.updated = Date.now();
  return true;
}

async function graph(pathAndQuery, token = TOKEN) {
  const target = pathAndQuery.startsWith('http') ? pathAndQuery : `${GRAPH}${pathAndQuery}`;
  const u = new URL(target);
  if (token) u.searchParams.set('access_token', token);
  const r = await fetch(u, { headers: { Accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j && j.error ? j.error.message : `Graph API HTTP ${r.status}`);
  return j;
}

async function discoverInstagramAccounts(token) {
  const found = [];
  const tryEdge = async (edge) => {
    try {
      const j = await graph(edge, token);
      for (const a of j.data || []) {
        const id = String(a.id || '');
        if (id && !found.some(x => x.id === id)) found.push({ id, username: a.username || '', followers_count: a.followers_count });
      }
    } catch (e) { console.warn('Instagram account discovery:', e.message); }
  };
  await tryEdge('/me/assigned_instagram_accounts?fields=id,username,followers_count&limit=100');
  if (IG_BUSINESS_ID) {
    await tryEdge(`/${encodeURIComponent(IG_BUSINESS_ID)}/owned_instagram_accounts?fields=id,username,followers_count&limit=100`);
    await tryEdge(`/${encodeURIComponent(IG_BUSINESS_ID)}/assigned_instagram_accounts?fields=id,username,followers_count&limit=100`);
  }
  if (!found.length) {
    try {
      const pages = await graph('/me/accounts?fields=id,name,instagram_business_account{id,username,followers_count}&limit=100', token);
      for (const p of pages.data || []) {
        const a = p.instagram_business_account;
        if (a && a.id && !found.some(x => x.id === String(a.id))) found.push({ id: String(a.id), username: a.username || '', followers_count: a.followers_count });
      }
    } catch (e) { console.warn('Instagram Page discovery:', e.message); }
  }
  return found;
}

let lastPollError = '';
async function poll() {
  if (!IG_USER_ID || !TOKEN) return;
  try {
    const me = await graph(`/${encodeURIComponent(IG_USER_ID)}?fields=id,username,followers_count`);
    db.igUserId = String(me.id || IG_USER_ID);
    db.igUser = me.username || db.igUser;
    if (typeof me.followers_count === 'number') {
      db.followers = me.followers_count;
      if (db.baseline === null) db.baseline = me.followers_count;
      const delta = me.followers_count - db.baseline;
      if (ANON_HOUSES && delta > 0) {
        for (let i = 0; i < Math.min(delta, 50); i++) {
          const n = ++db.anonSeq;
          const u = 'follower.' + n;
          db.villagers[u] = { username: u, name: 'متابع جديد ' + n, comments: 0, likes: 0, since: Date.now() + i, anon: true };
        }
      }
      db.baseline = me.followers_count;
    }
    const media = await graph(`/${encodeURIComponent(IG_USER_ID)}/media?fields=id&limit=${MEDIA_LIMIT}`);
    for (const m of media.data || []) {
      let next = `/${m.id}/comments?fields=id,username,timestamp&limit=100`;
      for (let page = 0; page < 5 && next; page++) {
        const c = await graph(next);
        for (const it of c.data || []) addComment(it.username || (it.from && it.from.username), it.id, it.timestamp);
        next = c.paging && c.paging.next ? c.paging.next : null;
      }
    }
    db.updated = Date.now();
    lastPollError = '';
    save();
  } catch (e) {
    lastPollError = String(e.message || e);
    console.error('poll error:', lastPollError);
  }
}
async function refreshToken() {
  // Unified Login system-user tokens can be configured as non-expiring.
  // If Meta supplies an expiry, request reconnection rather than using the legacy IG refresh endpoint.
  if (TOKEN && db.tokenExpiresAt && db.tokenExpiresAt - Date.now() <= 7 * 864e5) {
    console.warn('Instagram token is near expiry; reconnect from the dashboard.');
  }
}
setInterval(poll, POLL_SECONDS * 1000);
setInterval(refreshToken, 6 * 3600 * 1000);
poll();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function send(res, code, obj, type) {
  cors(res);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  // Meta Unified Login OAuth start: config_id replaces the legacy scope list.
  if (url.pathname === '/auth/instagram' && req.method === 'GET') {
    if (!IG_APP_ID || !IG_APP_SECRET || !IG_CONFIG_ID || !IG_REDIRECT_URI || IG_REDIRECT_URI.includes('localhost')) {
      return send(res, 500, { error: 'Set IG_APP_ID, IG_APP_SECRET, IG_CONFIG_ID and a public HTTPS IG_REDIRECT_URI in Railway.' });
    }
    const state = crypto.randomBytes(32).toString('hex');
    db.oauthStates = db.oauthStates || {};
    db.oauthStates[state] = Date.now() + 10 * 60 * 1000;
    save();
    const auth = new URL('https://www.facebook.com/dialog/oauth');
    auth.searchParams.set('client_id', IG_APP_ID);
    auth.searchParams.set('config_id', IG_CONFIG_ID);
    auth.searchParams.set('redirect_uri', IG_REDIRECT_URI);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('state', state);
    auth.searchParams.set('override_default_response_type', 'true');
    auth.searchParams.set('auth_type', 'rerequest');
    res.writeHead(302, { Location: auth.toString(), 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname === '/auth/instagram/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    const validUntil = db.oauthStates && db.oauthStates[state];
    if (!state || !validUntil || validUntil < Date.now()) return send(res, 400, { error: 'OAuth state invalid or expired. Start again.' });
    delete db.oauthStates[state];
    save();
    if (url.searchParams.get('error')) {
      const why = url.searchParams.get('error_description') || url.searchParams.get('error');
      res.writeHead(302, { Location: '/?instagram=denied&reason=' + encodeURIComponent(why), 'Cache-Control': 'no-store' });
      return res.end();
    }
    const code = (url.searchParams.get('code') || '').replace(/#_$/, '');
    if (!code) return send(res, 400, { error: 'Meta did not return an authorization code.' });
    try {
      const exchange = new URL(`${GRAPH}/oauth/access_token`);
      exchange.searchParams.set('client_id', IG_APP_ID);
      exchange.searchParams.set('client_secret', IG_APP_SECRET);
      exchange.searchParams.set('redirect_uri', IG_REDIRECT_URI);
      exchange.searchParams.set('code', code);
      const tokenResponse = await fetch(exchange, { headers: { Accept: 'application/json' } });
      const tokenData = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) {
        throw new Error(tokenData.error && tokenData.error.message || `Token exchange failed (${tokenResponse.status})`);
      }
      TOKEN = tokenData.access_token;
      db.token = TOKEN;
      db.tokenAt = Date.now();
      db.tokenExpiresAt = Number(tokenData.expires_in) > 0 ? Date.now() + Number(tokenData.expires_in) * 1000 : null;
      // Do not silently keep an old account ID after a user authorizes a different asset.
      IG_USER_ID = '';
      db.igUserId = '';
      const accounts = await discoverInstagramAccounts(TOKEN);
      if (accounts.length === 1) {
        IG_USER_ID = accounts[0].id;
        db.igUserId = IG_USER_ID;
        db.igUser = accounts[0].username || db.igUser;
        if (typeof accounts[0].followers_count === 'number') db.followers = accounts[0].followers_count;
      } else if (accounts.length > 1) {
        db.availableInstagramAccounts = accounts;
      }
      save();
      if (IG_USER_ID) await poll();
      const result = accounts.length > 1 ? 'choose_account' : (IG_USER_ID ? 'connected' : 'connected_needs_account');
      res.writeHead(302, { Location: '/?instagram=' + result, 'Cache-Control': 'no-store' });
      return res.end();
    } catch (e) {
      console.error('Instagram OAuth callback:', e.message);
      res.writeHead(302, { Location: '/?instagram=error&reason=' + encodeURIComponent(e.message), 'Cache-Control': 'no-store' });
      return res.end();
    }
  }

  if (url.pathname === '/api/instagram/status' && req.method === 'GET') {
    return send(res, 200, {
      configured: Boolean(IG_APP_ID && IG_APP_SECRET && IG_CONFIG_ID && IG_REDIRECT_URI && !IG_REDIRECT_URI.includes('localhost')),
      connected: Boolean(TOKEN),
      accountId: IG_USER_ID || db.igUserId || '',
      username: db.igUser || '',
      accounts: db.availableInstagramAccounts || [],
      followers: db.followers,
      error: lastPollError || ''
    });
  }

  if (url.pathname === '/api/instagram/select' && req.method === 'POST') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const requestedId = String(body.id || '');
      const selected = (db.availableInstagramAccounts || []).find(a => a.id === requestedId)
        || (/^\\d{5,}$/.test(requestedId) ? { id: requestedId, username: '' } : null);
      if (!selected) return send(res, 400, { error: 'Choose a discovered account or enter a numeric Instagram account ID.' });
      IG_USER_ID = selected.id;
      db.igUserId = selected.id;
      db.igUser = selected.username || db.igUser || '';
      delete db.availableInstagramAccounts;
      db.baseline = null;
      save();
      await poll();
      return send(res, 200, { ok: true, username: db.igUser, accountId: IG_USER_ID });
    } catch (e) { return send(res, 400, { error: 'bad json' }); }
  }


  if (url.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, {
      igUser: db.igUser,
      igUserId: IG_USER_ID || db.igUserId,
      instagramConnected: Boolean(TOKEN),
      followers: db.followers,
      villagers: Object.values(db.villagers),
      layout: db.layout,
      claims: db.claims,
      updated: db.updated,
      error: lastPollError || undefined,
    });
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
    await poll();
    return send(res, 200, { ok: true, error: lastPollError || undefined });
  }

  if (url.pathname === '/api/layout' && req.method === 'POST') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      db.layout = { plots: body.plots || {}, districts: body.districts || {}, villagers: body.villagers || {} };
      save();
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 400, { error: 'bad json' }); }
  }

  if (url.pathname === '/api/add' && req.method === 'POST') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const names = Array.isArray(body.usernames) ? body.usernames : [];
      let n = 0;
      for (const raw of names) {
        const u = norm(raw);
        if (u && !db.villagers[u]) { db.villagers[u] = { username: u, name: u, comments: 0, likes: 0, since: Date.now() }; n++; }
      }
      db.updated = Date.now(); save();
      return send(res, 200, { added: n });
    } catch (e) { return send(res, 400, { error: 'bad json' }); }
  }

  // Meta Webhook: التحقق
  if (url.pathname === '/webhook' && req.method === 'GET') {
    if (url.searchParams.get('hub.mode') === 'subscribe' && VERIFY_TOKEN && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
      cors(res); res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(url.searchParams.get('hub.challenge') || '');
    }
    return send(res, 403, 'forbidden', 'text/plain');
  }

  // Meta Webhook: استقبال التعليقات لحظياً
  if (url.pathname === '/webhook' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      if (APP_SECRET) {
        const sig = String(req.headers['x-hub-signature-256'] || '').replace('sha256=', '');
        const exp = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
        if (!sig || !safeEq(sig, exp)) return send(res, 403, 'bad signature', 'text/plain');
      }
      const body = JSON.parse(raw.toString('utf8'));
      for (const entry of body.entry || []) {
        for (const ch of entry.changes || []) {
          if (ch.field === 'comments' && ch.value && ch.value.from) {
            addComment(ch.value.from.username, ch.value.id, null);
          }
        }
      }
      save();
      return send(res, 200, 'ok', 'text/plain');
    } catch (e) { return send(res, 400, 'bad request', 'text/plain'); }
  }

  // تقديم صفحة اللعبة إن وُضع index.html بجانب الملف
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      cors(res); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) { return send(res, 404, 'index.html not found', 'text/plain'); }
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`مدينة المتابعين تعمل على http://localhost:${PORT}`));
