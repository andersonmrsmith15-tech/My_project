// Локальный сервер для разработки: тот же сайт и те же API-функции, что и на Vercel.
// Запуск: npm start  →  http://localhost:3000
// На Vercel этот файл НЕ используется (и исключён в .vercelignore): там работают функции из папки api/.
// Не переносите его в корень проекта — Vercel примет его за сервер всего сайта.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetCache, json } from '../lib/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Локально кнопка «Обновить» запускает сборщик прямо на компьютере (если не настроен GitHub)
let local = { running: false, ok: null, log: '' };
function runCollector() {
  if (local.running) return;
  local = { running: true, ok: null, log: '' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scraper', 'collect.mjs')], { cwd: ROOT, env: { ...process.env, BLOB_READ_WRITE_TOKEN: '' } });
  const add = (b) => { local.log = (local.log + b).slice(-3000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  child.on('close', (code) => { local.running = false; local.ok = code === 0; if (code === 0) resetCache(); });
}

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method, headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
}

async function sendResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/refresh' && !process.env.GITHUB_TOKEN) {
      if (req.method === 'POST') runCollector();
      const { getData } = await import('../lib/data.js');
      const { data } = await getData();
      return sendResponse(res, json({ configured: true, local: true, collectedAt: data.collectedAt, running: local.running, ok: local.ok, log: local.ok === false ? local.log : undefined }, { status: req.method === 'POST' ? 202 : 200 }));
    }
    const m = url.pathname.match(/^\/api\/([a-z-]+)$/);
    if (m) {
      const mod = await import(`../api/${m[1]}.js`).catch(() => null);
      const handler = mod?.[req.method];
      if (!handler) return sendResponse(res, json({ error: 'Not found' }, { status: 404 }));
      return sendResponse(res, await handler(await toRequest(req)));
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    sendResponse(res, json({ error: e.message }, { status: 500 }));
  }
}).listen(PORT, () => console.log(`Сайт работает: http://localhost:${PORT}`));
