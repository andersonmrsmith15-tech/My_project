// GET /api/assess?id=olx-123 — ИИ-оценка дома и застройщика (Claude + веб-поиск).
// Результат кешируется на CDN Vercel на 7 дней, чтобы не платить за повторные запросы.
import Anthropic from '@anthropic-ai/sdk';
import { getData, json } from '../lib/data.js';
import { marketFor } from '../lib/filter.js';
import { assessListing } from '../lib/assess.js';

const memo = new Map(); // кеш в памяти экземпляра функции
const hits = new Map(); // простое ограничение частоты: IP -> [время запросов]
const LIMIT_PER_HOUR = Number(process.env.ASSESS_LIMIT_PER_HOUR || 20);

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= LIMIT_PER_HOUR) return true;
  arr.push(now); hits.set(ip, arr);
  return false;
}

export async function GET(request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: 'ИИ-оценка не настроена: добавьте переменную окружения ANTHROPIC_API_KEY в настройках проекта Vercel.' }, { status: 503 });
  }
  const id = new URL(request.url).searchParams.get('id');
  const { data, byId } = await getData();
  const l = byId.get(id);
  if (!l) return json({ error: 'Объявление не найдено' }, { status: 404 });

  const cacheHeaders = { 'Cache-Control': 'public, s-maxage=604800, stale-while-revalidate=86400' };
  if (memo.has(id)) return json(memo.get(id), { headers: cacheHeaders });

  const ip = (request.headers.get('x-forwarded-for') || 'local').split(',')[0].trim();
  if (rateLimited(ip)) return json({ error: 'Слишком много запросов на ИИ-оценку. Попробуйте через час.' }, { status: 429 });

  try {
    const market = marketFor(l, data.listings);
    const assessment = await assessListing(l, market);
    const body = { id, market, assessment };
    memo.set(id, body);
    return json(body, { headers: cacheHeaders });
  } catch (e) {
    let msg = e.message;
    if (e instanceof Anthropic.AuthenticationError) msg = 'Неверный ключ ANTHROPIC_API_KEY.';
    else if (e instanceof Anthropic.RateLimitError) msg = 'Лимит запросов к Claude исчерпан, попробуйте позже.';
    else if (e instanceof Anthropic.APIError) msg = `Ошибка Claude API (${e.status}): ${e.message}`;
    console.error('assess error', e);
    return json({ error: msg }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
