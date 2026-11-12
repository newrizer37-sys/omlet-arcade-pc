'use strict';
/* 🍊 Omlet Arcade PC — клиент: лента, Discover, эфиры, ЛС, уведомления, гильдии */

/* ============================== helpers ============================== */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const tok = () => localStorage.getItem('omlet_token') || '';
const me = () => { try { return JSON.parse(localStorage.getItem('omlet_user') || 'null'); } catch { return null; } };
const setAuth = (t, u) => { localStorage.setItem('omlet_token', t); localStorage.setItem('omlet_user', JSON.stringify(u)); };
const logout = () => { localStorage.removeItem('omlet_token'); localStorage.removeItem('omlet_user'); try { ws && ws.close(); } catch {} location.reload(); };

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok() ? { authorization: 'Bearer ' + tok() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка сервера ' + r.status);
  return data;
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
  return Math.floor(s / 86400) + ' дн назад';
}

function avatarHTML(u, size = 40) {
  const letter = (u?.username || '?')[0].toUpperCase();
  return `<div class="avatar" style="width:${size}px;height:${size}px;background:${esc(u?.avatar_color || '#555')};font-size:${Math.round(size * 0.45)}px">${esc(letter)}</div>`;
}

function toast(msg, ms = 3400) {
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), ms);
}

function modal(html, title) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-overlay" id="modal-overlay"><div class="modal-panel">
    <div class="modal-head"><span>${esc(title)}</span><button class="icon-btn" id="modal-close">✕</button></div>
    ${html}</div></div>`;
  $('#modal-close').onclick = closeModal;
  $('#modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });
}
function closeModal() { $('#modal-root').innerHTML = ''; }

const COLORS = ['#FF7A00', '#FF4D4D', '#2ECC71', '#3498DB', '#9B59B6', '#F1C40F', '#1ABC9C', '#E91E63'];
const GAME_ICONS = {
  'Minecraft PE': '⛏️', 'Roblox': '🧱', 'PUBG Mobile': '🪖', 'Standoff 2': '🔫',
  'Genshin Impact': '🌸', 'Brawl Stars': '💥', 'Free Fire': '🔥', 'Другое': '🎮',
};
const gameIcon = (g) => GAME_ICONS[g] || '🎮';

/* ============================== state / ws ============================== */
const state = { screen: 'home', dialogUser: null, guildId: null, watchId: null, watchMode: 'viewer', user: null, rtmpUrl: null, selColor: null };
let ws = null, streamWS = null, guildWS = null;
let notifUnread = 0, dmUnread = 0;
let screenStream = null, recorder = null, rtmpActive = false, viewerPC = null;
let pcs = new Map(), pendingPeers = new Set(), readyTimer = null;

function updateBadges() {
  const bell = $('#bell-badge');
  if (bell) { const n = notifUnread; bell.textContent = n > 99 ? '99+' : n || ''; bell.style.display = n ? '' : 'none'; }
  const tab = $('#nav-badge-msg');
  if (tab) { const n = dmUnread; tab.textContent = n > 99 ? '99+' : n || ''; tab.style.display = n ? '' : 'none'; }
  const total = notifUnread + dmUnread;
  document.title = (total ? `(${total}) ` : '') + '🍊 Omlet Arcade PC';
}

function connectWS() {
  try { ws && ws.close(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${proto}${location.host}/ws?token=${tok()}`);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'personal-welcome') { notifUnread = m.unread || 0; updateBadges(); }
    else if (m.type === 'dm') onDmPush(m);
    else if (m.type === 'notification') onNotifPush(m);
  };
  ws.onclose = () => { setTimeout(() => { if (me()) connectWS(); }, 5000); };
}

function onDmPush(m) {
  if (state.screen === 'dialog' && state.dialogUser === m.from.username) {
    $('#dm-list')?.insertAdjacentHTML('beforeend', dmBubble({ sender_id: m.from.id, text: m.text, created_at: m.ts }));
    const list = $('#dm-list'); if (list) list.scrollTop = list.scrollHeight;
  } else {
    dmUnread++;
    updateBadges();
    toast('💬 ' + m.from.username + ': ' + m.text.slice(0, 50));
    if (state.screen === 'messages') render();
  }
}

function onNotifPush(m) {
  notifUnread++;
  updateBadges();
  const texts = {
    live: `🔴 ${m.payload.host} вышел в эфир!`,
    like: `❤️ ${m.payload.by} лайкнул твой пост`,
    comment: `💬 ${m.payload.by}: ${(m.payload.text || '').slice(0, 40)}`,
    follow: `➕ ${m.payload.by} подписался на тебя`,
  };
  toast(texts[m.ntype] || '🔔 Новое уведомление');
  if (state.screen === 'home' && m.ntype === 'live') render();
}

/* ============================== каркас ============================== */
const TABS = [
  { id: 'home', icon: '🏠', label: 'Главная' },
  { id: 'discover', icon: '🧭', label: 'Открытия' },
  { id: 'live', icon: '⏺', label: 'В эфир' },
  { id: 'messages', icon: '💬', label: 'Сообщения', badge: 'msg' },
  { id: 'profile', icon: '👤', label: 'Профиль' },
];
const BACK_TO = { watch: 'live', golive: 'live', dialog: 'messages', user: 'discover', guild: 'discover' };

function renderNav() {
  $('#nav').innerHTML = TABS.map((t) => `
    <button class="nav-btn ${state.screen === t.id ? 'active' : ''}" data-nav="${t.id}">
      <span class="nav-icon">${t.icon}${t.badge === 'msg' ? '<span id="nav-badge-msg" class="badge"></span>' : ''}</span>
      <span class="nav-label">${t.label}</span>
    </button>`).join('');
  updateBadges();
}

function header(title, back) {
  $('#header').innerHTML = `<div class="header-inner">
    ${back ? '<button id="btn-back" class="icon-btn">←</button>' : '<div class="logo-mini">🍊</div>'}
    <div class="header-title">${esc(title)}</div>
    ${me() ? '<button id="btn-bell" class="icon-btn" title="Уведомления">🔔<span id="bell-badge" class="badge"></span></button>' : ''}
  </div>`;
  const b = $('#btn-back'); if (b) b.onclick = () => nav(back);
  const bell = $('#btn-bell'); if (bell) bell.onclick = openNotifications;
  updateBadges();
}

function nav(screen, params = {}) {
  if (!me() && screen !== 'auth') screen = 'auth';
  if (state.screen === 'watch' && screen !== 'watch') cleanupStream();
  if (state.screen === 'guild' && screen !== 'guild') { try { guildWS && guildWS.close(); } catch {} guildWS = null; }
  state.screen = screen;
  Object.assign(state, params);
  closeModal();
  window.scrollTo(0, 0);
  render();
}

async function render() {
  renderNav();
  const scr = $('#screen');
  try {
    switch (state.screen) {
      case 'auth': return renderAuth(scr);
      case 'discover': return renderDiscover(scr);
      case 'live': return renderLive(scr);
      case 'golive': return renderGoLive(scr);
      case 'watch': return renderWatch(scr);
      case 'messages': return renderMessages(scr);
      case 'dialog': return renderDialog(scr);
      case 'user': return renderUser(scr);
      case 'profile': return renderProfile(scr);
      case 'guild': return renderGuild(scr);
      default: return renderHome(scr);
    }
  } catch (e) {
    console.error(e);
    scr.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div><div style="text-align:center"><button class="btn" data-nav="home">Повторить</button></div>`;
  }
}

/* ============================== клики (делегирование) ============================== */
document.addEventListener('click', (e) => {
  const q = (sel) => e.target.closest(sel);
  let t;
  if ((t = q('[data-like]'))) { e.stopPropagation(); return toggleLike(t); }
  if ((t = q('[data-cmt]'))) { e.stopPropagation(); return toggleComments(t); }
  if ((t = q('[data-follow]'))) { e.stopPropagation(); return toggleFollow(t.dataset.follow, t); }
  if ((t = q('[data-gjoin]'))) { e.stopPropagation(); return toggleGuild(t.dataset.gjoin); }
  if ((t = q('[data-dm]'))) { e.stopPropagation(); return nav('dialog', { dialogUser: t.dataset.dm }); }
  if ((t = q('[data-user]'))) {
    const uname = t.dataset.user;
    if (!uname || uname === 'undefined') return;
    return uname === me()?.username ? nav('profile') : nav('user', { user: uname });
  }
  if ((t = q('[data-stream]'))) return nav('watch', { watchId: t.dataset.stream, watchMode: 'viewer' });
  if ((t = q('[data-guild]'))) return nav('guild', { guildId: t.dataset.guild });
  if ((t = q('[data-nav]'))) return nav(t.dataset.nav);
});

/* ============================== авторизация ============================== */
function renderAuth(scr) {
  header('Добро пожаловать!');
  $('#nav').style.display = 'none';
  scr.innerHTML = `
    <div class="auth">
      <div class="auth-logo">🍊</div>
      <h1>Omlet Arcade <span class="accent">PC</span></h1>
      <p class="muted">Эфиры, гильдии и лента — как в мобильном Omlet Arcade, только на ПК</p>
      <div class="auth-tabs">
        <button class="auth-tab active" data-tab="login">Вход</button>
        <button class="auth-tab" data-tab="reg">Регистрация</button>
      </div>
      <form id="f-login" class="auth-form">
        <input name="username" placeholder="Ник" autocomplete="username" required>
        <input name="password" type="password" placeholder="Пароль" autocomplete="current-password" required>
        <button class="btn big">Войти</button>
      </form>
      <form id="f-reg" class="auth-form" style="display:none">
        <input name="username" placeholder="Ник (латиница, 3–20)" autocomplete="username" required>
        <input name="password" type="password" placeholder="Пароль (минимум 6)" autocomplete="new-password" required>
        <button class="btn big">Создать аккаунт 🍊</button>
      </form>
    </div>`;
  scr.querySelectorAll('.auth-tab').forEach((t) => t.onclick = () => {
    scr.querySelectorAll('.auth-tab').forEach((x) => x.classList.toggle('active', x === t));
    $('#f-login').style.display = t.dataset.tab === 'login' ? '' : 'none';
    $('#f-reg').style.display = t.dataset.tab === 'reg' ? '' : 'none';
  });
  $('#f-login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api('POST', '/api/login', { username: e.target.username.value.trim(), password: e.target.password.value });
      setAuth(d.token, d.user);
      enterApp();
    } catch (err) { toast(err.message); }
  };
  $('#f-reg').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api('POST', '/api/register', { username: e.target.username.value.trim(), password: e.target.password.value });
      setAuth(d.token, d.user);
      enterApp();
      toast('Аккаунт создан! Добро пожаловать 🍊');
    } catch (err) { toast(err.message); }
  };
}

function enterApp() {
  notifUnread = 0; dmUnread = 0;
  connectWS();
  nav('home');
}

/* ============================== главная / лента ============================== */
const liveCard = (s) => `
  <div class="live-card" data-stream="${esc(s.id)}">
    <div class="live-thumb">${gameIcon(s.game)}<span class="live-dot">LIVE</span></div>
    <div class="live-card-title">${esc(s.title)}</div>
    <div class="live-card-sub">${esc(s.host_username)} · 👁 ${s.viewers}</div>
  </div>`;

function postHTML(p) {
  return `
  <div class="post" data-post="${esc(p.id)}">
    <div class="post-head">
      ${avatarHTML(p, 40)}
      <div class="row-main" data-user="${esc(p.username)}">
        <div class="row-title">${esc(p.username)}</div>
        <div class="muted tiny">${timeAgo(p.created_at)}</div>
      </div>
    </div>
    ${p.text ? `<div class="post-text">${esc(p.text).replace(/\n/g, '<br>')}</div>` : ''}
    ${p.image ? `<img class="post-img" src="${esc(p.image)}" loading="lazy" alt="">` : ''}
    <div class="post-actions">
      <button class="pa ${p.liked ? 'liked' : ''}" data-like="${esc(p.id)}">❤ <span class="lc">${p.likes ?? 0}</span></button>
      <button class="pa" data-cmt="${esc(p.id)}">💬 <span class="cc">${p.comments ?? 0}</span></button>
    </div>
    <div class="cbox" id="cbox-${esc(p.id)}" hidden></div>
  </div>`;
}

function fileToDataUrl(file, cb) {
  const img = new Image();
  img.onload = () => {
    try {
      const scale = Math.min(1, 1000 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = 0.85, url = c.toDataURL('image/jpeg', q);
      while (url.length > 280000 && q > 0.35) { q -= 0.15; url = c.toDataURL('image/jpeg', q); }
      cb(url);
    } catch { cb(null); }
  };
  img.onerror = () => cb(null);
  img.src = URL.createObjectURL(file);
}

async function renderHome(scr) {
  header('Главная');
  $('#nav').style.display = '';
  const [feedD, streamsD] = await Promise.all([api('GET', '/api/feed'), api('GET', '/api/streams')]);
  const posts = feedD.posts || [];
  const live = streamsD.live || [];
  scr.innerHTML = `
    ${live.length ? `<div class="section-title">🔴 Сейчас в эфире</div><div class="hscroll">${live.map(liveCard).join('')}</div>` : ''}
    <div class="composer">
      <textarea id="post-text" placeholder="Что нового? Делись моментами из игр…" maxlength="1000"></textarea>
      <div class="composer-row">
        <label class="icon-btn" title="Прикрепить картинку">🖼<input type="file" id="post-img" accept="image/*" hidden></label>
        <span id="post-img-name" class="muted small"></span>
        <button id="post-send" class="btn">Опубликовать</button>
      </div>
    </div>
    <div class="section-title">📰 Лента</div>
    <div id="feed">${posts.map((p) => postHTML(p)).join('') || '<div class="empty">Пока пусто — будь первым! 🍊</div>'}</div>`;
  let postImage = null;
  $('#post-img').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('#post-img-name').textContent = f.name.slice(0, 30);
    fileToDataUrl(f, (url) => { postImage = url; if (!url) { postImage = null; $('#post-img-name').textContent = 'файл не поддержан'; } });
  };
  $('#post-send').onclick = async () => {
    const text = $('#post-text').value.trim();
    if (!text && !postImage) return toast('Пост пустой');
    try {
      await api('POST', '/api/posts', { text, image: postImage });
      toast('Опубликовано 🍊');
      render();
    } catch (err) { toast(err.message); }
  };
}

async function toggleLike(btn) {
  if (!me()) return nav('auth');
  try {
    const r = await api('POST', '/api/posts/' + btn.dataset.like + '/like');
    btn.classList.toggle('liked', r.liked);
    btn.querySelector('.lc').textContent = r.likes;
  } catch (e) { toast(e.message); }
}

async function toggleComments(btn) {
  const id = btn.dataset.cmt;
  const box = document.getElementById('cbox-' + id);
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  try {
    const r = await api('GET', '/api/posts/' + id + '/comments');
    box.innerHTML = `
      <div class="clist">${(r.comments || []).map((c) => `
        <div class="cmt">${avatarHTML(c, 24)}<div><b style="color:${esc(c.avatar_color)}">${esc(c.username)}</b> <span>${esc(c.text)}</span></div></div>`).join('') || '<div class="muted tiny">Пока нет комментариев</div>'}</div>
      <form class="c-form"><input placeholder="Твой комментарий…" maxlength="300" autocomplete="off"><button class="btn small">➤</button></form>`;
    box.querySelector('.c-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const text = ev.target.querySelector('input').value.trim();
      if (!text) return;
      try {
        const rr = await api('POST', '/api/posts/' + id + '/comments', { text });
        box.querySelector('.clist').insertAdjacentHTML('beforeend',
          `<div class="cmt">${avatarHTML(rr.comment, 24)}<div><b style="color:${esc(rr.comment.avatar_color)}">${esc(rr.comment.username)}</b> <span>${esc(rr.comment.text)}</span></div></div>`);
        ev.target.reset();
        const cc = btn.querySelector('.cc');
        cc.textContent = (parseInt(cc.textContent) || 0) + 1;
      } catch (e) { toast(e.message); }
    };
  } catch (e) { box.hidden = true; toast(e.message); }
}

/* ============================== открытия ============================== */
const guildRow = (g) => `
  <div class="row" data-guild="${esc(g.id)}">
    <div class="notif-icon">🛡</div>
    <div class="row-main">
      <div class="row-title">${esc(g.name)} ${g.tag ? `<span class="tag">${esc(g.tag)}</span>` : ''}</div>
      <div class="row-sub">${esc(g.description || '').slice(0, 60)}</div>
    </div>
    <span class="muted small">👥 ${g.members}</span>
  </div>`;

async function renderDiscover(scr) {
  header('Открытия');
  $('#nav').style.display = '';
  const d = await api('GET', '/api/discover');
  const m = me();
  scr.innerHTML = `
    <div class="section-title">🔥 Игры в эфире</div>
    <div class="chips">${(d.games || []).map((g) => `<span class="chip">${gameIcon(g.game)} ${esc(g.game)} · ${g.c}</span>`).join('') || '<span class="muted">Пока никто не стримит</span>'}</div>
    <div class="section-title">⭐ Топ стримеров</div>
    <div class="list">${(d.top_streamers || []).map((u) => `
      <div class="row">
        ${avatarHTML(u, 44)}
        <div class="row-main" data-user="${esc(u.username)}">
          <div class="row-title">${esc(u.username)} ${u.is_live ? '<span class="live-dot">LIVE</span>' : ''}</div>
          <div class="row-sub">👥 ${u.followers} подписчиков${u.bio ? ' · ' + esc(u.bio.slice(0, 40)) : ''}</div>
        </div>
        ${u.username !== m?.username ? `
          <button class="btn small" data-follow="${esc(u.username)}">Подписаться</button>
          <button class="btn small ghost" data-dm="${esc(u.username)}" title="Написать">💬</button>` : ''}
      </div>`).join('')}</div>
    <div class="section-title">🛡 Гильдии</div>
    ${m ? '<button id="btn-gcreate" class="btn ghost full">＋ Создать гильдию</button><div id="gcreate-box"></div>' : ''}
    <div class="list">${(d.guilds || []).map(guildRow).join('') || '<div class="empty">Гильдий пока нет — создай первую!</div>'}</div>`;
  const gc = $('#btn-gcreate');
  if (gc) gc.onclick = () => {
    $('#gcreate-box').innerHTML = `
      <form id="gf" class="card">
        <div class="row-sub" style="margin-bottom:10px">Название (3–24), тег (до 5 симв.) и описание</div>
        <input id="gf-name" placeholder="Название гильдии" maxlength="24" required>
        <input id="gf-tag" placeholder="Тег, напр. OML" maxlength="5" style="margin:10px 0">
        <input id="gf-desc" placeholder="Описание" maxlength="300" style="margin-bottom:10px">
        <button class="btn">Создать</button>
      </form>`;
    $('#gf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/guilds', { name: $('#gf-name').value.trim(), tag: $('#gf-tag').value.trim(), description: $('#gf-desc').value });
        toast('Гильдия создана!');
        nav('guild', { guildId: r.guild.id });
      } catch (err) { toast(err.message); }
    };
  };
}

async function toggleFollow(username, btn) {
  if (!me()) return nav('auth');
  try {
    const info = await api('GET', '/api/users/' + encodeURIComponent(username));
    if (info.is_following) {
      await api('DELETE', '/api/users/' + encodeURIComponent(username) + '/follow');
      if (btn) btn.textContent = 'Подписаться';
      toast('Вы отписались от ' + username);
    } else {
      await api('POST', '/api/users/' + encodeURIComponent(username) + '/follow');
      if (btn) btn.textContent = 'Отписаться';
      toast('Вы подписались на ' + username);
    }
  } catch (e) { toast(e.message); }
}

async function toggleGuild(id) {
  if (!me()) return nav('auth');
  try {
    const r = await api('POST', '/api/guilds/' + id + '/join');
    toast(r.joined ? 'Вы вступили в гильдию 🛡' : 'Вы покинули гильдию');
    if (state.screen === 'guild') render();
  } catch (e) { toast(e.message); }
}

/* ============================== эфиры ============================== */
const streamRow = (s) => `
  <div class="row" data-stream="${esc(s.id)}" style="cursor:pointer">
    <div class="notif-icon">${gameIcon(s.game)}</div>
    <div class="row-main">
      <div class="row-title">${esc(s.title)} <span class="live-dot">LIVE</span></div>
      <div class="row-sub">${esc(s.host_username)} · 👁 ${s.viewers} · ${timeAgo(s.started_at)}</div>
    </div>
    <button class="btn small">Смотреть</button>
  </div>`;

const streamRowEnded = (s) => `
  <div class="row">
    <div class="notif-icon">📺</div>
    <div class="row-main">
      <div class="row-title">${esc(s.title)}</div>
      <div class="row-sub">${esc(s.host_username)} · завершился ${timeAgo(s.ended_at)}</div>
    </div>
  </div>`;

async function renderLive(scr) {
  header('⏺ Эфиры');
  $('#nav').style.display = '';
  const d = await api('GET', '/api/streams');
  scr.innerHTML = `
    ${me() ? '<button id="btn-golive" class="btn big full">⏺ Go Live — начать эфир</button>' : '<div class="empty">Войдите, чтобы стримить и смотреть эфиры</div>'}
    <div class="section-title">🔴 В эфире сейчас</div>
    <div class="list">${(d.live || []).map(streamRow).join('') || '<div class="empty">Никто не стримит. Стань первым! ⏺</div>'}</div>
    <div class="section-title">📺 Недавние</div>
    <div class="list">${(d.recent || []).slice(0, 15).map(streamRowEnded).join('') || ''}</div>`;
  const go = $('#btn-golive');
  if (go) go.onclick = () => nav('golive');
}

async function renderGoLive(scr) {
  if (!me()) return nav('auth');
  header('Настройка эфира', 'live');
  const games = (await api('GET', '/api/games')).games;
  scr.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0">Новый эфир</div>
      <form id="golive-form">
        <input id="gl-title" placeholder="Название эфира" maxlength="100" required>
        <select id="gl-game">${games.map((g) => `<option>${esc(g)}</option>`).join('')}</select>
        <input id="gl-rtmp" placeholder="RTMP URL для Twitch/YouTube (необязательно)">
        <div class="muted small" style="margin:8px 0 14px">Например: rtmp://live.twitch.tv/app/ВАШ_КЛЮЧ — картинка пойдёт и в веб-чат, и на Twitch (эксперимент). Без RTMP стрим идёт только внутри Omlet Arcade PC.</div>
        <button class="btn big full" style="margin:0">⏺ В эфир!</button>
      </form>
    </div>`;
  $('#golive-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      state.rtmpUrl = $('#gl-rtmp').value.trim() || null;
      const d = await api('POST', '/api/streams', { title: $('#gl-title').value, game: $('#gl-game').value, rtmp_url: state.rtmpUrl });
      nav('watch', { watchId: d.stream.id, watchMode: 'host' });
    } catch (err) { toast(err.message); }
  };
}

/* ---------- просмотр / хостинг эфира ---------- */
function addChat(m) {
  const c = $('#chat');
  if (!c || !m.user) return;
  const d = document.createElement('div');
  d.className = 'chat-msg';
  d.innerHTML = `${avatarHTML(m.user, 26)}<div><b style="color:${esc(m.user.avatar_color || '#ccc')}">${esc(m.user.username)}</b> <span>${esc(m.text)}</span></div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

async function renderWatch(scr) {
  const d = await api('GET', '/api/streams/' + state.watchId);
  const s = d.stream;
  const host = state.watchMode === 'host';
  if (s.status !== 'live') {
    header(s.title, 'live');
    scr.innerHTML = `<div class="card center"><div style="font-size:40px">📺</div><div class="section-title">Этот эфир уже завершился</div><button class="btn" data-nav="live">К списку эфиров</button></div>`;
    return;
  }
  header(s.title, 'live');
  scr.innerHTML = `
    <div class="video-wrap">
      <video id="video" autoplay playsinline muted></video>
      <div id="voverlay" class="voverlay">${host ? 'Выбери окно/экран для захвата…' : 'Ожидание видео…'}</div>
      <div class="vstats">🔴 LIVE · 👁 <span id="vcount">…</span></div>
    </div>
    ${host ? `
      <div class="card">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button id="btn-rtmp" class="btn">📺 Ретрансляция на Twitch/YouTube</button>
          <button id="btn-end" class="btn danger">⏹ Завершить эфир</button>
        </div>
        <div id="rtmp-status" class="muted small" style="margin-top:8px">${s.rtmp_url ? 'RTMP: ' + esc(s.rtmp_url) : 'Без RTMP — только внутренний эфир'}</div>
      </div>` : `
      <div class="row">
        ${avatarHTML({ username: s.host_username, avatar_color: s.host_color }, 42)}
        <div class="row-main" data-user="${esc(s.host_username)}">
          <div class="row-title">${esc(s.host_username)}</div>
          <div class="row-sub">👥 ${d.host_followers} подписчиков</div>
        </div>
        <button class="btn small" data-follow="${esc(s.host_username)}">Подписаться</button>
      </div>`}
    <div class="section-title">Чат эфира</div>
    <div id="chat" class="chat"></div>
    ${me() ? '<form id="chat-form" class="chat-form"><input id="chat-input" placeholder="Написать в чат…" maxlength="300" autocomplete="off"><button class="btn">➤</button></form>'
      : '<div class="empty">Войдите, чтобы писать в чат</div>'}`;
  (d.messages || []).forEach((m) => addChat({ text: m.text, user: { username: m.username, avatar_color: m.avatar_color } }));
  const video = $('#video');
  video.onclick = () => { video.muted = !video.muted; toast(video.muted ? '🔇 Звук выключен' : '🔊 Звук включен'); };
  $('#btn-end') && ($('#btn-end').onclick = endHostStream);
  $('#btn-rtmp') && ($('#btn-rtmp').onclick = () => toggleRtmp());
  $('#chat-form') && ($('#chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text || !streamWS || streamWS.readyState !== 1) return;
    $('#chat-input').value = '';
    streamWS.send(JSON.stringify({ type: 'chat', text }));
  });
  connectStreamWS(s, host);
}

function connectStreamWS(s, host) {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  streamWS = new WebSocket(`${proto}${location.host}/ws?stream=${s.id}&token=${tok()}`);
  streamWS.binaryType = 'arraybuffer';

  streamWS.onopen = () => {
    if (!host) {
      streamWS.send(JSON.stringify({ type: 'ready' }));
      // переподключение сигнала, если хост ещё не начал захват
      let tries = 0;
      readyTimer = setInterval(() => {
        if (++tries > 6 || state.screen !== 'watch' || host) { clearInterval(readyTimer); return; }
        const v = $('#video');
        if (v && !v.srcObject) streamWS.send(JSON.stringify({ type: 'ready' }));
      }, 7000);
    }
  };

  streamWS.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'welcome':
      case 'host-welcome': {
        const v = $('#vcount'); if (v) v.textContent = m.viewers;
        if (host) await startScreenShare(s);
        break;
      }
      case 'viewers': { const v = $('#vcount'); if (v) v.textContent = m.count; break; }
      case 'peer-joined': {
        if (host) {
          if (screenStream) createHostPC(m.peerId);
          else pendingPeers.add(m.peerId);
        }
        break;
      }
      case 'signal': {
        if (host) {
          const pc = pcs.get(m.from);
          if (!pc) break;
          if (m.data.desc) await pc.setRemoteDescription(m.data.desc).catch(() => {});
          if (m.data.candidate) await pc.addIceCandidate(m.data.candidate).catch(() => {});
        } else {
          if (!viewerPC) viewerPC = createViewerPC();
          if (m.data.desc) {
            await viewerPC.setRemoteDescription(m.data.desc).catch(() => {});
            if (m.data.desc.type === 'offer') {
              const ans = await viewerPC.createAnswer();
              await viewerPC.setLocalDescription(ans);
              streamWS.send(JSON.stringify({ type: 'signal', to: 'host', data: { desc: ans } }));
            }
          }
          if (m.data.candidate) await viewerPC.addIceCandidate(m.data.candidate).catch(() => {});
        }
        break;
      }
      case 'chat': addChat(m); break;
      case 'error': toast(m.message === 'login_required' ? 'Войдите, чтобы писать в чат' : String(m.message)); break;
      case 'rtmp-status': rtmpStatus(m); break;
      case 'stream-ended': onStreamEnded(); break;
    }
  };

  streamWS.onclose = () => {
    clearInterval(readyTimer);
    if (state.screen === 'watch') setTimeout(() => { if (state.screen === 'watch') render(); }, 2500);
  };
}

function createViewerPC() {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.ontrack = (e) => {
    const v = $('#video');
    if (v) {
      v.srcObject = e.streams[0];
      $('#voverlay') && ($('#voverlay').style.display = 'none');
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate && streamWS && streamWS.readyState === 1) {
      streamWS.send(JSON.stringify({ type: 'signal', to: 'host', data: { candidate: e.candidate.toJSON() } }));
    }
  };
  return pc;
}

function createHostPC(peerId) {
  if (!screenStream) return;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pcs.set(peerId, pc);
  for (const t of screenStream.getTracks()) { try { pc.addTrack(t, screenStream); } catch {} }
  pc.onicecandidate = (e) => {
    if (e.candidate && streamWS && streamWS.readyState === 1) {
      streamWS.send(JSON.stringify({ type: 'signal', to: peerId, data: { candidate: e.candidate.toJSON() } }));
    }
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) pcs.delete(peerId);
  };
  pc.createOffer().then(async (offer) => {
    await pc.setLocalDescription(offer);
    streamWS && streamWS.readyState === 1 && streamWS.send(JSON.stringify({ type: 'signal', to: peerId, data: { desc: pc.localDescription } }));
  }).catch(() => pcs.delete(peerId));
}

async function startScreenShare(s) {
  if (screenStream) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch { toast('Захват экрана отменён — эфир без видео'); }
  if (!screenStream) return;
  const v = $('#video');
  if (v) { v.srcObject = screenStream; v.muted = true; }
  const ov = $('#voverlay'); if (ov) ov.style.display = 'none';
  screenStream.getVideoTracks()[0].onended = endHostStream; // нажали «Остановить показ»
  for (const id of pendingPeers) createHostPC(id);
  pendingPeers.clear();
  if (s.rtmp_url) toggleRtmp(); // авто-включение ретрансляции
}

function pickMime() {
  for (const m of ['video/webm;codecs=vp8,opus', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function startRecorder() {
  if (!screenStream) return;
  const mime = pickMime();
  try {
    recorder = mime ? new MediaRecorder(screenStream, { mimeType: mime, videoBitsPerSecond: 2500000 }) : new MediaRecorder(screenStream);
  } catch (e) { $('#rtmp-status').textContent = '🔴 MediaRecorder не поддержан: ' + e.message; return; }
  recorder.ondataavailable = (e) => {
    if (!e.data.size || !rtmpActive) return;
    e.data.arrayBuffer().then((buf) => {
      if (!rtmpActive || !streamWS || streamWS.readyState !== 1) return;
      const frame = new Uint8Array(buf.byteLength + 1);
      frame[0] = 1; // маркер RTMP-чанка для сервера
      frame.set(new Uint8Array(buf), 1);
      streamWS.send(frame);
    });
  };
  recorder.start(1000);
}

function toggleRtmp() {
  if (!streamWS || streamWS.readyState !== 1) return;
  if (rtmpActive) {
    rtmpActive = false;
    try { recorder && recorder.stop(); } catch {}
    streamWS.send(JSON.stringify({ type: 'rtmp-stop' }));
    const el = $('#rtmp-status'); if (el) el.textContent = 'Ретрансляция выключена';
    const b = $('#btn-rtmp'); if (b) b.textContent = '📺 Ретрансляция на Twitch/YouTube';
    return;
  }
  if (!state.rtmpUrl) {
    const el = $('#rtmp-status');
    if (el) el.textContent = '🔴 RTMP URL не задан — укажи его при создании эфира';
    return;
  }
  streamWS.send(JSON.stringify({ type: 'rtmp-start', url: state.rtmpUrl }));
}

function rtmpStatus(m) {
  const el = $('#rtmp-status'); if (!el) return;
  if (m.ok) {
    rtmpActive = true;
    startRecorder();
    el.textContent = '🟢 Ретрансляция включена — видео уходит на внешний сервис';
    const b = $('#btn-rtmp'); if (b) b.textContent = '⏹ Отключить ретрансляцию';
    toast('📺 Стрим ретранслируется на Twitch/YouTube');
  } else {
    const msgs = { ffmpeg_unavailable: 'на сервере нет ffmpeg — ретрансляция недоступна', bad_url: 'неверный RTMP URL (должен начинаться с rtmp:// или rtmps://)' };
    el.textContent = '🔴 ' + (msgs[m.error] || m.error);
  }
}

async function endHostStream() {
  try { await api('POST', '/api/streams/' + state.watchId + '/end'); } catch {}
  cleanupStream();
  toast('Эфир завершён 🍊');
  nav('live');
}

function onStreamEnded() {
  toast('Стрим завершился');
  cleanupStream();
  nav('live');
}

function cleanupStream() {
  clearInterval(readyTimer);
  try { recorder && recorder.state !== 'inactive' && recorder.stop(); } catch {}
  recorder = null;
  rtmpActive = false;
  try { screenStream && screenStream.getTracks().forEach((t) => t.stop()); } catch {}
  screenStream = null;
  for (const pc of pcs.values()) { try { pc.close(); } catch {} }
  pcs.clear();
  pendingPeers.clear();
  if (viewerPC) { try { viewerPC.close(); } catch {} viewerPC = null; }
  try { streamWS && streamWS.close(); } catch {}
  streamWS = null;
}

/* ============================== сообщения ============================== */
function dmBubble(m) {
  const mine = m.sender_id === me()?.id;
  return `<div class="dm-bubble ${mine ? 'mine' : ''}"><div class="bubble">${esc(m.text)}</div><div class="muted tiny">${timeAgo(m.created_at)}</div></div>`;
}

async function refreshDmUnread() {
  try {
    const d = await api('GET', '/api/dm/contacts');
    dmUnread = (d.contacts || []).reduce((s, c) => s + (c.unread || 0), 0);
    updateBadges();
  } catch {}
}

async function renderMessages(scr) {
  header('Сообщения');
  $('#nav').style.display = '';
  const d = await api('GET', '/api/dm/contacts');
  scr.innerHTML = `
    <form id="dm-new" class="dm-new">
      <input id="dm-new-name" placeholder="Ник пользователя, напримерalice" autocomplete="off">
      <button class="btn">Начать чат</button>
    </form>
    <div class="list">${(d.contacts || []).map((c) => `
      <div class="row" data-user="${esc(c.username)}" style="cursor:pointer">
        ${avatarHTML(c, 46)}
        <div class="row-main">
          <div class="row-title">${esc(c.username)}${c.unread ? ` <span class="pill">${c.unread}</span>` : ''}</div>
          <div class="row-sub">${esc((c.last_text || '').slice(0, 50))}</div>
        </div>
        <div class="muted tiny">${timeAgo(c.last_at)}</div>
      </div>`).join('') || '<div class="empty">Чатов нет. Найди кого-нибудь в Открытиях! 💬</div>'}</div>`;
  $('#dm-new').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#dm-new-name').value.trim();
    if (!name) return;
    try {
      await api('GET', '/api/users/' + encodeURIComponent(name));
      nav('dialog', { dialogUser: name });
    } catch { toast('Пользователь не найден'); }
  };
  refreshDmUnread();
}

async function renderDialog(scr) {
  const name = state.dialogUser;
  header('💬 ' + name, 'messages');
  const d = await api('GET', '/api/dm/' + encodeURIComponent(name));
  scr.innerHTML = `
    <div class="dm-head">${avatarHTML(d.peer, 42)}<div><b>${esc(d.peer.username)}</b><div class="muted small">${esc(d.peer.bio || '')}</div></div></div>
    <div id="dm-list" class="dm-list">${(d.messages || []).map(dmBubble).join('')}</div>
    <form id="dm-form" class="chat-form"><input id="dm-input" placeholder="Сообщение…" maxlength="1000" autocomplete="off"><button class="btn">➤</button></form>`;
  const list = $('#dm-list');
  list.scrollTop = list.scrollHeight;
  $('#dm-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#dm-input').value.trim();
    if (!text) return;
    $('#dm-input').value = '';
    try {
      const r = await api('POST', '/api/dm/' + encodeURIComponent(name), { text });
      list.insertAdjacentHTML('beforeend', dmBubble({ sender_id: me().id, text, created_at: r.message.created_at }));
      list.scrollTop = list.scrollHeight;
    } catch (err) { toast(err.message); }
  };
  refreshDmUnread(); // открытие диалога = прочтение на сервере
}

/* ============================== уведомления ============================== */
async function openNotifications() {
  let d;
  try { d = await api('GET', '/api/notifications'); } catch (e) { return toast(e.message); }
  notifUnread = 0;
  updateBadges();
  api('POST', '/api/notifications/read').catch(() => {});
  const items = (d.notifications || []).map((n) => {
    const p = n.payload || {};
    const icon = { live: '🔴', like: '❤️', comment: '💬', follow: '➕' }[n.type] || '🔔';
    const text = {
      live: `${p.host} начал эфир: ${p.title}`,
      like: `${p.by} лайкнул твой пост`,
      comment: `${p.by} прокомментировал: ${(p.text || '').slice(0, 40)}`,
      follow: `${p.by} подписался на тебя`,
    }[n.type] || n.type;
    const attrs = n.type === 'live' && p.stream_id ? `data-stream="${esc(p.stream_id)}" style="cursor:pointer"` : p.by ? `data-user="${esc(p.by)}" style="cursor:pointer"` : '';
    return `<div class="row notif ${n.unread ? 'unread' : ''}" ${attrs}>
      <div class="notif-icon">${icon}</div>
      <div class="row-main"><div class="row-title">${esc(text)}</div><div class="muted tiny">${timeAgo(n.created_at)}</div></div>
    </div>`;
  }).join('');
  modal(items || '<div class="empty">Уведомлений пока нет 🔔</div>', 'Уведомления');
}

/* ============================== профиль ============================== */
async function renderProfile(scr) {
  const m = me();
  header('Профиль');
  $('#nav').style.display = '';
  const d = await api('GET', '/api/users/' + encodeURIComponent(m.username));
  state.selColor = d.user.avatar_color;
  const posts = (d.posts || []).map((p) => ({ ...p, username: d.user.username, avatar_color: d.user.avatar_color }));
  const streams = (d.streams || []).map((s) => ({ ...s, host_username: d.user.username }));
  scr.innerHTML = `
    <div class="card center">
      ${avatarHTML(d.user, 84)}
      <div class="big-name">${esc(d.user.username)}</div>
      <div class="row-sub" style="white-space:normal">${esc(d.user.bio || 'Расскажи о себе…')}</div>
      <div class="stats">
        <div><b>${d.followers}</b><span>подписчиков</span></div>
        <div><b>${d.following}</b><span>подписки</span></div>
        <div><b>${d.streams_total}</b><span>эфиров</span></div>
      </div>
      <div class="colors">${COLORS.map((c) => `<button class="color-dot ${c === d.user.avatar_color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div>
      <form id="bio-form" style="display:flex;gap:8px">
        <input id="bio-input" value="${esc(d.user.bio)}" placeholder="О себе (до 200)" maxlength="200">
        <button class="btn">Сохранить</button>
      </form>
    </div>
    <div class="section-title">⏺ Мои эфиры</div>
    <div class="list">${streams.map((s) => s.status === 'live' ? streamRow(s) : streamRowEnded(s)).join('') || '<div class="empty muted">Ещё не стримил</div>'}</div>
    <div class="section-title">📰 Мои посты</div>
    <div>${posts.map((p) => postHTML(p)).join('') || '<div class="empty muted">Постов нет</div>'}</div>
    <button id="btn-logout" class="btn danger full" style="margin-top:16px">🚪 Выйти из аккаунта</button>`;
  scr.querySelectorAll('.color-dot').forEach((b) => b.onclick = () => {
    state.selColor = b.dataset.color;
    scr.querySelectorAll('.color-dot').forEach((x) => x.classList.toggle('sel', x === b));
  });
  $('#bio-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('PATCH', '/api/me', { bio: $('#bio-input').value, avatar_color: state.selColor });
      setAuth(tok(), r.user);
      toast('Профиль сохранён ✅');
    } catch (err) { toast(err.message); }
  };
  $('#btn-logout').onclick = logout;
}

async function renderUser(scr) {
  const d = await api('GET', '/api/users/' + encodeURIComponent(state.user));
  header('@' + d.user.username, 'discover');
  const posts = (d.posts || []).map((p) => ({ ...p, username: d.user.username, avatar_color: d.user.avatar_color }));
  const streams = (d.streams || []).map((s) => ({ ...s, host_username: d.user.username }));
  scr.innerHTML = `
    <div class="card center">
      ${avatarHTML(d.user, 84)}
      <div class="big-name">${esc(d.user.username)}</div>
      <div class="row-sub" style="white-space:normal">${esc(d.user.bio || '')}</div>
      ${d.live_stream_id ? `<button class="btn big" data-stream="${esc(d.live_stream_id)}" style="margin:10px 0">🔴 Смотреть эфир!</button>` : ''}
      <div class="stats">
        <div><b>${d.followers}</b><span>подписчиков</span></div>
        <div><b>${d.following}</b><span>подписки</span></div>
        <div><b>${d.streams_total}</b><span>эфиров</span></div>
      </div>
      ${me() && me().username !== d.user.username ? `
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn" data-follow="${esc(d.user.username)}">${d.is_following ? 'Отписаться' : 'Подписаться'}</button>
        <button class="btn ghost" data-dm="${esc(d.user.username)}">💬 Написать</button>
      </div>` : ''}
    </div>
    <div class="section-title">⏺ Эфиры</div>
    <div class="list">${streams.map((s) => s.status === 'live' ? streamRow(s) : streamRowEnded(s)).join('') || '<div class="empty muted">Пока нет эфиров</div>'}</div>
    <div class="section-title">📰 Посты</div>
    <div>${posts.map((p) => postHTML(p)).join('') || '<div class="empty muted">Постов нет</div>'}</div>`;
}

/* ============================== гильдии ============================== */
function addGuildChat(m) {
  const c = $('#gchat');
  if (!c || !m.user) return;
  const d = document.createElement('div');
  d.className = 'chat-msg';
  d.innerHTML = `${avatarHTML(m.user, 26)}<div><b style="color:${esc(m.user.avatar_color || '#ccc')}">${esc(m.user.username)}</b> <span>${esc(m.text)}</span></div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

async function renderGuild(scr) {
  const d = await api('GET', '/api/guilds/' + state.guildId);
  header('🛡 ' + d.guild.name, 'discover');
  scr.innerHTML = `
    <div class="card">
      <div class="row-title" style="font-size:17px">${esc(d.guild.name)} ${d.guild.tag ? `<span class="tag">${esc(d.guild.tag)}</span>` : ''}</div>
      <div class="row-sub" style="white-space:normal;margin:6px 0">${esc(d.guild.description || '')}</div>
      <div class="row-sub">👑 ${esc(d.guild.owner_username || '')} · 👥 ${d.guild.member_count} участников</div>
      <div style="margin-top:12px">
        ${me()?.username === d.guild.owner_username
          ? '<span class="tag">Ты владелец этой гильдии</span>'
          : me() ? `<button class="btn" data-gjoin="${esc(d.guild.id)}">${d.joined ? 'Покинуть гильдию' : 'Вступить в гильдию'}</button>`
          : '<div class="muted small">Войдите, чтобы вступить</div>'}
      </div>
    </div>
    <div class="section-title">Участники</div>
    <div class="list">${(d.members || []).map((mem) => `
      <div class="row">
        ${avatarHTML(mem, 36)}
        <div class="row-main" data-user="${esc(mem.username)}">
          <div class="row-title">${esc(mem.username)}</div>
          <div class="row-sub">${mem.role === 'owner' ? '👑 владелец' : 'участник'}</div>
        </div>
        ${me() && mem.username !== me().username ? `<button class="btn small ghost" data-dm="${esc(mem.username)}">💬</button>` : ''}
      </div>`).join('')}</div>
    <div class="section-title">Чат гильдии</div>
    <div id="gchat" class="chat"></div>
    ${me() ? '<form id="gchat-form" class="chat-form"><input id="gchat-input" placeholder="Сообщение в гильдию…" maxlength="300" autocomplete="off"><button class="btn">➤</button></form>'
      : '<div class="empty">Войдите, чтобы писать в чат гильдии</div>'}`;
  (d.messages || []).forEach((m) => addGuildChat({ text: m.text, user: { username: m.username, avatar_color: m.avatar_color } }));
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  guildWS = new WebSocket(`${proto}${location.host}/ws?guild=${d.guild.id}&token=${tok()}`);
  guildWS.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'chat') addGuildChat(m);
  };
  const f = $('#gchat-form');
  if (f) f.onsubmit = (e) => {
    e.preventDefault();
    const text = $('#gchat-input').value.trim();
    if (!text || !guildWS || guildWS.readyState !== 1) return;
    $('#gchat-input').value = '';
    guildWS.send(JSON.stringify({ type: 'chat', text }));
  };
}

/* ============================== запуск ============================== */
window.addEventListener('DOMContentLoaded', async () => {
  if (tok()) {
    try {
      const d = await api('GET', '/api/me');
      setAuth(tok(), d.user);
      notifUnread = d.unread || 0;
      connectWS();
      nav('home');
    } catch {
      localStorage.removeItem('omlet_token');
      localStorage.removeItem('omlet_user');
      nav('auth');
    }
  } else {
    nav('auth');
  }
});
