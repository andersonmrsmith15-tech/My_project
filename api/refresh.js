// GET  /api/refresh — когда данные обновлялись и идёт ли сбор сейчас
// POST /api/refresh — запустить сбор объявлений в GitHub Actions
// (сам сбор длится ~25 минут — это дольше лимита функций Vercel, поэтому он работает в GitHub Actions
//  и загружает результат в Vercel Blob).
import { getData, json } from '../lib/data.js';

const REPO = process.env.GITHUB_REPO; // например "username/novostroyki"
const TOKEN = process.env.GITHUB_TOKEN; // fine-grained token с правом Actions: Read and write
const WORKFLOW = 'collect.yml';
const MIN_AGE_H = Number(process.env.REFRESH_MIN_AGE_HOURS || 3);

const gh = (p, init = {}) => fetch(`https://api.github.com/repos/${REPO}${p}`, {
  ...init,
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'novostroyki', ...(init.headers || {}) },
});

async function lastRun() {
  if (!REPO || !TOKEN) return null;
  const r = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!r.ok) return null;
  const run = (await r.json()).workflow_runs?.[0];
  return run ? { status: run.status, conclusion: run.conclusion, startedAt: run.run_started_at, url: run.html_url } : null;
}

export async function GET() {
  const { data } = await getData();
  const run = await lastRun().catch(() => null);
  return json({ configured: !!(REPO && TOKEN), collectedAt: data.collectedAt, running: run ? run.status !== 'completed' : false, run }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST() {
  if (!REPO || !TOKEN) return json({ error: 'Обновление с сайта не настроено (нужны GITHUB_REPO и GITHUB_TOKEN). Данные обновляются автоматически раз в сутки.' }, { status: 501 });
  const { data } = await getData();
  const ageH = data.collectedAt ? (Date.now() - new Date(data.collectedAt)) / 36e5 : Infinity;
  const run = await lastRun().catch(() => null);
  if (run && run.status !== 'completed') return json({ ok: true, running: true, message: 'Сбор уже идёт' });
  if (ageH < MIN_AGE_H) return json({ error: `Данные свежие (обновлены ${Math.round(ageH * 60)} мин назад). Повторный сбор возможен через ${MIN_AGE_H} ч.` }, { status: 429 });
  const r = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: process.env.GITHUB_BRANCH || 'main' }) });
  if (!r.ok) return json({ error: `GitHub ответил ${r.status}: ${(await r.text()).slice(0, 200)}` }, { status: 502 });
  return json({ ok: true, running: true, message: 'Сбор запущен, займёт около 25 минут' }, { status: 202 });
}
