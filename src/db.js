import { createClient } from '@libsql/client';

/**
 * Turso (libSQL) database client.
 * On Render: DATABASE_URL = libsql://xxx.turso.io, DATABASE_AUTH_TOKEN = eyJ...
 * Locally (no env): falls back to a local SQLite file so dev works offline.
 */
export const db = createClient({
  url: process.env.DATABASE_URL || 'file:local.db',
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

export async function initDb() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#FF7A00',
      bio TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      title TEXT NOT NULL,
      game TEXT NOT NULL DEFAULT 'Другое',
      status TEXT NOT NULL DEFAULT 'live',
      rtmp_url TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      stream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (follower_id, following_id)
    );

    -- лента
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      image TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS post_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- личные сообщения (пара a|b отсортирована лексикографически)
    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY,
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dm_reads (
      user_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, peer_id)
    );

    -- уведомления
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- гильдии
    CREATE TABLE IF NOT EXISTS guilds (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      tag TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS guild_members (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS guild_messages (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_streams_host ON streams(host_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(a, b, created_at);
  `);
  await migrate();
}

/** CREATE TABLE IF NOT EXISTS не дополняет существующие таблицы — мягкие ALTER'ы для старых схем. */
async function migrate() {
  const alters = [
    ['streams', 'rtmp_url', 'TEXT'],
    ['users', 'bio', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [table, col, type] of alters) {
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      console.log(`[db] миграция: ${table} + ${col}`);
    } catch {
      /* колонка уже есть — норм */
    }
  }
}
