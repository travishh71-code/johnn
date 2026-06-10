/* ============================================================================
   JOHN'S SLOTS — backend server
   Express + Socket.IO + JSON file persistence (no native deps).
   ----------------------------------------------------------------------------
   IMPORTANT (read me): This is a software template / demo. Balances and prizes
   are VIRTUAL credits, not real money. Running a real-money gambling service
   requires licensing, age verification (18+/21+), KYC/AML, geo-restrictions and
   a payment processor, and it is regulated or illegal in many jurisdictions.
   ========================================================================== */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// DATA_DIR lets the data + secret files live on a persistent disk in production
// (e.g. Render disk mounted at /var/data). Defaults to this folder for local runs.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

/* ---------- JWT secret (persisted so logins survive restarts) ------------- */
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); }
  catch {
    const s = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(SECRET_FILE, s); } catch {}
    return s;
  }
}
const JWT_SECRET = loadSecret();

/* ---------- Tiny JSON "database" ------------------------------------------ */
const defaultData = {
  users: {},          // username -> { username, passHash, email, balance, isAdmin, vip, employee, createdAt, lastDailySpin, spinHistory[], vault[], lastBonusSpinDate }
  announcements: [],   // { id, title, body, createdAt }
  giveaways: [],       // { id, title, body, prize, endsAt, createdAt }
  redemptions: [],     // { id, code, username, amount, status, createdAt, expiresAt, claimedAt, claimedBy, note }
  downloads: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, label: `Game ${i + 1}`, url: '' })),
  feedbacks: [],       // { id, username, message, createdAt }            (admin-only view)
  posts: [],           // { id, caption, image, createdAt }               (admin publishes)
  stories: [],         // { id, caption, image, createdAt, expiresAt }    (24h, facebook-style)
  bonusSpins: [],      // { id, username, percent, at, status, claimedAt, claimedBy }
  reports: [],         // { id, employee, date 'YYYY-MM-DD', cashIn, cashOut, submittedBy, at }
  settings: { fbLink1: '', fbLink2: '' },
  draw: {
    participants: [],  // up to 10 strings
    spinTime: '20:00', // HH:MM in SERVER local time
    lastSpinDate: null,// 'YYYY-MM-DD' guard so daily auto-spin fires once/day
    lastResult: null   // { winner, index, at }
  }
};

let db;
function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // merge in any missing top-level keys
    db = Object.assign({}, structuredClone(defaultData), db);
    db.draw = Object.assign({}, defaultData.draw, db.draw || {});
    db.settings = Object.assign({}, defaultData.settings, db.settings || {});
  } catch {
    db = structuredClone(defaultData);
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), () => {});
  }, 50);
}
load();

/* ---------- Seed an admin account on first run ---------------------------- */
(function seedAdmin() {
  const adminUser = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (!db.users[adminUser]) {
    db.users[adminUser] = {
      username: adminUser,
      passHash: bcrypt.hashSync(adminPass, 10),
      balance: 0,
      isAdmin: true,
      createdAt: Date.now(),
      lastDailySpin: null,
      spinHistory: []
    };
    save();
    console.log(`\n  ▶ Admin account ready  ->  username: "${adminUser}"  password: "${adminPass}"`);
    console.log('    Change ADMIN_PASSWORD (env) before deploying anywhere public.\n');
  }
})();

/* ---------- Helpers ------------------------------------------------------- */
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hhmm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const round2 = (n) => Math.round(n * 100) / 100;
const id = () => crypto.randomUUID();

/* ---------- Username namespace + redemption settings ---------------------- */
const USER_PREFIX   = 'john@';            // every player handle is stored as john@<handle>
const MIN_REDEEM    = 1;                  // $ minimum balance required to redeem
const REDEEM_TTL_MS = 24 * 60 * 60 * 1000; // receipts expire 24h after redeeming
// personal lucky spin: one spin per hour (override with SPIN_COOLDOWN_MIN, in minutes)
const _spinMin = Number(process.env.SPIN_COOLDOWN_MIN);
const SPIN_COOLDOWN_MS = (Number.isFinite(_spinMin) && _spinMin > 0 ? _spinMin : 60) * 60 * 1000;

// turn whatever the user typed into a clean handle (no prefix), e.g. "John@Player" -> "player"
function cleanHandle(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^john@/, '');
}
// receipt code like JS-7F3A-9K21 (ambiguous chars removed)
function genReceiptCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => abc[crypto.randomInt(0, abc.length)]).join('');
  let code;
  do { code = `JS-${block()}-${block()}`; } while (db.redemptions.some(r => r.code === code));
  return code;
}

/* personal lucky spin timing (hourly). lastDailySpin now holds a timestamp;
   legacy date-strings are treated as "never spun" so old accounts can spin. */
function lastSpinMs(u) {
  const t = u && u.lastDailySpin;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}
function canSpinNow(u) { return Date.now() - lastSpinMs(u) >= SPIN_COOLDOWN_MS; }
function nextSpinAt(u) { const t = lastSpinMs(u); return t ? t + SPIN_COOLDOWN_MS : 0; }

/* ---------- Employees (admin reports) & deposit bonus wheel ---------------- */
const EMPLOYEES = ['Famous', 'Hulk', 'Travis'];                 // the 3 fixed agents
const BONUS_PERCENTS = [10, 12, 15, 17, 20, 22, 25, 30];        // deposit bonus wheel
function canBonusSpin(u) { return (u.lastBonusSpinDate || null) !== todayStr(); }

function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    email: u.email || '',
    balance: round2(u.balance),
    isAdmin: !!u.isAdmin,
    vip: !!u.vip,
    employee: u.employee || null,
    lastSpin: lastSpinMs(u) || null,
    canSpin: canSpinNow(u),
    nextSpinAt: nextSpinAt(u),
    spinCooldownMs: SPIN_COOLDOWN_MS,
    spinHistory: (u.spinHistory || []).slice(-20),
    canBonusSpin: canBonusSpin(u)
  };
}

function sign(username) {
  return jwt.sign({ u: username }, JWT_SECRET, { expiresIn: '30d' });
}
function userFromToken(token) {
  try {
    const { u } = jwt.verify(token, JWT_SECRET);
    return db.users[u] || null;
  } catch { return null; }
}

/* ---------- Personal lucky spin (hourly): weighted prize table ($0.10–$3.00) -- */
const PRIZES = [
  { v: 0.10, w: 30 }, { v: 0.20, w: 22 }, { v: 0.30, w: 16 },
  { v: 0.50, w: 12 }, { v: 0.75, w: 8 }, { v: 1.00, w: 6 },
  { v: 1.50, w: 3 }, { v: 2.00, w: 2 }, { v: 3.00, w: 1 }
];
const PRIZE_VALUES = PRIZES.map(p => p.v); // exposed to client for the reel UI
function drawPrize() {
  const total = PRIZES.reduce((s, p) => s + p.w, 0);
  let r = crypto.randomInt(0, total);
  for (const p of PRIZES) { if (r < p.w) return p.v; r -= p.w; }
  return PRIZES[0].v;
}

/* ============================================================================
   Express app
   ========================================================================== */
const app = express();
app.use(express.json({ limit: '8mb' }));            // larger limit so posts/stories can carry base64 images
app.use(express.static(path.join(__dirname, 'public')));

/* uploaded post / story images persist on disk next to data.json */
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
app.use('/uploads', express.static(UPLOAD_DIR));

/* save a data-URL image to /uploads, return its public path (or null) */
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) return null;     // 5MB cap per image
  const name = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}
function deleteImage(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(publicPath))); } catch {}
}

// auth middleware
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const u = userFromToken(token);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  req.user = u;
  next();
}
function adminOnly(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admins only' });
  next();
}

/* ---------------------------- AUTH ---------------------------------------- */
app.post('/api/auth/register', (req, res) => {
  let { username, password, email } = req.body || {};
  const handle = cleanHandle(username);          // strip any john@ the user typed
  password = String(password || '');
  email = String(email || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(handle))
    return res.status(400).json({ error: 'Username: 3–20 chars, letters / numbers / underscore.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return res.status(400).json({ error: 'That email doesn\u2019t look valid.' });

  const full = USER_PREFIX + handle;             // stored + displayed as john@<handle>
  if (db.users[full])
    return res.status(409).json({ error: 'That username is taken.' });

  db.users[full] = {
    username: full,
    passHash: bcrypt.hashSync(password, 10),
    email,
    balance: 0,
    isAdmin: false,
    vip: false,
    employee: null,
    createdAt: Date.now(),
    lastDailySpin: null,
    spinHistory: [],
    vault: [],
    lastBonusSpinDate: null
  };
  save();
  res.json({ token: sign(full), user: publicUser(db.users[full]) });
});

app.post('/api/auth/login', (req, res) => {
  let { username, password } = req.body || {};
  const raw = String(username || '').trim().toLowerCase();
  password = String(password || '');
  // accept the literal value first (admin / legacy), otherwise try the john@<handle> form
  let u = db.users[raw];
  if (!u && !raw.startsWith(USER_PREFIX)) u = db.users[USER_PREFIX + raw];
  if (!u || !bcrypt.compareSync(password, u.passHash))
    return res.status(401).json({ error: 'Invalid username or password.' });
  res.json({ token: sign(u.username), user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

/* ---------------------------- HOURLY SPIN --------------------------------- */
app.get('/api/spin/config', (req, res) => res.json({ prizes: PRIZE_VALUES, cooldownMs: SPIN_COOLDOWN_MS }));

app.post('/api/spin', auth, (req, res) => {
  const u = req.user;
  if (!canSpinNow(u)) {
    const waitMs = Math.max(0, nextSpinAt(u) - Date.now());
    const mins = Math.max(1, Math.ceil(waitMs / 60000));
    return res.status(429).json({
      error: `Your next spin unlocks in ${mins} minute${mins === 1 ? '' : 's'}.`,
      nextSpinAt: nextSpinAt(u), spinCooldownMs: SPIN_COOLDOWN_MS
    });
  }
  const prize = drawPrize();
  u.balance = round2((u.balance || 0) + prize);
  u.lastDailySpin = Date.now();                 // timestamp -> drives the hourly cooldown
  u.spinHistory = u.spinHistory || [];
  u.spinHistory.push({ amount: prize, at: Date.now() });
  save();
  res.json({
    prize, balance: u.balance, prizes: PRIZE_VALUES,
    canSpin: false, nextSpinAt: u.lastDailySpin + SPIN_COOLDOWN_MS, spinCooldownMs: SPIN_COOLDOWN_MS
  });
});

/* ---------------------------- ANNOUNCEMENTS ------------------------------- */
app.get('/api/announcements', (req, res) =>
  res.json({ items: [...db.announcements].sort((a, b) => b.createdAt - a.createdAt) }));

app.post('/api/announcements', auth, adminOnly, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  if (!title) return res.status(400).json({ error: 'Title required.' });
  const item = { id: id(), title, body, createdAt: Date.now() };
  db.announcements.push(item); save();
  io.emit('announcement:new', item);
  res.json({ item });
});

app.delete('/api/announcements/:id', auth, adminOnly, (req, res) => {
  db.announcements = db.announcements.filter(a => a.id !== req.params.id);
  save(); io.emit('announcement:remove', req.params.id);
  res.json({ ok: true });
});

/* ---------------------------- GIVEAWAYS ----------------------------------- */
app.get('/api/giveaways', (req, res) =>
  res.json({ items: [...db.giveaways].sort((a, b) => b.createdAt - a.createdAt) }));

app.post('/api/giveaways', auth, adminOnly, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim();
  const prize = String(req.body?.prize || '').trim();
  const endsAt = req.body?.endsAt ? Number(new Date(req.body.endsAt)) : null;
  if (!title) return res.status(400).json({ error: 'Title required.' });
  const item = { id: id(), title, body, prize, endsAt, createdAt: Date.now() };
  db.giveaways.push(item); save();
  io.emit('giveaway:new', item);
  res.json({ item });
});

app.delete('/api/giveaways/:id', auth, adminOnly, (req, res) => {
  db.giveaways = db.giveaways.filter(g => g.id !== req.params.id);
  save(); io.emit('giveaway:remove', req.params.id);
  res.json({ ok: true });
});

/* ---------------------------- DOWNLOADS ----------------------------------- */
app.get('/api/downloads', (req, res) => res.json({ items: db.downloads }));

app.put('/api/downloads', auth, adminOnly, (req, res) => {
  const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
  db.downloads = incoming.slice(0, 10).map((it, i) => ({
    id: i + 1,
    label: String(it.label || `Game ${i + 1}`).slice(0, 60),
    url: String(it.url || '').slice(0, 500)
  }));
  while (db.downloads.length < 10)
    db.downloads.push({ id: db.downloads.length + 1, label: `Game ${db.downloads.length + 1}`, url: '' });
  save(); io.emit('downloads:update', db.downloads);
  res.json({ items: db.downloads });
});

/* ---------------------------- LUCKY DRAW ---------------------------------- */
let activeSpin = null; // in-memory record of an in-progress spin (for late joiners)

function secondsUntilSpin() {
  const [h, m] = db.draw.spinTime.split(':').map(Number);
  const now = new Date();
  const t = new Date(now);
  t.setHours(h || 0, m || 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return Math.max(0, Math.floor((t - now) / 1000));
}
function serverClockStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function drawState() {
  return {
    participants: db.draw.participants,
    spinTime: db.draw.spinTime,
    lastResult: db.draw.lastResult,
    lastSpinDate: db.draw.lastSpinDate,
    serverTime: Date.now(),
    serverClock: serverClockStr(),
    nextSpinInSeconds: secondsUntilSpin(),
    active: activeSpin
  };
}

app.get('/api/draw', (req, res) => res.json(drawState()));

app.put('/api/draw', auth, adminOnly, (req, res) => {
  let parts = Array.isArray(req.body?.participants) ? req.body.participants : db.draw.participants;
  parts = parts.map(p => String(p || '').trim()).filter(Boolean).slice(0, 10);
  db.draw.participants = parts;
  if (typeof req.body?.spinTime === 'string' && /^\d{2}:\d{2}$/.test(req.body.spinTime))
    db.draw.spinTime = req.body.spinTime;
  save();
  io.emit('draw:update', drawState());
  res.json(drawState());
});

const SPIN_DURATION_MS = 9000;
const SPIN_TURNS = 8;

function runDraw(reason = 'manual') {
  const parts = db.draw.participants;
  if (!parts.length) return { error: 'No participants set.' };
  if (activeSpin) return { error: 'A draw is already spinning.' };

  const winnerIndex = crypto.randomInt(0, parts.length);
  const startAt = Date.now() + 1200; // small lead-in so all clients sync the start
  activeSpin = {
    participants: [...parts],
    winnerIndex,
    winner: parts[winnerIndex],
    startAt,
    durationMs: SPIN_DURATION_MS,
    turns: SPIN_TURNS,
    reason
  };
  io.emit('draw:spin', activeSpin);

  setTimeout(() => {
    const result = { winner: activeSpin.winner, index: activeSpin.winnerIndex, at: Date.now() };
    db.draw.lastResult = result;
    db.draw.lastSpinDate = todayStr();
    save();
    activeSpin = null;
    io.emit('draw:result', result);
    io.emit('draw:update', drawState());
  }, (startAt - Date.now()) + SPIN_DURATION_MS + 600);

  return { ok: true, startAt };
}

app.post('/api/draw/spin', auth, adminOnly, (req, res) => {
  const r = runDraw('manual');
  if (r.error) return res.status(400).json(r);
  res.json(r);
});

/* Auto daily spin: checks every 20s; fires once when server clock hits spinTime */
setInterval(() => {
  if (!db.draw.participants.length || activeSpin) return;
  if (db.draw.spinTime === hhmm() && db.draw.lastSpinDate !== todayStr()) {
    console.log('⏰ Auto daily draw firing at', hhmm());
    runDraw('scheduled');
  }
}, 20000);

/* Expire receipts past their 24h window (also enforced lazily on every read) */
setInterval(expireStaleRedemptions, 60 * 1000);

/* ---------------------------- ADMIN: users -------------------------------- */
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const list = Object.values(db.users)
    .map(u => ({
      username: u.username, email: u.email || '', balance: round2(u.balance),
      isAdmin: !!u.isAdmin, vip: !!u.vip, employee: u.employee || null, createdAt: u.createdAt
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json({ users: list });
});

/* admin: grant / remove the VIP badge */
app.post('/api/admin/users/:username/vip', auth, adminOnly, (req, res) => {
  const u = db.users[String(req.params.username).toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found.' });
  u.vip = !!req.body?.vip;
  save();
  io.emit('user:update', { username: u.username });
  res.json({ username: u.username, vip: u.vip });
});

/* admin: link an account to one of the 3 employees (Famous / Hulk / Travis) */
app.post('/api/admin/users/:username/employee', auth, adminOnly, (req, res) => {
  const u = db.users[String(req.params.username).toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const e = req.body?.employee ? String(req.body.employee) : null;
  if (e && !EMPLOYEES.includes(e))
    return res.status(400).json({ error: `Employee must be one of: ${EMPLOYEES.join(', ')}.` });
  // an employee name can only be linked to one account at a time
  if (e) for (const other of Object.values(db.users))
    if (other !== u && other.employee === e) other.employee = null;
  u.employee = e;
  save();
  io.emit('user:update', { username: u.username });
  res.json({ username: u.username, employee: u.employee });
});

app.post('/api/admin/users/:username/balance', auth, adminOnly, (req, res) => {
  const u = db.users[String(req.params.username).toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const delta = Number(req.body?.delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'delta must be a number.' });
  u.balance = round2((u.balance || 0) + delta);
  save();
  res.json({ username: u.username, balance: u.balance });
});

/* admin: set / reset a user's password */
app.post('/api/admin/users/:username/password', auth, adminOnly, (req, res) => {
  const u = db.users[String(req.params.username).toLowerCase()];
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  u.passHash = bcrypt.hashSync(pw, 10);
  save();
  res.json({ ok: true, username: u.username });
});

/* ============================================================================
   FEEDBACKS — any player can submit; only admins can read them.
   ========================================================================== */
app.post('/api/feedback', auth, (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 1000);
  if (!message) return res.status(400).json({ error: 'Write something first.' });
  const item = { id: id(), username: req.user.username, message, createdAt: Date.now() };
  db.feedbacks.push(item); save();
  io.emit('feedback:new', { id: item.id });        // nudge admin dashboards
  res.json({ ok: true });
});
app.get('/api/admin/feedbacks', auth, adminOnly, (req, res) => {
  res.json({ items: [...db.feedbacks].sort((a, b) => b.createdAt - a.createdAt) });
});
app.delete('/api/admin/feedbacks/:id', auth, adminOnly, (req, res) => {
  db.feedbacks = db.feedbacks.filter(f => f.id !== req.params.id);
  save(); res.json({ ok: true });
});

/* ============================================================================
   POSTS & 24h STORIES — admin publishes; everyone logged in can view.
   ========================================================================== */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;
function pruneStories() {
  const now = Date.now();
  const dead = db.stories.filter(s => now >= s.expiresAt);
  if (!dead.length) return;
  dead.forEach(s => deleteImage(s.image));
  db.stories = db.stories.filter(s => now < s.expiresAt);
  save();
}
setInterval(pruneStories, 60 * 1000);

app.get('/api/posts', auth, (req, res) => {
  pruneStories();
  res.json({
    posts: [...db.posts].sort((a, b) => b.createdAt - a.createdAt),
    stories: [...db.stories].sort((a, b) => b.createdAt - a.createdAt)
  });
});
app.post('/api/admin/posts', auth, adminOnly, (req, res) => {
  const caption = String(req.body?.caption || '').trim().slice(0, 1000);
  const image = req.body?.imageData ? saveImage(req.body.imageData) : null;
  if (!caption && !image) return res.status(400).json({ error: 'Add a caption or an image.' });
  if (req.body?.imageData && !image) return res.status(400).json({ error: 'Image must be PNG/JPG/WEBP/GIF under 5MB.' });
  const item = { id: id(), caption, image, createdAt: Date.now() };
  db.posts.push(item); save();
  io.emit('post:new', { id: item.id });
  res.json({ item });
});
app.delete('/api/admin/posts/:id', auth, adminOnly, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (p) deleteImage(p.image);
  db.posts = db.posts.filter(x => x.id !== req.params.id);
  save(); io.emit('post:new', {});
  res.json({ ok: true });
});
app.post('/api/admin/stories', auth, adminOnly, (req, res) => {
  const caption = String(req.body?.caption || '').trim().slice(0, 200);
  const image = saveImage(req.body?.imageData);
  if (!image) return res.status(400).json({ error: 'A story needs an image (PNG/JPG/WEBP/GIF under 5MB).' });
  const now = Date.now();
  const item = { id: id(), caption, image, createdAt: now, expiresAt: now + STORY_TTL_MS };
  db.stories.push(item); save();
  io.emit('post:new', { id: item.id });
  res.json({ item });
});
app.delete('/api/admin/stories/:id', auth, adminOnly, (req, res) => {
  const s = db.stories.find(x => x.id === req.params.id);
  if (s) deleteImage(s.image);
  db.stories = db.stories.filter(x => x.id !== req.params.id);
  save(); io.emit('post:new', {});
  res.json({ ok: true });
});

/* ============================================================================
   GAME VAULT — a private notepad where each player saves game credentials.
   Only the owner can read their own vault.
   ========================================================================== */
function publicVault(u) { return (u.vault || []).slice().reverse(); }
app.get('/api/vault', auth, (req, res) => res.json({ items: publicVault(req.user) }));
app.post('/api/vault', auth, (req, res) => {
  const u = req.user;
  const game = String(req.body?.game || '').trim().slice(0, 60);
  const username = String(req.body?.username || '').trim().slice(0, 80);
  const password = String(req.body?.password || '').slice(0, 120);
  const notes = String(req.body?.notes || '').trim().slice(0, 400);
  if (!game) return res.status(400).json({ error: 'Game name is required.' });
  u.vault = u.vault || [];
  if (u.vault.length >= 50) return res.status(400).json({ error: 'Vault is full (50 entries max).' });
  const item = { id: id(), game, username, password, notes, createdAt: Date.now() };
  u.vault.push(item); save();
  res.json({ item, items: publicVault(u) });
});
app.put('/api/vault/:id', auth, (req, res) => {
  const u = req.user;
  const it = (u.vault || []).find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Entry not found.' });
  if (req.body?.game !== undefined)     it.game = String(req.body.game).trim().slice(0, 60) || it.game;
  if (req.body?.username !== undefined) it.username = String(req.body.username).trim().slice(0, 80);
  if (req.body?.password !== undefined) it.password = String(req.body.password).slice(0, 120);
  if (req.body?.notes !== undefined)    it.notes = String(req.body.notes).trim().slice(0, 400);
  save();
  res.json({ item: it, items: publicVault(u) });
});
app.delete('/api/vault/:id', auth, (req, res) => {
  const u = req.user;
  u.vault = (u.vault || []).filter(x => x.id !== req.params.id);
  save();
  res.json({ items: publicVault(u) });
});

/* ============================================================================
   DEPOSIT BONUS WHEEL — 10/12/15/17/20/22/25/30 %, one spin per day.
   Result is recorded so the player can claim it with an agent, and every
   spin shows up on the admin side.
   ========================================================================== */
function publicBonus(b) {
  return { id: b.id, username: b.username, percent: b.percent, at: b.at,
           status: b.status, claimedAt: b.claimedAt || null, claimedBy: b.claimedBy || null };
}
app.get('/api/bonus/config', auth, (req, res) => {
  res.json({
    percents: BONUS_PERCENTS,
    canSpin: canBonusSpin(req.user),
    mine: db.bonusSpins.filter(b => b.username === req.user.username).slice(-10).reverse().map(publicBonus)
  });
});
app.post('/api/bonus/spin', auth, (req, res) => {
  const u = req.user;
  if (!canBonusSpin(u))
    return res.status(429).json({ error: 'You already spun the bonus wheel today — come back tomorrow!' });
  const idx = crypto.randomInt(0, BONUS_PERCENTS.length);
  const percent = BONUS_PERCENTS[idx];
  const b = { id: id(), username: u.username, percent, at: Date.now(),
              status: 'unclaimed', claimedAt: null, claimedBy: null };
  db.bonusSpins.push(b);
  u.lastBonusSpinDate = todayStr();
  save();
  io.emit('bonus:new', { username: u.username, percent }); // agents/admin see it instantly
  res.json({ percent, index: idx, percents: BONUS_PERCENTS, bonus: publicBonus(b), canSpin: false });
});
app.get('/api/admin/bonus', auth, adminOnly, (req, res) => {
  res.json({ items: [...db.bonusSpins].sort((a, b) => b.at - a.at).slice(0, 200).map(publicBonus) });
});
app.post('/api/admin/bonus/:id/claim', auth, adminOnly, (req, res) => {
  const b = db.bonusSpins.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: 'Bonus not found.' });
  if (b.status === 'claimed') return res.status(400).json({ error: 'Already claimed.' });
  b.status = 'claimed'; b.claimedAt = Date.now(); b.claimedBy = req.user.username;
  save();
  io.emit('bonus:update', { id: b.id });
  res.json({ bonus: publicBonus(b) });
});

/* ============================================================================
   EMPLOYEE REPORTS — Famous / Hulk / Travis each submit a daily cash-in and
   cash-out. The admin panel totals them per day and per month
   (profit = cash in − cash out).
   ========================================================================== */
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
function upsertReport(employee, date, cashIn, cashOut, by) {
  let r = db.reports.find(x => x.employee === employee && x.date === date);
  if (!r) { r = { id: id(), employee, date, cashIn: 0, cashOut: 0, submittedBy: by, at: Date.now() }; db.reports.push(r); }
  r.cashIn = round2(cashIn); r.cashOut = round2(cashOut);
  r.submittedBy = by; r.at = Date.now();
  save();
  return r;
}

/* employee (or admin on their behalf) submits today's numbers */
app.post('/api/reports', auth, (req, res) => {
  let employee = req.user.employee;
  if (req.user.isAdmin && req.body?.employee) employee = String(req.body.employee);
  if (!employee || !EMPLOYEES.includes(employee))
    return res.status(403).json({ error: 'Only Famous, Hulk or Travis (or an admin) can submit reports.' });
  const date = dateRe.test(String(req.body?.date || '')) ? req.body.date : todayStr();
  const cashIn = Number(req.body?.cashIn), cashOut = Number(req.body?.cashOut);
  if (!Number.isFinite(cashIn) || !Number.isFinite(cashOut) || cashIn < 0 || cashOut < 0)
    return res.status(400).json({ error: 'Cash in and cash out must be numbers (0 or more).' });
  const r = upsertReport(employee, date, cashIn, cashOut, req.user.username);
  io.emit('report:update', { date: r.date });
  res.json({ report: r });
});

/* an employee sees their own recent submissions */
app.get('/api/reports/mine', auth, (req, res) => {
  if (!req.user.employee) return res.status(403).json({ error: 'Not an employee account.' });
  const items = db.reports.filter(r => r.employee === req.user.employee)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 31);
  res.json({ employee: req.user.employee, items });
});

/* admin: daily breakdown + monthly totals for a given month (YYYY-MM) */
app.get('/api/admin/reports', auth, adminOnly, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : todayStr().slice(0, 7);
  const rows = db.reports.filter(r => r.date.startsWith(month + '-'));
  const byDate = {};
  for (const r of rows) {
    (byDate[r.date] = byDate[r.date] || { date: r.date, entries: {}, cashIn: 0, cashOut: 0 });
    byDate[r.date].entries[r.employee] = { cashIn: r.cashIn, cashOut: r.cashOut, submittedBy: r.submittedBy, at: r.at };
    byDate[r.date].cashIn = round2(byDate[r.date].cashIn + r.cashIn);
    byDate[r.date].cashOut = round2(byDate[r.date].cashOut + r.cashOut);
  }
  const days = Object.values(byDate)
    .map(d => ({ ...d, profit: round2(d.cashIn - d.cashOut), complete: EMPLOYEES.every(e => d.entries[e]) }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const monthTotal = {
    cashIn: round2(days.reduce((s, d) => s + d.cashIn, 0)),
    cashOut: round2(days.reduce((s, d) => s + d.cashOut, 0))
  };
  monthTotal.profit = round2(monthTotal.cashIn - monthTotal.cashOut);
  res.json({ month, employees: EMPLOYEES, days, monthTotal });
});

/* ============================================================================
   SETTINGS — Facebook page links (admin edits, everyone sees).
   ========================================================================== */
app.get('/api/settings', (req, res) =>
  res.json({ fbLink1: db.settings.fbLink1 || '', fbLink2: db.settings.fbLink2 || '' }));
app.put('/api/admin/settings', auth, adminOnly, (req, res) => {
  const clean = v => String(v || '').trim().slice(0, 500);
  if (req.body?.fbLink1 !== undefined) db.settings.fbLink1 = clean(req.body.fbLink1);
  if (req.body?.fbLink2 !== undefined) db.settings.fbLink2 = clean(req.body.fbLink2);
  save();
  io.emit('settings:update', { fbLink1: db.settings.fbLink1, fbLink2: db.settings.fbLink2 });
  res.json({ fbLink1: db.settings.fbLink1, fbLink2: db.settings.fbLink2 });
});

/* ============================================================================
   REDEMPTIONS — players cash out their balance into a receipt code.
   • Balance must be >= MIN_REDEEM to redeem.
   • Redeeming zeroes the balance immediately and mints a receipt.
   • A receipt is valid for 24h; if it isn't claimed by an admin in time it
     expires and the value is lost (balance stays 0).
   • Admin "claims" a receipt once the credits are loaded into the player's game.
   ========================================================================== */
function expireStaleRedemptions() {
  const now = Date.now();
  let changed = false;
  for (const r of db.redemptions)
    if (r.status === 'pending' && now >= r.expiresAt) { r.status = 'expired'; changed = true; }
  if (changed) save();
  return changed;
}
function publicRedemption(r) {
  return {
    id: r.id, code: r.code, username: r.username, amount: round2(r.amount),
    status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt,
    claimedAt: r.claimedAt || null, claimedBy: r.claimedBy || null, note: r.note || ''
  };
}

/* player: redeem the whole current balance */
app.post('/api/redeem', auth, (req, res) => {
  expireStaleRedemptions();
  const u = req.user;
  const amount = round2(u.balance || 0);
  if (amount < MIN_REDEEM)
    return res.status(400).json({ error: `You need at least $${MIN_REDEEM.toFixed(2)} to redeem.` });

  const now = Date.now();
  const r = {
    id: id(), code: genReceiptCode(), username: u.username, amount,
    status: 'pending', createdAt: now, expiresAt: now + REDEEM_TTL_MS,
    claimedAt: null, claimedBy: null, note: ''
  };
  db.redemptions.push(r);
  u.balance = 0;                       // balance disappears the moment it's redeemed
  save();
  io.emit('redemption:new', { username: u.username });   // nudge admin dashboards
  res.json({ receipt: publicRedemption(r), balance: 0, ttlMs: REDEEM_TTL_MS });
});

/* player: list their own receipts */
app.get('/api/redemptions', auth, (req, res) => {
  expireStaleRedemptions();
  const items = db.redemptions
    .filter(r => r.username === req.user.username)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicRedemption);
  res.json({ items, ttlMs: REDEEM_TTL_MS, minRedeem: MIN_REDEEM });
});

/* admin: every receipt */
app.get('/api/admin/redemptions', auth, adminOnly, (req, res) => {
  expireStaleRedemptions();
  const items = [...db.redemptions].sort((a, b) => b.createdAt - a.createdAt).map(publicRedemption);
  res.json({ items, ttlMs: REDEEM_TTL_MS });
});

/* admin: mark a receipt loaded into the player's game */
app.post('/api/admin/redemptions/:id/claim', auth, adminOnly, (req, res) => {
  expireStaleRedemptions();
  const r = db.redemptions.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Receipt not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: `Receipt is already ${r.status}.` });
  r.status = 'claimed';
  r.claimedAt = Date.now();
  r.claimedBy = req.user.username;
  r.note = String(req.body?.note || '').slice(0, 120);
  save();
  io.emit('redemption:update', { id: r.id });
  res.json({ receipt: publicRedemption(r) });
});

/* admin: refund a pending receipt back to the player's balance (safety valve) */
app.post('/api/admin/redemptions/:id/refund', auth, adminOnly, (req, res) => {
  expireStaleRedemptions();
  const r = db.redemptions.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Receipt not found.' });
  if (r.status !== 'pending') return res.status(400).json({ error: `Only pending receipts can be refunded (this is ${r.status}).` });
  const u = db.users[r.username];
  if (u) u.balance = round2((u.balance || 0) + r.amount);
  r.status = 'refunded';
  r.claimedAt = Date.now();
  r.claimedBy = req.user.username;
  save();
  io.emit('redemption:update', { id: r.id });
  res.json({ receipt: publicRedemption(r), refundedTo: r.username });
});

/* fallback to index for any unknown route (SPA) */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ============================================================================
   Socket.IO — realtime presence + draw broadcasts
   ========================================================================== */
const server = http.createServer(app);
const io = new Server(server);

let onlineCount = 0;
io.on('connection', (socket) => {
  onlineCount++;
  io.emit('presence', onlineCount);
  socket.emit('draw:state', drawState());

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit('presence', onlineCount);
  });
});

server.listen(PORT, () => {
  console.log(`\n  🎰  JOHN'S SLOTS running -> http://localhost:${PORT}\n`);
});
