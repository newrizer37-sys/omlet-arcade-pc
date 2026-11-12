/* Render build step: скачать статический ffmpeg (BtbN linux64) → bin/ffmpeg.
   Любая ошибка НЕ валит сборку: стрим на Twitch просто останется недоступным. */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binDir = path.join(root, 'bin');
const ffmpegPath = path.join(binDir, 'ffmpeg');

if (fs.existsSync(ffmpegPath)) {
  console.log('[ffmpeg] уже есть:', ffmpegPath);
  process.exit(0);
}

const url = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz';
const archive = path.join(binDir, 'ffmpeg.tar.xz');
fs.mkdirSync(binDir, { recursive: true });

try {
  console.log('[ffmpeg] качаю', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive));
  console.log('[ffmpeg] распаковываю…');
  execFileSync('tar', ['-xJf', archive, '-C', binDir], { stdio: 'inherit' });
  const find = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = find(p); if (r) return r; }
      else if (e.name === 'ffmpeg') return p;
    }
    return null;
  };
  const found = find(binDir);
  if (!found) throw new Error('ffmpeg не найден в архиве');
  fs.renameSync(found, ffmpegPath);
  fs.chmodSync(ffmpegPath, 0o755);
  console.log('[ffmpeg] готов:', ffmpegPath);
} catch (e) {
  console.log('[ffmpeg] ОШИБКА:', e.message, '— RTMP-стрим будет недоступен');
} finally {
  try { fs.rmSync(archive, { force: true }); } catch {}
  try {
    for (const e of fs.readdirSync(binDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('ffmpeg-master')) {
        fs.rmSync(path.join(binDir, e.name), { recursive: true, force: true });
      }
    }
  } catch {}
}
process.exit(0);
