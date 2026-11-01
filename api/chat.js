// Coach chat (beta): one continuous conversation with Claude or OpenAI, kept in the same Upstash Redis as the cloud backup.
//
//   GET    /api/chat                 { mode, ai, messages:[the latest 80], more, profile, spend }   mode: "live" or "pretend";
//                                    ai: the model answering and its prices (null when pretend)
//   GET    /api/chat?before=N        { messages:[up to 80 older than message N], more }
//   POST   /api/chat                 body { text, snapshot, retry, qid }  -> text/event-stream of JSON events:
//                                    user (the stored message), status, delta, done (the stored reply), error
//                                    409 { error:'busy' } while another reply is still being written
//                                    qid: the question's id, kept with it; the same id again (Try again, or a send the
//                                    phone never heard back from) answers the stored question instead of storing it twice.
//                                    Without an id (older messages), retry matches the question by its text
//   POST   /api/chat?distill=1       body { text, force }     -> { profile } written from imported chat history; the same
//                                    history again returns the profile already written from it, without a second charge;
//                                    409 while one is still being read
//   PUT    /api/chat?profile=1       body { text }            -> { profile }
//   DELETE /api/chat                 clears the conversation (the profile stays); 409 while a reply is being written
//
// Same passphrase as /api/sync. No npm packages: Node built-ins and fetch only. Claude answers when ANTHROPIC_API_KEY
// is set, otherwise OpenAI when OPENAI_API_KEY is set (CHAT_PROVIDER=claude or openai picks one when both are). Without
// either, every reply is a pretend one, streamed the same way, so the app can be built and tested for free. Real
// requests stop for the rest of the day once they have cost CHAT_DAILY_CAP_EUR (default 1). Keys start with
// COACH_PREFIX (default "coach"), so a test deployment can keep its conversation apart from the real one.
const crypto = require('crypto');
const zlib = require('zlib');

// USD per million tokens. OpenAI charges cache writes at 1.25 times input and prompts over 272k tokens at the long rates.
// CHAT_MODEL swaps the model within the provider; the prices stay those of the default model.
const AI = {
  claude: { name: 'Claude Sonnet 5.5', model: 'claude-sonnet-5-5', price: { in: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 } },
  openai: { name: 'GPT-6.1 Sol', model: 'gpt-6.1-sol', price: { in: 2, cacheWrite: 2.5, cacheRead: 0.1, out: 10,
    longFrom: 272000, long: { in: 4, cacheWrite: 5, cacheRead: 0.2, out: 15 } } }
};
function provider(){
  const e = process.env, want = e.CHAT_PROVIDER;
  if (want === 'openai' && e.OPENAI_API_KEY) return 'openai';
  if (e.ANTHROPIC_API_KEY) return 'claude';
  return e.OPENAI_API_KEY ? 'openai' : null;
}
const model = () => process.env.CHAT_MODEL || AI[provider()].model;
const EUR_PER_USD = 0.92;
const CONTEXT_MESSAGES = 40;   // the latest messages sent with each request; the profile carries what lasts
const PAGE = 80;

const INSTRUCTIONS = `You are Coach AI, the personal training and nutrition coach inside the Coach app, talking with one person in one ongoing conversation, like texting a coach who knows them well.

What you have: their profile (goal, body, health notes, rules, preferences), and with every message the app's data: today's targets, meals, macros, water and food limits, the last 7 days, today's training plan with suggested weights and what was logged, this week's split, recent sessions and the latest waist measurement. Base every number on it. When the data doesn't cover something, say so instead of guessing.

What you do: answer questions, explain the plan and the numbers, suggest what to eat next within their targets and rules, help when a day goes off plan, and review progress when asked. The app logs food and sets, plans sessions and sets weights: never log anything in chat and never write a rival plan. You can't change the app yet. When something should change, say exactly what and where (for example "Settings, Daily targets: carbs 235 to 260 g").

Reviews (when asked, or when the data clearly calls for one):
- Look at weekly average weight or waist, 3 to 5 key lifts, days on target, sessions done.
- Main measure flat for 2 to 3 weeks with good adherence: suggest 150 to 200 kcal, usually from carbs.
- Losing faster than about 1% of body weight a week, or strength dropping across lifts: suggest adding 150 to 200 kcal.
- Poor adherence: fix that first (simpler meals, foods they like, shorter sessions), never cut further.
- Everything working: change nothing, and say so.
- Be honest about pace: about 0.5 to 1% of body weight a week for fat loss, slow scale movement during recomposition, 1 to 2 kg daily swings from water and salt.

Their rules are hard rules: limits, foods they won't eat, removed exercises, suggestions they turned down. Never break them and never suggest them again.

Situations:
- Illness: symptoms only above the neck, light training is fine; fever, chest or body aches, rest.
- Sharp, one-sided or worsening pain: stop that exercise, suggest a pain-free swap, and a physio if it isn't better within about a week.
- After overeating: back to normal at the next meal, never fasting or extra cardio.
- Busy weeks: a minimum version (two short sessions, hit protein).

Safety: you are a coach, not a doctor. Don't diagnose or treat. Recommend a doctor for heart symptoms, fainting, or anything the profile flags. Watch for signs of disordered eating (extreme restriction, guilt or panic around food, compensating with exercise, obsessive weighing). If you see them, stop giving numbers, say kindly what you noticed, and suggest professional help. Don't support crash diets, unsafe supplements, or training through injury or illness. Never shame anyone about food or bodies; slips are data.

Style: lead with the answer, short enough to read mid-workout, metric units and their language. Short paragraphs; bullets only for lists of foods, lifts or steps; bold only for the one thing that matters most. Tables only for comparisons. Ask at most one question, and only if it changes the answer; otherwise state your assumption and go on. Never use em dashes. Most replies end without follow-ups; when there's an obvious next question, end with one or two on their own lines starting with "↳ ", in their voice. They become tap-to-send suggestions under your reply.`;

const NO_PROFILE = `There is no profile yet. Early in the conversation, ask whether they have earlier chats or notes you could learn from: they can import them in Settings, Coach AI, Import chat history. Until then, learn their goals and routine by asking.`;

const DISTILL = `Below is an earlier conversation history between this person and an AI coach. Write the profile the Coach app will give you at the start of every future conversation.

Include what stays true: who they are, their goals and timeline, body stats and how they have changed, their training split and lifts, injuries and what to avoid, food rules, daily limits and targets, foods they eat and like or dislike, their routine (work, office days, cooking), how they like answers, and anything else a coach should remember. Leave out one-off chatter and anything the app already tracks day by day (individual meals and sets), except where it shows a lasting pattern.

Write it in plain, compact sections with short bullets, in the second person ("You..."), and keep it under about 1,500 words. Do not use em dashes.`;

/* ---------- storage ---------- */
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
const pack = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
const unpack = s => JSON.parse(zlib.gunzipSync(Buffer.from(s, 'base64')).toString());
const P = () => process.env.COACH_PREFIX || 'coach';
const K = {
  meta: () => `${P()}:chat:meta`,                       // { months:['2026-10', ...], seq }
  month: m => `${P()}:chat:m:${m}`,                      // gzipped array of messages of that month
  profile: () => `${P()}:chat:profile`,                  // { text, updatedAt }
  spend: day => `${P()}:chat:spend:${day}`,              // { usd, n } for one day, kept 3 days
  busy: () => `${P()}:chat:busy`,                        // held while a reply is written, so two never write at once
  reading: () => `${P()}:chat:reading`                   // held while imported history is read into a profile
};

function authorised(req){
  const want = process.env.COACH_TOKEN || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want || !got) return false;
  const a = crypto.createHash('sha256').update(want).digest(), b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

// the day of the spending cap is Surath's own day (Stuttgart), so it starts again at local midnight, not UTC's
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.CHAT_TZ || 'Europe/Berlin' }).format(new Date());
const monthOf = ts => new Date(ts).toISOString().slice(0, 7);
async function readMeta(env){ const [raw] = await redis(env, [['GET', K.meta()]]); return raw ? JSON.parse(raw) : { months: [], seq: 0 }; }
async function readMonth(env, m){ const [raw] = await redis(env, [['GET', K.month(m)]]); return raw ? unpack(raw) : []; }
async function readProfile(env){ const [raw] = await redis(env, [['GET', K.profile()]]); return raw ? JSON.parse(raw) : { text: '', updatedAt: null }; }
async function readSpend(env){ const [raw] = await redis(env, [['GET', K.spend(today())]]); return raw ? JSON.parse(raw) : { usd: 0, n: 0 }; }
const capUsd = () => Number(process.env.CHAT_DAILY_CAP_EUR || 1) / EUR_PER_USD;
const spendOut = s => ({ eur: Math.round(s.usd * EUR_PER_USD * 1000) / 1000, capEur: Number(process.env.CHAT_DAILY_CAP_EUR || 1) });

/* the latest `limit` messages older than `before` (all of them when before is empty), newest month first */
async function readMessages(env, meta, before, limit){
  let out = [];
  for (const m of meta.months.slice().reverse()) {
    const msgs = (await readMonth(env, m)).filter(x => !before || x.n < before);
    out = msgs.concat(out);
    if (out.length > limit) break;
  }
  return { messages: out.slice(-limit), more: out.length > limit };
}
async function appendMessage(env, meta, msg){
  const m = monthOf(msg.ts), list = await readMonth(env, m);
  msg.n = ++meta.seq; list.push(msg);
  if (!meta.months.includes(m)) meta.months.push(m);
  await redis(env, [['SET', K.month(m), pack(list)], ['SET', K.meta(), JSON.stringify(meta)]], '/multi-exec');
  return msg;
}
async function removeMessage(env, msg){
  const m = monthOf(msg.ts), list = await readMonth(env, m);
  await redis(env, [['SET', K.month(m), pack(list.filter(x => x.n !== msg.n))]]);
}
async function updateMessage(env, msg, patch){
  const m = monthOf(msg.ts), list = await readMonth(env, m), x = list.find(y => y.n === msg.n);
  Object.assign(msg, patch); if (!x) return;
  Object.assign(x, patch); await redis(env, [['SET', K.month(m), pack(list)]]);
}
/* one writer at a time: appends read the month's list and write it back, so two replies written at once (a second send
   while the server still finishes one the phone gave up on) would overwrite each other. The lock expires on its own.
   It is released before the response ends (`held`): work after the response is not guaranteed to run on Vercel, and a
   lock left behind would turn the next message away for up to 5 minutes. */
async function lock(env, key = K.busy()){ const id = crypto.randomUUID(); const [ok] = await redis(env, [['SET', key, id, 'NX', 'EX', '300']]); return ok === 'OK' ? id : null; }
async function unlock(env, id, key = K.busy()){ const [v] = await redis(env, [['GET', key]]); if (v === id) await redis(env, [['DEL', key]]); }
function held(env, id, key){ let on = true; return async () => { if (on) { on = false; await unlock(env, id, key).catch(() => {}); } }; }
async function addSpend(env, usd){
  const s = await readSpend(env); s.usd += usd; s.n += 1;
  await redis(env, [['SET', K.spend(today()), JSON.stringify(s), 'EX', String(3 * 86400)]]);
  return s;
}
// usage in Claude's terms: input_tokens is only the input that was not read from or written to the cache
function costUsd(u){
  const p0 = AI[provider() || 'claude'].price;
  const all = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const p = p0.longFrom && all > p0.longFrom ? p0.long : p0;
  return ((u.input_tokens || 0) * p.in + (u.cache_creation_input_tokens || 0) * p.cacheWrite
    + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.output_tokens || 0) * p.out) / 1e6;
}

/* ---------- the request ---------- */
// The instructions and the profile come first and are cached; the conversation follows as plain text (the model's own
// thinking is never stored or replayed), cached up to the previous turn; the app data rides on the new message only.
// It is written once as { system, turns, now } and put into each provider's format when sent.
function buildRequest(profile, history, text, snapshot){
  const turns = [];
  for (const m of history) {   // the API wants user and assistant turns in turn, starting with the user
    if (m.refused || !String(m.text || '').trim()) continue;   // a declined question would only be declined again; empty text is refused by the API
    if (!turns.length && m.role !== 'user') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.text += '\n\n' + m.text; else turns.push({ role: m.role, text: m.text });
  }
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();   // an earlier message that never got its reply
  const now = [];
  if (snapshot) now.push('App data with this message:\n' + String(snapshot).slice(0, 20000));
  now.push(text);
  return { system: [INSTRUCTIONS, profile ? 'Their profile, kept by them in the app:\n\n' + profile : NO_PROFILE], turns, now, effort: 'low', max: 4000 };
}
/* Claude caches up to the marks: the end of the system blocks and the last earlier turn */
function claudeBody(q){
  const messages = q.turns.map(m => ({ role: m.role, content: [{ type: 'text', text: m.text }] }));
  if (messages.length) messages[messages.length - 1].content[0].cache_control = { type: 'ephemeral' };
  messages.push({ role: 'user', content: q.now.map(text => ({ type: 'text', text })) });
  const body = { model: model(), max_tokens: q.max, stream: true, output_config: { effort: q.effort }, fallbacks: 'default', messages };
  if (q.system.length) body.system = q.system.map((text, i, all) => i === all.length - 1 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text });
  return body;
}
/* OpenAI caches the longest prefix it has seen on its own. store:false: it does not keep the response (30 days otherwise) */
function openaiBody(q){
  const body = { model: model(), max_output_tokens: q.max, stream: true, store: false, reasoning: { effort: q.effort },
    input: [...q.turns.map(m => ({ role: m.role, content: m.text })), { role: 'user', content: q.now.map(text => ({ type: 'input_text', text })) }] };
  if (q.system.length) body.instructions = q.system.join('\n\n');
  return body;
}

async function post(url, headers, body){
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = 'http ' + r.status, code; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; code = j.error && j.error.code; } catch (e) {}
    const err = new Error(msg); err.status = r.status; err.code = code; throw err;
  }
  return r;
}
/* the data of each server-sent event, parsed */
async function* events(r){
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      yield ev;
    }
  }
}
// a stream that fails part way was still billed: what it had used goes with the error, output estimated from the text
const billed = (err, usage, text) => { err.usage = Object.assign({}, usage, { output_tokens: Math.max(usage.output_tokens || 0, Math.ceil(text.length / 3.5)) }); return err; };

/* stream one reply; calls on(type, data) for status and text, resolves to { text, usage, stop } in Claude's terms
   (stop: end_turn when it finished, max_tokens when it was cut off, refusal when it was declined) */
const streamAI = (q, on) => provider() === 'openai' ? streamOpenAI(openaiBody(q), on) : streamClaude(claudeBody(q), on);

async function streamClaude(body, on){
  const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' }, body);
  const usage = {}; let text = '', stop = null;
  try { for await (const ev of events(r)) {
    if (ev.type === 'message_start' && ev.message && ev.message.usage) Object.assign(usage, ev.message.usage);
    else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') on('status', 'Thinking…');
    else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { text += ev.delta.text; on('delta', ev.delta.text); }
    else if (ev.type === 'message_delta') { if (ev.usage) Object.assign(usage, ev.usage); if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; }
    else if (ev.type === 'error') { const err = new Error((ev.error && ev.error.message) || 'stream error'); err.status = 529; throw err; }
  } } catch (e) { throw billed(e, usage, text); }
  return { text, usage, stop };
}

async function streamOpenAI(body, on){
  const r = await post('https://api.openai.com/v1/responses', { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body);
  // usage only comes at the end: until then a failure counts the whole request as uncached input
  let usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 3.5) }, text = '', stop = null, refused = false;
  try { for await (const ev of events(r)) {
    if (ev.type === 'response.output_item.added' && ev.item && ev.item.type === 'reasoning') on('status', 'Thinking…');
    else if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') { text += ev.delta; on('delta', ev.delta); }
    else if (ev.type === 'response.refusal.delta') refused = true;   // a refusal is its own part, never shown as the reply
    else if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') {
      const x = ev.response || {}, u = x.usage, d = (u && u.input_tokens_details) || {};
      if (u) usage = { input_tokens: Math.max(0, (u.input_tokens || 0) - (d.cached_tokens || 0) - (d.cache_write_tokens || 0)),
        cache_read_input_tokens: d.cached_tokens || 0, cache_creation_input_tokens: d.cache_write_tokens || 0, output_tokens: u.output_tokens || 0 };
      if (ev.type === 'response.failed') { const err = new Error((x.error && x.error.message) || 'response failed'); err.status = 529; throw err; }
      const why = x.incomplete_details && x.incomplete_details.reason;
      stop = refused || why === 'content_filter' ? 'refusal' : ev.type === 'response.completed' ? 'end_turn' : why === 'max_output_tokens' ? 'max_tokens' : why || 'incomplete';
    }
    else if (ev.type === 'error') { const err = new Error(ev.message || 'stream error'); err.status = 529; err.code = ev.code; throw err; }
  } } catch (e) { throw billed(e, usage, text); }
  return { text, usage, stop: stop || (refused ? 'refusal' : null) };
}

/* ---------- pretend replies, for building without an API key ---------- */
const wait = ms => new Promise(r => setTimeout(r, ms));
function pretendReply(text, snapshot){
  const t = text.toLowerCase(), snap = String(snapshot || '');
  const grab = re => { const m = snap.match(re); return m ? m[1] : null; };
  if (t.includes('/error')) return { error: true };
  if (t.includes('/long')) return { text: Array.from({ length: 6 }, (_, i) => `**Part ${i + 1}.** This is a long pretend reply to test scrolling and streaming. It keeps going for a while so the conversation has to scroll, and the newest words should stay in view while they arrive.`).join('\n\n') + '\n\n- One point\n- Another point\n- A third point\n\n↳ Can you shorten that?\n↳ What should I eat next?' };
  if (/protein|eat|food|meal|kcal|calorie/.test(t)) {
    const eaten = grab(/Eaten today: ([^\n]+?)\.?\n/), left = grab(/Left today: ([^\n]+?)\.?\n/);
    return { text: `This is a pretend reply, Coach AI is not connected to an AI yet.\n\nFrom your log: you have eaten ${eaten || 'nothing yet'} today${left ? `, and ${left} is still open` : ''}. Once the API key is in, I will plan the rest of your day from these numbers.\n\n↳ What should I have for dinner?\n↳ Am I on track for protein this week?` };
  }
  if (/train|lift|session|gym|workout/.test(t)) {
    const plan = grab(/Training today: ([^\n]+)/);
    return { text: `This is a pretend reply, Coach AI is not connected to an AI yet.\n\nToday's plan in the app: ${plan || 'no session'}. With the API key, I will look at your last sessions and tell you what to push and what to hold.\n\n↳ What weight for chest press today?\n↳ How did my last Push session go?` };
  }
  return { text: `This is a pretend reply. Coach AI is not connected to an AI yet, so I can't really answer, but everything you see here works the same way: your message is saved, this reply streams in word by word, and both are kept in your conversation.\n\nTry asking about **food** or **training** to see your app data come through, or send **/long** or **/error** to test those cases.` };   // like most real replies, no follow-ups
}

/* ---------- handler ---------- */
async function readBody(req){
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const env = redisEnv();
  if (!env || !process.env.COACH_TOKEN) return res.status(503).json({ error: 'not-configured' });
  if (!authorised(req)) { await new Promise(r => setTimeout(r, 400)); return res.status(401).json({ error: 'unauthorised' }); }
  const ai = provider(), live = !!ai, q = req.query || {};
  try {
    if (req.method === 'GET') {
      const meta = await readMeta(env), before = Number(q.before) || 0;
      const page = await readMessages(env, meta, before, PAGE);
      if (before) return res.status(200).json(page);
      const [profile, spend] = await Promise.all([readProfile(env), readSpend(env)]);
      return res.status(200).json({ mode: live ? 'live' : 'pretend', ai: live ? { name: process.env.CHAT_MODEL || AI[ai].name, price: AI[ai].price } : null,
        ...page, profile, spend: spendOut(spend) });
    }
    if (req.method === 'PUT' && q.profile) {
      const b = await readBody(req), text = String(b.text || '').slice(0, 60000);
      const profile = { text, updatedAt: new Date().toISOString() };
      await redis(env, [['SET', K.profile(), JSON.stringify(profile)]]);
      return res.status(200).json({ profile });
    }
    if (req.method === 'DELETE') {
      const id = await lock(env); if (!id) return res.status(409).json({ error: 'busy' });
      try {
        const meta = await readMeta(env);
        await redis(env, [...meta.months.map(m => ['DEL', K.month(m)]), ['DEL', K.meta()]], '/multi-exec');
      } finally { await unlock(env, id).catch(() => {}); }
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST' && q.distill) return await distill(env, req, res, live);
    if (req.method === 'POST') return await chat(env, req, res, live);
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    console.error(e);
    if (res.headersSent) { try { res.end(); } catch (x) {} return; }
    return res.status(502).json({ error: 'storage' });
  }
};

async function chat(env, req, res, live){
  const b = await readBody(req), text = String(b.text || '').trim().slice(0, 8000), snapshot = b.snapshot ? String(b.snapshot) : '';
  if (!text) return res.status(400).json({ error: 'empty' });
  const spend = await readSpend(env);
  if (live && spend.usd >= capUsd()) return res.status(429).json({ error: 'cap', spend: spendOut(spend) });
  const id = await lock(env);
  if (!id) return res.status(409).json({ error: 'busy' });
  const release = held(env, id);
  try { await answer(env, req, res, live, b, text, snapshot, spend, release); }
  finally { await release(); }
}
async function answer(env, req, res, live, b, text, snapshot, spend, release){
  const [meta, profile] = await Promise.all([readMeta(env), readProfile(env)]);
  // Try again: the question is often stored already (the reply failed after it, or the phone lost the answer). It is
  // answered again rather than stored twice; a reply that was cut off makes way, and one that did arrive is simply returned.
  const recent = (await readMessages(env, meta, 0, CONTEXT_MESSAGES + 2)).messages;
  const last = recent[recent.length - 1], prev = recent[recent.length - 2], qid = String(b.qid || '').slice(0, 64);
  const asked = m => !!(m && m.role === 'user' && (qid && m.qid ? m.qid === qid : b.retry && m.text === text));
  let history = recent, userMsg = null;
  if (asked(last)) { userMsg = last; history = recent.slice(0, -1); }
  else if (last && last.role === 'assistant' && asked(prev)) {
    if (!last.cut) {
      await release();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform' });
      res.write(`data: ${JSON.stringify({ t: 'user', msg: prev })}\n\n`); res.write(`data: ${JSON.stringify({ t: 'done', msg: last, spend: spendOut(spend) })}\n\n`);
      return res.end();
    }
    await removeMessage(env, last); userMsg = prev; history = recent.slice(0, -2);
  }
  history = history.slice(-CONTEXT_MESSAGES);

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  let gone = false; res.on('close', () => { gone = true; });   // closing the chat mid-reply: the reply is still finished and saved
  const send = (t, data) => { if (!gone) res.write(`data: ${JSON.stringify({ t, ...data })}\n\n`); };
  const finish = async (t, data) => { await release(); send(t, data); res.end(); };   // everything stored, then the lock, then the end
  if (!userMsg) userMsg = await appendMessage(env, meta, { role: 'user', text, ts: Date.now(), ...(qid ? { qid } : {}) });
  send('user', { msg: userMsg });
  if (snapshot) send('status', { text: 'Reading your log…' });

  let reply = '';
  try {
    if (live) {
      const out = await streamAI(buildRequest(profile.text, history, text, snapshot), (type, x) => {
        if (type === 'status') send('status', { text: x }); else { reply += x; send('delta', { text: x }); }
      });
      const after = await addSpend(env, costUsd(out.usage));
      // declined, even part way: what was written is dropped (the API says to discard it), and the question is kept out of
      // later requests, where it would only be declined again
      if (out.stop === 'refusal') { await updateMessage(env, userMsg, { refused: true }); return finish('error', { code: 'refusal', message: 'Coach AI could not answer that one.' }); }
      if (!out.text.trim()) return finish('error', { code: 'empty', message: 'Coach AI could not answer. Try again.' });   // stored, it would be sent back empty with every later request
      const msg = await appendMessage(env, meta, { role: 'assistant', text: out.text, ts: Date.now(), ...(out.stop !== 'end_turn' ? { cut: true } : {}) });
      return finish('done', { msg, spend: spendOut(after) });
    } else {
      const p = pretendReply(text, snapshot);
      await wait(snapshot ? 700 : 300); send('status', { text: 'Thinking…' }); await wait(900);
      if (p.error) return finish('error', { code: 'pretend', message: 'A pretend error, to test how failures look.' });
      for (const word of p.text.split(/(\s+)/)) { if (!word) continue; reply += word; send('delta', { text: word }); if (!gone && word.trim()) await wait(28); }
      const msg = await appendMessage(env, meta, { role: 'assistant', text: p.text, ts: Date.now() });
      return finish('done', { msg, spend: spendOut(spend) });
    }
  } catch (e) {
    console.error(e);
    if (e.usage) await addSpend(env, costUsd(e.usage)).catch(() => {});   // what a failed stream used still counts towards the cap
    if (reply) await appendMessage(env, meta, { role: 'assistant', text: reply, ts: Date.now(), cut: true }).catch(() => {});
    const broke = e.code === 'insufficient_quota' || /credit balance/i.test(e.message || '');   // OpenAI's and Anthropic's ways of saying so
    return finish('error', broke ? { code: 'credit', message: 'Coach AI is out of API credit.' }
      : { code: e.status === 429 ? 'busy' : 'failed', message: e.status === 429 || e.status === 529 ? 'Coach AI is busy right now. Try again in a moment.' : 'Coach AI could not answer. Try again.' });
  }
}

/* write the profile from imported chat history: one request, at most about 600k tokens of history */
async function distill(env, req, res, live){
  const b = await readBody(req), text = String(b.text || '');
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  if (text.length > 2400000) return res.status(413).json({ error: 'too-long' });
  // the same history again (the phone lost the answer while the profile was written, and Write my profile was tapped
  // again): the profile already written from it, no second charge
  const src = crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
  const [spend, cur] = await Promise.all([readSpend(env), readProfile(env)]);
  if (cur.src === src) return res.status(200).json({ profile: cur, spend: spendOut(spend) });
  if (live && spend.usd >= capUsd() && !b.force) return res.status(429).json({ error: 'cap', spend: spendOut(spend) });
  const id = await lock(env, K.reading()); if (!id) return res.status(409).json({ error: 'busy' });   // one read at a time
  const release = held(env, id, K.reading());
  try { return await readInto(env, res, live, text, src, release); } finally { await release(); }
}
async function readInto(env, res, live, text, src, release){
  let profileText;
  if (live) {
    // thinking counts towards max_tokens; only a profile that ended on its own is kept, not one cut off or declined
    const q = { system: [], turns: [], now: [DISTILL, '<history>\n' + text + '\n</history>'], effort: 'medium', max: 16000 };
    let out;
    try { out = await streamAI(q, () => {}); }
    catch (e) { if (e.usage) await addSpend(env, costUsd(e.usage)).catch(() => {}); throw e; }
    await addSpend(env, costUsd(out.usage));
    if (out.stop !== 'end_turn' || !out.text.trim()) { await release(); return res.status(502).json({ error: out.stop === 'refusal' ? 'refusal' : 'unfinished' }); }
    profileText = out.text.trim();
  } else {
    await wait(1500);
    const n = (text.match(/\n(You|Human|User|Me):/gi) || []).length;
    profileText = `This is a pretend profile. Coach AI is not connected to an AI yet, so it could not read your ${Math.round(text.length / 1000)}k characters of history${n ? ` (${n} of your messages)` : ''}.\n\nOnce the API key is in, importing again writes the real profile here: your goals, training split, food rules and limits, routine and how you like answers.`;
  }
  const profile = { text: profileText, updatedAt: new Date().toISOString(), src };
  await redis(env, [['SET', K.profile(), JSON.stringify(profile)]]);
  const spend = await readSpend(env); await release();
  return res.status(200).json({ profile, spend: spendOut(spend) });
}
