import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { db, initDb } from './src/db.js';
import {
  hashPassword, verifyPassword, getUserByToken, publicUser,
  authMiddleware, optionalAuth,
} from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GAMES = ['Minecraft PE', 'Roblox', 'PUBG Mobile', 'Standoff 2', 'Genshin Impact', 'Brawl Stars', 'Free Fire', 'Другое'];
const AVATAR_COLORS = ['#FF7A00', '#FF4D4D', '#2ECC71', '#3498DB', '#9B59B6', '#F1C40F', '#1ABC9C', '#E91E63'];

const app = express();
app.use(express.json());
const server = http.createServer(app);

// ---------------------------------------------------------------- live rooms
// streamId -> { host: ws|null, viewers: Map<peerId, ws> }
const rooms = new Map();

function getRoom(streamId) {
  if (!rooms.has(streamId)) rooms.set(streamId, { host: null, viewers: new Map() });
  return rooms.get(streamId);
}

function viewerCount(streamId) {
  const room = rooms.get(streamId);
  return room ? room.viewers.size : 0;
}

function broadcastViewers(streamId) {
  const room = rooms.get(streamId);
  if (!room) return;
  const payload = JSON.stringify({ type: 'viewers', count: room.viewers.size });
  for (const ws of room.viewers.values()) {
    if (ws.readyState === 1) ws.send(payload);
  }
  if (room.host && room.host.readyState === 1) room.host.send(payload);
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

// ------------------------------------------------------------------- helpers
async function streamWithHost(id) {
  const r = await db.execute({
    sql: `SELECT s.*, u.username AS host_username, u.avatar_color AS host_color
          FROM streams s JOIN users u ON u.id = s.host_id
          WHERE s.id = ?`,
    args: [id],
  });
  return r.rows[0] || null;
}

async function endStream(streamId) {
  await db.execute({
    sql: `UPDATE streams SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'live'`,
    args: [Date.now(), streamId],
  });
  const room = rooms.get(streamId);
  if (room) {
    for (const ws of room.viewers.values()) {
      safeSend(ws, JSON.stringify({ type: 'stream-ended' }));
    }
    if (room.host) { try { room.host.close(); } catch {} }
    room.host = null;
    rooms.delete(streamId);
  }
}

// --------------------------------------------------------------- auth routes
app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Ник: 3–20 символов, латиница, цифры и _' });
    }
    if (password.length < 6 || password.length > 100) {
      return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    }
    const exists = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
    if (exists.rows.length) return res.status(409).json({ error: 'Этот ник уже занят' });

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    const color = AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)];
    await db.batch([
      {
        sql: 'INSERT INTO users (id, username, pass_hash, avatar_color, created_at) VALUES (?,?,?,?,?)',
        args: [id, username, hashPassword(password), color, Date.now()],
      },
      {
        sql: 'INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)',
        args: [token, id, Date.now()],
      },
    ], 'write');
    const user = await getUserByToken(token);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('register', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] });
    const user = r.rows[0];
    if (!user || !verifyPassword(password, user.pass_hash)) {
      return res.status(401).json({ error: 'Неверный ник или пароль' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await db.execute({
      sql: 'INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)',
      args: [token, user.id, Date.now()],
    });
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('login', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/me', authMiddleware, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', authMiddleware, async (req, res) => {
  try {
    const bio = String(req.body?.bio ?? req.user.bio).slice(0, 200);
    let color = String(req.body?.avatar_color ?? req.user.avatar_color);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = req.user.avatar_color;
    await db.execute({ sql: 'UPDATE users SET bio = ?, avatar_color = ? WHERE id = ?', args: [bio, color, req.user.id] });
    res.json({ user: { ...publicUser(req.user), bio, avatar_color: color } });
  } catch (e) {
    console.error('patch me', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ------------------------------------------------------------- stream routes
app.get('/api/games', (_req, res) => res.json({ games: GAMES }));

app.get('/api/streams', async (req, res) => {
  try {
    const live = await db.execute({
      sql: `SELECT s.*, u.username AS host_username, u.avatar_color AS host_color
            FROM streams s JOIN users u ON u.id = s.host_id
            WHERE s.status = 'live'
            ORDER BY s.started_at DESC LIMIT 100`,
      args: [],
    });
    const recent = await db.execute({
      sql: `SELECT s.*, u.username AS host_username, u.avatar_color AS host_color
            FROM streams s JOIN users u ON u.id = s.host_id
            WHERE s.status = 'ended'
            ORDER BY s.ended_at DESC LIMIT 50`,
      args: [],
    });
    res.json({
      live: live.rows.map((s) => ({ ...s, viewers: viewerCount(s.id) })),
      recent: recent.rows,
    });
  } catch (e) {
    console.error('streams list', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/streams', authMiddleware, async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 100) || 'Эфир без названия';
    const game = GAMES.includes(req.body?.game) ? req.body.game : 'Другое';

    // если у юзера уже есть живой эфир — завершаем его
    const prev = await db.execute({
      sql: `SELECT id FROM streams WHERE host_id = ? AND status = 'live'`,
      args: [req.user.id],
    });
    for (const row of prev.rows) await endStream(row.id);

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO streams (id, host_id, title, game, status, started_at) VALUES (?,?,?,?, 'live', ?)`,
      args: [id, req.user.id, title, game, Date.now()],
    });
    res.json({ stream: await streamWithHost(id) });
  } catch (e) {
    console.error('create stream', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/streams/:id', async (req, res) => {
  try {
    const stream = await streamWithHost(req.params.id);
    if (!stream) return res.status(404).json({ error: 'not_found' });
    const msgs = await db.execute({
      sql: `SELECT m.id, m.text, m.created_at, u.username, u.avatar_color
            FROM messages m JOIN users u ON u.id = m.user_id
            WHERE m.stream_id = ? ORDER BY m.created_at ASC LIMIT 200`,
      args: [stream.id],
    });
    const followers = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM follows WHERE following_id = ?',
      args: [stream.host_id],
    });
    res.json({
      stream: { ...stream, viewers: stream.status === 'live' ? viewerCount(stream.id) : 0 },
      messages: msgs.rows,
      host_followers: followers.rows[0].c,
    });
  } catch (e) {
    console.error('stream get', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/streams/:id/end', authMiddleware, async (req, res) => {
  try {
    const stream = await streamWithHost(req.params.id);
    if (!stream) return res.status(404).json({ error: 'not_found' });
    if (stream.host_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    await endStream(stream.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('stream end', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// -------------------------------------------------------------- user routes
app.get('/api/users/:username', optionalAuth, async (req, res) => {
  try {
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [req.params.username] });
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: 'not_found' });
    const followers = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM follows WHERE following_id = ?', args: [user.id],
    });
    const following = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM follows WHERE follower_id = ?', args: [user.id],
    });
    const streamsCount = await db.execute({
      sql: 'SELECT COUNT(*) AS c FROM streams WHERE host_id = ?', args: [user.id],
    });
    const streams = await db.execute({
      sql: `SELECT * FROM streams WHERE host_id = ? ORDER BY started_at DESC LIMIT 30`,
      args: [user.id],
    });
    const liveNow = streams.rows.find((s) => s.status === 'live') || null;
    let is_following = false;
    if (req.user) {
      const f = await db.execute({
        sql: 'SELECT 1 AS x FROM follows WHERE follower_id = ? AND following_id = ?',
        args: [req.user.id, user.id],
      });
      is_following = f.rows.length > 0;
    }
    res.json({
      user: publicUser(user),
      followers: followers.rows[0].c,
      following: following.rows[0].c,
      streams_total: streamsCount.rows[0].c,
      streams: streams.rows,
      live_stream_id: liveNow ? liveNow.id : null,
      is_following,
    });
  } catch (e) {
    console.error('user get', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/users/:username/follow', authMiddleware, async (req, res) => {
  try {
    const r = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [req.params.username] });
    const target = r.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'cannot_follow_self' });
    await db.execute({
      sql: `INSERT INTO follows (follower_id, following_id, created_at) VALUES (?,?,?)
            ON CONFLICT DO NOTHING`,
      args: [req.user.id, target.id, Date.now()],
    });
    res.json({ ok: true, is_following: true });
  } catch (e) {
    console.error('follow', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/users/:username/follow', authMiddleware, async (req, res) => {
  try {
    const r = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [req.params.username] });
    const target = r.rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    await db.execute({
      sql: 'DELETE FROM follows WHERE follower_id = ? AND following_id = ?',
      args: [req.user.id, target.id],
    });
    res.json({ ok: true, is_following: false });
  } catch (e) {
    console.error('unfollow', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

// ------------------------------------------------------------------- static
app.use(express.static(path.join(__dirname, 'client')));

// ------------------------------------------------------------ websocket /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const u = new URL(req.url, 'http://localhost');
  const streamId = u.searchParams.get('stream');
  const token = u.searchParams.get('token');

  try {
    const stream = await streamWithHost(streamId);
    if (!stream || stream.status !== 'live') {
      safeSend(ws, JSON.stringify({ type: 'error', message: 'stream_offline' }));
      ws.close();
      return;
    }
    const user = await getUserByToken(token);
    const isHost = !!user && user.id === stream.host_id;
    const room = getRoom(streamId);
    const peerId = crypto.randomUUID();
    ws._meta = { streamId, peerId, user, isHost };

    if (isHost) {
      room.host = ws;
      safeSend(ws, JSON.stringify({ type: 'host-welcome', peerId, viewers: room.viewers.size }));
    } else {
      room.viewers.set(peerId, ws);
      safeSend(ws, JSON.stringify({
        type: 'welcome', peerId,
        viewers: room.viewers.size,
        chatEnabled: !!user,
      }));
      broadcastViewers(streamId);
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const meta = ws._meta;
      if (!meta) return;
      const r = rooms.get(meta.streamId);
      if (!r) return;

      switch (msg.type) {
        // зритель загрузился — просим хоста сделать offer под этого зрителя
        case 'ready': {
          safeSend(r.host, JSON.stringify({ type: 'peer-joined', peerId: meta.peerId }));
          break;
        }

        // ретрансляция WebRTC-сигналов (offer/answer/ice)
        case 'signal': {
          const target = msg.to === 'host'
            ? r.host
            : r.viewers.get(msg.to);
          if (target && target !== ws) {
            safeSend(target, JSON.stringify({ type: 'signal', from: meta.peerId, data: msg.data }));
          }
          break;
        }

        // чат
        case 'chat': {
          if (!meta.user) {
            safeSend(ws, JSON.stringify({ type: 'error', message: 'login_required' }));
            break;
          }
          const text = String(msg.text || '').slice(0, 300).trim();
          if (!text) break;
          const mid = crypto.randomUUID();
          const ts = Date.now();
          db.execute({
            sql: 'INSERT INTO messages (id, stream_id, user_id, text, created_at) VALUES (?,?,?,?,?)',
            args: [mid, meta.streamId, meta.user.id, text, ts],
          }).catch(console.error);
          const payload = JSON.stringify({
            type: 'chat', id: mid, text, ts,
            user: { id: meta.user.id, username: meta.user.username, avatar_color: meta.user.avatar_color },
          });
          for (const v of r.viewers.values()) safeSend(v, payload);
          safeSend(r.host, payload);
          break;
        }

        case 'ping':
          safeSend(ws, JSON.stringify({ type: 'pong' }));
          break;
      }
    });

    ws.on('close', () => {
      const r = rooms.get(ws._meta?.streamId);
      if (!r) return;
      if (ws._meta.isHost && r.host === ws) {
        r.host = null;
        for (const v of r.viewers.values()) {
          safeSend(v, JSON.stringify({ type: 'stream-ended' }));
        }
        // если хост просто пропал — завершаем эфир в базе
        endStream(ws._meta.streamId).catch(console.error);
      } else {
        r.viewers.delete(ws._meta.peerId);
        broadcastViewers(ws._meta.streamId);
      }
    });
  } catch (e) {
    console.error('ws connection error', e);
    ws.close();
  }
});

// каждые 30с пингуем, чтобы прокси не рвал соединения
setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of [room.host, ...room.viewers.values()]) {
      if (ws && ws.readyState === 1) {
        try { ws.ping(); } catch {}
      }
    }
  }
}, 30000);

// -------------------------------------------------------------------- start
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🍊 Omlet Arcade PC server: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('DB init failed', e);
    process.exit(1);
  });
