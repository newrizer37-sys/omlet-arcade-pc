/* Удаление тестовых пользователей со всеми связанными данными.
   Запуск: node --env-file=.env scripts/cleanup.mjs alice_x bob_y */
import { createClient } from '@libsql/client';

const db = createClient({
  url: process.env.DATABASE_URL || 'file:local.db',
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
});

for (const name of process.argv.slice(2)) {
  const u = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [name] });
  const id = u.rows[0]?.id;
  if (!id) { console.log('нет юзера:', name); continue; }
  const posts = await db.execute({ sql: 'SELECT id FROM posts WHERE user_id = ?', args: [id] });
  for (const p of posts.rows) {
    await db.execute({ sql: 'DELETE FROM post_likes WHERE post_id = ?', args: [p.id] });
    await db.execute({ sql: 'DELETE FROM post_comments WHERE post_id = ?', args: [p.id] });
    await db.execute({ sql: 'DELETE FROM posts WHERE id = ?', args: [p.id] });
  }
  await db.execute({ sql: 'DELETE FROM messages WHERE user_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM dm_messages WHERE a = ? OR b = ?', args: [id, id] });
  await db.execute({ sql: 'DELETE FROM dm_reads WHERE user_id = ? OR peer_id = ?', args: [id, id] });
  await db.execute({ sql: 'DELETE FROM notifications WHERE user_id = ?', args: [id] });
  const guilds = await db.execute({ sql: 'SELECT id FROM guilds WHERE owner_id = ?', args: [id] });
  for (const g of guilds.rows) {
    await db.execute({ sql: 'DELETE FROM guild_messages WHERE guild_id = ?', args: [g.id] });
    await db.execute({ sql: 'DELETE FROM guild_members WHERE guild_id = ?', args: [g.id] });
    await db.execute({ sql: 'DELETE FROM guilds WHERE id = ?', args: [g.id] });
  }
  await db.execute({ sql: 'DELETE FROM guild_members WHERE user_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM follows WHERE follower_id = ? OR following_id = ?', args: [id, id] });
  await db.execute({ sql: 'DELETE FROM streams WHERE host_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [id] });
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
  console.log('удалён:', name);
}
