// GET /api/listing?id=olx-123 — полная карточка + сравнение цены с рынком
import { getData, json } from '../lib/data.js';
import { marketFor } from '../lib/filter.js';

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id');
  const { data, byId } = await getData();
  const l = byId.get(id);
  if (!l) return json({ error: 'Объявление не найдено (возможно, данные обновились)' }, { status: 404 });
  const { _loc, _hay, ...listing } = l;
  return json(
    { listing, market: marketFor(l, data.listings), uzsPerUsd: data.uzsPerUsd, collectedAt: data.collectedAt },
    { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' } },
  );
}
