// Coach cloud sync: one private copy of the app's data in Upstash Redis (added through the Vercel Marketplace).
//
//   GET /api/sync?rev=N           { same:true, rev } if the cloud is still at rev N, else { rev, savedAt, device, state }
//   PUT /api/sync                 body { baseRev, state, device, day }. Saves when baseRev is the cloud's rev,
//                                 otherwise answers 409 with the newer cloud copy so the app can merge and retry.
//   GET /api/sync?snapshots=1     { days:[...] } that have a daily snapshot (kept for 31 days)
//   GET /api/sync?snapshot=DAY    { day, state } for one snapshot
//
// Every request needs "Authorization: Bearer <COACH_TOKEN>". No npm packages: Node built-ins and fetch only.
const crypto = require('crypto');
const zlib = require('zlib');

const KEEP_DAYS = 31;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The Marketplace names the variables KV_REST_API_URL / _TOKEN (with an optional prefix) or UPSTASH_REDIS_REST_URL / _TOKEN.
function redisEnv(){
  const e = process.env;
  for (const k of Object.keys(e)) {
    const m = k.match(/^(.*?)(KV_REST_API_URL|UPSTASH_REDIS_REST_URL)$/);
    if (!m || !e[k]) continue;
    const token = e[m[1] + m[2].replace(/URL$/, 'TOKEN')];
    if (token) return { url: e[k].replace(/\/+$/, ''), token };
  }
  return null;
}

async function redis(env, cmds, path = '/pipeline'){
  const r = await fetch(env.url + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x && x.error) throw new Error('redis ' + x.error); return x.result; });
}

// stored gzipped, so a year of logs stays far below the free plan's request size
const pack = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
const unpack = s => JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString());

function authorised(req){
  const want = process.env.COACH_TOKEN || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want || !got) return false;
  const a = crypto.createHash('sha256').update(want).digest(), b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readMeta(env){
  const [raw] = await redis(env, [['GET', 'coach:meta']]);
  return raw ? JSON.parse(raw) : { rev: 0 };
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const env = redisEnv();
  if (!env || !process.env.COACH_TOKEN) return res.status(503).json({ error: 'not-configured' });
  if (!authorised(req)) { await new Promise(r => setTimeout(r, 400)); return res.status(401).json({ error: 'unauthorised' }); }
  try {
    const q = req.query || {};
    if (req.method === 'GET' && q.snapshots) {
      const days = []; let cursor = '0';
      do {
        const [[next, keys]] = await redis(env, [['SCAN', cursor, 'MATCH', 'coach:snap:*', 'COUNT', '200']]);
        cursor = String(next); keys.forEach(k => days.push(k.slice('coach:snap:'.length)));
      } while (cursor !== '0');
      return res.status(200).json({ days: days.sort() });
    }
    if (req.method === 'GET' && q.snapshot) {
      if (!DAY.test(q.snapshot)) return res.status(400).json({ error: 'bad-day' });
      const [raw] = await redis(env, [['GET', 'coach:snap:' + q.snapshot]]);
      if (!raw) return res.status(404).json({ error: 'no-snapshot' });
      return res.status(200).json({ day: q.snapshot, state: unpack(raw) });
    }
    if (req.method === 'GET') {
      const meta = await readMeta(env);
      if (String(meta.rev) === String(q.rev)) return res.status(200).json({ same: true, rev: meta.rev });
      if (!meta.rev) return res.status(200).json({ rev: 0, empty: true });
      const [raw] = await redis(env, [['GET', 'coach:state']]);
      return res.status(200).json({ rev: meta.rev, savedAt: meta.savedAt, device: meta.device, state: raw ? unpack(raw) : null });
    }
    if (req.method === 'PUT') {
      const b = req.body || {}, st = b.state;
      if (!st || typeof st !== 'object' || !st.settings || !st.days || !st.workouts) return res.status(400).json({ error: 'bad-state' });
      const meta = await readMeta(env);
      if (Number(b.baseRev) !== Number(meta.rev || 0)) {
        const [raw] = await redis(env, [['GET', 'coach:state']]);
        return res.status(409).json({ rev: meta.rev, savedAt: meta.savedAt, device: meta.device, state: raw ? unpack(raw) : null });
      }
      const rev = (meta.rev || 0) + 1, savedAt = new Date().toISOString();
      const device = String(b.device || '').slice(0, 40), day = DAY.test(b.day) ? b.day : savedAt.slice(0, 10);
      const packed = pack(st);
      await redis(env, [
        ['SET', 'coach:state', packed],
        ['SET', 'coach:snap:' + day, packed, 'EX', String(KEEP_DAYS * 86400)],
        ['SET', 'coach:meta', JSON.stringify({ rev, savedAt, device })]
      ], '/multi-exec');
      return res.status(200).json({ rev, savedAt });
    }
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'storage' });
  }
};
