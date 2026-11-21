// Загрузка данных объявлений.
// На Vercel: из Vercel Blob (файл listings.json.gz, его загружает сборщик из GitHub Actions).
// Если Blob не подключён — из файла data/listings.json.gz, который лежит в репозитории.

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { head } from '@vercel/blob';
import { computeFacets, locKey } from './filter.js';

export const BLOB_PATH = 'listings.json.gz';
const LOCAL_FILE = path.join(process.cwd(), 'data', 'listings.json.gz');
const RECHECK_MS = 10 * 60 * 1000; // как часто проверять, не появились ли новые данные

let cache = null; // { data, byId, facets, version, checkedAt }
let loading = null;

async function fetchFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const meta = await head(BLOB_PATH);
    const version = String(meta.uploadedAt);
    if (cache && cache.version === version) return { same: true };
    const res = await fetch(meta.url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Blob HTTP ${res.status}`);
    return { buf: Buffer.from(await res.arrayBuffer()), version };
  } catch (e) {
    console.warn('Blob недоступен, берём локальный файл:', e.message);
    return null;
  }
}

function prepare(buf, version) {
  const data = JSON.parse(gunzipSync(buf).toString('utf8'));
  const byId = new Map();
  for (const l of data.listings) {
    l._loc = locKey(l);
    byId.set(l.id, l);
  }
  return { data, byId, facets: computeFacets(data.listings), version, checkedAt: Date.now() };
}

async function load() {
  const blob = await fetchFromBlob();
  if (blob?.same) { cache.checkedAt = Date.now(); return cache; }
  if (blob?.buf) return (cache = prepare(blob.buf, blob.version));
  if (cache) { cache.checkedAt = Date.now(); return cache; }
  try {
    return (cache = prepare(await readFile(LOCAL_FILE), 'local'));
  } catch {
    return (cache = { data: { collectedAt: null, listings: [] }, byId: new Map(), facets: computeFacets([]), version: 'empty', checkedAt: Date.now() });
  }
}

export async function getData() {
  if (cache && Date.now() - cache.checkedAt < RECHECK_MS) return cache;
  if (!loading) loading = load().finally(() => { loading = null; });
  // если данные уже есть, не заставляем пользователя ждать проверку
  if (cache) { loading.catch(() => {}); return cache; }
  return loading;
}

export const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });

/** Сбросить кеш (локальный сервер вызывает после сбора новых данных) */
export function resetCache() { cache = null; }
