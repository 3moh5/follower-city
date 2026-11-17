// server.js - خادم مدينة المتابعين
// التشغيل: node server.js   (يتطلب Node 18 أو أحدث، بدون أي حزم إضافية)
//
// متغيرات البيئة:
//   PORT            منفذ الخادم (الافتراضي 3000)
//   ADMIN_KEY       مفتاح المدير لحفظ تخطيط القرية من الموقع (اجعله طويلاً وسرياً)
//   IG_USER_ID      معرّف حساب إنستغرام المهني (Instagram Business/Creator account ID)
//   IG_TOKEN        رمز الوصول (Access Token) من Meta
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
const IG_USER_ID = process.env.IG_USER_ID || '';
const IG_TOKEN = process.env.IG_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const APP_SECRET = process.env.APP_SECRET || '';
const POLL_SECONDS = +process.env.POLL_SECONDS || 120;
const MEDIA_LIMIT = +process.env.MEDIA_LIMIT || 12;
const ANON_HOUSES = process.env.ANON_HOUSES === '1'; // بيوت مجهولة للمتابعين الصامتين (معطلة افتراضياً)
const GRAPH = 'https://graph.instagram.com/v21.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

let db = { igUser: '', followers: null, villagers: {}, layout: null, seen: {}, updated: 0, baseline: null, anonSeq: 0, claims: {}, token: '', tokenSrc: '', tokenAt: 0 };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
// الرمز: يُستخدم الرمز المجدَّد المحفوظ ما لم تضع رمزاً جديداً في المتغيرات
if (db.tokenSrc !== IG_TOKEN) { db.token = IG_TOKEN; db.tokenSrc = IG_TOKEN; db.tokenAt = Date.now(); }
let TOKEN = db.token || IG_TOKEN;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), () => {});
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

async function graph(pathAndQuery) {
  if (pathAndQuery.startsWith('http')) {
    const r0 = await fetch(pathAndQuery);
    const j0 = await r0.json();
    if (!r0.ok) throw new Error(j0 && j0.error ? j0.error.message : `HTTP ${r0.status}`);
    return j0;
  }
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const r = await fetch(`${GRAPH}${pathAndQuery}${sep}access_token=${encodeURIComponent(TOKEN)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j && j.error ? j.error.message : `HTTP ${r.status}`);
  return j;
}

let lastPollError = '';
async function poll() {
  if (!IG_USER_ID || !TOKEN) return;
  try {
    const me = await graph(`/${IG_USER_ID}?fields=username,followers_count`);
    db.igUser = me.username || db.igUser;
    if (typeof me.followers_count === 'number') {
      db.followers = me.followers_count;
      if (db.baseline === null) db.baseline = me.followers_count; // أول تشغيل: لا نبني بيوتاً للقدامى
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
    const media = await graph(`/${IG_USER_ID}/media?fields=id&limit=${MEDIA_LIMIT}`);
    for (const m of media.data || []) {
      let url = `/${m.id}/comments?fields=id,username,timestamp&limit=100`;
      for (let page = 0; page < 5 && url; page++) {
        const c = await graph(url);
        for (const it of c.data || []) addComment(it.username, it.id, it.timestamp);
        url = c.paging && c.paging.next ? c.paging.next : null;
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
  if (!TOKEN || Date.now() - db.tokenAt < 7 * 864e5) return;
  try {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(TOKEN)}`);
    const j = await r.json();
    if (r.ok && j.access_token) {
      TOKEN = j.access_token; db.token = TOKEN; db.tokenAt = Date.now();
      fs.writeFileSync(DATA_FILE, JSON.stringify(db));
      console.log('تم تجديد الرمز');
    } else console.error('refresh failed:', j && j.error ? j.error.message : r.status);
  } catch (e) { console.error('refresh error:', e.message); }
}
setInterval(poll, POLL_SECONDS * 1000);
setInterval(refreshToken, 6 * 3600 * 1000);
refreshToken();
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

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, {
      igUser: db.igUser,
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
