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
const CLAIM_WORD = (process.env.CLAIM_WORD || '').trim().toLowerCase();
const ANON_HOUSES = process.env.ANON_HOUSES === '1';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v25.0';
const GRAPH = `https://graph.instagram.com/${GRAPH_VERSION}`;
const GRAPH_FB = `https://graph.facebook.com/${GRAPH_VERSION}`;
const IG_CONFIG_ID = process.env.IG_CONFIG_ID || '';
const IG_REDIRECT_URI = process.env.IG_REDIRECT_URI || '';
const IG_APP_ID = process.env.IG_APP_ID || '';
const IG_APP_SECRET = process.env.IG_APP_SECRET || '';
const FB_APP_ID = process.env.FB_APP_ID || '';
const FB_APP_SECRET = process.env.FB_APP_SECRET || '';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

let db = {
  models: [],
  igUser: '',
  followers: null,
  villagers: {},
  layout: null,
  lifeSettings: {
    walkers: true,
    walkerCount: 22,
    walkerSpeed: 1,
    carCount: 12,
    carSpeed: 1,
    carMode: 'mixed',
    carColor: '#d94a38'
  },
  seen: {},
  updated: 0,
  baseline: null,
  anonSeq: 0,
  claims: {},
  token: '',
  tokenSrc: '',
  tokenAt: 0
};

try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch (e) {}

if (!Array.isArray(db.models)) db.models = [];

// إعدادات الحركة المشتركة التي يرسلها المدير وتصل إلى جميع الزوار.
const DEFAULT_LIFE_SETTINGS = {
  walkers: true,
  walkerCount: 22,
  walkerSpeed: 1,
  carCount: 12,
  carSpeed: 1,
  carMode: 'mixed',
  carColor: '#d94a38'
};

function cleanLifeSettings(input, current) {
  const result = Object.assign(
    {},
    DEFAULT_LIFE_SETTINGS,
    current || {}
  );

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return result;
  }

  if (typeof input.walkers === 'boolean') {
    result.walkers = input.walkers;
  }

  for (const key of ['walkerCount', 'carCount']) {
    if (input[key] !== undefined && Number.isFinite(Number(input[key]))) {
      result[key] = Math.max(
        0,
        Math.min(100, Math.round(Number(input[key])))
      );
    }
  }

  for (const key of ['walkerSpeed', 'carSpeed']) {
    if (input[key] !== undefined && Number.isFinite(Number(input[key]))) {
      result[key] = Math.max(
        0,
        Math.min(10, Number(input[key]))
      );
    }
  }

  if (input.carMode === 'mixed' || input.carMode === 'single') {
    result.carMode = input.carMode;
  }

  if (
    typeof input.carColor === 'string' &&
    /^#[0-9a-fA-F]{6}$/.test(input.carColor)
  ) {
    result.carColor = input.carColor;
  }

  return result;
}

db.lifeSettings = cleanLifeSettings(db.lifeSettings);

const MODEL_DIR = path.join(path.dirname(DATA_FILE), 'models');

try {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
} catch (e) {}

let saveTimer = null;

// الرمز: يُستخدم الرمز المجدَّد المحفوظ ما لم تضع رمزاً جديداً في المتغيرات
if (db.tokenSrc !== IG_TOKEN) {
  db.token = IG_TOKEN;
  db.tokenSrc = IG_TOKEN;
  db.tokenAt = Date.now();
  db.igId = '';
  db.fbExchangedFor = '';
  db.fbAt = 0;
  db.tokenKind = '';
}

let TOKEN = db.token || IG_TOKEN;

const isFb = () => (
  db.tokenKind
    ? (db.tokenKind === 'fb' || db.tokenKind === 'unified')
    : /^EA/.test(TOKEN)
);

const isUnified = () => db.tokenKind === 'unified';
const base = () => (isFb() ? GRAPH_FB : GRAPH);

let exchangeError = '';

function save() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), () => {});
  }, 300);
}

const norm = (u) =>
  String(u || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '');

function addComment(username, commentId, timestamp, text) {
  const u = norm(username);

  if (!u || u === norm(db.igUser)) return false;

  if (
    !db.villagers[u] &&
    CLAIM_WORD &&
    !String(text || '').toLowerCase().includes(CLAIM_WORD)
  ) {
    return false;
  }

  if (commentId) {
    if (db.seen[commentId]) return false;
    db.seen[commentId] = 1;
  }

  let v = db.villagers[u];

  if (!v) {
    v = db.villagers[u] = {
      username: u,
      name: u,
      comments: 0,
      likes: 0,
      since: timestamp
        ? Date.parse(timestamp) || Date.now()
        : Date.now(),
    };

    // إن وُجد بيت مجهول غير مطالَب به، يصبح هذا الشخص صاحبه
    const anon = Object.values(db.villagers)
      .filter((x) => x.anon)
      .sort((a, b) => a.since - b.since)[0];

    if (anon) {
      db.claims[anon.username] = u;
      v.since = anon.since;
      delete db.villagers[anon.username];
    }
  }

  v.comments += 1;
  db.updated = Date.now();

  return true;
}

// ---- توزيع البيوت على الخريطة من الخادم نفسه ----

const DIST = 4;

const hashS = (s) => {
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
};

function districtType(dx, dy) {
  const k = dx + ',' + dy;

  const ov =
    db.layout &&
    db.layout.districts &&
    db.layout.districts[k];

  if (ov && ov.type) return ov.type;
  if (dx === 0 && dy === 0) return 'residential';

  const r = hashS('d' + k) % 10;

  return r < 5
    ? 'residential'
    : r < 7
      ? 'farm'
      : r < 8
        ? 'industrial'
        : r < 9
          ? 'commercial'
          : 'park';
}

function* spiral() {
  yield [0, 0];

  for (let r = 1; r <= 60; r++) {
    for (let x = -r; x <= r; x++) yield [x, -r];
    for (let y = -r + 1; y <= r; y++) yield [r, y];
    for (let x = r - 1; x >= -r; x--) yield [x, r];
    for (let y = r - 1; y >= -r + 1; y--) yield [-r, y];
  }
}

function freePlot(plots) {
  for (const [x, y] of spiral()) {
    const k = x + ',' + y;

    if (plots[k]) continue;

    if (
      districtType(
        Math.floor(x / DIST),
        Math.floor(y / DIST)
      ) === 'residential'
    ) {
      return k;
    }
  }

  return null;
}

const DEMO_USERS = [
  'sara_art',
  'ahmed.m',
  'layla_daily',
  'omar.k',
  'noor_s',
  'yousef.99',
  'huda.z',
  'khaled_t',
  'maryam.q',
  'ali_r',
  'zainab.h',
  'hasan.b'
];

function purgeDemoPlots() {
  const L = db.layout;

  if (!L || !L.plots) return;

  Object.keys(L.plots).forEach((k) => {
    const o = L.plots[k].owner;

    if (o && DEMO_USERS.includes(o) && !db.villagers[o]) {
      delete L.plots[k];

      if (L.villagers) {
        delete L.villagers[o];
      }
    }
  });
}

function assignPlots() {
  purgeDemoPlots();

  if (!db.layout) {
    db.layout = {
      plots: {},
      districts: {},
      villagers: {}
    };
  }

  const L = db.layout;

  L.plots = L.plots || {};
  L.districts = L.districts || {};
  L.villagers = L.villagers || {};

  const owners = {};

  Object.keys(L.plots).forEach((k) => {
    if (L.plots[k].owner) {
      owners[L.plots[k].owner] = k;
    }
  });

  let changed = false;

  Object.values(db.villagers)
    .sort((a, b) =>
      (a.since - b.since) ||
      (a.username < b.username ? -1 : 1)
    )
    .forEach((v) => {
      if (owners[v.username]) return;

      const k = freePlot(L.plots);

      if (!k) return;

      L.plots[k] = {
        type: 'house',
        owner: v.username,
        level: 1,
        rot: 0,
        ox: 0,
        oz: 0,
        scale: 1,
        auto: true
      };

      owners[v.username] = k;

      L.villagers[v.username] = Object.assign(
        {},
        L.villagers[v.username],
        { plot: k }
      );

      changed = true;
    });

  if (changed) save();
}

async function graph(pathAndQuery) {
  if (pathAndQuery.startsWith('http')) {
    const r0 = await fetch(pathAndQuery);
    const j0 = await r0.json();

    if (!r0.ok) throw igErr(j0, r0.status);

    return j0;
  }

  const sep = pathAndQuery.includes('?') ? '&' : '?';

  const r = await fetch(
    `${base()}${pathAndQuery}${sep}access_token=${encodeURIComponent(TOKEN)}`
  );

  const j = await r.json();

  if (!r.ok) throw igErr(j, r.status);

  return j;
}

function igErr(j, status) {
  const e = new Error(
    j && j.error
      ? j.error.message
      : `HTTP ${status}`
  );

  e.code = j && j.error ? j.error.code : status;

  return e;
}

function hint(e) {
  const m = String(e.message || e);

  if (isFb() && e.code === 190) {
    return 'انتهى الرمز. رموز فيسبوك القصيرة تنتهي بعد ساعة تقريباً. ' +
      (
        FB_APP_ID && FB_APP_SECRET
          ? (exchangeError || 'ولّد رمزاً جديداً وضعه في IG_TOKEN.')
          : 'ضع FB_APP_ID وFB_APP_SECRET في المتغيرات ليحوّله الخادم إلى رمز مدته 60 يوماً.'
      );
  }

  if (e.code === 190 || /token|oauth|expired/i.test(m)) {
    return 'الرمز منتهٍ أو غير صحيح. ولّد رمزاً جديداً وضعه في IG_TOKEN.';
  }

  if (e.code === 10 || e.code === 200 || /permission/i.test(m)) {
    return 'ينقص الرمز صلاحية. ولّده من جديد ووافق على كل الصلاحيات (قراءة الحساب وإدارة التعليقات).';
  }

  if (e.code === 4 || e.code === 17 || /limit/i.test(m)) {
    return 'تجاوز حد الطلبات مؤقتاً. سيعاود الخادم المحاولة وحده.';
  }

  return '';
}

let IG_ID = db.igId || '';

async function igNode() {
  if (!isFb()) return 'me';
  if (IG_ID) return IG_ID;

  let found = null;

  if (isUnified()) {
    const assigned = await graph(
      '/me/assigned_instagram_accounts?fields=id,username&limit=100'
    );

    found = (assigned.data || []).find(
      (account) => account && account.id
    );

    if (found && found.id) {
      IG_ID = found.id;
      db.igId = IG_ID;

      if (found.username) {
        db.igUser = found.username;
      }

      save();

      return IG_ID;
    }

    throw new Error(
      'لم يعثر Meta على حساب Instagram مُسند إلى إعداد Unified Login. تأكد من اختيار حساب Instagram في التكوين ومنح الصلاحيات.'
    );
  }

  try {
    const acc = await graph(
      '/me/accounts?fields=name,instagram_business_account%7Bid,username%7D&limit=50'
    );

    found = (acc.data || [])
      .map((p) => p.instagram_business_account)
      .find(Boolean);

  } catch (e) {
    try {
      const pg = await graph(
        '/me?fields=instagram_business_account%7Bid,username%7D'
      );

      found = pg.instagram_business_account;

    } catch (e2) {
      if (!IG_USER_ID) throw e;
    }
  }

  if (found && found.id) {
    IG_ID = found.id;
  } else if (IG_USER_ID) {
    IG_ID = IG_USER_ID;
  } else {
    throw new Error(
      'لم أجد حساب إنستغرام مهنياً مرتبطاً بصفحة فيسبوك لهذا الرمز. اربط حسابك بصفحة فيسبوك، ووافق على صلاحيات الصفحات عند توليد الرمز.'
    );
  }

  db.igId = IG_ID;

  return IG_ID;
}

let lastPollError = '';

async function poll() {
  if (!TOKEN) {
    lastPollError = 'المتغير IG_TOKEN غير مضبوط في الخادم.';
    return;
  }

  try {
    const node = await igNode();

    const me = await graph(
      `/${node}?fields=username,followers_count`
    );

    db.igUser = me.username || db.igUser;

    if (typeof me.followers_count === 'number') {
      db.followers = me.followers_count;

      if (db.baseline === null) {
        db.baseline = me.followers_count;
      }

      const delta = me.followers_count - db.baseline;

      if (ANON_HOUSES && delta > 0) {
        for (let i = 0; i < Math.min(delta, 50); i++) {
          const n = ++db.anonSeq;
          const u = 'follower.' + n;

          db.villagers[u] = {
            username: u,
            name: 'متابع جديد ' + n,
            comments: 0,
            likes: 0,
            since: Date.now() + i,
            anon: true
          };
        }
      }

      db.baseline = me.followers_count;
    }

    const media = await graph(
      `/${node}/media?fields=id&limit=${MEDIA_LIMIT}`
    );

    for (const m of media.data || []) {
      let url =
        `/${m.id}/comments?fields=id,username,text,timestamp&limit=100`;

      for (let page = 0; page < 5 && url; page++) {
        const c = await graph(url);

        for (const it of c.data || []) {
          addComment(
            it.username,
            it.id,
            it.timestamp,
            it.text
          );
        }

        url = c.paging && c.paging.next
          ? c.paging.next
          : null;
      }
    }

    db.updated = Date.now();
    lastPollError = '';

    assignPlots();
    save();

  } catch (e) {
    lastPollError =
      String(e.message || e) +
      (hint(e) ? ' — ' + hint(e) : '');

    console.error('poll error:', lastPollError);
  }
}
async function exchangeFb() {
  if (!FB_APP_ID || !FB_APP_SECRET) return;

  if (
    db.fbExchangedFor === db.tokenSrc &&
    Date.now() - (db.fbAt || 0) < 30 * 864e5
  ) return;

  try {
    const u =
      `${GRAPH_FB}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${encodeURIComponent(FB_APP_ID)}` +
      `&client_secret=${encodeURIComponent(FB_APP_SECRET)}` +
      `&fb_exchange_token=${encodeURIComponent(TOKEN)}`;

    const r = await fetch(u);
    const j = await r.json();

    if (r.ok && j.access_token) {
      TOKEN = j.access_token;
      db.token = TOKEN;
      db.tokenAt = Date.now();
      db.fbExchangedFor = db.tokenSrc;
      db.fbAt = Date.now();
      exchangeError = '';

      fs.writeFileSync(DATA_FILE, JSON.stringify(db));
      console.log('تم تحويل الرمز إلى رمز طويل الأمد');

    } else {
      exchangeError =
        'فشل تحويل الرمز إلى طويل الأمد: ' +
        (j && j.error ? j.error.message : r.status) +
        ' (تحقق من FB_APP_ID وFB_APP_SECRET)';

      console.error(exchangeError);
    }

  } catch (e) {
    exchangeError = 'تعذر تحويل الرمز: ' + e.message;
    console.error(exchangeError);
  }
}

async function refreshToken() {
  if (!TOKEN) return;
  if (isUnified()) return;
  if (isFb()) return exchangeFb();

  if (Date.now() - db.tokenAt < 7 * 864e5) return;

  try {
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(TOKEN)}`
    );

    const j = await r.json();

    if (r.ok && j.access_token) {
      TOKEN = j.access_token;
      db.token = TOKEN;
      db.tokenAt = Date.now();

      fs.writeFileSync(DATA_FILE, JSON.stringify(db));
      console.log('تم تجديد الرمز');

    } else {
      console.error(
        'refresh failed:',
        j && j.error ? j.error.message : r.status
      );
    }

  } catch (e) {
    console.error('refresh error:', e.message);
  }
}

setInterval(poll, POLL_SECONDS * 1000);
setInterval(refreshToken, 6 * 3600 * 1000);

refreshToken().finally(poll);

// ---- الربط المباشر (Instagram Business Login) ----

const oauthStates = new Map();

function newState(redirect) {
  const st = crypto.randomBytes(16).toString('hex');
  const now = Date.now();

  for (const [k, v] of oauthStates) {
    if (v.exp < now) oauthStates.delete(k);
  }

  oauthStates.set(st, {
    redirect,
    exp: now + 10 * 60e3
  });

  return st;
}

async function connectWithCode(code, redirect) {
  const u =
    `${GRAPH_FB}/oauth/access_token?` +
    new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: IG_APP_SECRET,
      redirect_uri: redirect,
      code: String(code).replace(/#_$/, ''),
    });

  const r = await fetch(u);
  const j = await r.json();

  if (!r.ok || !j.access_token) {
    throw new Error(
      (j.error && j.error.message) ||
      `فشل تبادل رمز Unified Login (HTTP ${r.status})`
    );
  }

  TOKEN = j.access_token;
  db.token = TOKEN;
  db.tokenSrc = IG_TOKEN;
  db.tokenAt = Date.now();
  db.tokenKind = 'unified';
  db.igId = '';
  IG_ID = '';
  db.igUser = '';
  db.fbExchangedFor = '';
  db.fbAt = 0;
  exchangeError = '';

  fs.writeFileSync(DATA_FILE, JSON.stringify(db));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-admin-key'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS'
  );
}

function send(res, code, obj, type) {
  cors(res);

  res.writeHead(code, {
    'Content-Type':
      type || 'application/json; charset=utf-8'
  });

  res.end(
    typeof obj === 'string'
      ? obj
      : JSON.stringify(obj)
  );
}

function readBody(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (c) => {
      size += c.length;

      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));

  return (
    x.length === y.length &&
    crypto.timingSafeEqual(x, y)
  );
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  // حالة القرية العامة، بما فيها إعدادات حركة السيارات والمشاة
  if (
    url.pathname === '/api/state' &&
    req.method === 'GET'
  ) {
    return send(res, 200, {
      igUser: db.igUser,
      followers: db.followers,
      villagers: Object.values(db.villagers),
      layout: db.layout,
      lifeSettings: db.lifeSettings,
      claims: db.claims,
      models: db.models,
      hasToken: !!TOKEN,
      canConnect: !!(
        IG_APP_ID &&
        IG_APP_SECRET &&
        IG_CONFIG_ID &&
        IG_REDIRECT_URI
      ),
      redirectUri: IG_REDIRECT_URI,
      tokenType: isUnified()
        ? 'unified'
        : (isFb() ? 'facebook' : 'instagram'),
      longLived: !!db.fbExchangedFor,
      updated: db.updated,
      error: lastPollError || undefined,
    });
  }

  // إنشاء رابط تسجيل دخول Instagram
  if (
    url.pathname === '/api/auth/instagram/url' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, { error: 'forbidden' });
    }

    if (
      !IG_APP_ID ||
      !IG_APP_SECRET ||
      !IG_CONFIG_ID ||
      !IG_REDIRECT_URI
    ) {
      return send(res, 400, {
        error:
          'أكمل IG_APP_ID وIG_APP_SECRET وIG_CONFIG_ID وIG_REDIRECT_URI في Railway أولاً'
      });
    }

    try {
      const body = await readBody(req);

      const requested = body.length
        ? JSON.parse(body.toString('utf8')).redirect
        : '';

      if (
        !/^https:\/\/[^/]+\/auth\/instagram\/callback$/.test(
          IG_REDIRECT_URI
        )
      ) {
        throw new Error('bad configured redirect');
      }

      if (requested && requested !== IG_REDIRECT_URI) {
        throw new Error('redirect mismatch');
      }

      const st = newState(IG_REDIRECT_URI);

      const u =
        `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?` +
        new URLSearchParams({
          client_id: IG_APP_ID,
          config_id: IG_CONFIG_ID,
          redirect_uri: IG_REDIRECT_URI,
          response_type: 'code',
          override_default_response_type: 'true',
          state: st,
        });

      return send(res, 200, {
        url: u,
        redirect: IG_REDIRECT_URI
      });

    } catch (e) {
      console.error(
        'Unified Login URL error:',
        e.message
      );

      return send(res, 400, {
        error:
          'تعذر إنشاء رابط Unified Login. تحقق من IG_REDIRECT_URI وأنه مطابق تماماً في Meta.'
      });
    }
  }

  // عودة Instagram بعد تسجيل الدخول
  if (
    url.pathname === '/auth/instagram/callback' &&
    req.method === 'GET'
  ) {
    const back = (q) => {
      res.writeHead(302, {
        Location: '/?' + q
      });

      res.end();
    };

    const st = oauthStates.get(
      url.searchParams.get('state') || ''
    );

    if (!st || st.exp < Date.now()) {
      return back(
        'connect_error=' +
        encodeURIComponent('انتهت صلاحية الطلب، أعد المحاولة')
      );
    }

    oauthStates.delete(url.searchParams.get('state'));

    if (url.searchParams.get('error')) {
      return back(
        'connect_error=' +
        encodeURIComponent(
          url.searchParams.get('error_description') ||
          'تم إلغاء الربط'
        )
      );
    }

    const code = url.searchParams.get('code');

    if (!code) {
      return back(
        'connect_error=' +
        encodeURIComponent('لم يصل رمز التفويض')
      );
    }

    try {
      await connectWithCode(code, st.redirect);
      poll();

      return back('connected=1');

    } catch (e) {
      return back(
        'connect_error=' +
        encodeURIComponent(
          String(e.message || e).slice(0, 200)
        )
      );
    }
  }

  // التحقق من المدير
  if (
    url.pathname === '/api/auth' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, { error: 'forbidden' });
    }

    return send(res, 200, { ok: true });
  }

  // رفع نموذج ثلاثي الأبعاد
  if (
    url.pathname === '/api/model' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, { error: 'forbidden' });
    }

    try {
      const buf = await readBody(req, 40e6);
      const id = 'm' + Date.now().toString(36);

      fs.writeFileSync(
        path.join(MODEL_DIR, id + '.glb'),
        buf
      );

      db.models.push({
        id,
        name: (url.searchParams.get('name') || id).slice(0, 60)
      });

      save();

      return send(res, 200, { id });

    } catch (e) {
      return send(res, 400, {
        error: 'upload failed'
      });
    }
  }

  // حذف نموذج
  if (
    url.pathname === '/api/model/delete' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, { error: 'forbidden' });
    }

    const id = url.searchParams.get('id') || '';

    if (/^m[a-z0-9]+$/.test(id)) {
      db.models = db.models.filter(
        (m) => m.id !== id
      );

      try {
        fs.unlinkSync(
          path.join(MODEL_DIR, id + '.glb')
        );
      } catch (e) {}

      save();
    }

    return send(res, 200, { ok: true });
  }

  // عرض نموذج ثلاثي الأبعاد
  if (
    url.pathname.startsWith('/api/model/') &&
    req.method === 'GET'
  ) {
    const id = url.pathname.slice(
      '/api/model/'.length
    );

    if (!/^m[a-z0-9]+$/.test(id)) {
      return send(res, 404, {
        error: 'not found'
      });
    }

    try {
      const buf = fs.readFileSync(
        path.join(MODEL_DIR, id + '.glb')
      );

      cors(res);

      res.writeHead(200, {
        'Content-Type': 'model/gltf-binary',
        'Cache-Control': 'public, max-age=86400'
      });

      return res.end(buf);

    } catch (e) {
      return send(res, 404, {
        error: 'not found'
      });
    }
  }

  // تحديث بيانات Instagram يدوياً
  if (
    url.pathname === '/api/refresh' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, {
        error: 'forbidden'
      });
    }

    await poll();

    return send(res, 200, {
      ok: true,
      error: lastPollError || undefined
    });
  }

  // حفظ تخطيط القرية وإعدادات حركة الزوار
  if (
    url.pathname === '/api/layout' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, {
        error: 'forbidden'
      });
    }

    try {
      const body = JSON.parse(
        (await readBody(req)).toString('utf8')
      );

      db.layout = {
        plots: body.plots || {},
        districts: body.districts || {},
        villagers: body.villagers || {}
      };

      // حفظ إعدادات الحركة المشتركة إذا أرسلها المدير
      if (
        body.lifeSettings &&
        typeof body.lifeSettings === 'object'
      ) {
        db.lifeSettings = cleanLifeSettings(
          body.lifeSettings,
          db.lifeSettings
        );
      }

      assignPlots();
      save();

      return send(res, 200, {
        ok: true,
        lifeSettings: db.lifeSettings
      });

    } catch (e) {
      return send(res, 400, {
        error: 'bad json'
      });
    }
  }

  // إضافة متابعين يدوياً
  if (
    url.pathname === '/api/add' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, {
        error: 'forbidden'
      });
    }

    try {
      const body = JSON.parse(
        (await readBody(req)).toString('utf8')
      );

      const names = Array.isArray(body.usernames)
        ? body.usernames
        : [];

      let n = 0;

      for (const raw of names) {
        const u = norm(raw);

        if (u && !db.villagers[u]) {
          db.villagers[u] = {
            username: u,
            name: u,
            comments: 0,
            likes: 0,
            since: Date.now()
          };

          n++;
        }
      }

      db.updated = Date.now();

      assignPlots();
      save();

      return send(res, 200, {
        added: n
      });

    } catch (e) {
      return send(res, 400, {
        error: 'bad json'
      });
    }
  }

  // Meta Webhook: التحقق
  if (
    url.pathname === '/webhook' &&
    req.method === 'GET'
  ) {
    if (
      url.searchParams.get('hub.mode') === 'subscribe' &&
      VERIFY_TOKEN &&
      url.searchParams.get('hub.verify_token') === VERIFY_TOKEN
    ) {
      cors(res);

      res.writeHead(200, {
        'Content-Type': 'text/plain'
      });

      return res.end(
        url.searchParams.get('hub.challenge') || ''
      );
    }

    return send(
      res,
      403,
      'forbidden',
      'text/plain'
    );
  }

  // Meta Webhook: استقبال التعليقات لحظياً
  if (
    url.pathname === '/webhook' &&
    req.method === 'POST'
  ) {
    try {
      const raw = await readBody(req);

      if (APP_SECRET) {
        const sig = String(
          req.headers['x-hub-signature-256'] || ''
        ).replace('sha256=', '');

        const exp = crypto
          .createHmac('sha256', APP_SECRET)
          .update(raw)
          .digest('hex');

        if (!sig || !safeEq(sig, exp)) {
          return send(
            res,
            403,
            'bad signature',
            'text/plain'
          );
        }
      }

      const body = JSON.parse(
        raw.toString('utf8')
      );

      for (const entry of body.entry || []) {
        for (const ch of entry.changes || []) {
          if (
            ch.field === 'comments' &&
            ch.value &&
            ch.value.from
          ) {
            addComment(
              ch.value.from.username,
              ch.value.id,
              null,
              ch.value.text
            );

            assignPlots();
          }
        }
      }

      save();

      return send(
        res,
        200,
        'ok',
        'text/plain'
      );

    } catch (e) {
      return send(
        res,
        400,
        'bad request',
        'text/plain'
      );
    }
  }

  // تقديم صفحة اللعبة
  if (
    req.method === 'GET' &&
    (
      url.pathname === '/' ||
      url.pathname === '/index.html'
    )
  ) {
    try {
      const html = fs.readFileSync(
        path.join(__dirname, 'index.html')
      );

      cors(res);

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8'
      });

      return res.end(html);

    } catch (e) {
      return send(
        res,
        404,
        'index.html not found',
        'text/plain'
      );
    }
  }

  return send(res, 404, {
    error: 'not found'
  });
});

server.listen(PORT, () => {
  console.log(
    `مدينة المتابعين تعمل على http://localhost:${PORT}`
  );
});
