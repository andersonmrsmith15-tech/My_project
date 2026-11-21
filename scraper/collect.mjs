// Сборщик реальных объявлений о ПРОДАЖЕ новостроек и новых домов/коттеджей.
// Источники: OLX.uz (публичный API) и Uybor.uz (публичный API).
// Результат: data/listings.json
//
// Запуск: npm run collect

import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'listings.json.gz');

// ---- Настройки ----
const CONFIG = {
  // Дом считается «новым», если год постройки/сдачи не раньше этого года
  newHouseMinYear: 2023,
  // Объявления дешевле этой суммы (USD) — почти всегда цена за м² или ошибка, отбрасываем
  minPriceUsd: 8000,
  // Дом дешевле этой суммы — почти всегда участок земли или недострой-коробка, а не дом
  minHousePriceUsd: 15000,
  // Пауза между запросами, чтобы не нагружать сайты
  delayMs: 350,
  // OLX: Ташкент + Ташкентская область
  olxRegionId: 5,
  // Uybor: берём только объявления по Ташкенту и области
  uyborRegionMatch: /ташкент/i,
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'ru' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (i === tries) { console.warn(`  ! ${url} → ${e.message}`); return null; }
      await sleep(1500 * i);
    }
  }
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const clean = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();

let UZS_PER_USD = 12000; // уточняется по данным Uybor

// =====================================================================
// Uybor.uz
// =====================================================================
const UYBOR_REPAIR = { evro: 'Евроремонт', sredniy: 'Средний ремонт', kapital: 'Капитальный ремонт', chernovaya: 'Черновая отделка', custom: 'Авторский проект', bez: 'Без ремонта', predchistovaya: 'Предчистовая' };
const UYBOR_MATERIAL = { kirpich: 'Кирпичный', monolit: 'Монолитный', panel: 'Панельный', blok: 'Блочный', other: 'Другое' };
const UYBOR_HOUSE_SUB = { 28: 'Дом', 27: 'Коттедж', 9: 'Дача' };
// Объявления о продаже участка, ошибочно размещённые в разделе «Дома»
const LAND_ONLY = /(участ|земел|\byer\b|yer sotil|ер сотил|sotix yer)/i;
const HOUSE_WORDS = /(дом|коттедж|таунхаус|дач|этаж|qavat|etaj|dacha|\buy\b|uyi|hovli|ховли|уй\b|xona|хона|комнат)/i;
export const isLandOnly = (title) => LAND_ONLY.test(title || '') && !HOUSE_WORDS.test(title || '');

const NEW_WORDS = /(нов(ый|ая|ое|остро)|yangi|янги|сдача|под ключ новый|только построен|2025|2026)/i;

async function collectUybor() {
  const out = [];
  const base = 'https://api.uybor.uz/api/v1/listings?operationType__eq=sale&embed=region,district,residentialComplex,zone&limit=100';
  const queries = [
    { q: '&isNewBuilding__eq=true', kind: 'apartment' },
    { q: '&category__eq=8', kind: 'house' },
  ];
  for (const { q, kind } of queries) {
    for (let page = 1; page < 200; page++) {
      const d = await getJson(`${base}${q}&page=${page}`);
      await sleep(CONFIG.delayMs);
      const rows = d?.results || [];
      if (!rows.length) break;
      for (const x of rows) {
        if (x.operationType !== 'sale' || x.isActive === false) continue;
        const region = x.region?.name?.ru || '';
        if (!CONFIG.uyborRegionMatch.test(region)) continue;
        if (x.prices?.usd && x.prices?.uzs) UZS_PER_USD = x.prices.uzs / x.prices.usd;

        let type = 'apartment';
        let newBy = 'Отмечено сайтом как новостройка';
        if (kind === 'house') {
          // Для домов Uybor не даёт год постройки — берём только те, где продавец явно пишет, что дом новый
          if (!NEW_WORDS.test(x.description || '')) continue;
          type = x.subCategoryId === 27 ? 'cottage' : 'house';
          newBy = 'Продавец указал в описании, что дом новый';
          if ((x.prices?.usd ?? 0) < CONFIG.minHousePriceUsd || isLandOnly(x.description?.split('\n')[0])) continue;
        }
        const priceUsd = x.prices?.usd ?? null;
        if (!priceUsd || priceUsd < CONFIG.minPriceUsd) continue;
        const desc = clean(x.description);
        const rooms = num(x.room);
        const area = num(x.square);
        const complex = x.residentialComplex?.name?.ru || null;
        out.push({
          id: `uybor-${x.id}`,
          source: 'Uybor.uz',
          url: `https://uybor.uz/listings/${x.id}`,
          type,
          houseKind: kind === 'house' ? (UYBOR_HOUSE_SUB[x.subCategoryId] || 'Дом') : null,
          title: complex
            ? `${rooms ? rooms + '-комн. ' : ''}квартира в ЖК «${complex}»`
            : kind === 'house'
              ? `${UYBOR_HOUSE_SUB[x.subCategoryId] || 'Дом'}${rooms ? ', ' + rooms + ' комн.' : ''}${area ? ', ' + area + ' м²' : ''}`
              : `${rooms ? rooms + '-комн. ' : ''}квартира в новостройке${area ? ', ' + area + ' м²' : ''}`,
          description: desc.slice(0, 600),
          priceUsd: Math.round(priceUsd),
          priceNegotiable: !!x.isPriceAuction,
          rooms,
          area,
          landSotka: num(x.squareGround),
          floor: num(x.floor),
          floors: num(x.floorTotal),
          region,
          city: /город/i.test(region) ? 'Ташкент' : null,
          district: x.district?.name?.ru || null,
          address: x.address || null,
          complex,
          repair: UYBOR_REPAIR[x.repair] || null,
          material: UYBOR_MATERIAL[x.foundation] || null,
          year: null,
          market: null,
          newBy,
          lat: x.lat ?? null,
          lng: x.lng ?? null,
          photos: (x.media || []).slice(0, 8).map((m) => m.url),
          seller: null,
          createdAt: x.createdAt,
          updatedAt: x.upAt || x.updatedAt,
        });
      }
      if (rows.length < 100) break;
    }
  }
  return out;
}

// =====================================================================
// OLX.uz
// =====================================================================
const OLX_APART = 13; // Квартиры — продажа
const OLX_HOUSE = 18; // Дома — продажа

// OLX отдаёт максимум 1000 объявлений на запрос, поэтому дробим по цене (USD)
const APART_BUCKETS = [[0, 30000], [30001, 38000], [38001, 45000], [45001, 52000], [52001, 60000], [60001, 68000], [68001, 77000], [77001, 88000], [88001, 100000], [100001, 120000], [120001, 150000], [150001, 200000], [200001, 300000], [300001, 1e9]];
const HOUSE_BUCKETS = [[0, 60000], [60001, 100000], [100001, 150000], [150001, 220000], [220001, 350000], [350001, 1e9]];

const param = (x, key) => x.params?.find((p) => p.key === key)?.value;

function olxPriceUsd(x) {
  const p = param(x, 'price');
  if (!p || p.value == null) return null;
  if (p.currency === 'UYE' || p.currency === 'USD') return p.value;
  if (p.currency === 'UZS') return p.value / UZS_PER_USD;
  return null;
}

function olxPhoto(link) {
  return link ? link.replace('{width}', '640').replace('{height}', '480') : null;
}

// Если диапазон упёрся в лимит OLX (1000), делим его пополам и собираем каждую половину
async function olxRange(baseQuery, from, to, onRow, depth = 0) {
  let got = 0;
  for (let offset = 0; offset < 1000; offset += 50) {
    const url = `https://www.olx.uz/api/v1/offers/?limit=50&offset=${offset}&region_id=${CONFIG.olxRegionId}&currency=UYE&filter_float_price:from=${from}&filter_float_price:to=${to}&${baseQuery}`;
    const d = await getJson(url);
    await sleep(CONFIG.delayMs);
    const rows = d?.data || [];
    rows.forEach(onRow);
    got += rows.length;
    if (rows.length < 50) break;
  }
  if (got >= 1000 && to - from > 400 && depth < 8) {
    const top = to >= 1e9 ? Math.max(from * 2, 1000000) : to; // открытый верхний диапазон
    const mid = Math.floor((from + top) / 2);
    got = await olxRange(baseQuery, from, mid, onRow, depth + 1) + await olxRange(baseQuery, mid + 1, to, onRow, depth + 1);
  } else {
    process.stdout.write(`    ${from}–${to >= 1e9 ? '∞' : to}$: ${got}${got >= 1000 ? ' (лимит)' : ''}\n`);
  }
  return got;
}

async function olxPaged(baseQuery, buckets, onRow) {
  for (const [from, to] of buckets) await olxRange(baseQuery, from, to, onRow);
}

function olxBase(x) {
  const loc = x.location || {};
  return {
    source: 'OLX.uz',
    url: x.url,
    title: clean(x.title),
    description: clean(x.description).slice(0, 600),
    region: loc.region?.name || null,
    city: loc.city?.name || null,
    district: loc.district?.name || null,
    address: null,
    lat: x.map?.lat ?? null,
    lng: x.map?.lon ?? null,
    photos: (x.photos || []).slice(0, 8).map((p) => olxPhoto(p.link)),
    seller: x.business ? 'Агентство / компания' : 'Частное лицо',
    createdAt: x.created_time,
    updatedAt: x.last_refresh_time,
  };
}

async function collectOlx() {
  const out = new Map();

  console.log('  OLX: квартиры в новостройках');
  for (const market of ['primary', 'developer']) {
    await olxPaged(`category_id=${OLX_APART}&filter_enum_type_of_market%5B0%5D=${market}`, market === 'primary' ? APART_BUCKETS : [[0, 1e9]], (x) => {
      const m = param(x, 'type_of_market');
      if (!m || !['primary', 'developer'].includes(m.key)) return; // строго только новостройки
      const priceUsd = olxPriceUsd(x);
      if (!priceUsd || priceUsd < CONFIG.minPriceUsd) return;
      out.set(`olx-${x.id}`, {
        id: `olx-${x.id}`,
        ...olxBase(x),
        type: 'apartment',
        houseKind: null,
        priceUsd: Math.round(priceUsd),
        priceNegotiable: !!param(x, 'price')?.negotiable,
        rooms: num(param(x, 'number_of_rooms')?.key),
        area: num(param(x, 'total_area')?.key),
        landSotka: null,
        floor: num(param(x, 'floor')?.key),
        floors: num(param(x, 'total_floors')?.key),
        complex: null,
        repair: param(x, 'repairs')?.label || null,
        material: param(x, 'house_type')?.label || null,
        year: null,
        market: m.label,
        newBy: `Тип жилья на OLX: «${m.label}»`,
      });
    });
  }

  console.log(`  OLX: дома и коттеджи (год постройки/сдачи ≥ ${CONFIG.newHouseMinYear})`);
  await olxPaged(`category_id=${OLX_HOUSE}`, HOUSE_BUCKETS, (x) => {
    const y = param(x, 'year_of_construction_sale');
    const year = num(y?.key);
    if (!year || year < CONFIG.newHouseMinYear) return; // только новые дома
    const priceUsd = olxPriceUsd(x);
    if (!priceUsd || priceUsd < CONFIG.minHousePriceUsd) return;
    if (isLandOnly(x.title)) return; // это участок, а не дом
    const kind = param(x, 'private_house_type')?.label || 'Дом';
    const type = /коттедж/i.test(kind) ? 'cottage' : /таунхаус/i.test(kind) ? 'townhouse' : 'house';
    out.set(`olx-${x.id}`, {
      id: `olx-${x.id}`,
      ...olxBase(x),
      type,
      houseKind: kind,
      priceUsd: Math.round(priceUsd),
      priceNegotiable: !!param(x, 'price')?.negotiable,
      rooms: num(param(x, 'number_of_rooms')?.key),
      area: num(param(x, 'total_area')?.key),
      landSotka: num(param(x, 'plot')?.key),
      floor: null,
      floors: num(param(x, 'total_floors')?.key),
      complex: null,
      repair: param(x, 'house_repairs')?.label || null,
      material: param(x, 'house_type')?.label || null,
      year,
      market: null,
      newBy: `Год постройки/сдачи: ${y.label}`,
    });
  });

  return [...out.values()];
}

// =====================================================================
// Поиск дублей: одно и то же объявление, выложенное на двух сайтах
// =====================================================================
function markDuplicates(list) {
  const seen = new Map();
  for (const l of list) {
    if (!l.area || !l.priceUsd) continue;
    const key = [l.type === 'apartment' ? 'a' : 'h', l.priceUsd, Math.round(l.area), l.rooms ?? '', l.floor ?? ''].join('|');
    const first = seen.get(key);
    if (first && first.source !== l.source) {
      l.duplicateOf = first.id;
      first.alsoOn = [...(first.alsoOn || []), { source: l.source, url: l.url }];
    } else if (!first) seen.set(key, l);
  }
}

// =====================================================================
async function main() {
  const t0 = Date.now();
  console.log('Сбор объявлений…');
  console.log('  Uybor.uz');
  const uybor = await collectUybor();
  console.log(`    найдено: ${uybor.length}`);
  const olx = await collectOlx();
  console.log(`    OLX найдено: ${olx.length}`);

  const all = [...uybor, ...olx];
  for (const l of all) {
    if (l.area && l.priceUsd) {
      const m2 = Math.round(l.priceUsd / l.area);
      // слишком маленькая/большая цена за м² = ошибка в площади, не показываем её
      l.pricePerM2 = m2 >= 200 && m2 <= 15000 ? m2 : null;
    }
  }
  markDuplicates(all);
  all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const gz = gzipSync(JSON.stringify({
    collectedAt: new Date().toISOString(),
    uzsPerUsd: Math.round(UZS_PER_USD),
    newHouseMinYear: CONFIG.newHouseMinYear,
    count: all.length,
    listings: all,
  }), { level: 9 });
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, gz);

  // На GitHub Actions (или если задан токен) — загружаем данные в Vercel Blob, сайт подхватит их сам
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = await import('@vercel/blob');
    const blob = await put('listings.json.gz', gz, {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/gzip', cacheControlMaxAge: 60, multipart: true,
    });
    console.log(`Загружено в Vercel Blob: ${blob.url}`);
  }
  const dups = all.filter((l) => l.duplicateOf).length;
  console.log(`Готово: ${all.length} объявлений (дублей между сайтами: ${dups}) за ${Math.round((Date.now() - t0) / 1000)} с → ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
