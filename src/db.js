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

    CREATE INDEX IF NOT EXISTS idx_streams_status ON streams(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_streams_host ON streams(host_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id, created_at);
  `);
}
