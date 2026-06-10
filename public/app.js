/* ============================================================================
   JOHN'S SLOTS — client
   ========================================================================== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = n => '$' + Number(n || 0).toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* token lives in sessionStorage by default (so closing the tab logs you out);
   ticking "keep me signed in" moves it to localStorage instead */
let token = localStorage.getItem('js_token') || sessionStorage.getItem('js_token') || null;
function storeToken(t, remember) {
  token = t;
  localStorage.removeItem('js_token');
  sessionStorage.removeItem('js_token');
  (remember ? localStorage : sessionStorage).setItem('js_token', t);
}
function clearToken() {
  localStorage.removeItem('js_token');
  sessionStorage.removeItem('js_token');
  token = null;
}
let me = null;
let MIN_REDEEM = 1;                         // updated from server
let REDEEM_TTL_MS = 24 * 60 * 60 * 1000;    // updated from server
let receiptsCache = [];
let prizes = [0.10,0.20,0.30,0.50,0.75,1.00,1.50,2.00,3.00];
let socket = null;
let serverOffset = 0;           // serverTime - clientTime
let spinning = false;           // wheel busy
let reelSpinning = false;       // personal slot reel busy (separate from the draw wheel)
let cdSec = null;               // countdown seconds (null = paused)
let drawCache = { participants: [], lastResult: null };

/* ---------- api + toast --------------------------------------------------- */
async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3200);
}
function party() {
  if (!window.confetti) return;
  confetti({ particleCount: 150, spread: 80, origin: { y: .6 }, colors: ['#ffd35a','#8a4bff','#ff3ea5','#21e8c9','#ffffff'] });
}

/* ============================================================================
   AUTH
   ========================================================================== */
$('#tabLogin').onclick = () => { $('#tabLogin').classList.add('active'); $('#tabSignup').classList.remove('active'); $('#formLogin').classList.remove('hidden'); $('#formSignup').classList.add('hidden'); };
$('#tabSignup').onclick = () => { $('#tabSignup').classList.add('active'); $('#tabLogin').classList.remove('active'); $('#formSignup').classList.remove('hidden'); $('#formLogin').classList.add('hidden'); };

$('#formLogin').addEventListener('submit', async e => {
  e.preventDefault();                                  // real <form> submit -> browser offers to save the password
  try {
    const d = await api('POST', '/api/auth/login', { username: $('#liUser').value, password: $('#liPass').value });
    storeToken(d.token, $('#liRemember').checked);
    enterApp(d.user);
  } catch (err) { toast(err.message, 'err'); }
});
$('#formSignup').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const d = await api('POST', '/api/auth/register', {
      username: $('#suUser').value, password: $('#suPass').value, email: $('#suEmail').value
    });
    storeToken(d.token, $('#suRemember').checked);
    enterApp(d.user); toast('Welcome to the floor 🎰', 'ok');
  } catch (err) { toast(err.message, 'err'); }
});
// live "john@<handle>" preview on the signup field
$('#suUser').addEventListener('input', () => {
  const h = ($('#suUser').value || '').trim().toLowerCase().replace(/^john@/, '') || 'yourname';
  $('#suPreview').textContent = 'john@' + h;
});
$('#logout').onclick = () => { clearToken(); location.reload(); };

/* ============================================================================
   NAV  (top bar + mobile bottom bar share one switcher)
   ========================================================================== */
function switchView(view) {
  const target = $('#view-' + view);
  if (!target) return;
  $$('.view').forEach(v => v.classList.remove('active'));
  target.classList.add('active');
  $$('#nav button, #mnav button').forEach(x => x.classList.toggle('active', x.dataset.view === view));
  const mb = $(`#mnav button[data-view="${view}"]`);
  if (mb) mb.scrollIntoView({ inline: 'center', block: 'nearest' });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'wallet') loadWallet();
  if (view === 'feed') loadFeed();
  if (view === 'bonus') loadBonus();
  if (view === 'vault') loadVault();
  if (view === 'reports' && me?.employee) loadMyReports();
  if (view === 'admin' && me?.isAdmin) loadAdminRedemptions();
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) switchView(b.dataset.view); });
$('#mnav').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) switchView(b.dataset.view); });
$('#heroRedeem').onclick = () => switchView('wallet');

$('#admTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-panel]'); if (!b) return;
  $$('#admTabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $$('.panel').forEach(p => p.classList.remove('active'));
  $('#panel-' + b.dataset.panel).classList.add('active');
  if (b.dataset.panel === 'redeem') loadAdminRedemptions();
  if (b.dataset.panel === 'users') loadUsers();
  if (b.dataset.panel === 'feedback') loadFeedbacks();
  if (b.dataset.panel === 'posts') loadAdminPosts();
  if (b.dataset.panel === 'bonus') loadAdminBonus();
  if (b.dataset.panel === 'reports') loadAdminReports();
  if (b.dataset.panel === 'settings') loadSettingsForm();
});

/* ============================================================================
   ENTER APP
   ========================================================================== */
async function enterApp(user) {
  me = user;
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderName();
  $('#navAdmin').classList.toggle('hidden', !me.isAdmin);
  $('#mnavAdmin').classList.toggle('hidden', !me.isAdmin);
  $('#navReports').classList.toggle('hidden', !me.employee);
  $('#mnavReports').classList.toggle('hidden', !me.employee);
  if (me.employee) $('#repWho').textContent = me.employee;

  try { const c = await api('GET', '/api/spin/config'); if (c.prizes?.length) prizes = c.prizes; } catch {}
  buildReel();
  drawBonusWheel(0);
  renderMe();

  loadAnnouncements();
  loadGiveaways();
  loadDownloads();
  loadDraw();
  loadWallet();
  loadFeed();
  loadBonus();
  loadVault();
  if (me.employee) loadMyReports();
  if (me.isAdmin) { loadUsers(); loadAdminRedemptions(); loadFeedbacks(); loadAdminPosts(); loadAdminBonus(); loadAdminReports(); loadSettingsForm(); }

  connectSocket();
}

function renderName() {
  $('#uName').innerHTML = esc(me.username) + (me.vip ? ' <span class="vip-badge">💎 VIP</span>' : '');
}

async function refreshMe() {
  try {
    const { user } = await api('GET', '/api/me'); me = user; renderMe(); renderName();
    $('#navReports').classList.toggle('hidden', !me.employee);
    $('#mnavReports').classList.toggle('hidden', !me.employee);
    if (me.employee) $('#repWho').textContent = me.employee;
  } catch {}
}

function renderMe() {
  $('#balAmt').textContent = Number(me.balance).toFixed(2);
  $('#heroBal').textContent = money(me.balance);
  if ($('#walletBal')) $('#walletBal').textContent = money(me.balance);
  updateRedeemButton();
  const hist = me.spinHistory || [];
  $('#statSpins').textContent = hist.length;
  renderSpinButton();

  const rw = $('#recentWins');
  rw.innerHTML = hist.length
    ? hist.slice().reverse().map(h => `<div class="mini"><span class="t">${money(h.amount)}</span><span class="hint">${new Date(h.at).toLocaleString()}</span></div>`).join('')
    : `<div class="hint">No spins yet — take your first spin above!</div>`;
}

function spinRemainStr(ms) {
  if (ms <= 0) return '0:00';
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function renderSpinButton() {
  const sb = $('#spinBtn'); if (!sb) return;
  if (reelSpinning) { sb.disabled = true; return; }   // don't touch mid-animation
  const now = Date.now();
  const ready = !me ? false : (me.canSpin || !me.nextSpinAt || now >= me.nextSpinAt);
  if (ready) {
    sb.disabled = false;
    sb.textContent = 'SPIN — win $0.10–$3.00';
    if ($('#statStreak')) $('#statStreak').textContent = 'Ready';
  } else {
    const left = me.nextSpinAt - now;
    sb.disabled = true;
    sb.textContent = `Next spin in ${spinRemainStr(left)} ⏳`;
    if ($('#statStreak')) $('#statStreak').textContent = spinRemainStr(left);
  }
}
/* tick the hourly countdown; auto-unlocks the button when the hour elapses */
setInterval(() => { if (me) renderSpinButton(); }, 1000);

function updateRedeemButton() {
  const b = $('#redeemBtn'); if (!b) return;
  const bal = Number(me?.balance || 0);
  const ok = bal >= MIN_REDEEM;
  b.disabled = !ok;
  b.textContent = ok ? `Redeem ${money(bal)}` : `Need ${money(MIN_REDEEM)} to redeem`;
}

/* ============================================================================
   HOURLY SPIN (slot reel)
   ========================================================================== */
const CELL = 50, CYCLES = 12;
function buildReel() {
  const reel = $('#reel');
  reel.innerHTML = '';
  for (let c = 0; c < CYCLES; c++)
    for (const p of prizes) {
      const d = document.createElement('div');
      d.className = 'cell';
      d.textContent = money(p);
      reel.appendChild(d);
    }
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0px)';
}
$('#spinBtn').onclick = async () => {
  const btn = $('#spinBtn');
  if (reelSpinning) return;
  reelSpinning = true;
  btn.disabled = true; $('#wonText').textContent = '';
  let res;
  try { res = await api('POST', '/api/spin'); }
  catch (e) {
    reelSpinning = false;
    toast(e.message, 'err');
    await refreshMe();              // resync cooldown / button from server
    return;
  }
  const idx = prizes.indexOf(res.prize);
  const final = (8 * prizes.length) + (idx < 0 ? 0 : idx);
  const reel = $('#reel');
  reel.style.transition = 'none';
  reel.style.transform = 'translateY(0px)';
  void reel.offsetWidth;
  requestAnimationFrame(() => {
    reel.style.transition = 'transform 4.4s cubic-bezier(.1,.72,.12,1)';
    reel.style.transform = `translateY(${-((final - 1) * CELL)}px)`;
  });
  setTimeout(() => {
    reelSpinning = false;
    me.balance = res.balance;
    me.canSpin = false;
    if (res.nextSpinAt) me.nextSpinAt = res.nextSpinAt;
    if (res.spinCooldownMs) me.spinCooldownMs = res.spinCooldownMs;
    me.spinHistory = (me.spinHistory || []).concat([{ amount: res.prize, at: Date.now() }]);
    renderMe();
    $('#wonText').innerHTML = `<span class="glow">+${money(res.prize)}</span> 🎉`;
    party();
    toast(`You won ${money(res.prize)}!`, 'ok');
  }, 4500);
};

/* ============================================================================
   WALLET / REDEEM
   ========================================================================== */
async function loadWallet() {
  if ($('#walletBal')) $('#walletBal').textContent = money(me?.balance || 0);
  updateRedeemButton();
  try {
    const d = await api('GET', '/api/redemptions');
    if (Number.isFinite(d.minRedeem)) MIN_REDEEM = d.minRedeem;
    if (Number.isFinite(d.ttlMs)) REDEEM_TTL_MS = d.ttlMs;
    receiptsCache = d.items || [];
    renderReceipts();
    updateRedeemButton();
  } catch {}
}

function statusBadge(s) {
  const map = { pending:['Pending','st-pending'], claimed:['Loaded','st-claimed'], expired:['Expired','st-expired'], refunded:['Refunded','st-refunded'] };
  const [txt, cls] = map[s] || [s, ''];
  return `<span class="rc-badge ${cls}">${txt}</span>`;
}
function remainStr(ms) {
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m left`;
  if (m > 0) return `${m}m ${String(s).padStart(2,'0')}s left`;
  return `${s}s left`;
}

function renderReceipts() {
  const wrap = $('#receiptList'); if (!wrap) return;
  if (!receiptsCache.length) { wrap.innerHTML = `<div class="hint">No receipts yet — redeem your balance to get one.</div>`; return; }
  wrap.innerHTML = receiptsCache.map(r => {
    const pending = r.status === 'pending';
    const left = pending ? remainStr(r.expiresAt - Date.now()) : '';
    return `
    <div class="receipt-row ${r.status}">
      <div class="rc-head"><span class="rc-code-sm">${esc(r.code)}</span>${statusBadge(r.status)}</div>
      <div class="rc-line">
        <span class="rc-amt">${money(r.amount)}</span>
        ${pending ? `<span class="rc-timer" data-exp="${r.expiresAt}">${left}</span>`
                  : `<span class="hint">${new Date(r.createdAt).toLocaleDateString()}</span>`}
      </div>
      ${r.status === 'claimed'  ? `<div class="hint">✅ Loaded into your game${r.note ? ' · ' + esc(r.note) : ''}</div>` : ''}
      ${r.status === 'expired'  ? `<div class="hint">⌛ Expired — the amount was lost.</div>` : ''}
      ${r.status === 'refunded' ? `<div class="hint">↩ Refunded back to your balance.</div>` : ''}
      <div class="rc-actions">
        ${pending ? `<button class="btn sm ghost" data-copy="${esc(r.code)}">Copy code</button>` : ''}
        <button class="btn sm ghost" data-print="${r.id}">🖨️ View / Print</button>
      </div>
    </div>`;
  }).join('');
}

/* live countdown for every pending receipt (player + admin lists) */
setInterval(() => {
  $$('.rc-timer').forEach(t => {
    const left = Number(t.dataset.exp) - Date.now();
    t.textContent = remainStr(left);
    if (left <= 0) t.classList.add('dead');
  });
}, 1000);

$('#redeemBtn').onclick = async () => {
  const bal = Number(me?.balance || 0);
  if (bal < MIN_REDEEM) return toast(`You need at least ${money(MIN_REDEEM)} to redeem.`, 'err');
  if (!confirm(`Redeem ${money(bal)} now?\n\nYour balance becomes $0 and you get a receipt code. The receipt must be claimed within 24 hours or it expires and the amount is lost.`)) return;
  $('#redeemBtn').disabled = true;
  try {
    const d = await api('POST', '/api/redeem');
    me.balance = 0; renderMe();
    showReceipt(d.receipt, d.ttlMs);
    await loadWallet();
    toast('Balance redeemed — receipt ready 🎟️', 'ok');
  } catch (e) { toast(e.message, 'err'); updateRedeemButton(); }
};

/* receipt modal (used for a fresh redeem AND for re-printing past receipts) */
function showReceipt(r, ttlMs) {
  $('#rcAmt').textContent = money(r.amount);
  $('#rcCode').textContent = r.code;
  const hrs = Math.round((ttlMs || (r.expiresAt - r.createdAt) || REDEEM_TTL_MS) / 3600000);
  $('#rcMeta').innerHTML =
    `<div class="mini"><span class="t">Issued</span><span>${new Date(r.createdAt).toLocaleString()}</span></div>` +
    `<div class="mini"><span class="t">Expires</span><span>${new Date(r.expiresAt).toLocaleString()}</span></div>` +
    (r.status && r.status !== 'pending' ? `<div class="mini"><span class="t">Status</span><span>${r.status[0].toUpperCase() + r.status.slice(1)}</span></div>` : '');
  $('#rcNote').innerHTML = (!r.status || r.status === 'pending')
    ? `Show this code to John's Slots to get <b>${money(r.amount)}</b> loaded into your game (Milkyway, Juwa, Gamevault, Orionstars or Firekirin). ⏳ Claim within <b>${hrs} hours</b> or it expires and the amount is lost.`
    : `This receipt for <b>${money(r.amount)}</b> is <b>${r.status}</b>.`;
  $('#receiptModal').classList.remove('hidden');
}
$('#rcDone').onclick = () => $('#receiptModal').classList.add('hidden');
$('#rcPrint').onclick = () => window.print();
$('#receiptModal').addEventListener('click', e => { if (e.target.id === 'receiptModal') $('#receiptModal').classList.add('hidden'); });
$('#rcCopy').onclick = () => copyText($('#rcCode').textContent);

function copyText(txt) {
  if (navigator.clipboard?.writeText)
    navigator.clipboard.writeText(txt).then(() => toast('Copied!', 'ok')).catch(() => toast('Copy failed', 'err'));
  else {
    const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied!', 'ok'); } catch { toast('Copy failed', 'err'); }
    ta.remove();
  }
}
document.addEventListener('click', e => { const c = e.target.closest('[data-copy]'); if (c) copyText(c.dataset.copy); });
document.addEventListener('click', e => {
  const p = e.target.closest('[data-print]'); if (!p) return;
  const r = receiptsCache.find(x => x.id === p.dataset.print);
  if (r) showReceipt(r);
});

/* ============================================================================
   ANNOUNCEMENTS / GIVEAWAYS / DOWNLOADS
   ========================================================================== */
async function loadAnnouncements() {
  const { items } = await api('GET', '/api/announcements');
  renderAnn(items); if (me.isAdmin) renderAdmAnn(items);
}
function renderAnn(items) {
  $('#annList').innerHTML = items.length ? items.map(a => `
    <div class="card glass">
      <div class="meta">${new Date(a.createdAt).toLocaleString()}</div>
      <h3>${esc(a.title)}</h3>
      ${a.body ? `<p>${esc(a.body)}</p>` : ''}
    </div>`).join('')
    : `<div class="empty glass"><div class="big">📭</div>No announcements yet. Stay tuned!</div>`;
}
async function loadGiveaways() {
  const { items } = await api('GET', '/api/giveaways');
  renderGift(items); if (me.isAdmin) renderAdmGift(items);
}
function renderGift(items) {
  $('#giftList').innerHTML = items.length ? items.map(g => `
    <div class="card glass">
      <span class="tag gift">🎁 Giveaway</span>
      <h3>${esc(g.title)}</h3>
      ${g.prize ? `<div class="meta">Prize · ${esc(g.prize)}${g.endsAt ? ' · ends ' + new Date(g.endsAt).toLocaleString() : ''}</div>` : ''}
      ${g.body ? `<p>${esc(g.body)}</p>` : ''}
    </div>`).join('')
    : `<div class="empty glass"><div class="big">🎁</div>No giveaways running right now — check back soon!</div>`;
}
async function loadDownloads() {
  const { items } = await api('GET', '/api/downloads');
  renderDl(items); if (me.isAdmin) buildDlEditor(items);
}
function renderDl(items) {
  $('#dlGrid').innerHTML = items.map((g, i) => `
    <div class="dl-card glass">
      <div class="ic">🎮</div>
      <h4>${esc(g.label || 'Game ' + (i + 1))}</h4>
      ${g.url
        ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener">Download</a>`
        : `<span class="soon">⏳ Coming soon</span>`}
    </div>`).join('');
}

/* ============================================================================
   LUCKY DRAW — wheel + countdown
   ========================================================================== */
const WHEEL_COLORS = [
  ['#8a4bff','#5a2bd6'], ['#ff3ea5','#c41e78'], ['#ffd35a','#f2a23b'],
  ['#21e8c9','#0fae95'], ['#6c8bff','#3f5be0'], ['#ff7b54','#e0512f']
];
function drawWheel(parts) {
  const cv = $('#wheel'), ctx = cv.getContext('2d');
  const W = cv.width, cx = W / 2, cy = W / 2, R = W / 2 - 6;
  ctx.clearRect(0, 0, W, W);
  if (!parts.length) {
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.04)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.fillStyle = '#a89fce'; ctx.font = '600 26px Sora, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('Waiting for', cx, cy - 14);
    ctx.fillText('contenders…', cx, cy + 22);
    return;
  }
  const n = parts.length, slice = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a0 = i * slice, a1 = a0 + slice;
    const [c1, c2] = WHEEL_COLORS[i % WHEEL_COLORS.length];
    const g = ctx.createRadialGradient(cx, cy, R * .2, cx, cy, R);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.stroke();
    // label
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a0 + slice / 2);
    ctx.textAlign = 'right'; ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.max(14, Math.min(26, 220 / n + 8))}px Sora, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6;
    const name = parts[i].length > 12 ? parts[i].slice(0, 11) + '…' : parts[i];
    ctx.fillText(name, R - 18, 6);
    ctx.restore();
  }
  // outer ring dots
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,211,90,.55)'; ctx.lineWidth = 5; ctx.stroke();
}

function spinWheel(parts, winnerIndex, durationMs, turns) {
  if (!parts.length) return;
  spinning = true; cdSec = null;
  drawWheel(parts);
  const el = $('#wheel');
  const sliceDeg = 360 / parts.length;
  const center = winnerIndex * sliceDeg + sliceDeg / 2;
  const R = (((270 - center) % 360) + 360) % 360;
  const finalDeg = turns * 360 + R;

  el.style.transition = 'none';
  el.style.transform = 'rotate(0deg)';
  void el.offsetWidth;
  requestAnimationFrame(() => {
    el.style.transition = `transform ${durationMs}ms cubic-bezier(.08,.72,.12,1)`;
    el.style.transform = `rotate(${finalDeg}deg)`;
  });

  $('#drawStatus').textContent = 'Spinning…';
  $('#countdown').innerHTML = '';

  setTimeout(() => {
    spinning = false;
    const who = parts[winnerIndex];
    $('#winnerBanner').innerHTML = `<div class="label">🏆 Winner</div><div class="who glow">${esc(who)}</div>`;
    highlightWinner(winnerIndex);
    party(); setTimeout(party, 350); setTimeout(party, 700);
    toast(`🏆 ${who} wins the daily draw!`, 'ok');
  }, durationMs + 80);
}

function highlightWinner(idx) {
  $$('#partsList li').forEach((li, i) => li.classList.toggle('win', i === idx));
}

function renderParts(parts, winnerIdx) {
  const ol = $('#partsList');
  ol.innerHTML = parts.map((p, i) => `<li class="${winnerIdx === i ? 'win' : ''}">${esc(p)}</li>`).join('');
  $('#partsEmpty').classList.toggle('hidden', parts.length > 0);
}

function renderCountdown() {
  if (spinning) return;
  const c = $('#countdown');
  if (cdSec == null) { c.innerHTML = ''; return; }
  const h = Math.floor(cdSec / 3600), m = Math.floor((cdSec % 3600) / 60), s = cdSec % 60;
  const box = (v, l) => `<div class="cd"><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`;
  $('#drawStatus').textContent = 'Next draw in';
  c.innerHTML = box(h, 'hrs') + box(m, 'min') + box(s, 'sec');
}
setInterval(() => { if (cdSec != null && cdSec > 0) cdSec--; renderCountdown(); }, 1000);

function applyDrawState(st) {
  serverOffset = st.serverTime - Date.now();
  drawCache = st;
  const winIdx = (st.lastResult && !st.active) ? st.lastResult.index : -1;
  renderParts(st.participants, winIdx);
  if (!spinning) drawWheel(st.participants);

  // admin mirror
  if (me?.isAdmin) {
    if (document.activeElement !== $('#admParts')) $('#admParts').value = st.participants.join('\n');
    if (document.activeElement !== $('#admTime'))  $('#admTime').value = st.spinTime;
    $('#admLastWinner').textContent = st.lastResult ? st.lastResult.winner : '—';
    $('#admLastDate').textContent = st.lastSpinDate || '—';
    $('#serverClock').textContent = 'Server time now: ' + (st.serverClock || '—');
  }

  // mid-spin late joiner
  if (st.active) {
    const a = st.active;
    const elapsed = (Date.now() + serverOffset) - a.startAt;
    if (elapsed < a.durationMs) {
      const remain = Math.max(1500, a.durationMs - Math.max(0, elapsed));
      spinWheel(a.participants, a.winnerIndex, remain, 4);
    } else {
      spinning = false;
      if (st.lastResult) {
        $('#winnerBanner').innerHTML = `<div class="label">🏆 Latest winner</div><div class="who glow">${esc(st.lastResult.winner)}</div>`;
      }
    }
  } else if (!spinning) {
    cdSec = st.nextSpinInSeconds;
    if (st.lastResult) {
      $('#winnerBanner').innerHTML =
        `<div class="label" id="drawStatus">Next draw in</div><div class="countdown" id="countdown"></div>` +
        `<div class="hint" style="margin-top:8px">Latest winner: <b class="glow">${esc(st.lastResult.winner)}</b></div>`;
    }
    renderCountdown();
  }
}
async function loadDraw() { applyDrawState(await api('GET', '/api/draw')); }

/* ============================================================================
   ADMIN ACTIONS
   ========================================================================== */
$('#saveDraw').onclick = async () => {
  const participants = $('#admParts').value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 10);
  const spinTime = $('#admTime').value.trim();
  try { applyDrawState(await api('PUT', '/api/draw', { participants, spinTime })); toast('Draw saved.', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
$('#spinNow').onclick = async () => {
  try { await api('POST', '/api/draw/spin'); toast('Spinning the wheel live!', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};
$('#addAnn').onclick = async () => {
  try {
    await api('POST', '/api/announcements', { title: $('#annTitle').value, body: $('#annBody').value });
    $('#annTitle').value = ''; $('#annBody').value = ''; toast('Published.', 'ok'); loadAnnouncements();
  } catch (e) { toast(e.message, 'err'); }
};
$('#addGift').onclick = async () => {
  try {
    await api('POST', '/api/giveaways', { title: $('#giftTitle').value, prize: $('#giftPrize').value, body: $('#giftBody').value, endsAt: $('#giftEnds').value || null });
    ['giftTitle','giftPrize','giftBody','giftEnds'].forEach(id => $('#'+id).value = '');
    toast('Giveaway launched.', 'ok'); loadGiveaways();
  } catch (e) { toast(e.message, 'err'); }
};
function renderAdmAnn(items) {
  $('#admAnnList').innerHTML = items.length ? items.map(a =>
    `<div class="mini"><span class="t">${esc(a.title)}</span><button class="btn danger sm" data-del-ann="${a.id}">Delete</button></div>`).join('')
    : `<div class="hint">None yet.</div>`;
}
function renderAdmGift(items) {
  $('#admGiftList').innerHTML = items.length ? items.map(g =>
    `<div class="mini"><span class="t">${esc(g.title)}</span><button class="btn danger sm" data-del-gift="${g.id}">Delete</button></div>`).join('')
    : `<div class="hint">None yet.</div>`;
}
document.addEventListener('click', async e => {
  const da = e.target.closest('[data-del-ann]');
  const dg = e.target.closest('[data-del-gift]');
  if (da) { try { await api('DELETE', '/api/announcements/' + da.dataset.delAnn); loadAnnouncements(); } catch (x) { toast(x.message,'err'); } }
  if (dg) { try { await api('DELETE', '/api/giveaways/' + dg.dataset.delGift); loadGiveaways(); } catch (x) { toast(x.message,'err'); } }
});

function buildDlEditor(items) {
  $('#dlEditor').innerHTML = items.map((g, i) => `
    <div class="dlrow">
      <input data-dl-label="${i}" value="${esc(g.label)}" placeholder="Game ${i + 1}">
      <input data-dl-url="${i}" value="${esc(g.url)}" placeholder="https://download-link…">
    </div>`).join('');
}
function buildDlEditorFromState() { /* filled after loadDownloads */ }
$('#saveDl').onclick = async () => {
  const items = [];
  for (let i = 0; i < 10; i++) {
    const l = $(`[data-dl-label="${i}"]`), u = $(`[data-dl-url="${i}"]`);
    items.push({ label: l ? l.value : 'Game ' + (i + 1), url: u ? u.value : '' });
  }
  try { const r = await api('PUT', '/api/downloads', { items }); renderDl(r.items); toast('Links saved.', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
};

async function loadUsers() {
  const { users } = await api('GET', '/api/admin/users');
  const empOpts = sel => ['', 'Famous', 'Hulk', 'Travis']
    .map(e => `<option value="${e}" ${sel === e ? 'selected' : ''}>${e || '— not an agent —'}</option>`).join('');
  $('#usersList').innerHTML = users.map(u => `
    <div class="user-row">
      <div class="user-top">
        <span class="t">${esc(u.username)} ${u.isAdmin ? '👑' : ''}${u.vip ? ' <span class="vip-badge">💎 VIP</span>' : ''}${u.employee ? ` <span class="emp-badge">🧑‍💼 ${esc(u.employee)}</span>` : ''}</span>
        <span class="hint">${money(u.balance)}</span>
      </div>
      ${u.email ? `<div class="hint" style="margin:2px 0 6px">✉️ ${esc(u.email)}</div>` : ''}
      <div class="user-ctrls">
        <input data-bal="${esc(u.username)}" inputmode="decimal" placeholder="±$  e.g. 5 or -2.5">
        <button class="btn sm" data-apply="${esc(u.username)}">Apply</button>
      </div>
      <div class="user-ctrls">
        <input data-pw="${esc(u.username)}" type="text" autocomplete="off" placeholder="New password (min 6)">
        <button class="btn sm violet" data-setpw="${esc(u.username)}">Set password</button>
      </div>
      <div class="user-ctrls">
        <button class="btn sm ${u.vip ? 'danger' : 'ghost'}" data-vip="${esc(u.username)}" data-vip-now="${u.vip ? 1 : 0}">${u.vip ? 'Remove VIP 💎' : 'Make VIP 💎'}</button>
        <select data-emp="${esc(u.username)}">${empOpts(u.employee || '')}</select>
      </div>
    </div>`).join('');
}
document.addEventListener('click', async e => {
  const apply = e.target.closest('[data-apply]');
  const setpw = e.target.closest('[data-setpw]');
  if (apply) {
    const u = apply.dataset.apply;
    const delta = parseFloat($(`[data-bal="${CSS.escape(u)}"]`).value);
    if (!Number.isFinite(delta)) return toast('Enter a number like 5 or -2.5', 'err');
    try { await api('POST', `/api/admin/users/${encodeURIComponent(u)}/balance`, { delta }); toast('Balance updated.', 'ok'); loadUsers(); }
    catch (x) { toast(x.message, 'err'); }
  }
  if (setpw) {
    const u = setpw.dataset.setpw;
    const inp = $(`[data-pw="${CSS.escape(u)}"]`);
    const pw = (inp?.value || '').trim();
    if (pw.length < 6) return toast('Password must be at least 6 characters.', 'err');
    try { await api('POST', `/api/admin/users/${encodeURIComponent(u)}/password`, { password: pw }); toast(`Password updated for ${u}.`, 'ok'); if (inp) inp.value = ''; }
    catch (x) { toast(x.message, 'err'); }
  }
  const vipBtn = e.target.closest('[data-vip]');
  if (vipBtn) {
    const u = vipBtn.dataset.vip, makeVip = vipBtn.dataset.vipNow !== '1';
    try { await api('POST', `/api/admin/users/${encodeURIComponent(u)}/vip`, { vip: makeVip }); toast(makeVip ? `💎 ${u} is now VIP!` : `VIP removed from ${u}.`, 'ok'); loadUsers(); }
    catch (x) { toast(x.message, 'err'); }
  }
});
document.addEventListener('change', async e => {
  const empSel = e.target.closest('select[data-emp]');
  if (empSel) {
    const u = empSel.dataset.emp;
    try {
      await api('POST', `/api/admin/users/${encodeURIComponent(u)}/employee`, { employee: empSel.value || null });
      toast(empSel.value ? `${u} is now agent "${empSel.value}".` : `${u} unlinked from agents.`, 'ok');
      loadUsers();
    } catch (x) { toast(x.message, 'err'); loadUsers(); }
  }
});

/* ---------- admin: redemption receipts -------------------------------- */
async function loadAdminRedemptions() {
  if (!me?.isAdmin) return;
  try { const { items } = await api('GET', '/api/admin/redemptions'); renderAdmRedemptions(items); }
  catch {}
}
function renderAdmRedemptions(items) {
  const wrap = $('#admRedeemList'); if (!wrap) return;
  if (!items.length) { wrap.innerHTML = `<div class="hint">No redemptions yet.</div>`; return; }
  wrap.innerHTML = items.map(r => {
    const pending = r.status === 'pending';
    const left = pending ? remainStr(r.expiresAt - Date.now()) : '';
    return `
    <div class="receipt-row ${r.status}">
      <div class="rc-head"><span class="rc-code-sm">${esc(r.code)}</span>${statusBadge(r.status)}</div>
      <div class="rc-line">
        <span>${esc(r.username)} · <b class="rc-amt">${money(r.amount)}</b></span>
        ${pending ? `<span class="rc-timer" data-exp="${r.expiresAt}">${left}</span>`
                  : `<span class="hint">${new Date(r.createdAt).toLocaleString()}</span>`}
      </div>
      ${pending
        ? `<div class="rc-actions">
             <button class="btn sm" data-claim="${r.id}">✅ Mark loaded</button>
             <button class="btn sm danger" data-refund="${r.id}">↩ Refund</button>
           </div>`
        : (r.claimedBy ? `<div class="hint">by ${esc(r.claimedBy)}${r.note ? ' · ' + esc(r.note) : ''}</div>` : '')}
    </div>`;
  }).join('');
}
document.addEventListener('click', async e => {
  const cl = e.target.closest('[data-claim]');
  const rf = e.target.closest('[data-refund]');
  if (cl) {
    const note = prompt('Optional note (e.g. game / account it was loaded to):', '') ?? '';
    try { await api('POST', `/api/admin/redemptions/${cl.dataset.claim}/claim`, { note }); toast('Marked as loaded.', 'ok'); loadAdminRedemptions(); }
    catch (x) { toast(x.message, 'err'); }
  }
  if (rf) {
    if (!confirm("Refund this receipt back to the player's balance?")) return;
    try { await api('POST', `/api/admin/redemptions/${rf.dataset.refund}/refund`); toast('Refunded to player.', 'ok'); loadAdminRedemptions(); }
    catch (x) { toast(x.message, 'err'); }
  }
});

/* ============================================================================
   FEED — stories (24h), posts, facebook links, feedback
   ========================================================================== */
let storiesCache = [];
let fbSettings = { fbLink1: '', fbLink2: '' };

async function loadFeed() {
  try {
    const d = await api('GET', '/api/posts');
    storiesCache = d.stories || [];
    renderStories(d.stories || []);
    renderPosts(d.posts || []);
    if (me?.isAdmin) renderAdmPosts(d.posts || [], d.stories || []);
  } catch {}
  try { fbSettings = await api('GET', '/api/settings'); renderFbLinks(); } catch {}
}
function renderFbLinks() {
  const row = $('#fbRow'); if (!row) return;
  const btns = [];
  if (fbSettings.fbLink1) btns.push(`<a class="btn sm" href="${esc(fbSettings.fbLink1)}" target="_blank" rel="noopener">📘 Facebook Page 1</a>`);
  if (fbSettings.fbLink2) btns.push(`<a class="btn sm violet" href="${esc(fbSettings.fbLink2)}" target="_blank" rel="noopener">📘 Facebook Page 2</a>`);
  row.innerHTML = btns.length ? btns.join('') : `<span class="hint">Links coming soon.</span>`;
}
function renderStories(items) {
  const row = $('#storiesRow'); if (!row) return;
  if (!items.length) { row.innerHTML = `<div class="hint">No stories right now.</div>`; return; }
  row.innerHTML = items.map(s => `
    <button class="story-bubble" data-story="${s.id}">
      <span class="story-ring"><img src="${esc(s.image)}" alt=""></span>
      <span class="story-label">${esc(s.caption || 'Story')}</span>
    </button>`).join('');
}
function renderPosts(items) {
  const wrap = $('#postList'); if (!wrap) return;
  wrap.innerHTML = items.length ? items.map(p => `
    <div class="card glass post-card">
      <div class="meta">📌 John's Slots · ${new Date(p.createdAt).toLocaleString()}</div>
      ${p.image ? `<img class="post-img" src="${esc(p.image)}" alt="" loading="lazy">` : ''}
      ${p.caption ? `<p>${esc(p.caption)}</p>` : ''}
    </div>`).join('')
    : `<div class="empty glass"><div class="big">📸</div>No posts yet — check back soon!</div>`;
}

/* story viewer: tap a bubble, auto-closes after 6s */
let storyTimer = null;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-story]');
  if (!b) return;
  const s = storiesCache.find(x => x.id === b.dataset.story);
  if (!s) return;
  $('#storyImg').src = s.image;
  $('#storyCap').textContent = s.caption || '';
  $('#storyModal').classList.remove('hidden');
  const bar = $('#storyBar');
  bar.style.transition = 'none'; bar.style.width = '0%';
  void bar.offsetWidth;
  bar.style.transition = 'width 6s linear'; bar.style.width = '100%';
  clearTimeout(storyTimer);
  storyTimer = setTimeout(closeStory, 6100);
});
function closeStory() { clearTimeout(storyTimer); $('#storyModal').classList.add('hidden'); }
$('#storyClose').onclick = closeStory;
$('#storyModal').addEventListener('click', e => { if (e.target.id === 'storyModal') closeStory(); });

/* feedback (player -> admin only) */
$('#sendFeedback').onclick = async () => {
  const msg = $('#fbMsg').value.trim();
  if (!msg) return toast('Write something first.', 'err');
  try {
    await api('POST', '/api/feedback', { message: msg });
    $('#fbMsg').value = '';
    toast('Feedback sent — thank you! 💜', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

/* ============================================================================
   DEPOSIT BONUS WHEEL — 8 segments, once per day
   ========================================================================== */
let bonusPercents = [10, 12, 15, 17, 20, 22, 25, 30];
let bonusSpinning = false;

function drawBonusWheel(rotated) {
  const cv = $('#bonusWheel'); if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, cx = W / 2, cy = W / 2, R = W / 2 - 6;
  ctx.clearRect(0, 0, W, W);
  const n = bonusPercents.length, slice = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a0 = i * slice, a1 = a0 + slice;
    const [c1, c2] = WHEEL_COLORS[i % WHEEL_COLORS.length];
    const g = ctx.createRadialGradient(cx, cy, R * .2, cx, cy, R);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath();
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(a0 + slice / 2);
    ctx.textAlign = 'right'; ctx.fillStyle = '#fff';
    ctx.font = '800 44px Sora, sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6;
    ctx.fillText(bonusPercents[i] + '%', R - 24, 14);
    ctx.restore();
  }
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,211,90,.55)'; ctx.lineWidth = 5; ctx.stroke();
}

async function loadBonus() {
  try {
    const d = await api('GET', '/api/bonus/config');
    if (d.percents?.length) { bonusPercents = d.percents; drawBonusWheel(); }
    me.canBonusSpin = d.canSpin;
    renderBonusBtn();
    renderBonusMine(d.mine || []);
  } catch {}
}
function renderBonusBtn() {
  const b = $('#bonusSpinBtn'); if (!b) return;
  if (bonusSpinning) { b.disabled = true; return; }
  b.disabled = !me?.canBonusSpin;
  b.textContent = me?.canBonusSpin ? '🎡 SPIN THE BONUS WHEEL' : '✅ Spun today — back tomorrow!';
}
function renderBonusMine(items) {
  const wrap = $('#bonusMine'); if (!wrap) return;
  wrap.innerHTML = items.length ? items.map(b => `
    <div class="mini">
      <span class="t glow">+${b.percent}% bonus</span>
      <span>${b.status === 'claimed'
        ? `<span class="rc-badge st-claimed">Claimed</span>`
        : `<span class="rc-badge st-pending">Show agent to claim</span>`}</span>
    </div>
    <div class="hint" style="margin:-6px 0 8px">${new Date(b.at).toLocaleString()}</div>`).join('')
    : `<div class="hint">No bonus spins yet.</div>`;
}
$('#bonusSpinBtn').onclick = async () => {
  if (bonusSpinning) return;
  bonusSpinning = true; renderBonusBtn(); $('#bonusSpinBtn').disabled = true;
  let res;
  try { res = await api('POST', '/api/bonus/spin'); }
  catch (e) { bonusSpinning = false; toast(e.message, 'err'); loadBonus(); return; }
  if (res.percents?.length) bonusPercents = res.percents;
  // animate the wheel to land on the winning segment (pointer at top = 270°)
  const el = $('#bonusWheel');
  const sliceDeg = 360 / bonusPercents.length;
  const center = res.index * sliceDeg + sliceDeg / 2;
  const finalDeg = 6 * 360 + ((((270 - center) % 360) + 360) % 360);
  el.style.transition = 'none'; el.style.transform = 'rotate(0deg)';
  void el.offsetWidth;
  requestAnimationFrame(() => {
    el.style.transition = 'transform 6s cubic-bezier(.08,.72,.12,1)';
    el.style.transform = `rotate(${finalDeg}deg)`;
  });
  setTimeout(() => {
    bonusSpinning = false;
    me.canBonusSpin = false;
    renderBonusBtn();
    $('#bonusBanner').innerHTML =
      `<div class="label">🎉 You won</div><div class="who glow" style="font-family:var(--font-display);font-size:2rem">+${res.percent}% DEPOSIT BONUS</div>` +
      `<div class="hint" style="margin-top:8px">Show this to an agent to claim it on your next deposit. The agent has already been notified.</div>`;
    party(); setTimeout(party, 400);
    toast(`🎁 You won a ${res.percent}% deposit bonus — claim it with an agent!`, 'ok');
    loadBonus();
  }, 6200);
};

/* ============================================================================
   GAME VAULT — personal credentials notepad
   ========================================================================== */
let vaultCache = [];
async function loadVault() {
  try { const d = await api('GET', '/api/vault'); vaultCache = d.items || []; renderVault(); } catch {}
}
function renderVault() {
  const wrap = $('#vaultList'); if (!wrap) return;
  wrap.innerHTML = vaultCache.length ? vaultCache.map(v => `
    <div class="vault-row glass">
      <div class="user-top"><span class="t">🎮 ${esc(v.game)}</span>
        <button class="btn sm danger" data-vdel="${v.id}">Delete</button></div>
      ${v.username ? `<div class="vault-line"><span class="hint">User</span><code>${esc(v.username)}</code><button class="btn sm ghost" data-copy="${esc(v.username)}">Copy</button></div>` : ''}
      ${v.password ? `<div class="vault-line"><span class="hint">Pass</span><code class="vault-pw" data-pwid="${v.id}">••••••••</code><button class="btn sm ghost" data-vshow="${v.id}">Show</button><button class="btn sm ghost" data-copy="${esc(v.password)}">Copy</button></div>` : ''}
      ${v.notes ? `<div class="hint" style="margin-top:6px">📝 ${esc(v.notes)}</div>` : ''}
    </div>`).join('')
    : `<div class="hint">Nothing saved yet.</div>`;
}
$('#vAdd').onclick = async () => {
  try {
    const d = await api('POST', '/api/vault', {
      game: $('#vGame').value, username: $('#vUser').value,
      password: $('#vPass').value, notes: $('#vNotes').value
    });
    vaultCache = d.items; renderVault();
    ['vGame','vUser','vPass','vNotes'].forEach(id => $('#' + id).value = '');
    toast('Saved to your vault 🔐', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};
document.addEventListener('click', async e => {
  const del = e.target.closest('[data-vdel]');
  const show = e.target.closest('[data-vshow]');
  if (del) {
    if (!confirm('Delete this vault entry?')) return;
    try { const d = await api('DELETE', '/api/vault/' + del.dataset.vdel); vaultCache = d.items; renderVault(); toast('Deleted.', 'ok'); }
    catch (x) { toast(x.message, 'err'); }
  }
  if (show) {
    const v = vaultCache.find(x => x.id === show.dataset.vshow);
    const code = $(`[data-pwid="${CSS.escape(show.dataset.vshow)}"]`);
    if (v && code) {
      const hidden = code.textContent.startsWith('•');
      code.textContent = hidden ? v.password : '••••••••';
      show.textContent = hidden ? 'Hide' : 'Show';
    }
  }
});

/* ============================================================================
   EMPLOYEE REPORTS (Famous / Hulk / Travis side)
   ========================================================================== */
function todayInput() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
async function loadMyReports() {
  if (!me?.employee) return;
  if ($('#repDate') && !$('#repDate').value) $('#repDate').value = todayInput();
  try {
    const d = await api('GET', '/api/reports/mine');
    $('#repMine').innerHTML = d.items.length ? d.items.map(r => `
      <div class="mini"><span class="t">${esc(r.date)}</span>
        <span>In <b class="glow">${money(r.cashIn)}</b> · Out <b>${money(r.cashOut)}</b></span></div>`).join('')
      : `<div class="hint">No reports yet.</div>`;
  } catch {}
}
$('#repSubmit').onclick = async () => {
  const cashIn = parseFloat($('#repIn').value), cashOut = parseFloat($('#repOut').value);
  if (!Number.isFinite(cashIn) || !Number.isFinite(cashOut)) return toast('Enter both cash in and cash out.', 'err');
  try {
    await api('POST', '/api/reports', { date: $('#repDate').value, cashIn, cashOut });
    toast('Report submitted ✅', 'ok');
    $('#repIn').value = ''; $('#repOut').value = '';
    loadMyReports();
  } catch (e) { toast(e.message, 'err'); }
};

/* ============================================================================
   ADMIN — feedbacks
   ========================================================================== */
async function loadFeedbacks() {
  if (!me?.isAdmin) return;
  try {
    const { items } = await api('GET', '/api/admin/feedbacks');
    $('#admFeedbackList').innerHTML = items.length ? items.map(f => `
      <div class="receipt-row">
        <div class="rc-head"><span class="t">${esc(f.username)}</span><span class="hint">${new Date(f.createdAt).toLocaleString()}</span></div>
        <p style="margin:8px 0">${esc(f.message)}</p>
        <button class="btn sm danger" data-del-fb="${f.id}">Delete</button>
      </div>`).join('')
      : `<div class="hint">No feedback yet.</div>`;
  } catch {}
}
document.addEventListener('click', async e => {
  const d = e.target.closest('[data-del-fb]');
  if (d) { try { await api('DELETE', '/api/admin/feedbacks/' + d.dataset.delFb); loadFeedbacks(); } catch (x) { toast(x.message, 'err'); } }
});

/* ============================================================================
   ADMIN — posts & stories
   ========================================================================== */
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('Could not read the image.'));
    r.readAsDataURL(file);
  });
}
function previewImg(inputId, boxId) {
  const inp = $('#' + inputId), box = $('#' + boxId);
  inp.addEventListener('change', () => {
    const f = inp.files?.[0];
    if (!f) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const url = URL.createObjectURL(f);
    box.innerHTML = `<img src="${url}" alt="">`;
    box.classList.remove('hidden');
  });
}
previewImg('apImage', 'apPreview');
previewImg('asImage', 'asPreview');

async function loadAdminPosts() { if (me?.isAdmin) loadFeed(); }
function renderAdmPosts(posts, stories) {
  $('#admStoryList').innerHTML = stories.length ? stories.map(s => `
    <div class="mini"><span class="t">${esc(s.caption || 'Story')} · expires ${new Date(s.expiresAt).toLocaleTimeString()}</span>
      <button class="btn sm danger" data-del-story="${s.id}">Delete</button></div>`).join('')
    : `<div class="hint">None.</div>`;
  $('#admPostList').innerHTML = posts.length ? posts.map(p => `
    <div class="mini"><span class="t">${esc((p.caption || '(image only)').slice(0, 50))}</span>
      <button class="btn sm danger" data-del-post="${p.id}">Delete</button></div>`).join('')
    : `<div class="hint">None.</div>`;
}
$('#apPublish').onclick = async () => {
  const f = $('#apImage').files?.[0];
  try {
    const imageData = f ? await fileToDataUrl(f) : null;
    await api('POST', '/api/admin/posts', { caption: $('#apCaption').value, imageData });
    $('#apCaption').value = ''; $('#apImage').value = ''; $('#apPreview').classList.add('hidden');
    toast('Post published 📸', 'ok'); loadFeed();
  } catch (e) { toast(e.message, 'err'); }
};
$('#asPublish').onclick = async () => {
  const f = $('#asImage').files?.[0];
  if (!f) return toast('A story needs an image.', 'err');
  try {
    const imageData = await fileToDataUrl(f);
    await api('POST', '/api/admin/stories', { caption: $('#asCaption').value, imageData });
    $('#asCaption').value = ''; $('#asImage').value = ''; $('#asPreview').classList.add('hidden');
    toast('Story is live for 24h ⏱', 'ok'); loadFeed();
  } catch (e) { toast(e.message, 'err'); }
};
document.addEventListener('click', async e => {
  const dp = e.target.closest('[data-del-post]');
  const ds = e.target.closest('[data-del-story]');
  if (dp) { try { await api('DELETE', '/api/admin/posts/' + dp.dataset.delPost); loadFeed(); } catch (x) { toast(x.message, 'err'); } }
  if (ds) { try { await api('DELETE', '/api/admin/stories/' + ds.dataset.delStory); loadFeed(); } catch (x) { toast(x.message, 'err'); } }
});

/* ============================================================================
   ADMIN — bonus claims
   ========================================================================== */
async function loadAdminBonus() {
  if (!me?.isAdmin) return;
  try {
    const { items } = await api('GET', '/api/admin/bonus');
    $('#admBonusList').innerHTML = items.length ? items.map(b => `
      <div class="receipt-row ${b.status === 'claimed' ? 'claimed' : ''}">
        <div class="rc-head"><span class="t">${esc(b.username)} · <b class="glow">+${b.percent}%</b></span>
          ${b.status === 'claimed' ? `<span class="rc-badge st-claimed">Claimed</span>` : `<span class="rc-badge st-pending">Unclaimed</span>`}</div>
        <div class="rc-line"><span class="hint">${new Date(b.at).toLocaleString()}</span>
          ${b.status !== 'claimed' ? `<button class="btn sm" data-bclaim="${b.id}">✅ Mark claimed</button>`
            : `<span class="hint">by ${esc(b.claimedBy || '')}</span>`}</div>
      </div>`).join('')
      : `<div class="hint">No bonus spins yet.</div>`;
  } catch {}
}
document.addEventListener('click', async e => {
  const c = e.target.closest('[data-bclaim]');
  if (c) { try { await api('POST', `/api/admin/bonus/${c.dataset.bclaim}/claim`); toast('Bonus marked claimed.', 'ok'); loadAdminBonus(); } catch (x) { toast(x.message, 'err'); } }
});

/* ============================================================================
   ADMIN — employee reports (daily totals + monthly sum)
   ========================================================================== */
const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
function fancyDate(iso) { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; }

async function loadAdminReports() {
  if (!me?.isAdmin) return;
  if ($('#armDate') && !$('#armDate').value) $('#armDate').value = todayInput();
  if ($('#armMonth') && !$('#armMonth').value) $('#armMonth').value = todayInput().slice(0, 7);
  try {
    const d = await api('GET', '/api/admin/reports?month=' + encodeURIComponent($('#armMonth').value || ''));
    renderAdminReports(d);
  } catch (e) { toast(e.message, 'err'); }
}
function renderAdminReports(d) {
  const [y, m] = d.month.split('-').map(Number);
  $('#armMonthTotal').innerHTML = `
    <div class="label">${MONTHS[m - 1]} ${y} — month to date</div>
    <div class="rep-totals">
      <div class="rep-t"><span>TOTAL CASHIN</span><b class="glow">${money(d.monthTotal.cashIn)}</b></div>
      <div class="rep-t"><span>TOTAL CASHOUT</span><b>${money(d.monthTotal.cashOut)}</b></div>
      <div class="rep-t"><span>TOTAL ${d.monthTotal.profit >= 0 ? 'PROFIT' : 'LOSS'}</span>
        <b class="${d.monthTotal.profit >= 0 ? 'glow' : 'loss'}">${money(Math.abs(d.monthTotal.profit))}</b></div>
    </div>`;
  $('#armDays').innerHTML = d.days.length ? d.days.map(day => `
    <div class="rep-day glass ${day.complete ? '' : 'incomplete'}">
      <div class="rep-day-head">
        <span class="t">${fancyDate(day.date)}</span>
        ${day.complete ? `<span class="rc-badge st-claimed">All 3 in</span>` : `<span class="rc-badge st-pending">⚠ Waiting on agents</span>`}
      </div>
      <div class="rep-emp-row">
        ${d.employees.map(e => {
          const en = day.entries[e];
          return `<div class="rep-emp ${en ? '' : 'missing'}"><span class="hint">${esc(e)}</span>
            ${en ? `<span>In ${money(en.cashIn)} · Out ${money(en.cashOut)}</span>` : `<span class="hint">— not submitted —</span>`}</div>`;
        }).join('')}
      </div>
      <div class="rep-totals">
        <div class="rep-t"><span>TOTAL CASHIN</span><b class="glow">${money(day.cashIn)}</b></div>
        <div class="rep-t"><span>TOTAL CASHOUT</span><b>${money(day.cashOut)}</b></div>
        <div class="rep-t"><span>${day.profit >= 0 ? 'TOTAL PROFIT' : 'TOTAL LOSS'}</span>
          <b class="${day.profit >= 0 ? 'glow' : 'loss'}">${money(Math.abs(day.profit))}</b></div>
      </div>
    </div>`).join('')
    : `<div class="hint">No reports for this month yet.</div>`;
}
$('#armLoad').onclick = loadAdminReports;
$('#armSubmit').onclick = async () => {
  const cashIn = parseFloat($('#armIn').value), cashOut = parseFloat($('#armOut').value);
  if (!Number.isFinite(cashIn) || !Number.isFinite(cashOut)) return toast('Enter both cash in and cash out.', 'err');
  try {
    await api('POST', '/api/reports', { employee: $('#armEmp').value, date: $('#armDate').value, cashIn, cashOut });
    toast('Report saved.', 'ok');
    $('#armIn').value = ''; $('#armOut').value = '';
    loadAdminReports();
  } catch (e) { toast(e.message, 'err'); }
};

/* ============================================================================
   ADMIN — settings (facebook links)
   ========================================================================== */
async function loadSettingsForm() {
  if (!me?.isAdmin) return;
  try {
    const s = await api('GET', '/api/settings');
    fbSettings = s;
    $('#setFb1').value = s.fbLink1 || '';
    $('#setFb2').value = s.fbLink2 || '';
    renderFbLinks();
  } catch {}
}
$('#saveSettings').onclick = async () => {
  try {
    fbSettings = await api('PUT', '/api/admin/settings', { fbLink1: $('#setFb1').value, fbLink2: $('#setFb2').value });
    renderFbLinks();
    toast('Links saved.', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

/* ============================================================================
   SOCKET.IO realtime
   ========================================================================== */
function connectSocket() {
  socket = io();
  socket.on('presence', n => { $('#statOnline').textContent = n; $('#watchers').textContent = n; });
  socket.on('draw:state', applyDrawState);
  socket.on('draw:update', applyDrawState);
  socket.on('draw:spin', a => {
    const localStart = a.startAt - serverOffset;
    const delay = Math.max(0, localStart - Date.now());
    setTimeout(() => spinWheel(a.participants, a.winnerIndex, a.durationMs, a.turns), delay);
  });
  socket.on('draw:result', () => { /* refresh handled by draw:update */ });

  socket.on('announcement:new', () => loadAnnouncements());
  socket.on('announcement:remove', () => loadAnnouncements());
  socket.on('giveaway:new', () => loadGiveaways());
  socket.on('giveaway:remove', () => loadGiveaways());
  socket.on('downloads:update', items => { renderDl(items); if (me?.isAdmin) buildDlEditor(items); });

  socket.on('redemption:new', () => { if (me?.isAdmin) loadAdminRedemptions(); });
  socket.on('redemption:update', () => {
    if (me?.isAdmin) return loadAdminRedemptions();
    refreshMe();                                              // balance may change on a refund
    if ($('#view-wallet')?.classList.contains('active')) loadWallet();
  });

  socket.on('feedback:new', () => { if (me?.isAdmin) { loadFeedbacks(); toast('💬 New feedback received', 'ok'); } });
  socket.on('post:new', () => loadFeed());
  socket.on('bonus:new', d => { if (me?.isAdmin) { loadAdminBonus(); toast(`🎡 ${d.username} won a ${d.percent}% deposit bonus`, 'ok'); } });
  socket.on('bonus:update', () => { if (me?.isAdmin) loadAdminBonus(); loadBonus(); });
  socket.on('report:update', () => { if (me?.isAdmin) loadAdminReports(); });
  socket.on('settings:update', s => { fbSettings = s; renderFbLinks(); if (me?.isAdmin) { $('#setFb1').value = s.fbLink1 || ''; $('#setFb2').value = s.fbLink2 || ''; } });
  socket.on('user:update', d => { if (d.username === me?.username) refreshMe(); if (me?.isAdmin) loadUsers(); });
}

/* ============================================================================
   BOOT
   ========================================================================== */
(async function boot() {
  drawWheel([]); // placeholder behind auth
  if (!token) return;
  try { const { user } = await api('GET', '/api/me'); enterApp(user); }
  catch { clearToken(); }
})();
