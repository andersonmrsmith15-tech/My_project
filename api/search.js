// GET /api/search?type=apartment&pMax=80000&offset=0&limit=36[&map=1]
// Фильтрация на сервере: в браузер уходит только нужная страница карточек.
import { getData, json } from '../lib/data.js';
import { parseQuery, filterListings, sortListings, toCard } from '../lib/filter.js';

export async function GET(request) {
  const sp = new URL(request.url).searchParams;
  const { data, facets } = await getData();
  const q = parseQuery(sp);
  const list = sortListings(filterListings(data.listings, q), q.sort);
  const offset = Math.max(0, parseInt(sp.get('offset') || '0', 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(sp.get('limit') || '36', 10) || 36));
  const body = {
    total: list.length,
    items: list.slice(offset, offset + limit).map(toCard),
    meta: { collectedAt: data.collectedAt, count: data.listings.length, uzsPerUsd: data.uzsPerUsd },
    facets,
  };
  if (sp.get('map') === '1') {
    body.points = list.filter((l) => l.lat && l.lng).slice(0, 4000)
      .map((l) => [l.id, +l.lat.toFixed(5), +l.lng.toFixed(5), l.priceUsd, l.type, l.rooms, l.area]);
  }
  return json(body, { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=3600' } });
}
