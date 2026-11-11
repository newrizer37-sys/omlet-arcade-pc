/* Omlet Arcade PC — клиент (vanilla JS SPA) */

const S = {
  token: localStorage.getItem('oapc_token') || null,
  user: JSON.parse(localStorage.getItem('oapc_user') || 'null'),
  ws: null,
  screen: null,          // MediaStream (у хоста)
  pc: null,              // RTCPeerConnection (у зрителя)
  peers: new Map(),      // у хоста: peerId -> RTCPeerConnection
  currentStream: null,
  ended: false,
};

const GAMES = ['Minecraft PE', 'Roblox', 'PUBG Mobile', 'Standoff 2', 'Genshin Impact', 'Brawl Stars', 'Free Fire', 'Другое'];
const ICE_CONFIG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

const $ = (s) => document.querySelector(s);
const app = $('#app');

/* ------------------------------------------------------------------ utils */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = text;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function avatarHTML(user, size = 30) {
  const letter = (user?.username || '?')[0];
  return `<span class="avatar" style="width:${size}px;height:${size}px;font-size:${size * 0.45}px;background:${user?.avatar_color || '#555'}">${esc(letter)}</span>`;
}

function timeAgo(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return 'только что';
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return `${Math.floor(d / 86400)} дн назад`;
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function wsUrl(streamId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ stream: streamId });
  if (S.token) q.set('token', S.token);
  return `${proto}://${location.host}/ws?${q}`;
}

function setAuth(token, user) {
  S.token = token; S.user = user;
  if (token) { localStorage.setItem('oapc_token', token); localStorage.setItem('oapc_user', JSON.stringify(user)); }
  else { localStorage.removeItem('oapc_token'); localStorage.removeItem('oapc_user'); }
  renderUserChip();
}

function renderUserChip() {
  const chip = $('#userchip');
  if (S.user) {
    chip.innerHTML = `
      <a href="#/u/${esc(S.user.username)}" style="display:flex;align-items:center;gap:8px">
        ${avatarHTML(S.user, 32)}
        <span style="font-weight:700;font-size:14px">${esc(S.user.username)}</span>
      </a>
      <button class="btn-ghost" id="logout-btn" style="padding:6px 12px;font-size:12px">Выйти</button>`;
    $('#logout-btn').onclick = () => { setAuth(null, null); toast('Вы вышли из аккаунта'); route(); };
  } else {
    chip.innerHTML = `<button class="btn-ghost" id="login-btn">Войти</button>`;
    $('#login-btn').onclick = () => openAuthModal('login');
  }
}

/* ------------------------------------------------------------------ modal */
function openModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"></div><div class="modal">${html}</div>`;
  root.classList.add('open');
  root.querySelector('.modal-backdrop').onclick = closeModal;
  return root.querySelector('.modal');
}
function closeModal() {
  const root = $('#modal-root');
  root.classList.remove('open');
  root.innerHTML = '';
}

function openAuthModal(mode = 'login') {
  const isLogin = mode === 'login';
  const m = openModal(`
    <h2>${isLogin ? 'Вход' : 'Регистрация'}</h2>
    <label>Ник</label>
    <input type="text" id="auth-username" maxlength="20" placeholder="например, ProGamer_2026" autocomplete="username">
    <label>Пароль</label>
    <input type="password" id="auth-password" placeholder="минимум 6 символов" autocomplete="current-password">
    <div class="form-error" id="auth-error"></div>
    <div class="actions">
      <button class="btn-primary" id="auth-submit">${isLogin ? 'Войти' : 'Создать аккаунт'}</button>
    </div>
    <div class="switch-auth">${isLogin ? 'Нет аккаунта? <a id="auth-switch">Зарегистрироваться</a>' : 'Уже есть аккаунт? <a id="auth-switch">Войти</a>'}</div>
  `);
  m.querySelector('#auth-switch').onclick = () => openAuthModal(isLogin ? 'register' : 'login');
  m.querySelector('#auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const submit = async () => {
    const username = m.querySelector('#auth-username').value.trim();
    const password = m.querySelector('#auth-password').value;
    const err = m.querySelector('#auth-error');
    err.textContent = '';
    try {
      const data = await api(isLogin ? '/login' : '/register', { method: 'POST', body: { username, password } });
      setAuth(data.token, data.user);
      closeModal();
      toast(isLogin ? `С возвращением, ${data.user.username}!` : 'Аккаунт создан! Добро пожаловать 🎉');
      route();
    } catch (e) { err.textContent = e.message; }
  };
  m.querySelector('#auth-submit').onclick = submit;
}

/* -------------------------------------------------------------- go live */
async function goLiveFlow() {
  if (!S.user) { openAuthModal('login'); return; }
  const m = openModal(`
    <h2>🍊 Начать эфир</h2>
    <label>Название трансляции</label>
    <input type="text" id="gl-title" maxlength="100" placeholder="Например: Стримим Minecraft, заходи!">
    <label>Игра</label>
    <select id="gl-game">${GAMES.map((g) => `<option>${esc(g)}</option>`).join('')}</select>
    <div class="preview-strip" id="gl-preview">📺 Экран ещё не выбран</div>
    <div class="form-error" id="gl-error"></div>
    <div class="actions">
      <button class="btn-ghost" id="gl-pick">Выбрать экран</button>
      <button class="btn-primary" id="gl-start" disabled>В эфир!</button>
    </div>
  `);
  const preview = m.querySelector('#gl-preview');
  const startBtn = m.querySelector('#gl-start');
  m.querySelector('#gl-pick').onclick = async () => {
    try {
      S.screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 }, audio: true,
      });
      preview.classList.add('ok');
      preview.textContent = '✅ Экран захвачен: ' + (S.screen.getVideoTracks()[0].label || 'источник');
      startBtn.disabled = false;
      S.screen.getVideoTracks()[0].addEventListener('ended', () => {
        preview.classList.remove('ok');
        preview.textContent = '📺 Экран ещё не выбран';
        startBtn.disabled = true;
      });
    } catch (e) {
      m.querySelector('#gl-error').textContent = 'Захват экрана отменён';
    }
  };
  startBtn.onclick = async () => {
    try {
      startBtn.disabled = true;
      const { stream } = await api('/streams', { method: 'POST', body: { title: m.querySelector('#gl-title').value, game: m.querySelector('#gl-game').value } });
      S.currentStream = stream;
      closeModal();
      location.hash = '#/live/' + stream.id;
    } catch (e) {
      m.querySelector('#gl-error').textContent = e.message;
      startBtn.disabled = false;
    }
  };
}

/* --------------------------------------------------------------- routing */
function cleanupLive() {
  if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
  for (const pc of S.peers.values()) { try { pc.close(); } catch {} }
  S.peers.clear();
  if (S.pc) { try { S.pc.close(); } catch {} S.pc = null; }
  if (S.screen) {
    for (const t of S.screen.getTracks()) t.stop();
    S.screen = null;
  }
  S.currentStream = null;
  S.ended = false;
}

window.addEventListener('hashchange', route);

async function route() {
  cleanupLive();
  const h = location.hash || '#/';
  $('#mainnav').querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#/' && h === '#/'));
  if (h.startsWith('#/live/')) return viewStream(h.slice(7));
  if (h.startsWith('#/u/')) return viewProfile(decodeURIComponent(h.slice(4)));
  return viewHome();
}

/* ------------------------------------------------------------------ home */
async function viewHome() {
  app.innerHTML = '<div class="loading">Загрузка эфиров…</div>';
  let data;
  try { data = await api('/streams'); } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const liveCards = data.live.map(streamCard).join('');
  const recentCards = data.recent.map(streamCard).join('');

  app.innerHTML = `
    <div class="hero">
      <h1>Твои игры. Твой эфир. 🍊</h1>
      <p>Omlet Arcade вернулся — теперь на ПК. Стримь свой экран, общайся в чате, подписывайся на стримеров.</p>
      <button class="btn-primary" id="hero-golive" style="font-size:16px;padding:12px 26px">▶ Начать трансляцию</button>
    </div>

    <div class="section-title"><span class="dot"></span> Сейчас в эфире (${data.live.length})</div>
    ${data.live.length ? `<div class="grid-streams">${liveCards}</div>` : '<div class="empty">Пока никто не стримит. Стань первым — нажми «В эфир»! 🔥</div>'}

    <div class="section-title">📺 Недавние эфиры</div>
    ${data.recent.length ? `<div class="grid-streams">${recentCards}</div>` : '<div class="empty">Здесь появятся завершённые эфиры</div>'}
  `;
  $('#hero-golive').onclick = goLiveFlow;
  app.querySelectorAll('[data-stream]').forEach((el) => {
    el.onclick = () => { location.hash = '#/live/' + el.dataset.stream; };
  });
}

function streamCard(s) {
  const isLive = s.status === 'live';
  return `
    <div class="stream-card" data-stream="${esc(s.id)}" style="cursor:pointer">
      <div class="thumb" style="background:linear-gradient(135deg, ${esc(s.host_color || s.host_avatar_color || '#ff7a00')}33, #1a1e2a)">
        ${isLive ? '<span class="live-badge">● LIVE</span>' : '<span class="offline-badge">офлайн</span>'}
        ${isLive ? `<span class="viewers-badge">👁 ${s.viewers || 0}</span>` : ''}
        <span>${esc(gameEmoji(s.game))}</span>
      </div>
      <div class="meta">
        <div class="title">${esc(s.title)}</div>
        <div class="byline">${avatarHTML({ username: s.host_username, avatar_color: s.host_color || s.host_avatar_color }, 22)}
          <span>${esc(s.host_username)}</span><span>·</span><span>${timeAgo(isLive ? s.started_at : (s.ended_at || s.started_at))}</span></div>
        <span class="game-tag">🎮 ${esc(s.game)}</span>
      </div>
    </div>`;
}

function gameEmoji(game) {
  return { 'Minecraft PE': '⛏️', 'Roblox': '🟥', 'PUBG Mobile': '🔫', 'Standoff 2': '💥', 'Genshin Impact': '⚔️', 'Brawl Stars': '⭐', 'Free Fire': '🔥', 'Другое': '🎮' }[game] || '🎮';
}

/* ---------------------------------------------------------------- stream */
async function viewStream(id) {
  app.innerHTML = '<div class="loading">Подключаемся к эфиру…</div>';
  let data;
  try { data = await api('/streams/' + id); } catch { app.innerHTML = '<div class="empty">Эфир не найден 😢 <br><br><a href="#/" style="color:var(--accent2);font-weight:700">← На главную</a></div>'; return; }
  const { stream, messages, host_followers } = data;
  const isHost = !!S.user && S.user.id === stream.host_id;

  app.innerHTML = `
    <div class="stream-layout">
      <div>
        <div class="video-wrap" id="video-wrap">
          <video id="stream-video" autoplay playsinline muted></video>
          ${stream.status === 'live'
            ? `<div class="video-placeholder" id="video-placeholder"><div class="spinner"></div><div>Ожидаем видеопоток…</div></div>`
            : ''}
          ${stream.status === 'live' ? '<div class="live-pill"><span class="dot"></span>LIVE</div><div class="viewers-pill" id="viewers-pill">👁 0</div>' : ''}
          ${stream.status === 'ended' ? '<div class="offline-overlay"><div class="big">Эфир завершён</div><div style="color:var(--muted)">Загляни на главную — там ещё идут трансляции</div><a class="btn-primary" href="#/" style="margin-top:6px;display:inline-block">На главную</a></div>' : ''}
        </div>
        <div class="stream-info">
          <h2>${esc(stream.title)}</h2>
          <div class="row">
            ${avatarHTML({ username: stream.host_username, avatar_color: stream.host_color }, 34)}
            <a href="#/u/${esc(stream.host_username)}" style="font-weight:700;color:var(--text)">${esc(stream.host_username)}</a>
            <span>· 👥 ${host_followers} подписчиков</span>
            ${!isHost && S.user ? `<button class="btn-ghost" id="follow-btn" style="margin-left:auto">${''}</button>` : ''}
            ${isHost ? '<button class="btn-danger" id="end-btn" style="margin-left:auto">■ Завершить эфир</button>' : ''}
          </div>
          <div style="margin-top:10px"><span class="game-tag">🎮 ${esc(stream.game)}</span>
            <span class="game-tag">${isHost ? '🔴 ты в эфире' : timeAgo(stream.started_at)}</span></div>
        </div>
      </div>
      <div class="chat-panel">
        <h3>💬 ЧАТ ТРАНСЛЯЦИИ</h3>
        <div id="chat-messages"></div>
        ${S.user
          ? `<div class="chat-input-row">
               <input id="chat-input" maxlength="300" placeholder="Написать сообщение…">
               <button id="chat-send">➤</button>
             </div>`
          : `<div class="chat-login-hint"><a id="chat-login">Войдите</a>, чтобы писать в чат</div>`}
      </div>
    </div>
  `;

  const video = $('#stream-video');
  const placeholder = $('#video-placeholder');

  const followBtn = $('#follow-btn');
  if (followBtn) {
    api('/users/' + stream.host_username).then((d) => {
      updateFollowBtn(followBtn, d.is_following, stream.host_username);
    }).catch(() => {});
  }
  const endBtn = $('#end-btn');
  if (endBtn) endBtn.onclick = () => endLive(stream.id, true);

  renderChatMessages(messages);

  const chatInput = $('#chat-input');
  if (chatInput) {
    const send = () => {
      const text = chatInput.value.trim();
      if (!text || !S.ws || S.ws.readyState !== 1) return;
      S.ws.send(JSON.stringify({ type: 'chat', text }));
      chatInput.value = '';
    };
    $('#chat-send').onclick = send;
    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    chatInput.focus();
  }
  const chatLogin = $('#chat-login');
  if (chatLogin) chatLogin.onclick = () => openAuthModal('login');

  if (stream.status !== 'live') return;

  // ---- websocket: видеосигналинг + чат
  S.currentStream = stream;
  S.ws = new WebSocket(wsUrl(stream.id));

  S.ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'welcome':
        updateViewers(msg.viewers);
        S.ws.send(JSON.stringify({ type: 'ready' }));
        if (!S.user) pushChatSystem('Только зарегистрированные могут писать в чат');
        break;
      case 'host-welcome':
        updateViewers(msg.viewers);
        if (isHost && S.screen) startHosting();
        break;
      case 'viewers':
        updateViewers(msg.count);
        break;
      case 'peer-joined':
        if (isHost) createHostPeer(msg.peerId);
        break;
      case 'signal':
        handleSignal(msg);
        break;
      case 'chat':
        pushChatMessage(msg);
        break;
      case 'stream-ended':
        S.ended = true;
        pushChatSystem('Эфир завершён');
        setTimeout(() => route(), 1500);
        break;
      case 'error':
        if (msg.message === 'login_required') toast('Войдите, чтобы писать в чат', true);
        break;
    }
  };

  S.ws.onclose = () => { if (!S.ended && !isHost) pushChatSystem('Соединение потеряно…'); };

  function startHosting() {
    S.screen.getTracks().forEach((t) => {
      if (t.kind === 'video') t.addEventListener('ended', () => endLive(stream.id, false));
    });
    video.srcObject = S.screen;
    video.muted = true;
    hidePlaceholder();
    for (const [peerId] of S.peers) createHostPeer(peerId); // уже ждущие зрители
  }

  async function createHostPeer(peerId) {
    if (!S.screen || S.peers.has(peerId)) return;
    const pc = new RTCPeerConnection(ICE_CONFIG);
    S.peers.set(peerId, pc);
    S.screen.getTracks().forEach((track) => pc.addTrack(track, S.screen));
    pc.onicecandidate = (e) => {
      if (e.candidate) S.ws.send(JSON.stringify({ type: 'signal', to: peerId, data: { candidate: e.candidate } }));
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    S.ws.send(JSON.stringify({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } }));
  }

  async function handleSignal(msg) {
    if (isHost) {
      const pc = S.peers.get(msg.from);
      if (!pc) return;
      if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
      else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
    } else {
      if (msg.data.sdp && msg.data.sdp.type === 'offer') {
        const pc = new RTCPeerConnection(ICE_CONFIG);
        S.pc = pc;
        pc.ontrack = (e) => {
          video.srcObject = e.streams[0];
          video.muted = false;
          hidePlaceholder();
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) S.ws.send(JSON.stringify({ type: 'signal', to: 'host', data: { candidate: e.candidate } }));
        };
        await pc.setRemoteDescription(msg.data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        S.ws.send(JSON.stringify({ type: 'signal', to: 'host', data: { sdp: pc.localDescription } }));
      } else if (msg.data.candidate && S.pc) {
        await S.pc.addIceCandidate(msg.data.candidate).catch(() => {});
      }
    }
  }

  function updateViewers(n) {
    const pill = $('#viewers-pill');
    if (pill) pill.textContent = `👁 ${n}`;
  }

  function hidePlaceholder() {
    if (placeholder) placeholder.remove();
  }
}

/* ------------------------------------------------------------------ chat */
function renderChatMessages(list) {
  const box = $('#chat-messages');
  if (!box) return;
  for (const m of list) {
    box.insertAdjacentHTML('beforeend', `
      <div class="chat-msg">
        <span class="uname" style="color:${esc(m.avatar_color)}" data-user="${esc(m.username)}">${esc(m.username)}:</span>
        ${esc(m.text)}
      </div>`);
  }
  bindUserLinks(box);
  box.scrollTop = box.scrollHeight;
}

function pushChatMessage(m) {
  const box = $('#chat-messages');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', `
    <div class="chat-msg">
      <span class="uname" style="color:${esc(m.user.avatar_color)}" data-user="${esc(m.user.username)}">${esc(m.user.username)}:</span>
      ${esc(m.text)}
    </div>`);
  bindUserLinks(box);
  box.scrollTop = box.scrollHeight;
}

function pushChatSystem(text) {
  const box = $('#chat-messages');
  if (!box) return;
  box.insertAdjacentHTML('beforeend', `<div class="chat-msg system">${esc(text)}</div>`);
  box.scrollTop = box.scrollHeight;
}

function bindUserLinks(box) {
  box.querySelectorAll('.uname[data-user]').forEach((el) => {
    el.onclick = () => { location.hash = '#/u/' + el.dataset.user; };
  });
}

/* --------------------------------------------------------------- go live */
async function endLive(streamId, viaButton) {
  try {
    await api(`/streams/${streamId}/end`, { method: 'POST' });
  } catch {}
  S.ended = true;
  if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
  if (S.screen) { for (const t of S.screen.getTracks()) t.stop(); S.screen = null; }
  toast(viaButton ? 'Эфир завершён' : 'Захват экрана остановлен — эфир завершён');
  location.hash = '#/';
}

/* --------------------------------------------------------------- profile */
function updateFollowBtn(btn, following, username) {
  btn.textContent = following ? '✓ Вы подписаны' : '+ Подписаться';
  btn.style.borderColor = following ? 'rgba(46,204,113,.5)' : '';
  btn.onclick = async () => {
    try {
      const d = await api(`/users/${username}/follow`, { method: following ? 'DELETE' : 'POST' });
      updateFollowBtn(btn, d.is_following, username);
    } catch (e) { toast(e.message, true); }
  };
}

async function viewProfile(username) {
  app.innerHTML = '<div class="loading">Загрузка профиля…</div>';
  let d;
  try { d = await api('/users/' + encodeURIComponent(username)); } catch { app.innerHTML = '<div class="empty">Пользователь не найден</div>'; return; }
  const isMe = S.user && S.user.id === d.user.id;

  app.innerHTML = `
    <div class="profile-head">
      ${avatarHTML(d.user, 76)}
      <div>
        <div style="font-size:22px;font-weight:800">${esc(d.user.username)}</div>
        <div class="profile-stats">
          <span><b>${d.followers}</b> подписчиков</span>
          <span><b>${d.following}</b> подписок</span>
          <span><b>${d.streams_total}</b> эфиров</span>
        </div>
        ${d.user.bio ? `<div class="profile-bio">${esc(d.user.bio)}</div>` : ''}
      </div>
      <div style="margin-left:auto;display:flex;gap:10px">
        ${d.live_stream_id ? `<a class="btn-primary" href="#/live/${d.live_stream_id}" style="display:flex;align-items:center">● Смотреть эфир</a>` : ''}
        ${!isMe && S.user ? `<button class="btn-ghost" id="follow-btn"></button>` : ''}
        ${isMe ? '<button class="btn-ghost" id="edit-profile">Редактировать</button>' : ''}
      </div>
    </div>
    <div class="section-title">🎮 Эфиры ${esc(d.user.username)}</div>
    ${d.streams.length ? `<div class="grid-streams">${d.streams.map(streamCard).join('')}</div>` : '<div class="empty">Пока нет эфиров</div>'}
  `;

  const fb = $('#follow-btn');
  if (fb) updateFollowBtn(fb, d.is_following, d.user.username);

  const editBtn = $('#edit-profile');
  if (editBtn) editBtn.onclick = () => {
    const m = openModal(`
      <h2>Профиль</h2>
      <label>О себе</label>
      <textarea id="pf-bio" maxlength="200" rows="3">${esc(d.user.bio)}</textarea>
      <label>Цвет аватарки</label>
      <input type="text" id="pf-color" value="${esc(d.user.avatar_color)}" placeholder="#FF7A00">
      <div class="form-error" id="pf-error"></div>
      <div class="actions"><button class="btn-primary" id="pf-save">Сохранить</button></div>
    `);
    m.querySelector('#pf-save').onclick = async () => {
      try {
        const resp = await api('/me', { method: 'PATCH', body: { bio: m.querySelector('#pf-bio').value, avatar_color: m.querySelector('#pf-color').value } });
        setAuth(S.token, resp.user);
        closeModal(); toast('Профиль обновлён'); route();
      } catch (e) { m.querySelector('#pf-error').textContent = e.message; }
    };
  };

  app.querySelectorAll('[data-stream]').forEach((el) => {
    el.onclick = () => { location.hash = '#/live/' + el.dataset.stream; };
  });
}

/* ------------------------------------------------------------------ init */
$('#golive-btn').onclick = goLiveFlow;
renderUserChip();
route();

// если открыли не с той страницы — норм, hash-роутер сам разберётся
window.addEventListener('error', (e) => console.error('client error:', e.message));
