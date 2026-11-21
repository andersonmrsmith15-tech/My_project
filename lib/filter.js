// Фильтрация, сортировка, счётчики для фильтров и рыночная статистика.

export const TYPE_LABEL = { apartment: 'Квартира в новостройке', house: 'Новый дом', cottage: 'Коттедж', townhouse: 'Таунхаус' };
const LIST_KEYS = ['type', 'rooms', 'district', 'repair', 'material', 'seller', 'source'];
const NUM_KEYS = ['pMin', 'pMax', 'm2Min', 'm2Max', 'aMin', 'aMax', 'flMin', 'flMax', 'lMin', 'lMax', 'year'];
const BOOL_KEYS = ['notFirst', 'notLast', 'withPhoto', 'hideDup', 'fresh'];

export function locKey(l) {
  if (l.city && l.city !== 'Ташкент') return l.city;
  if (!l.district) return l.city || 'Ташкент';
  return l.district.replace(/ский район/i, 'ский').replace(/ район/i, '').trim();
}
export const roomKey = (l) => (l.rooms == null ? null : l.rooms >= 5 ? '5+' : String(l.rooms));

/** Разбор параметров запроса: ?type=house~cottage&pMax=150000&withPhoto=true */
export function parseQuery(sp) {
  const q = {};
  for (const k of LIST_KEYS) q[k] = sp.get(k) ? new Set(sp.get(k).split('~').filter(Boolean)) : new Set();
  for (const k of NUM_KEYS) {
    const v = parseFloat(String(sp.get(k) ?? '').replace(/\s/g, ''));
    q[k] = Number.isFinite(v) ? v : null;
  }
  for (const k of BOOL_KEYS) q[k] = sp.get(k) === 'true';
  if (!sp.has('withPhoto')) q.withPhoto = true;
  if (!sp.has('hideDup')) q.hideDup = true;
  q.ids = sp.get('ids') ? new Set(sp.get('ids').split('~')) : null;
  q.text = (sp.get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  q.sort = sp.get('sort') || 'new';
  return q;
}

const inRange = (x, a, b) => (a == null || (x != null && x >= a)) && (b == null || (x != null && x <= b));

export function filterListings(list, q) {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const onlyHouse = q.type.size && !q.type.has('apartment');
  const onlyApt = q.type.size === 1 && q.type.has('apartment');
  return list.filter((l) => {
    if (q.ids && !q.ids.has(l.id)) return false;
    if (q.type.size && !q.type.has(l.type)) return false;
    if (q.rooms.size && !q.rooms.has(roomKey(l))) return false;
    if (q.district.size && !q.district.has(l._loc)) return false;
    if (q.repair.size && !q.repair.has(l.repair)) return false;
    if (q.material.size && !q.material.has(l.material)) return false;
    if (q.seller.size && !q.seller.has(l.seller)) return false;
    if (q.source.size && !q.source.has(l.source)) return false;
    if (!inRange(l.priceUsd, q.pMin, q.pMax)) return false;
    if (!inRange(l.pricePerM2, q.m2Min, q.m2Max)) return false;
    if (!inRange(l.area, q.aMin, q.aMax)) return false;
    if (l.type === 'apartment') {
      if (onlyHouse) return false;
      if (!inRange(l.floor, q.flMin, q.flMax)) return false;
      if (q.notFirst && l.floor === 1) return false;
      if (q.notLast && l.floor && l.floors && l.floor === l.floors) return false;
    } else {
      if (onlyApt) return false;
      if (!inRange(l.landSotka, q.lMin, q.lMax)) return false;
      if (q.year && !(l.year >= q.year)) return false;
    }
    if (q.withPhoto && !l.photos?.length) return false;
    if (q.hideDup && l.duplicateOf) return false;
    if (q.fresh && !(l.updatedAt >= weekAgo)) return false;
    if (q.text.length) {
      const hay = (l._hay ??= `${l.title} ${l.description} ${l.complex || ''} ${l.district || ''} ${l.city || ''} ${l.address || ''}`.toLowerCase());
      if (!q.text.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function sortListings(list, sort) {
  const nz = (x, d) => x ?? d;
  const f = {
    new: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
    cheap: (a, b) => a.priceUsd - b.priceUsd,
    exp: (a, b) => b.priceUsd - a.priceUsd,
    m2: (a, b) => nz(a.pricePerM2, 1e9) - nz(b.pricePerM2, 1e9),
    area: (a, b) => nz(b.area, 0) - nz(a.area, 0),
  }[sort] || ((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return list.sort(f);
}

/** Краткая карточка для списка (без описания и всех фото) */
export function toCard(l) {
  return {
    id: l.id, source: l.source, alsoOn: l.alsoOn ? l.alsoOn.map((a) => a.source) : undefined,
    type: l.type, title: l.title, priceUsd: l.priceUsd, pricePerM2: l.pricePerM2,
    rooms: l.rooms, area: l.area, floor: l.floor, floors: l.floors, landSotka: l.landSotka,
    district: l.district, city: l.city, region: l.region, complex: l.complex,
    repair: l.repair, year: l.year, updatedAt: l.updatedAt,
    photo: l.photos?.[0] || null, photoCount: l.photos?.length || 0,
  };
}

function countBy(list, fn) {
  const m = new Map();
  for (const l of list) { const k = fn(l); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]);
}

export function computeFacets(list) {
  const visible = list.filter((l) => !l.duplicateOf);
  return {
    total: list.length,
    type: countBy(visible, (l) => l.type),
    rooms: countBy(visible, roomKey),
    district: countBy(visible, (l) => l._loc ?? locKey(l)),
    repair: countBy(visible, (l) => l.repair),
    material: countBy(visible, (l) => l.material),
    seller: countBy(visible, (l) => l.seller),
    source: countBy(list, (l) => l.source),
    years: [...new Set(list.map((l) => l.year).filter(Boolean))].sort(),
  };
}

// ---------------- Рыночная статистика ----------------
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];

function stats(values) {
  const s = values.filter((v) => v != null).sort((a, b) => a - b);
  if (s.length < 5) return null;
  return { count: s.length, median: pct(s, 0.5), p25: pct(s, 0.25), p75: pct(s, 0.75) };
}

/** Сравнение цены объявления с похожими объявлениями (тот же тип, район, комнатность) */
export function marketFor(l, all) {
  if (!l.pricePerM2) return null;
  const isApt = l.type === 'apartment';
  const peers = all.filter((x) => !x.duplicateOf && x.id !== l.id && x.pricePerM2 && (x.type === 'apartment') === isApt);
  const sameArea = peers.filter((x) => x._loc === l._loc);
  const sameRooms = sameArea.filter((x) => (isApt ? roomKey(x) === roomKey(l) : true));
  const groups = [
    { label: `${isApt ? roomKey(l) + '-комн. квартиры' : 'Новые дома'} — ${l._loc}`, st: stats(sameRooms.map((x) => x.pricePerM2)) },
    { label: `${isApt ? 'Квартиры в новостройках' : 'Новые дома'} — ${l._loc}`, st: stats(sameArea.map((x) => x.pricePerM2)) },
    { label: `${isApt ? 'Квартиры в новостройках' : 'Новые дома'} — весь регион`, st: stats(peers.map((x) => x.pricePerM2)) },
  ].filter((g) => g.st);
  const main = groups[0];
  if (!main) return null;
  const diff = Math.round(((l.pricePerM2 - main.st.median) / main.st.median) * 100);
  return { pricePerM2: l.pricePerM2, diffPct: diff, compareTo: main.label, groups: groups.map((g) => ({ label: g.label, ...g.st })) };
}
