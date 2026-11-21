// GET /api/health — диагностика: загрузились ли данные, откуда, какие переменные окружения заданы
import { getData, diag, json } from '../lib/data.js';

export async function GET() {
  let count = 0, collectedAt = null, error = null;
  try {
    const { data } = await getData();
    count = data.listings.length; collectedAt = data.collectedAt;
  } catch (e) { error = `${e.name}: ${e.message}`; }
  const mem = process.memoryUsage();
  return json({
    ok: count > 0,
    count, collectedAt, error,
    dataSource: diag.source, loadMs: diag.loadMs,
    blobError: diag.blobError, localErrors: diag.localErrors,
    env: {
      BLOB_READ_WRITE_TOKEN: !!process.env.BLOB_READ_WRITE_TOKEN,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      GITHUB_REPO: process.env.GITHUB_REPO || null,
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
    },
    runtime: { node: process.version, cwd: process.cwd(), region: process.env.VERCEL_REGION || null, memoryMb: Math.round(mem.rss / 1048576) },
  }, { headers: { 'Cache-Control': 'no-store' } });
}
