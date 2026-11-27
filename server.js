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
//   MEDIA_LIMIT     عدد آخر المنشورات التي تُفحص (الافتراضي 50)

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
const MEDIA_LIMIT = +process.env.MEDIA_LIMIT || 50;
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
  contest: null,
  poll: null,
  planeParks: {},
  walkCodes: {},
  token: '',
  tokenSrc: '',
  tokenAt: 0
};

try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
} catch (e) {}

if (!Array.isArray(db.models)) db.models = [];
if (!db.planeParks || typeof db.planeParks !== 'object' || Array.isArray(db.planeParks)) db.planeParks = {};
if (!db.walkCodes || typeof db.walkCodes !== 'object' || Array.isArray(db.walkCodes)) db.walkCodes = {};

// ترحيل قديم: real/barca صارا الفريق a/b
Object.values(db.villagers || {}).forEach((v) => {
  if (v && v.team === 'real') v.team = 'a';
  else if (v && v.team === 'barca') v.team = 'b';
});

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

  for (const key of ['walkFreeze', 'carFreeze', 'gather', 'trees', 'treeSway', 'stLights', 'walkOn']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }

  if (input.treeStyle === 'ordered' || input.treeStyle === 'wild') {
    result.treeStyle = input.treeStyle;
  }

  if (input.treeD !== undefined && Number.isFinite(Number(input.treeD))) {
    result.treeD = Math.max(0.2, Math.min(2, Number(input.treeD)));
  }

  if (['auto', 'day', 'dawn', 'sunset', 'dusk', 'night', 'overcast', 'custom', 'golden', 'storm', 'candy', 'aurora', 'space', 'bluehour', 'fire', 'mint', 'desert', 'mist'].includes(input.skyMode)) {
    result.skyMode = input.skyMode;
  }
  if (typeof input.skyCol === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.skyCol)) {
    result.skyCol = input.skyCol;
  }
  if (typeof input.skyCol2 === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.skyCol2)) {
    result.skyCol2 = input.skyCol2;
  }
  if (input.raceRings !== undefined && Number.isFinite(Number(input.raceRings))) {
    result.raceRings = Math.max(4, Math.min(10, Math.round(Number(input.raceRings))));
  }
  if (input.raceSize !== undefined && Number.isFinite(Number(input.raceSize))) {
    result.raceSize = Math.max(0.7, Math.min(1.6, Number(input.raceSize)));
  }
  for (const key of ['skySun', 'skyStars', 'skyClouds', 'raceOn', 'raceAuto']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  if (input.plotRad !== undefined && Number.isFinite(Number(input.plotRad))) {
    result.plotRad = Math.max(0, Math.min(12, Math.round(Number(input.plotRad))));
  }
  if (['sea', 'turq', 'deep', 'natural', 'calm', 'classic', 'custom'].includes(input.waterStyle)) {
    result.waterStyle = input.waterStyle;
  }
  if (typeof input.waterCol === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.waterCol)) {
    result.waterCol = input.waterCol;
  }
  for (const [key, hi] of [['waveAmp', 2.5], ['waterShine', 2.5]]) {
    if (input[key] !== undefined && Number.isFinite(Number(input[key]))) {
      result[key] = Math.max(0, Math.min(hi, Number(input[key])));
    }
  }
  for (const key of ['foamOn', 'wakeOn']) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  if (['auto', 'custom', 'off'].includes(input.fogMode)) {
    result.fogMode = input.fogMode;
  }
  for (const [key, lo, hi] of [['fogFar', 60, 1200], ['fogSoft', 5, 95], ['camMax', 60, 500]]) {
    if (input[key] !== undefined && Number.isFinite(Number(input[key]))) {
      result[key] = Math.max(lo, Math.min(hi, Number(input[key])));
    }
  }

  if (['famous', 'classic', 'models'].includes(input.carStyle)) {
    result.carStyle = input.carStyle;
  }

  if (typeof input.carModels === 'string' && /^[\w,-]{0,400}$/.test(input.carModels)) {
    result.carModels = input.carModels;
  }

  if (input.carModelRot !== undefined && [0, 90, 180, 270].includes(Number(input.carModelRot))) {
    result.carModelRot = Number(input.carModelRot);
  }

  if (input.carModelSize !== undefined && Number.isFinite(Number(input.carModelSize))) {
    result.carModelSize = Math.max(2, Math.min(9, Number(input.carModelSize)));
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
const FLAG_DIR = path.join(path.dirname(DATA_FILE), 'flags');

try {
  fs.mkdirSync(FLAG_DIR, { recursive: true });
} catch (e) {}

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

// ---- كشف اسم الدولة من نص التعليق ----

const BUILTIN_COUNTRIES = {
  iq: ['عراق', 'عراقي', 'عراقيه', 'iraq', 'iraqi'],
  sa: ['سعوديه', 'سعودي', 'saudi', 'ksa'],
  ae: ['امارات', 'اماراتي', 'اماراتيه', 'uae', 'emirates'],
  kw: ['كويت', 'كويتي', 'كويتيه', 'kuwait'],
  qa: ['قطر', 'قطري', 'قطريه', 'qatar'],
  bh: ['بحرين', 'بحريني', 'bahrain'],
  om: ['عمان', 'عماني', 'oman'],
  ye: ['يمن', 'يمني', 'يمنيه', 'yemen'],
  jo: ['اردن', 'اردني', 'jordan'],
  sy: ['سوريا', 'سوريه', 'سوري', 'syria'],
  lb: ['لبنان', 'لبناني', 'lebanon'],
  ps: ['فلسطين', 'فلسطيني', 'فلسطينيه', 'palestine'],
  eg: ['مصر', 'مصري', 'مصريه', 'egypt'],
  ly: ['ليبيا', 'ليبي', 'ليبيه', 'libya'],
  tn: ['تونس', 'تونسي', 'تونسيه', 'tunisia'],
  dz: ['جزائر', 'جزائري', 'جزائريه', 'algeria'],
  ma: ['مغرب', 'مغربي', 'مغربيه', 'morocco', 'maroc'],
  mr: ['موريتانيا', 'موريتاني', 'موريتانيه', 'mauritania'],
  sd: ['سودان', 'سوداني', 'سودانيه', 'sudan'],
  so: ['صومال', 'صومالي', 'صواليه', 'somalia'],
  dj: ['جيبوتي', 'djibouti'],
  km: ['جزر القمر', 'القمر', 'comoros'],
  tr: ['تركيا', 'turkey', 'turkiye'],
  ir: ['ايران', 'ايراني', 'iran']
};

const normText = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');

// فريقا المباراة (يحددهما المدير): الاسم واللون وكلمات التشجيع
const MATCH_DEFAULT = [
  { name: 'ريال مدريد', col: '#f4f4f4', kw: 'ريال، مدريد، real, madrid' },
  { name: 'برشلونة', col: '#d42a2a', kw: 'برشلونة، برشا، برسا، barca, barcelona' }
];

function cleanMatch(m) {
  const t = Array.isArray(m && m.teams) ? m.teams : [];

  return {
    teams: [0, 1].map((i) => {
      const x = t[i] || {};
      const nm = String(x.name == null ? '' : x.name).trim().slice(0, 24);

      return {
        name: nm || MATCH_DEFAULT[i].name,
        col: /^#[0-9a-fA-F]{6}$/.test(x.col || '') ? x.col : MATCH_DEFAULT[i].col,
        kw: String(x.kw != null ? x.kw : MATCH_DEFAULT[i].kw).slice(0, 200)
      };
    }),
    score: [0, 1].map((i) => {
      const n = Math.round(Number(m && m.score && m.score[i]) || 0);

      return Math.max(0, Math.min(99, n));
    }),
    round: Math.max(0, Math.min(9999, Math.round(Number(m && m.round) || 0))),
    ads: (Array.isArray(m && m.ads) ? m.ads : [])
      .map((x) => String(x || '').trim().slice(0, 28))
      .filter(Boolean)
      .slice(0, 8),
    epoch: 0,
    history: (Array.isArray(m && m.history) ? m.history : [])
      .slice(-10)
      .map((h) => ({
        a: String((h && h.a) || '').slice(0, 24),
        b: String((h && h.b) || '').slice(0, 24),
        sa: Math.max(0, Math.min(99, Math.round(Number(h && h.sa) || 0))),
        sb: Math.max(0, Math.min(99, Math.round(Number(h && h.sb) || 0))),
        fa: Math.max(0, Math.min(999999, Math.round(Number(h && h.fa) || 0))),
        fb: Math.max(0, Math.min(999999, Math.round(Number(h && h.fb) || 0))),
        at: Math.max(0, Math.round(Number(h && h.at) || 0))
      }))
  };
}

function matchEpoch() {
  return (db.layout && db.layout.match && db.layout.match.epoch) || 0;
}

function rememberText(v, text, at) {
  const arr = Array.isArray(v.texts) ? v.texts : [];

  arr.push({ t: String(text || '').slice(0, 160), at });
  v.texts = arr.slice(-6);
  delete v.lastText;
}

function matchTeams() {
  return db.layout && db.layout.match
    ? db.layout.match.teams
    : MATCH_DEFAULT;
}

// يعيد 'a' أو 'b' بحسب أقرب كلمة تشجيع في النص
function detectTeam(text) {
  const t = normText(text);

  if (!t) return null;

  const teams = matchTeams();
  let best = null;
  let bi = Infinity;

  teams.forEach((tm, idx) => {
    String(tm.kw || '')
      .split(/[,،;؛\n]/)
      .map((w) => normText(w).trim().replace(/^ال(?=.{3,})/, ''))
      .filter(Boolean)
      .forEach((w) => {
        let at = -1;

        if (/^[a-z0-9 ]+$/.test(w)) {
          const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const m = new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').exec(t);

          if (m) at = m.index;
        } else {
          at = t.indexOf(w);
        }

        if (at >= 0 && at < bi) {
          bi = at;
          best = idx ? 'b' : 'a';
        }
      });
  });

  return best;
}

// بعد تغيير الفريقين: أعد توزيع المشجعين من آخر تعليقاتهم بعد بداية المباراة الحالية
function redetectTeams() {
  const ep = matchEpoch();

  Object.values(db.villagers).forEach((v) => {
    const arr = Array.isArray(v.texts) ? v.texts.slice().reverse() : [];
    let tm = null;

    for (const x of arr) {
      if (x.at >= ep) {
        tm = detectTeam(x.t);

        if (tm) break;
      }
    }

    if (tm) v.team = tm;
    else delete v.team;
  });
}

function detectCountry(text) {
  const raw = String(text || '');

  if (!raw) return null;

  const table = Object.assign({}, BUILTIN_COUNTRIES);

  const custom =
    db.flags && Array.isArray(db.flags.custom)
      ? db.flags.custom
      : [];

  custom.forEach((c) => {
    if (c && c.code) {
      table[c.code] = (c.aliases || [])
        .map(normText)
        .map((a) => a.replace(/^ال/, '').trim())
        .filter(Boolean);
    }
  });

  // إيموجي العلم (مؤشرات المناطق)
  const cps = Array.from(raw);

  for (let i = 0; i < cps.length - 1; i++) {
    const a = cps[i].codePointAt(0);
    const b = cps[i + 1].codePointAt(0);

    if (
      a >= 0x1F1E6 && a <= 0x1F1FF &&
      b >= 0x1F1E6 && b <= 0x1F1FF
    ) {
      const code = String.fromCharCode(
        97 + a - 0x1F1E6,
        97 + b - 0x1F1E6
      );

      if (table[code]) return code;
    }
  }

  const tokens = normText(raw)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  for (const tok of tokens) {
    const cands = new Set([tok]);

    ['وال', 'بال', 'لل', 'ال', 'و', 'ب', 'ل', 'ف'].forEach((p) => {
      if (tok.startsWith(p) && tok.length > p.length + 1) {
        cands.add(tok.slice(p.length));
      }
    });

    for (const code of Object.keys(table)) {
      if (table[code].some((al) => al && cands.has(al))) return code;
    }
  }

  // كلمات من أكثر من جزء (للأعلام المضافة)
  const flat =
    ' ' + normText(raw).replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';

  for (const code of Object.keys(table)) {
    if (
      table[code].some(
        (al) => al && al.includes(' ') && flat.includes(' ' + al + ' ')
      )
    ) {
      return code;
    }
  }

  return null;
}


// ====== إشارات القصص: من يشير إلى حسابك في قصته يرفع علم دولته ======
const IGSID_NAMES = {};

async function usernameOfIgsid(id) {
  id = String(id || '');
  if (!id) return '';
  if (IGSID_NAMES[id]) return IGSID_NAMES[id];
  const j = await graph('/' + encodeURIComponent(id) + '?fields=username');
  const u = norm(j && j.username);
  if (u) IGSID_NAMES[id] = u;
  return u;
}

function markStory(username, mid) {
  const u = norm(username);
  if (!u || u === norm(db.igUser)) return false;
  const v = db.villagers[u];
  if (!v) return false; // لا بيت له بعد
  if (mid) {
    db.seen['st_' + mid] = 1;
  }
  v.storyAt = Date.now();
  v.lastAt = Math.max(v.lastAt || 0, v.storyAt);
  return true;
}

async function handleStoryEvents(entry) {
  let n = 0;
  for (const m of entry.messaging || []) {
    const atts = (m.message && m.message.attachments) || [];
    const hit = atts.some((a) => a && a.type === 'story_mention');
    if (!hit || !m.sender) continue;
    const mid = m.message.mid || '';
    if (mid && db.seen['st_' + mid]) continue;
    try {
      const u = await usernameOfIgsid(m.sender.id);
      if (markStory(u, mid)) n++;
    } catch (e) {
      console.log('story mention: تعذّر جلب اسم المستخدم', e.message);
    }
  }
  return n;
}

// ---- المهام اليومية وسلاسل الحضور (تُحسب من سجل أيام التعليق) ----
const QCFG = {
  daily: 10,
  weekDays: [4, 60],
  weekComments: [5, 40],
  streaks: [[3, 30], [7, 100], [14, 250], [30, 600]]
};
const dayStr = (t) => new Date(t).toISOString().slice(0, 10);
const weekKey = (d) => {
  const t = Date.parse(d + 'T00:00:00Z');
  return dayStr(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5);
};

function questInfo(v) {
  const days = v.days || {};
  const ks = Object.keys(days).sort();
  let best = 0, run = 0, prev = null;

  for (const d of ks) {
    const t = Date.parse(d + 'T00:00:00Z');
    run = prev !== null && t - prev === 864e5 ? run + 1 : 1;
    prev = t;
    if (run > best) best = run;
  }

  const today = dayStr(Date.now());
  const yest = dayStr(Date.now() - 864e5);
  let streak = 0;

  if (days[today] || days[yest]) {
    let t = Date.parse((days[today] ? today : yest) + 'T00:00:00Z');
    while (days[dayStr(t)]) { streak++; t -= 864e5; }
  }

  const weeks = {};
  for (const d of ks) {
    const w = weeks[weekKey(d)] || (weeks[weekKey(d)] = { d: 0, c: 0 });
    w.d++;
    w.c += days[d];
  }

  let q = ks.length * QCFG.daily;
  for (const w of Object.values(weeks)) {
    if (w.d >= QCFG.weekDays[0]) q += QCFG.weekDays[1];
    if (w.c >= QCFG.weekComments[0]) q += QCFG.weekComments[1];
  }
  for (const [n, c] of QCFG.streaks) if (best >= n) q += c;

  const cw = weeks[weekKey(today)] || { d: 0, c: 0 };
  return {
    streak,
    best,
    qcoins: q,
    qd: { today: days[today] || 0, weekDays: cw.d, weekComments: cw.c }
  };
}

// بطل السلاسل الأسبوعي: أطول أيام متتالية في الأسبوع الماضي (3 أيام على الأقل)
function weeklyChampion() {
  const start = dayStr(
    Date.parse(weekKey(dayStr(Date.now())) + 'T00:00:00Z') - 7 * 864e5
  );
  let best = null;

  for (const v of Object.values(db.villagers)) {
    const days = v.days || {};
    let run = 0, max = 0, c = 0;

    for (let i = 0; i < 7; i++) {
      const d = dayStr(Date.parse(start + 'T00:00:00Z') + i * 864e5);
      if (days[d]) { run++; c += days[d]; if (run > max) max = run; }
      else run = 0;
    }

    if (max >= 3 && (!best || max > best.run || (max === best.run && c > best.c))) {
      best = { username: v.username, run: max, c, week: start };
    }
  }

  return best;
}


// ---- مسابقة الكلمة: من يكتب كلمة معيّنة أكثر ----
// الحالة: db.contest = { word, exact, active, startedAt, endedAt, counts:{user:n}, last:{user:ts}, ids:{commentId:1} }
function contestMatch(text, c) {
  const w = normText(c.word).trim();
  const t = normText(text);

  if (!w || !t) return false;
  if (!c.exact || /\s/.test(w)) return t.includes(w);

  return t.split(/[^\p{L}\p{N}]+/u).includes(w);
}

function contestCount(u, commentId, at, text, mediaId) {
  const c = db.contest;

  if (!c || !c.word) return;
  if (c.mediaId && String(mediaId || '') !== c.mediaId) return;
  if (at < c.startedAt) return;
  // بعد الإيقاف: تُحتسب فقط التعليقات التي كُتبت قبل لحظة الإيقاف (قد تصل متأخرة مع القراءة الدورية)
  if (!c.active && at > c.endedAt) return;
  if (commentId && c.ids[commentId]) return;
  if (!contestMatch(text, c)) return;

  if (commentId) {
    c.ids[commentId] = 1;
    const keys = Object.keys(c.ids);
    if (keys.length > 20000) {
      keys.slice(0, keys.length - 15000).forEach((k) => delete c.ids[k]);
    }
  }

  c.counts[u] = (c.counts[u] || 0) + 1;
  c.last[u] = Math.max(c.last[u] || 0, at);
  db.updated = Date.now();
}

function contestView() {
  const c = db.contest;

  if (!c) return { word: '', active: false, exact: true, total: 0, players: 0, top: [] };

  const top = Object.keys(c.counts)
    .map((u) => ({
      username: u,
      name: (db.villagers[u] && db.villagers[u].name) || u,
      count: c.counts[u],
      last: c.last[u] || 0
    }))
    // التعادل: من وصل لهذا العدد أولاً (أقدم آخر تعليق) يتقدم
    .sort((a, b) => b.count - a.count || a.last - b.last)
    .slice(0, 50);

  return {
    word: c.word,
    active: !!c.active,
    exact: c.exact !== false,
    mediaId: c.mediaId || '',
    startedAt: c.startedAt,
    endedAt: c.endedAt || 0,
    total: Object.values(c.counts).reduce((a, b) => a + b, 0),
    players: Object.keys(c.counts).length,
    top
  };
}


// ---- الاستبيان: يصوّت المتابع بتعليق (رقم الخيار أو نص الخيار) ----
const toLatinDigits = (t) =>
  String(t || '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 1632)
    .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 1776);

// يعيد رقم الخيار (0..n-1) أو -1 إن لم يطابق أو التبس
function pollMatch(text, p) {
  const t = normText(toLatinDigits(text)).trim();
  if (!t) return -1;

  const plain = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  if (/^\d{1,2}$/.test(plain)) {
    const n = +plain;
    return n >= 1 && n <= p.options.length ? n - 1 : -1;
  }

  const tokens = plain.split(' ');
  const hits = [];

  p.options.forEach((o, i) => {
    const w = normText(toLatinDigits(o.label)).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!w) return;
    const ok = /\s/.test(w) ? plain.includes(w) : tokens.includes(w);
    if (ok) hits.push(i);
  });

  return hits.length === 1 ? hits[0] : -1;
}

function pollVote(u, commentId, at, text, mediaId) {
  const p = db.poll;

  if (!p || !p.options || !p.options.length) return;
  if (p.mediaId && String(mediaId || '') !== p.mediaId) return;
  if (at < p.startedAt) return;
  if (!p.active && at > p.endedAt) return;
  if (commentId && p.ids[commentId]) return;

  if (commentId) {
    p.ids[commentId] = 1;
    const keys = Object.keys(p.ids);
    if (keys.length > 20000) {
      keys.slice(0, keys.length - 15000).forEach((k) => delete p.ids[k]);
    }
  }

  const opt = pollMatch(text, p);

  if (opt < 0) return;

  const prev = p.votes[u];

  // صوت واحد لكل شخص: آخر تعليق صالح هو المعتمد
  if (prev && prev.at > at) return;

  p.votes[u] = { opt, at };
  db.updated = Date.now();
}

function pollView() {
  const p = db.poll;

  if (!p) return { question: '', active: false, options: [], voters: 0, leader: -1, tie: false };

  const counts = p.options.map(() => 0);
  Object.values(p.votes).forEach((v) => { if (counts[v.opt] !== undefined) counts[v.opt]++; });

  const voters = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...counts);
  const tops = counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0);

  return {
    question: p.question,
    active: !!p.active,
    mediaId: p.mediaId || '',
    startedAt: p.startedAt,
    endedAt: p.endedAt || 0,
    voters,
    leader: max > 0 && tops.length === 1 ? tops[0] : -1,
    tie: max > 0 && tops.length > 1,
    options: p.options.map((o, i) => ({
      label: o.label,
      count: counts[i],
      pct: voters ? Math.round((counts[i] / voters) * 100) : 0
    }))
  };
}

function addComment(username, commentId, timestamp, text, mediaId) {
  const u = norm(username);
  const at = timestamp ? Date.parse(timestamp) || Date.now() : Date.now();

  if (!u || u === norm(db.igUser)) return false;

  contestCount(u, commentId, at, text, mediaId);
  pollVote(u, commentId, at, text, mediaId);

  if (
    !db.villagers[u] &&
    CLAIM_WORD &&
    !String(text || '').toLowerCase().includes(CLAIM_WORD)
  ) {
    return false;
  }

  if (commentId) {
    if (db.seen[commentId]) {
      // تعليق قديم: لا يُحتسب مجدداً، لكن نستفيد منه لمعرفة الدولة
      const ev = db.villagers[u];

      if (ev && !ev.country) {
        const cc0 = detectCountry(text);

        if (cc0) {
          ev.country = cc0;
          ev.countryText = String(text || '').slice(0, 80);
          ev.countryAt = at;
        }

        const tm0 = at >= matchEpoch() ? detectTeam(text) : null;

        if (tm0 && !ev.team) ev.team = tm0;

        if (!ev.texts || !ev.texts.length) rememberText(ev, text, at);
      }

      return false;
    }

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

  v.days = v.days || {};
  const dk = dayStr(at);
  v.days[dk] = (v.days[dk] || 0) + 1;
  const dks = Object.keys(v.days).sort();
  while (dks.length > 400) delete v.days[dks.shift()];

  const cc = detectCountry(text);

  if (cc) {
    v.country = cc;
    v.countryText = String(text || '').slice(0, 80);
    v.countryAt = at;
  }

  v.lastAt = Math.max(v.lastAt || 0, at);
  rememberText(v, text, at);

  const tm = at >= matchEpoch() ? detectTeam(text) : null;

  if (tm) v.team = tm;
  db.updated = Date.now();

  return true;
}

// ---- توزيع البيوت على الخريطة من الخادم نفسه ----

const gridDist = () => {
  const d = db.layout && db.layout.grid && Math.round(+db.layout.grid.dist);
  return d >= 2 && d <= 8 ? d : 4;
};

function cleanGrid(g) {
  if (!g || typeof g !== 'object') return null;
  const n = (v, a, b, d) =>
    Number.isFinite(Number(v))
      ? Math.max(a, Math.min(b, Math.round(Number(v))))
      : d;
  return {
    plot: n(g.plot, 8, 26, 14),
    road: n(g.road, 4, 16, 6),
    dist: n(g.dist, 2, 8, 4),
    fit: g.fit !== false
  };
}

function cleanTerrain(t) {
  if (!t || typeof t !== 'object') return null;
  const okC = /^-?\d{1,4},-?\d{1,4}$/;
  const okS = /^-?\d{1,4},-?\d{1,4},[xz]$/;
  const cells = {};
  let n = 0;
  for (const [k, v] of Object.entries(t.cells || {})) {
    if (n >= 4000) break;
    if (okC.test(k) && (v === 'river' || v === 'mount')) {
      cells[k] = v;
      n++;
    }
  }
  const pick = (o) => {
    const r = {};
    let m = 0;
    for (const k of Object.keys(o || {})) {
      if (m >= 4000) break;
      if (okS.test(k)) {
        r[k] = 1;
        m++;
      }
    }
    return r;
  };
  const num = (v, a, b, d) =>
    Number.isFinite(Number(v)) ? Math.max(a, Math.min(b, Number(v))) : d;
  return {
    cells,
    closed: pick(t.closed),
    bridges: pick(t.bridges),
    falls: (() => {
      const r = {};
      let m = 0;
      for (const [k, v] of Object.entries(t.falls || {})) {
        if (m >= 500) break;
        if (okC.test(k) && [0, 1, 2, 3].includes(Number(v))) {
          r[k] = Number(v);
          m++;
        }
      }
      return r;
    })(),
    ms: num(t.ms, 0.5, 2.5, 1),
    flow: num(t.flow, 0, 3, 1)
  };
}

const livePlanes = {};

// الطائرة تبقى واقفة حيث تركها قائدها حتى يقودها صاحبها أو المدير من جديد
const walkers = {};
function walkUserByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  return Object.keys(db.walkCodes).find((u) => db.walkCodes[u] === c) || '';
}
function newWalkCode() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += a[Math.floor(Math.random() * a.length)];
    if (!walkUserByCode(c)) return c;
  }
}
function parkPlane(id, p) {
  db.planeParks[id] = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, at: Date.now() };
  save();
}

// إذا انقطع الطيار (أغلق الصفحة مثلاً) تُركن الطائرة في آخر مكان وصل إليه
function expireLivePlanes(now) {
  Object.keys(livePlanes).forEach((id) => {
    const p = livePlanes[id];
    if (now - p.t >= 4000) {
      parkPlane(id, p);
      delete livePlanes[id];
    }
  });
}
setInterval(() => expireLivePlanes(Date.now()), 1000);
function raceWeekId() {
  return Math.floor((Date.now() - 2 * 86400000) / 604800000);
}
function rollRaceWeek() {
  const w = raceWeekId();
  if (db.raceWeek === undefined) {
    db.raceWeek = w;
    return;
  }
  if (db.raceWeek !== w) {
    if (db.lifeSettings && db.lifeSettings.raceAuto === false) {
      db.raceWeek = w;
      return;
    }
    const top = (db.raceBoard || [])[0];
    if (top) db.raceChamp = { name: top.name, time: top.time, at: Date.now(), week: db.raceWeek };
    db.raceBoard = [];
    db.raceWeek = w;
    save();
  }
}
function genPlaneCode() {
  const al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += al[Math.floor(Math.random() * al.length)];
  return c;
}
function fnvH(str) {
  let h = 2166136261;
  str = String(str);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function publicLayout(isAdmin) {
  const L = db.layout;
  if (isAdmin || !L || !Array.isArray(L.planes)) return L;
  return Object.assign({}, L, {
    planes: L.planes.map(p => {
      const o = Object.assign({}, p, { ch: p.code ? fnvH(p.code) : undefined });
      delete o.code;
      return o;
    })
  });
}
function cleanWar(w) {
  w = w && typeof w === 'object' ? w : {};
  const cs = (Array.isArray(w.countries) ? w.countries : [])
    .map(String)
    .filter(c => /^[a-z0-9_-]{2,20}$/.test(c))
    .filter((c, i, a) => a.indexOf(c) === i)
    .slice(0, 4);
  const cnt = o => {
    const r = {};
    if (o && typeof o === 'object')
      Object.keys(o).slice(0, 6).forEach(k => {
        if (/^[a-z0-9_-]{2,20}$/.test(k)) r[k] = Math.max(0, Math.min(1000000, Math.round(+o[k] || 0)));
      });
    return r;
  };
  const sc = w.sched && typeof w.sched === 'object' ? w.sched : {};
  const tmv = (x, d) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(x) ? x : d);
  const dv = (x, d) => {
    x = Math.round(+x);
    return x >= 0 && x <= 6 ? x : d;
  };
  return {
    ver: Math.max(0, Math.round(+w.ver || 0)),
    auto: !!w.auto,
    sched: {
      on: !!sc.on,
      sd: dv(sc.sd, 5),
      st: tmv(sc.st, '20:00'),
      ed: dv(sc.ed, 6),
      et: tmv(sc.et, '20:00'),
      tz: Math.max(-720, Math.min(840, Math.round(+sc.tz || 0))),
      last: Number.isFinite(+sc.last) ? +sc.last : 0
    },
    on: !!w.on,
    countries: cs,
    t0: Number.isFinite(+w.t0) ? +w.t0 : 0,
    all: !!w.all,
    round: Math.max(0, Math.min(100000, Math.round(+w.round || 0))),
    final: w.final ? cnt(w.final) : null,
    winner: w.winner ? String(w.winner).replace(/[^a-z0-9_-]/g, '').slice(0, 20) : null,
    hist: (Array.isArray(w.hist) ? w.hist : []).slice(0, 10).map(h => ({
      t: Number.isFinite(+(h && h.t)) ? +h.t : 0,
      round: Math.max(0, Math.round(+(h && h.round) || 0)),
      counts: cnt(h && h.counts),
      winner: String((h && h.winner) || '').replace(/[^a-z0-9_-]/g, '').slice(0, 20)
    }))
  };
}
function warCountsServer(w) {
  const o = {};
  w.countries.forEach(c => (o[c] = 0));
  const lay = (db.layout && db.layout.villagers) || {};
  Object.keys(db.villagers || {}).forEach(u => {
    const v = db.villagers[u] || {},
      l = lay[u] || {},
      c = l.countryManual || v.country;
    if (!c || o[c] === undefined) return;
    if (w.all || l.countryManual || (v.countryAt || 0) >= w.t0) o[c]++;
  });
  return o;
}
function warSchedState(s, now) {
  const pm = t => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
    return m ? +m[1] * 60 + +m[2] : 0;
  };
  const d = new Date(now + (s.tz || 0) * 60000);
  const wm = d.getUTCDay() * 1440 + d.getUTCHours() * 60 + d.getUTCMinutes();
  const sm = s.sd * 1440 + pm(s.st),
    em = s.ed * 1440 + pm(s.et);
  if (sm === em) return { on: false, cycleStart: 0 };
  const on = sm < em ? wm >= sm && wm < em : wm >= sm || wm < em;
  const since = (wm - sm + 10080) % 10080;
  return { on, cycleStart: Math.floor(now / 60000) * 60000 - since * 60000 };
}
function endWarServer(w, now) {
  const cnt = warCountsServer(w);
  let best = -1,
    win = null,
    tie = false;
  Object.keys(cnt).forEach(c => {
    if (cnt[c] > best) {
      best = cnt[c];
      win = c;
      tie = false;
    } else if (cnt[c] === best) tie = true;
  });
  w.on = false;
  w.auto = false;
  w.final = cnt;
  w.winner = tie || best <= 0 ? 'tie' : win;
  w.hist = [{ t: now, round: w.round, counts: cnt, winner: w.winner }].concat(w.hist || []).slice(0, 10);
}
function warTick(now) {
  try {
    now = now || Date.now();
    const L = db.layout,
      w = L && L.war,
      s = w && w.sched;
    if (!w || !s || !s.on) return;
    const st = warSchedState(s, now);
    if (st.on && !w.on && s.last !== st.cycleStart && w.countries.length >= 2) {
      w.on = true;
      w.auto = true;
      w.t0 = now;
      w.round = (w.round || 0) + 1;
      w.final = null;
      w.winner = null;
      s.last = st.cycleStart;
      w.ver = (w.ver || 0) + 1;
      save();
    } else if (!st.on && w.on && w.auto) {
      endWarServer(w, now);
      w.ver = (w.ver || 0) + 1;
      save();
    }
  } catch (e) {}
}
setInterval(() => warTick(), 30000);
function cleanPlanes(a) {
  const seen = new Set();
  return a.slice(0, 10).map((b, i) => {
    let id =
      String((b && b.id) || 'p' + i)
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 20) || 'p' + i;
    if (seen.has(id)) id = id + '_' + i;
    seen.add(id);
    return {
      id,
      name: String((b && b.name) || 'طائرة').slice(0, 30),
      color: /^#[0-9a-fA-F]{6}$/.test((b && b.color) || '') ? b.color : '#2f6fdb',
      owners: (Array.isArray(b && b.owners) ? b.owners : [])
        .slice(0, 30)
        .map(norm)
        .filter(Boolean),
      speed: 1,
      type: ['airliner', 'private', 'jet'].includes(b && b.type) ? b.type : 'airliner',
      code: /^[A-Z0-9]{4,8}$/.test((b && b.code) || '') ? b.code : genPlaneCode()
    };
  });
}
function cleanBoats(a) {
  const seen = new Set();
  return a.slice(0, 40).map((b, i) => {
    let id =
      String((b && b.id) || 'b' + i)
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 20) || 'b' + i;
    if (seen.has(id)) id = id + '_' + i;
    seen.add(id);
    const sp = Number(b && b.speed);
    return {
      id,
      name: String((b && b.name) || 'قارب').slice(0, 30),
      color: /^#[0-9a-fA-F]{6}$/.test((b && b.color) || '')
        ? b.color
        : '#d9362b',
      owners: (Array.isArray(b && b.owners) ? b.owners : [])
        .slice(0, 30)
        .map(norm)
        .filter(Boolean),
      speed: Number.isFinite(sp) ? Math.max(0.3, Math.min(3, sp)) : 1
    };
  });
}

function cleanCity(c) {
  const l = Math.round(Number(c && c.level));
  return { level: Number.isFinite(l) ? Math.max(1, Math.min(5, l)) : 1 };
}

function blockedCells(plots) {
  const set = new Set();
  const T = db.layout && db.layout.terrain;
  if (T && T.cells) Object.keys(T.cells).forEach((k) => set.add(k));
  Object.entries(plots || {}).forEach(([k, p]) => {
    const sp = p && p.span;
    const w = sp ? Math.max(1, Math.min(5, Math.round(sp.w) || 1)) : 1;
    const h = sp ? Math.max(1, Math.min(5, Math.round(sp.h) || 1)) : 1;
    if (w * h < 2) return;
    const [x, y] = k.split(',').map(Number);
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        if (i || j) set.add(x + i + ',' + (y + j));
      }
    }
  });
  return set;
}

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
  const blocked = blockedCells(plots);

  for (const [x, y] of spiral()) {
    const k = x + ',' + y;

    if (plots[k] || blocked.has(k)) continue;

    if (
      districtType(
        Math.floor(x / gridDist()),
        Math.floor(y / gridDist())
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

    (Array.isArray(L.plots[k].extra) ? L.plots[k].extra : []).forEach(
      (u) => {
        owners[u] = k;
      }
    );
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

// كل تعليقات المنشور بكل صفحاتها مع الردود (الردود تُحتسب أيضاً)
async function pollMediaComments(mediaId) {
  const F = 'id,username,text,timestamp';
  let url =
    `/${mediaId}/comments?fields=${F},replies.limit(100){${F}}&limit=100`;
  let plain = false;

  for (let page = 0; page < 200 && url; page++) {
    let c;

    try {
      c = await graph(url);
    } catch (e) {
      if (!plain && page === 0) {
        // الحساب أو الإصدار لا يدعم توسيع الردود: نعود للتعليقات الرئيسية فقط
        plain = true;
        url = `/${mediaId}/comments?fields=${F}&limit=100`;
        page = -1;
        continue;
      }

      throw e;
    }

    for (const it of c.data || []) {
      addComment(it.username, it.id, it.timestamp, it.text, mediaId);

      let rep = it.replies;

      for (let rp = 0; rep && rp < 20; rp++) {
        for (const r of rep.data || []) {
          addComment(r.username, r.id, r.timestamp, r.text, mediaId);
        }

        rep = rep.paging && rep.paging.next
          ? await graph(rep.paging.next)
          : null;
      }
    }

    url = c.paging && c.paging.next ? c.paging.next : null;
  }
}

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
      await pollMediaComments(m.id);
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
    'GET,POST,DELETE,OPTIONS'
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

let walkSaveT = null;

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
      qcfg: QCFG,
      champ: weeklyChampion(),
      villagers: Object.values(db.villagers).map(({ days, ...v }) => ({
        ...v,
        ...questInfo({ days })
      })),
      layout: publicLayout(
        !!ADMIN_KEY &&
          safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
      ),
      lifeSettings: db.lifeSettings,
      lifeSet: !!db.lifeSet,
      flags: db.flags || null,
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

  // رفع صورة علم مخصص
  if (
    url.pathname === '/api/flag' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, { error: 'forbidden' });
    }

    const code = url.searchParams.get('code') || '';

    if (!/^[a-z0-9]{1,12}$/.test(code)) {
      return send(res, 400, { error: 'bad code' });
    }

    try {
      const buf = await readBody(req, 2e6);

      fs.writeFileSync(path.join(FLAG_DIR, code + '.png'), buf);

      return send(res, 200, { ok: true });

    } catch (e) {
      return send(res, 400, { error: 'upload failed' });
    }
  }

  // حذف علم مخصص
  if (
    url.pathname === '/api/flag/delete' &&
    req.method === 'POST'
  ) {
    if (
      !ADMIN_KEY ||
      !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)
    ) {
      return send(res, 403, { error: 'forbidden' });
    }

    const code = url.searchParams.get('code') || '';

    if (/^[a-z0-9]{1,12}$/.test(code)) {
      try {
        fs.unlinkSync(path.join(FLAG_DIR, code + '.png'));
      } catch (e) {}
    }

    return send(res, 200, { ok: true });
  }

  // عرض صورة علم مخصص
  if (
    url.pathname.startsWith('/api/flag/') &&
    req.method === 'GET'
  ) {
    const code = url.pathname.slice('/api/flag/'.length);

    if (!/^[a-z0-9]{1,12}$/.test(code)) {
      return send(res, 404, { error: 'not found' });
    }

    try {
      const buf = fs.readFileSync(path.join(FLAG_DIR, code + '.png'));

      cors(res);

      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600'
      });

      return res.end(buf);

    } catch (e) {
      return send(res, 404, { error: 'not found' });
    }
  }

  // ===== قائمة آخر المنشورات (لاختيار منشور معيّن) =====
  if (url.pathname === '/api/admin/media' && req.method === 'GET') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) {
      return send(res, 403, { error: 'forbidden' });
    }
    try {
      const node = await igNode();
      const m = await graph(`/${node}/media?fields=id,caption,permalink,timestamp,media_type&limit=30`);
      return send(res, 200, {
        media: (m.data || []).map((x) => ({
          id: x.id,
          caption: String(x.caption || '').replace(/\s+/g, ' ').slice(0, 60),
          permalink: x.permalink || '',
          timestamp: x.timestamp || '',
          type: x.media_type || ''
        }))
      });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e).slice(0, 200) });
    }
  }

  // ===== الاستبيان: للمدير فقط =====
  if (url.pathname === '/api/admin/poll') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) {
      return send(res, 403, { error: 'forbidden' });
    }
    if (req.method === 'GET') return send(res, 200, pollView());
    if (req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req, 8000)).toString('utf8'));
        const act = String((b && b.action) || '');

        if (act === 'start') {
          const seen = new Set();
          const options = (Array.isArray(b.options) ? b.options : [])
            .map((x) => String(x || '').trim().slice(0, 40))
            .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
            .slice(0, 8)
            .map((label) => ({ label }));

          if (options.length < 2) return send(res, 400, { error: 'أضف خيارين على الأقل' });

          db.poll = {
            question: String(b.question || '').trim().slice(0, 120),
            options,
            mediaId: String(b.mediaId || '').replace(/[^0-9_]/g, '').slice(0, 40),
            active: true,
            startedAt: Date.now(),
            endedAt: 0,
            votes: {},
            ids: {}
          };
        } else if (act === 'stop') {
          if (db.poll) { db.poll.active = false; db.poll.endedAt = Date.now(); }
        } else if (act === 'resume') {
          if (db.poll) { db.poll.active = true; db.poll.endedAt = 0; }
        } else if (act === 'reset') {
          db.poll = null;
        } else {
          return send(res, 400, { error: 'bad action' });
        }

        save();
        return send(res, 200, pollView());
      } catch (e) {
        return send(res, 400, { error: 'bad json' });
      }
    }
  }

  // ===== مسابقة الكلمة: للمدير فقط =====
  if (url.pathname === '/api/admin/contest') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) {
      return send(res, 403, { error: 'forbidden' });
    }

    if (req.method === 'GET') {
      return send(res, 200, contestView());
    }

    if (req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req, 4000)).toString('utf8'));
        const act = String((b && b.action) || '');

        if (act === 'start') {
          const word = String(b.word || '').trim().slice(0, 40);
          if (!word) return send(res, 400, { error: 'اكتب الكلمة أولاً' });

          db.contest = {
            word,
            exact: b.exact !== false,
            mediaId: String(b.mediaId || '').replace(/[^0-9_]/g, '').slice(0, 40),
            active: true,
            startedAt: Date.now(),
            endedAt: 0,
            counts: {},
            last: {},
            ids: {}
          };
        } else if (act === 'stop') {
          if (db.contest) {
            db.contest.active = false;
            db.contest.endedAt = Date.now();
          }
        } else if (act === 'resume') {
          if (db.contest && db.contest.word) {
            db.contest.active = true;
            db.contest.endedAt = 0;
          }
        } else if (act === 'reset') {
          db.contest = null;
        } else {
          return send(res, 400, { error: 'bad action' });
        }

        save();
        return send(res, 200, contestView());
      } catch (e) {
        return send(res, 400, { error: 'bad json' });
      }
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

  // لوحة سباق الطائرات
  if (url.pathname === '/api/race' && req.method === 'GET') {
    rollRaceWeek();
    return send(res, 200, { board: (db.raceBoard || []).slice(0, 10), champ: db.raceChamp || null });
  }
  if (url.pathname === '/api/race' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const id = String((b && b.id) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
      const pl = db.layout && Array.isArray(db.layout.planes) && db.layout.planes.find(x => x.id === id);
      if (!pl) return send(res, 404, { error: 'no plane' });
      const isAdm = !!ADMIN_KEY && safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY);
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!isAdm && (!pl.code || !safeEq(code, pl.code))) return send(res, 403, { error: 'bad code' });
      rollRaceWeek();
      if (db.lifeSettings && db.lifeSettings.raceOn === false) return send(res, 403, { error: 'race off' });
      const time = Math.round(+b.time * 100) / 100;
      if (!Number.isFinite(time) || time < 12 || time > 1800) return send(res, 400, { error: 'bad time' });
      const name = String(b.name || 'طيار').replace(/[<>]/g, '').trim().slice(0, 20) || 'طيار';
      const key = name.toLowerCase();
      const board = (db.raceBoard = Array.isArray(db.raceBoard) ? db.raceBoard : []);
      const i = board.findIndex(e => String(e.name).toLowerCase() === key);
      if (i < 0) board.push({ name, time, plane: pl.name, at: Date.now() });
      else if (time < board[i].time) board[i] = { name, time, plane: pl.name, at: Date.now() };
      board.sort((x, y) => x.time - y.time);
      db.raceBoard = board.slice(0, 20);
      save();
      const rank = db.raceBoard.findIndex(e => String(e.name).toLowerCase() === key) + 1;
      return send(res, 200, { ok: true, rank, board: db.raceBoard.slice(0, 10), champ: db.raceChamp || null });
    } catch (e) {
      return send(res, 400, { error: 'bad' });
    }
  }
  if (url.pathname === '/api/race' && req.method === 'DELETE') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) return send(res, 403, { error: 'forbidden' });
    const mode = url.searchParams.get('mode') || 'clear';
    const top = (db.raceBoard || [])[0];
    if (mode === 'crown' && top) db.raceChamp = { name: top.name, time: top.time, at: Date.now(), week: raceWeekId() };
    if (mode === 'unchamp') db.raceChamp = null;
    if (mode !== 'unchamp') db.raceBoard = [];
    save();
    return send(res, 200, { ok: true, champ: db.raceChamp || null, board: db.raceBoard || [] });
  }

  // الطيران المباشر: الطيار يرسل وضعية طائرته والباقون يقرؤونها
  // ===== أكواد شخصيات السكان =====
  if (url.pathname === '/api/walk-login' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 2000)).toString('utf8'));
      const u = walkUserByCode(b && b.code);
      if (!u) return send(res, 403, { error: 'code' });
      return send(res, 200, { ok: true, user: u, name: (db.villagers[u] && db.villagers[u].name) || u });
    } catch (e) { return send(res, 400, { error: 'bad' }); }
  }
  if (url.pathname === '/api/walk-codes') {
    if (!(!!ADMIN_KEY && safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY))) return send(res, 401, { error: 'admin' });
    if (req.method === 'GET') return send(res, 200, { codes: db.walkCodes });
    if (req.method === 'POST') {
      try {
        const b = JSON.parse((await readBody(req, 2000)).toString('utf8'));
        const u = String((b && b.user) || '').trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 40);
        if (!u) return send(res, 400, { error: 'user' });
        if (b.del) delete db.walkCodes[u];
        else db.walkCodes[u] = newWalkCode();
        save();
        return send(res, 200, { codes: db.walkCodes });
      } catch (e) { return send(res, 400, { error: 'bad' }); }
    }
  }
  // ===== مراقبة المتجولين: للمدير فقط (يكشف اسم الحساب الحقيقي والمحادثات) =====
  if (url.pathname === '/api/admin/walk' && req.method === 'GET') {
    if (!ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY)) {
      return send(res, 403, { error: 'forbidden' });
    }
    const now = Date.now(), list = [];
    Object.keys(walkers).forEach((k) => {
      const w = walkers[k];
      if (now - w.t < 5000) { const { t, ...r } = w; list.push({ tok: k, ...r, age: now - t }); }
      else delete walkers[k];
    });
    const since = +url.searchParams.get('since') || 0;
    const log = (db.walkLog || []).filter((m) => m.t > since).slice(-200);
    return send(res, 200, { now, walkers: list, log });
  }
  // ===== حضور المتجولين (في الذاكرة فقط) =====
  if (url.pathname === '/api/walk' && req.method === 'GET') {
    const now = Date.now(), out = {};
    Object.keys(walkers).forEach((k) => {
      if (now - walkers[k].t < 5000) { const { t, user, ...r } = walkers[k]; out[k] = r; } else delete walkers[k];
    });
    return send(res, 200, { walkers: out, now });
  }
  if (url.pathname === '/api/walk' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req, 4000)).toString('utf8'));
      const tok = String((b && b.tok) || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      if (!tok) return send(res, 400, { error: 'bad' });
      if (b.stop) { delete walkers[tok]; return send(res, 200, { ok: true }); }
      if (db.lifeSettings && db.lifeSettings.walkOn === false) return send(res, 403, { error: 'off' });
      const isAdm = !!ADMIN_KEY && safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY);
      let who = '';
      if (!isAdm) {
        who = walkUserByCode(b.code);
        if (!who) return send(res, 403, { error: 'code' });
        const now0 = Date.now();
        const clash = Object.keys(walkers).find((k) => k !== tok && walkers[k].user === who && now0 - walkers[k].t < 5000);
        if (clash) return send(res, 409, { error: 'busy', by: walkers[clash].name });
      }
      if (!walkers[tok] && Object.keys(walkers).length >= 60) return send(res, 429, { error: 'full' });
      const n = (x, m) => Math.max(-m, Math.min(m, Number.isFinite(+x) ? Math.round(+x * 100) / 100 : 0));
      const cl = (s, l) => String(s || '').replace(/[<>]/g, '').slice(0, l);
      const col = (s, d) => (/^#[0-9a-fA-F]{6}$/.test(String(s)) ? String(s) : d);
      const prev = walkers[tok] || {};
      const w = { x: n(b.x, 5000), y: Math.max(0, n(b.y, 20)), z: n(b.z, 5000), yaw: n(b.yaw, 10), name: (who && ((db.villagers[who] && db.villagers[who].name) || who).slice(0, 20)) || cl(b.name, 20) || 'زائر', user: who,
        shirt: col(b.shirt, '#c4281c'), pants: col(b.pants, '#2f4aa6'), emo: cl(b.emo, 8), msg: cl(b.msg, 60), mid: cl(b.mid, 12), t: Date.now() };
      if (w.mid && w.mid !== prev.mid) w.mt = Date.now(); else w.mt = prev.mt || 0;
      // سجل محادثات المتجولين (يراه المدير فقط)
      if (w.mid && w.mid !== prev.mid && (w.msg || w.emo)) {
        db.walkLog = db.walkLog || [];
        db.walkLog.push({ t: Date.now(), tok, name: w.name, user: who, msg: w.msg, emo: w.emo });
        if (db.walkLog.length > 500) db.walkLog.splice(0, db.walkLog.length - 500);
        clearTimeout(walkSaveT);
        walkSaveT = setTimeout(save, 5000);
      }
      walkers[tok] = w;
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 400, { error: 'bad' }); }
  }
  if (url.pathname === '/api/plane-live' && req.method === 'GET') {
    const now = Date.now(),
      out = {},
      parked = {};
    expireLivePlanes(now);
    Object.keys(livePlanes).forEach(id => {
      const { tok, ...rest } = livePlanes[id];
      out[id] = rest;
    });
    const known = new Set(((db.layout && db.layout.planes) || []).map(p => p.id));
    Object.keys(db.planeParks).forEach(id => {
      if (!known.has(id)) return;
      const q = db.planeParks[id];
      parked[id] = { x: q.x, y: q.y, z: q.z, yaw: q.yaw };
    });
    return send(res, 200, { live: out, parked, now });
  }
  if (url.pathname === '/api/plane-live' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const id = String((b && b.id) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
      const pl = db.layout && Array.isArray(db.layout.planes) && db.layout.planes.find(x => x.id === id);
      if (!pl) return send(res, 404, { error: 'no plane' });
      const isAdm = !!ADMIN_KEY && safeEq(req.headers['x-admin-key'] || '', ADMIN_KEY);
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!isAdm && (!pl.code || !safeEq(code, pl.code))) return send(res, 403, { error: 'bad code' });
      const tok = String(b.tok || '').slice(0, 24) || 'x';
      const cur = livePlanes[id];
      const n = v => (Number.isFinite(+v) ? Math.round(+v * 100) / 100 : 0);
      if (b.stop) {
        if (cur && cur.tok === tok && b.ret) {
          delete livePlanes[id];
          if (db.planeParks[id]) { delete db.planeParks[id]; save(); }
        } else if (cur && cur.tok === tok) {
          const fin = Object.assign({}, cur);
          if (b.x !== undefined && b.z !== undefined && Number.isFinite(+b.x) && Number.isFinite(+b.z)) {
            fin.x = Math.max(-5000, Math.min(5000, n(b.x)));
            fin.y = Math.max(0, Math.min(400, n(b.y)));
            fin.z = Math.max(-5000, Math.min(5000, n(b.z)));
            fin.yaw = n(b.yaw);
          }
          parkPlane(id, fin);
          delete livePlanes[id];
        }
        return send(res, 200, { ok: true });
      }
      if (cur && cur.tok !== tok && Date.now() - cur.t < 3000) return send(res, 409, { error: 'busy', by: cur.name });
      if (db.planeParks[id]) {
        delete db.planeParks[id];
        save();
      }
      livePlanes[id] = {
        tok,
        name: String(b.name || 'طيار').replace(/[<>]/g, '').slice(0, 20) || 'طيار',
        x: Math.max(-5000, Math.min(5000, n(b.x))),
        y: Math.max(0, Math.min(400, n(b.y))),
        z: Math.max(-5000, Math.min(5000, n(b.z))),
        yaw: n(b.yaw),
        pitch: n(b.pitch),
        bank: n(b.bank),
        v: Math.max(0, Math.min(200, n(b.v))),
        t: Date.now()
      };
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 400, { error: 'bad' });
    }
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

      const prevLayout = db.layout;

      db.layout = {
        plots: body.plots || {},
        districts: body.districts || {},
        villagers: body.villagers || {},
        grid: cleanGrid(body.grid) || (db.layout && db.layout.grid) || undefined,
        terrain:
          cleanTerrain(body.terrain) ||
          (db.layout && db.layout.terrain) ||
          undefined,
        city: body.city
          ? cleanCity(body.city)
          : (db.layout && db.layout.city) || undefined,
        boats: Array.isArray(body.boats)
          ? cleanBoats(body.boats)
          : (db.layout && db.layout.boats) || undefined,
        war: (() => {
          const prev = db.layout && db.layout.war;
          if (body.war && typeof body.war === 'object') {
            const nw = cleanWar(body.war);
            if (!prev || (nw.ver || 0) >= (prev.ver || 0)) return nw;
          }
          return prev || undefined;
        })(),
        planes: Array.isArray(body.planes)
          ? cleanPlanes(body.planes)
          : (db.layout && db.layout.planes) || undefined,
        match:
          body.match && typeof body.match === 'object'
            ? cleanMatch(body.match)
            : (prevLayout && prevLayout.match) || undefined
      };

      // إنهاء مباراة: يرتفع رقم الجولة فتبدأ مباراة جديدة والملعب فارغ
      if (db.layout.match) {
        const pm = (prevLayout && prevLayout.match) || null;
        const pr = (pm && pm.round) || 0;

        db.layout.match.epoch = (pm && pm.epoch) || 0;
        db.layout.match.round = Math.max(db.layout.match.round, pr);

        if (db.layout.match.round > pr) {
          db.layout.match.epoch = Date.now();
          Object.values(db.villagers).forEach((v) => {
            delete v.team;
          });
        }
      }

      if (
        JSON.stringify(matchTeams()) !==
        JSON.stringify(prevLayout && prevLayout.match
          ? prevLayout.match.teams
          : MATCH_DEFAULT)
      ) {
        redetectTeams();
      }

      // الأعلام: تشغيل، إطفاء، وأعلام مضافة
      if (body.flags && typeof body.flags === 'object') {
        const f = body.flags;
        const okCode = (c) => /^[a-z0-9]{1,12}$/.test(String(c));

        db.flags = {
          on: f.on !== false,
          off: Object.fromEntries(
            Object.keys(f.off || {})
              .filter(okCode)
              .map((c) => [c, true])
          ),
          custom: (Array.isArray(f.custom) ? f.custom : [])
            .slice(0, 60)
            .filter((c) => c && okCode(c.code))
            .map((c) => ({
              code: String(c.code),
              name: String(c.name || c.code).slice(0, 40),
              aliases: (Array.isArray(c.aliases) ? c.aliases : [])
                .slice(0, 12)
                .map((a) => String(a).slice(0, 30))
            }))
        };
      }

      if (body.lifeSettings && typeof body.lifeSettings === 'object') {
        db.lifeSet = true;
      }

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

      // احذف مواقف الطائرات المحذوفة من التخطيط
      if (Array.isArray(db.layout.planes)) {
        const ids = new Set(db.layout.planes.map((p) => p.id));
        Object.keys(db.planeParks).forEach((id) => {
          if (!ids.has(id)) delete db.planeParks[id];
        });
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
        if (await handleStoryEvents(entry)) assignPlots();
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
              ch.value.text,
              ch.value.media && ch.value.media.id
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

  // لوحة التحكم
  if (
    req.method === 'GET' &&
    (url.pathname === '/admin' || url.pathname === '/admin.html')
  ) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'));
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      return send(res, 404, 'admin.html not found', 'text/plain');
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
