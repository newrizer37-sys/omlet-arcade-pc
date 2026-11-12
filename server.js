import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
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
const FFMPEG = process.env.FFMPEG_PATH || path.join(__dirname, 'bin', 'ffmpeg');
const HAS_FFMPEG = fs.existsSync(FFMPEG);
if (!HAS_FFMPEG) console.log('[rtmp] ffmpeg не найден — стрим на Twitch недоступен (experimental)');

const app = express();
app.use(express.json({ limit: '1mb' }));
const server = http.createServer(app);

// ---------------------------------------------------------------- live rooms
// streamId -> { host: ws|null, viewers: Map<peerId, ws> }
const rooms = new Map();
// userId -> Set<ws>  личные каналы (лс, уведомления)
const userSockets = new Map();
// guildId -> Set<ws>
const guildRooms = new Map();
// streamId -> { ffmpeg, url }  RTMP-ретрансляция
const rtmpRelays = new Map();

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
  for (const ws of room.viewers.values()) safeSend(ws, payload);
  safeSend(room.host, payload);
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(payload);
}

function pushToUser(userId, obj) {
  const set = userSockets.get(userId);
  if (!set) return;
  const payload = JSON.stringify(obj);
  for (const ws of set) safeSend(ws, payload);
}

function broadcastGuild(guildId, obj, exceptWs) {
  const set = guildRooms.get(guildId);
  if (!set) return;
  const payload = JSON.stringify(obj);
  for (const ws of set) {
    if (ws !== exceptWs) safeSend(ws, payload);
  }
}

// ------------------------------------------------------------- notifications
async function notify(userId, type, payload) {
  const id = crypto.randomUUID();
  await db.execute({
    sql: 'INSERT INTO notifications (id, user_id, type, payload, created_at) VALUES (?,?,?,?,?)',
    args: [id, userId, type, JSON.stringify(payload), Date.now()],
  });
  pushToUser(userId, { type: 'notification', id, ntype: type, payload, ts: Date.now() });
}

async function unreadCount(userId) {
  const r = await db.execute({
    sql: 'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0',
    args: [userId],
  });
  return r.rows[0].c;
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
  const relay = rtmpRelays.get(streamId);
  if (relay) stopRelay(streamId);
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

// ------------------------------------------------------------ RTMP (experimental)
function stopRelay(streamId) {
  const relay = rtmpRelays.get(streamId);
  if (!relay) return;
  rtmpRelays.delete(streamId);
  try { relay.ffmpeg.stdin.end(); } catch {}
  setTimeout(() => { try { relay.ffmpeg.kill('SIGKILL'); } catch {} }, 3000);
}

function startRelay(streamId, url) {
  if (!HAS_FFMPEG) return { error: 'ffmpeg_unavailable' };
  if (!/^(rtmp|rtmps):\/\//i.test(url || '')) return { error: 'bad_url' };
  stopRelay(streamId);
  const ffmpeg = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '1000k', '-maxrate', '1000k', '-bufsize', '2000k',
    '-vf', 'scale=-2:360', '-r', '30',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
    '-f', 'flv', url,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  ffmpeg.stderr.on('data', (d) => console.log('[ffmpeg]', String(d).slice(0, 200)));
  ffmpeg.on('exit', () => rtmpRelays.delete(streamId));
  rtmpRelays.set(streamId, { ffmpeg, url });
  return { ok: true };
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

app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({ user: publicUser(req.user), unread: await unreadCount(req.user.id) });
});

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
      sql: `SELECT s.*, u.username AS host_username, u.avatar_color AS host_color,
                   (SELECT COUNT(*) FROM follows f WHERE f.following_id = s.host_id) AS host_followers
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
    const rtmp = String(req.body?.rtmp_url || '').trim() || null;

    const prev = await db.execute({
      sql: `SELECT id FROM streams WHERE host_id = ? AND status = 'live'`,
      args: [req.user.id],
    });
    for (const row of prev.rows) await endStream(row.id);

    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO streams (id, host_id, title, game, status, rtmp_url, started_at) VALUES (?,?,?,?, 'live', ?, ?)`,
      args: [id, req.user.id, title, game, rtmp, Date.now()],
    });

    // уведомить подписчиков: стример вышел в эфир
    const followers = await db.execute({
      sql: 'SELECT follower_id FROM follows WHERE following_id = ? LIMIT 300',
      args: [req.user.id],
    });
    for (const f of followers.rows) {
      notify(f.follower_id, 'live', { stream_id: id, host: req.user.username, title, game }).catch(() => {});
    }

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

// ---------------------------------------------------------------- лента
app.post('/api/posts', authMiddleware, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    const image = typeof req.body?.image === 'string' && req.body.image.length <= 400_000 ? req.body.image : null;
    if (!text && !image) return res.status(400).json({ error: 'Пустой пост' });
    const id = crypto.randomUUID();
    await db.execute({
      sql: 'INSERT INTO posts (id, user_id, text, image, created_at) VALUES (?,?,?,?,?)',
      args: [id, req.user.id, text, image, Date.now()],
    });
    res.json({ post: { id } });
  } catch (e) {
    console.error('post create', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/feed', optionalAuth, async (req, res) => {
  try {
    const posts = await db.execute({
      sql: `SELECT p.id, p.text, p.image, p.created_at, u.username, u.avatar_color, u.id AS user_id
            FROM posts p JOIN users u ON u.id = p.user_id
            ORDER BY p.created_at DESC LIMIT 60`,
      args: [],
    });
    const ids = posts.rows.map((p) => p.id);
    let likes = {}, comments = {}, liked = {};
    if (ids.length) {
      const l = await db.execute({
        sql: `SELECT post_id, COUNT(*) AS c FROM post_likes WHERE post_id IN (${ids.map(() => '?').join(',')}) GROUP BY post_id`,
        args: ids,
      });
      for (const r of l.rows) likes[r.post_id] = r.c;
      const c = await db.execute({
        sql: `SELECT post_id, COUNT(*) AS c FROM post_comments WHERE post_id IN (${ids.map(() => '?').join(',')}) GROUP BY post_id`,
        args: ids,
      });
      for (const r of c.rows) comments[r.post_id] = r.c;
      if (req.user) {
        const my = await db.execute({
          sql: `SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN (${ids.map(() => '?').join(',')})`,
          args: [req.user.id, ...ids],
        });
        for (const r of my.rows) liked[r.post_id] = true;
      }
    }
    res.json({
      posts: posts.rows.map((p) => ({
        ...p, likes: likes[p.id] || 0, comments: comments[p.id] || 0, liked: !!liked[p.id],
      })),
    });
  } catch (e) {
    console.error('feed', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/posts/:id/like', authMiddleware, async (req, res) => {
  try {
    const pr = await db.execute({ sql: 'SELECT user_id FROM posts WHERE id = ?', args: [req.params.id] });
    const post = pr.rows[0];
    if (!post) return res.status(404).json({ error: 'not_found' });
    const existing = await db.execute({
      sql: 'SELECT 1 AS x FROM post_likes WHERE post_id = ? AND user_id = ?',
      args: [req.params.id, req.user.id],
    });
    let liked;
    if (existing.rows.length) {
      await db.execute({ sql: 'DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', args: [req.params.id, req.user.id] });
      liked = false;
    } else {
      await db.execute({
        sql: 'INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?,?,?)',
        args: [req.params.id, req.user.id, Date.now()],
      });
      liked = true;
      if (post.user_id !== req.user.id) {
        notify(post.user_id, 'like', { post_id: req.params.id, by: req.user.username }).catch(() => {});
      }
    }
    const c = await db.execute({ sql: 'SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?', args: [req.params.id] });
    res.json({ liked, likes: c.rows[0].c });
  } catch (e) {
    console.error('like', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT c.id, c.text, c.created_at, u.username, u.avatar_color
            FROM post_comments c JOIN users u ON u.id = c.user_id
            WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT 100`,
      args: [req.params.id],
    });
    res.json({ comments: r.rows });
  } catch (e) {
    console.error('comments get', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/posts/:id/comments', authMiddleware, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'Пустой комментарий' });
    const pr = await db.execute({ sql: 'SELECT user_id FROM posts WHERE id = ?', args: [req.params.id] });
    const post = pr.rows[0];
    if (!post) return res.status(404).json({ error: 'not_found' });
    const id = crypto.randomUUID();
    await db.execute({
      sql: 'INSERT INTO post_comments (id, post_id, user_id, text, created_at) VALUES (?,?,?,?,?)',
      args: [id, req.params.id, req.user.id, text, Date.now()],
    });
    if (post.user_id !== req.user.id) {
      notify(post.user_id, 'comment', { post_id: req.params.id, by: req.user.username, text }).catch(() => {});
    }
    res.json({ comment: { id, text, username: req.user.username, avatar_color: req.user.avatar_color, created_at: Date.now() } });
  } catch (e) {
    console.error('comment', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ------------------------------------------------------------ личные сообщения
function dmKey(a, b) {
  return a < b ? [a, b] : [b, a];
}

app.get('/api/dm/contacts', authMiddleware, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT CASE WHEN a = ? THEN b ELSE a END AS peer, text, created_at
            FROM dm_messages WHERE a = ? OR b = ? ORDER BY created_at DESC LIMIT 500`,
      args: [req.user.id, req.user.id, req.user.id],
    });
    const seen = new Map();
    for (const row of r.rows) {
      if (!seen.has(row.peer)) seen.set(row.peer, { peer: row.peer, last_text: row.text, last_at: row.created_at });
      if (seen.size >= 50) break;
    }
    const out = [];
    for (const row of seen.values()) {
      const u = await db.execute({ sql: 'SELECT username, avatar_color FROM users WHERE id = ?', args: [row.peer] });
      const unread = await db.execute({
        sql: `SELECT COUNT(*) AS c FROM dm_messages
              WHERE ((a = ? AND b = ?) OR (a = ? AND b = ?))
                AND sender_id != ?
                AND created_at > COALESCE((SELECT last_read_at FROM dm_reads WHERE user_id = ? AND peer_id = ?), 0)`,
        args: [req.user.id, row.peer, row.peer, req.user.id, req.user.id, req.user.id, row.peer],
      });
      out.push({
        peer_id: row.peer,
        username: u.rows[0]?.username || '?',
        avatar_color: u.rows[0]?.avatar_color || '#555',
        last_text: row.last_text,
        last_at: row.last_at,
        unread: unread.rows[0].c,
      });
    }
    res.json({ contacts: out });
  } catch (e) {
    console.error('dm contacts', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/dm/:username', authMiddleware, async (req, res) => {
  try {
    const u = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [req.params.username] });
    const peer = u.rows[0];
    if (!peer) return res.status(404).json({ error: 'not_found' });
    const [a, b] = dmKey(req.user.id, peer.id);
    const r = await db.execute({
      sql: 'SELECT id, sender_id, text, created_at FROM dm_messages WHERE a = ? AND b = ? ORDER BY created_at ASC LIMIT 200',
      args: [a, b],
    });
    await db.execute({
      sql: `INSERT INTO dm_reads (user_id, peer_id, last_read_at) VALUES (?,?,?)
            ON CONFLICT(user_id, peer_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
      args: [req.user.id, peer.id, Date.now()],
    });
    res.json({ peer: publicUser(peer), messages: r.rows });
  } catch (e) {
    console.error('dm get', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/dm/:username', authMiddleware, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    const u = await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [req.params.username] });
    const peer = u.rows[0];
    if (!peer) return res.status(404).json({ error: 'not_found' });
    if (peer.id === req.user.id) return res.status(400).json({ error: 'cannot_dm_self' });
    const [a, b] = dmKey(req.user.id, peer.id);
    const id = crypto.randomUUID();
    const ts = Date.now();
    await db.execute({
      sql: 'INSERT INTO dm_messages (id, a, b, sender_id, text, created_at) VALUES (?,?,?,?,?,?)',
      args: [id, a, b, req.user.id, text, ts],
    });
    pushToUser(peer.id, {
      type: 'dm', id, from: { id: req.user.id, username: req.user.username, avatar_color: req.user.avatar_color },
      text, ts,
    });
    res.json({ message: { id, sender_id: req.user.id, text, created_at: ts } });
  } catch (e) {
    console.error('dm send', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// -------------------------------------------------------------- уведомления
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const r = await db.execute({
      sql: 'SELECT id, type, payload, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
      args: [req.user.id],
    });
    res.json({ notifications: r.rows.map((n) => ({ ...n, payload: JSON.parse(n.payload || '{}'), unread: !n.read })), unread: await unreadCount(req.user.id) });
  } catch (e) {
    console.error('notifs get', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/notifications/read', authMiddleware, async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE notifications SET read = 1 WHERE user_id = ?', args: [req.user.id] });
    res.json({ ok: true });
  } catch (e) {
    console.error('notifs read', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ------------------------------------------------------------------- гильдии
app.post('/api/guilds', authMiddleware, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const tag = String(req.body?.tag || '').trim().slice(0, 5).toUpperCase();
    const description = String(req.body?.description || '').slice(0, 300);
    if (!/^[a-zA-Z0-9а-яА-Я _-]{3,24}$/.test(name)) return res.status(400).json({ error: 'Название: 3–24 символа' });
    const exists = await db.execute({ sql: 'SELECT id FROM guilds WHERE name = ?', args: [name] });
    if (exists.rows.length) return res.status(409).json({ error: 'Гильдия с таким названием уже есть' });
    const id = crypto.randomUUID();
    await db.batch([
      {
        sql: 'INSERT INTO guilds (id, name, tag, description, owner_id, created_at) VALUES (?,?,?,?,?,?)',
        args: [id, name, tag, description, req.user.id, Date.now()],
      },
      {
        sql: `INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?,?,'owner',?)`,
        args: [id, req.user.id, Date.now()],
      },
    ], 'write');
    res.json({ guild: { id, name, tag } });
  } catch (e) {
    console.error('guild create', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/guilds', async (_req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT g.*, (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id) AS members
            FROM guilds g ORDER BY members DESC, g.created_at DESC LIMIT 100`,
      args: [],
    });
    res.json({ guilds: r.rows });
  } catch (e) {
    console.error('guilds list', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/guilds/:id', optionalAuth, async (req, res) => {
  try {
    const g = await db.execute({ sql: 'SELECT * FROM guilds WHERE id = ?', args: [req.params.id] });
    const guild = g.rows[0];
    if (!guild) return res.status(404).json({ error: 'not_found' });
    const members = await db.execute({
      sql: `SELECT u.username, u.avatar_color, u.id, m.role FROM guild_members m
            JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? ORDER BY m.joined_at ASC LIMIT 200`,
      args: [guild.id],
    });
    const msgs = await db.execute({
      sql: `SELECT m.id, m.text, m.created_at, u.username, u.avatar_color FROM guild_messages m
            JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? ORDER BY m.created_at ASC LIMIT 200`,
      args: [guild.id],
    });
    const owner = await db.execute({ sql: 'SELECT username FROM users WHERE id = ?', args: [guild.owner_id] });
    let joined = false;
    if (req.user) {
      const me = await db.execute({
        sql: 'SELECT 1 AS x FROM guild_members WHERE guild_id = ? AND user_id = ?',
        args: [guild.id, req.user.id],
      });
      joined = me.rows.length > 0;
    }
    res.json({
      guild: { ...guild, owner_username: owner.rows[0]?.username, member_count: members.rows.length },
      members: members.rows,
      messages: msgs.rows,
      joined,
    });
  } catch (e) {
    console.error('guild get', e);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/guilds/:id/join', authMiddleware, async (req, res) => {
  try {
    const g = await db.execute({ sql: 'SELECT * FROM guilds WHERE id = ?', args: [req.params.id] });
    const guild = g.rows[0];
    if (!guild) return res.status(404).json({ error: 'not_found' });
    const me = await db.execute({
      sql: 'SELECT 1 AS x FROM guild_members WHERE guild_id = ? AND user_id = ?',
      args: [guild.id, req.user.id],
    });
    let joined;
    if (me.rows.length) {
      if (guild.owner_id === req.user.id) return res.status(400).json({ error: 'Владелец не может покинуть гильдию' });
      await db.execute({ sql: 'DELETE FROM guild_members WHERE guild_id = ? AND user_id = ?', args: [guild.id, req.user.id] });
      joined = false;
    } else {
      await db.execute({
        sql: `INSERT INTO guild_members (guild_id, user_id, role, joined_at) VALUES (?,?,'member',?)`,
        args: [guild.id, req.user.id, Date.now()],
      });
      joined = true;
    }
    res.json({ joined });
  } catch (e) {
    console.error('guild join', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ------------------------------------------------------------------ discover
app.get('/api/discover', optionalAuth, async (_req, res) => {
  try {
    const top = await db.execute({
      sql: `SELECT u.id, u.username, u.avatar_color, u.bio,
                   (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followers,
                   (SELECT COUNT(*) FROM streams s WHERE s.host_id = u.id AND s.status = 'live') AS is_live
            FROM users u ORDER BY followers DESC LIMIT 20`,
      args: [],
    });
    const byGame = await db.execute({
      sql: `SELECT game, COUNT(*) AS c FROM streams WHERE status = 'live' GROUP BY game ORDER BY c DESC`,
      args: [],
    });
    const guilds = await db.execute({
      sql: `SELECT g.*, (SELECT COUNT(*) FROM guild_members m WHERE m.guild_id = g.id) AS members
            FROM guilds g ORDER BY members DESC LIMIT 12`,
      args: [],
    });
    res.json({ top_streamers: top.rows, games: byGame.rows, guilds: guilds.rows });
  } catch (e) {
    console.error('discover', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------- user routes
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
    const posts = await db.execute({
      sql: 'SELECT id, text, image, created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
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
      posts: posts.rows,
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
    notify(target.id, 'follow', { by: req.user.username }).catch(() => {});
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

app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now(), ffmpeg: HAS_FFMPEG }));

// ------------------------------------------------------------------- static
app.use(express.static(path.join(__dirname, 'client')));

// ------------------------------------------------------------ websocket /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const u = new URL(req.url, 'http://localhost');
  const streamId = u.searchParams.get('stream');
  const guildId = u.searchParams.get('guild');
  const token = u.searchParams.get('token');

  try {
    const user = await getUserByToken(token);

    // ---------- личный канал (лс + уведомления)
    if (!streamId && !guildId) {
      if (!user) { ws.close(); return; }
      if (!userSockets.has(user.id)) userSockets.set(user.id, new Set());
      userSockets.get(user.id).add(ws);
      ws._personal = user.id;
      ws.send(JSON.stringify({ type: 'personal-welcome', username: user.username, unread: await unreadCount(user.id) }));
      ws.on('close', () => {
        const set = userSockets.get(ws._personal);
        if (set) { set.delete(ws); if (!set.size) userSockets.delete(ws._personal); }
      });
      return;
    }

    // ---------- гильдейский чат
    if (guildId) {
      const gr = await db.execute({ sql: 'SELECT id FROM guilds WHERE id = ?', args: [guildId] });
      if (!gr.rows.length) { ws.close(); return; }
      if (!guildRooms.has(guildId)) guildRooms.set(guildId, new Set());
      guildRooms.get(guildId).add(ws);
      ws._guild = guildId;
      if (user) ws.send(JSON.stringify({ type: 'guild-welcome', username: user.username }));
      ws.on('message', (raw) => {
        if (ws._guild === undefined) return;
        let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type !== 'chat' || !user) return;
        const text = String(msg.text || '').slice(0, 300).trim();
        if (!text) return;
        const id = crypto.randomUUID();
        const ts = Date.now();
        db.execute({
          sql: 'INSERT INTO guild_messages (id, guild_id, user_id, text, created_at) VALUES (?,?,?,?,?)',
          args: [id, guildId, user.id, text, ts],
        }).catch(console.error);
        broadcastGuild(guildId, {
          type: 'chat', id, text, ts,
          user: { id: user.id, username: user.username, avatar_color: user.avatar_color },
        });
      });
      ws.on('close', () => {
        const set = guildRooms.get(ws._guild);
        if (set) { set.delete(ws); if (!set.size) guildRooms.delete(ws._guild); }
      });
      return;
    }

    // ---------- комната эфира (видео + чат + rtmp)
    const stream = await streamWithHost(streamId);
    if (!stream || stream.status !== 'live') {
      safeSend(ws, JSON.stringify({ type: 'error', message: 'stream_offline' }));
      ws.close();
      return;
    }
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

    ws.on('message', (data, isBinary) => {
      // бинарные кадры = MediaRecorder → ffmpeg → RTMP
      if (isBinary) {
        const relay = rtmpRelays.get(ws._meta.streamId);
        if (relay && data.length > 1) {
          try { relay.ffmpeg.stdin.write(data.subarray(1)); } catch {}
        }
        return;
      }
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      const meta = ws._meta;
      if (!meta) return;
      const r = rooms.get(meta.streamId);
      if (!r) return;

      switch (msg.type) {
        case 'ready':
          safeSend(r.host, JSON.stringify({ type: 'peer-joined', peerId: meta.peerId }));
          break;
        case 'signal': {
          const target = msg.to === 'host' ? r.host : r.viewers.get(msg.to);
          if (target && target !== ws) {
            safeSend(target, JSON.stringify({ type: 'signal', from: meta.peerId, data: msg.data }));
          }
          break;
        }
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
        case 'rtmp-start': {
          if (!meta.isHost) break;
          const res = startRelay(meta.streamId, String(msg.url || ''));
          safeSend(ws, JSON.stringify({ type: 'rtmp-status', ...res }));
          break;
        }
        case 'rtmp-stop': {
          if (meta.isHost) stopRelay(meta.streamId);
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

// пинг прокси каждые 30с
setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of [room.host, ...room.viewers.values()]) {
      if (ws && ws.readyState === 1) { try { ws.ping(); } catch {} }
    }
  }
  for (const set of [...userSockets.values(), ...guildRooms.values()]) {
    for (const ws of set) { if (ws.readyState === 1) { try { ws.ping(); } catch {} } }
  }
}, 30000);

// -------------------------------------------------------------------- start
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`🍊 Omlet Arcade PC server: http://localhost:${PORT} | ffmpeg: ${HAS_FFMPEG ? 'ok' : 'нет'}`);
    });
  })
  .catch((e) => {
    console.error('DB init failed', e);
    process.exit(1);
  });
