// Coach chat (beta): one continuous conversation with Claude, kept in the same Upstash Redis as the cloud backup.
//
//   GET    /api/chat                 { mode, messages:[the latest 80], more, profile, spend }   mode: "live" or "pretend"
//   GET    /api/chat?before=N        { messages:[up to 80 older than message N], more }
//   POST   /api/chat                 body { text, snapshot }  -> text/event-stream of JSON events:
//                                    user (the stored message), status, delta, done (the stored reply), error
//   POST   /api/chat?distill=1       body { text, force }     -> { profile } written from imported chat history
//   PUT    /api/chat?profile=1       body { text }            -> { profile }
//   DELETE /api/chat                 clears the conversation (the profile stays)
//
// Same passphrase as /api/sync. No npm packages: Node built-ins and fetch only. Without ANTHROPIC_API_KEY every reply
// is a pretend one, streamed the same way, so the app can be built and tested for free. Real requests stop for the
// rest of the day once they have cost CHAT_DAILY_CAP_EUR (default 1). Keys start with COACH_PREFIX (default "coach"),
// so a test deployment can keep its conversation apart from the real one.
const crypto = require('crypto');
const zlib = require('zlib');

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5-5';
const PRICE = { in: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 };   // USD per million tokens, Claude Sonnet 5.5
const EUR_PER_USD = 0.92;
const CONTEXT_MESSAGES = 40;   // the latest messages sent with each request; the profile carries what lasts
const PAGE = 80;

const INSTRUCTIONS = `You are Coach, the personal training and nutrition coach inside the Coach app. You talk with one person in a single ongoing conversation, like texting a coach who knows them well.

How to answer:
- Be short, plain and direct, like a knowledgeable friend texting. A few sentences is usually right; go longer only when asked for a plan or an explanation.
- Use metric units and the person's own numbers. Each message comes with the app's data for today and the last days (meals, macros against targets, water, the workout plan and what was logged). Base every number on it, and say so when the data does not cover something instead of guessing.
- Keep to the food rules, limits and preferences in the profile. They are firm.
- Use short paragraphs. Use bullets only for lists of foods, lifts or steps, and bold only for the one thing that matters most.
- Never use em dashes.
- You cannot change anything in the app yet. When something should be logged or changed, tell the person what to log or change.
- When it helps, end with up to two short follow-up questions the person might ask next, each on its own line starting with "↳ ". They become tap-to-send suggestions, so phrase them in the person's voice.`;

const NO_PROFILE = `There is no profile yet. Early in the conversation, ask whether they have earlier chats or notes you could learn from: they can import them in Settings, Coach chat, Import chat history. Until then, learn their goals and routine by asking.`;

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
  spend: day => `${P()}:chat:spend:${day}`               // { usd, n } for one day, kept 3 days
};

function authorised(req){
  const want = process.env.COACH_TOKEN || '';
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!want || !got) return false;
  const a = crypto.createHash('sha256').update(want).digest(), b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

const today = () => new Date().toISOString().slice(0, 10);
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
async function addSpend(env, usd){
  const s = await readSpend(env); s.usd += usd; s.n += 1;
  await redis(env, [['SET', K.spend(today()), JSON.stringify(s), 'EX', String(3 * 86400)]]);
  return s;
}
const costUsd = u => ((u.input_tokens || 0) * PRICE.in + (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite
  + (u.cache_read_input_tokens || 0) * PRICE.cacheRead + (u.output_tokens || 0) * PRICE.out) / 1e6;

/* ---------- the request to Claude ---------- */
// The instructions and the profile come first and are cached; the conversation follows as plain text (Claude's own
// thinking is never stored or replayed), cached up to the previous turn; the app data rides on the new message only.
function buildRequest(profile, history, text, snapshot){
  const msgs = [];
  for (const m of history) {   // the API wants user and assistant turns in turn, starting with the user
    if (!msgs.length && m.role !== 'user') continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) last.text += '\n\n' + m.text; else msgs.push({ role: m.role, text: m.text });
  }
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();   // an earlier message that never got its reply
  const messages = msgs.map(m => ({ role: m.role, content: [{ type: 'text', text: m.text }] }));
  if (messages.length) messages[messages.length - 1].content[0].cache_control = { type: 'ephemeral' };
  const now = [];
  if (snapshot) now.push({ type: 'text', text: 'App data with this message:\n' + String(snapshot).slice(0, 20000) });
  now.push({ type: 'text', text });
  messages.push({ role: 'user', content: now });
  return {
    model: MODEL,
    max_tokens: 4000,
    stream: true,
    output_config: { effort: 'low' },
    fallbacks: 'default',
    system: [
      { type: 'text', text: INSTRUCTIONS },
      { type: 'text', text: profile ? 'Their profile, kept by them in the app:\n\n' + profile : NO_PROFILE, cache_control: { type: 'ephemeral' } }
    ],
    messages
  };
}
const anthropicHeaders = () => ({
  'Content-Type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2026-10-21',
  'anthropic-beta': 'server-side-fallback-2026-07-01'
});

/* stream one reply from Claude; calls on(type, data) for status and text, resolves to { text, usage, stop } */
async function streamClaude(body, on){
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: anthropicHeaders(), body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = 'http ' + r.status; try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  const usage = {}; let text = '', stop = null, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = block.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (ev.type === 'message_start' && ev.message && ev.message.usage) Object.assign(usage, ev.message.usage);
      else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'thinking') on('status', 'Thinking…');
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { text += ev.delta.text; on('delta', ev.delta.text); }
      else if (ev.type === 'message_delta') { if (ev.usage) Object.assign(usage, ev.usage); if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; }
      else if (ev.type === 'error') { const err = new Error((ev.error && ev.error.message) || 'stream error'); err.status = 529; throw err; }
    }
  }
  return { text, usage, stop };
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
    return { text: `This is a pretend reply, Coach is not connected to Claude yet.\n\nFrom your log: you have eaten ${eaten || 'nothing yet'} today${left ? `, and ${left} is still open` : ''}. Once the API key is in, I will plan the rest of your day from these numbers.\n\n↳ What should I have for dinner?\n↳ Am I on track for protein this week?` };
  }
  if (/train|lift|session|gym|workout/.test(t)) {
    const plan = grab(/Training today: ([^\n]+)/);
    return { text: `This is a pretend reply, Coach is not connected to Claude yet.\n\nToday's plan in the app: ${plan || 'no session'}. With the API key, I will look at your last sessions and tell you what to push and what to hold.\n\n↳ What weight for chest press today?\n↳ How did my last Push session go?` };
  }
  return { text: `This is a pretend reply. Coach is not connected to Claude yet, so I can't really answer, but everything you see here works the same way: your message is saved, this reply streams in word by word, and both are kept in your conversation.\n\nTry asking about **food** or **training** to see your app data come through, or send **/long** or **/error** to test those cases.\n\n↳ How much protein do I have left today?\n↳ What is my session today?` };
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
  const live = !!process.env.ANTHROPIC_API_KEY, q = req.query || {};
  try {
    if (req.method === 'GET') {
      const meta = await readMeta(env), before = Number(q.before) || 0;
      const page = await readMessages(env, meta, before, PAGE);
      if (before) return res.status(200).json(page);
      const [profile, spend] = await Promise.all([readProfile(env), readSpend(env)]);
      return res.status(200).json({ mode: live ? 'live' : 'pretend', ...page, profile, spend: spendOut(spend) });
    }
    if (req.method === 'PUT' && q.profile) {
      const b = await readBody(req), text = String(b.text || '').slice(0, 60000);
      const profile = { text, updatedAt: new Date().toISOString() };
      await redis(env, [['SET', K.profile(), JSON.stringify(profile)]]);
      return res.status(200).json({ profile });
    }
    if (req.method === 'DELETE') {
      const meta = await readMeta(env);
      await redis(env, [...meta.months.map(m => ['DEL', K.month(m)]), ['DEL', K.meta()]], '/multi-exec');
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
  const [meta, profile, spend] = await Promise.all([readMeta(env), readProfile(env), readSpend(env)]);
  if (live && spend.usd >= capUsd()) return res.status(429).json({ error: 'cap', spend: spendOut(spend) });

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  let gone = false; res.on('close', () => { gone = true; });   // closing the chat mid-reply: the reply is still finished and saved
  const send = (t, data) => { if (!gone) res.write(`data: ${JSON.stringify({ t, ...data })}\n\n`); };
  const history = (await readMessages(env, meta, 0, CONTEXT_MESSAGES)).messages;
  const userMsg = await appendMessage(env, meta, { role: 'user', text, ts: Date.now() });
  send('user', { msg: userMsg });
  if (snapshot) send('status', { text: 'Reading your log…' });

  let reply = '';
  try {
    if (live) {
      const out = await streamClaude(buildRequest(profile.text, history, text, snapshot), (type, x) => {
        if (type === 'status') send('status', { text: x }); else { reply += x; send('delta', { text: x }); }
      });
      const after = await addSpend(env, costUsd(out.usage));
      if (out.stop === 'refusal' && !out.text) { send('error', { code: 'refusal', message: 'Coach could not answer that one.' }); return res.end(); }
      const msg = await appendMessage(env, meta, { role: 'assistant', text: out.text, ts: Date.now(), ...(out.stop === 'max_tokens' ? { cut: true } : {}) });
      send('done', { msg, spend: spendOut(after) });
    } else {
      const p = pretendReply(text, snapshot);
      await wait(snapshot ? 700 : 300); send('status', { text: 'Thinking…' }); await wait(900);
      if (p.error) { send('error', { code: 'pretend', message: 'A pretend error, to test how failures look.' }); return res.end(); }
      for (const word of p.text.split(/(\s+)/)) { if (!word) continue; reply += word; send('delta', { text: word }); if (!gone && word.trim()) await wait(28); }
      const msg = await appendMessage(env, meta, { role: 'assistant', text: p.text, ts: Date.now() });
      send('done', { msg, spend: spendOut(spend) });
    }
  } catch (e) {
    console.error(e);
    if (reply) await appendMessage(env, meta, { role: 'assistant', text: reply, ts: Date.now(), cut: true }).catch(() => {});
    send('error', { code: e.status === 429 ? 'busy' : 'failed', message: e.status === 429 || e.status === 529 ? 'Claude is busy right now. Try again in a moment.' : 'Coach could not answer. Try again.' });
  }
  res.end();
}

/* write the profile from imported chat history: one request, at most about 600k tokens of history */
async function distill(env, req, res, live){
  const b = await readBody(req), text = String(b.text || '');
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  if (text.length > 2400000) return res.status(413).json({ error: 'too-long' });
  const spend = await readSpend(env);
  if (live && spend.usd >= capUsd() && !b.force) return res.status(429).json({ error: 'cap', spend: spendOut(spend) });
  let profileText;
  if (live) {
    const body = { model: MODEL, max_tokens: 8000, stream: true, output_config: { effort: 'medium' }, fallbacks: 'default',
      messages: [{ role: 'user', content: [{ type: 'text', text: DISTILL }, { type: 'text', text: '<history>\n' + text + '\n</history>' }] }] };
    const out = await streamClaude(body, () => {});
    await addSpend(env, costUsd(out.usage));
    if (!out.text) return res.status(502).json({ error: 'empty-reply' });
    profileText = out.text.trim();
  } else {
    await wait(1500);
    const n = (text.match(/\n(You|Human|User|Me):/gi) || []).length;
    profileText = `This is a pretend profile. Coach is not connected to Claude yet, so it could not read your ${Math.round(text.length / 1000)}k characters of history${n ? ` (${n} of your messages)` : ''}.\n\nOnce the API key is in, importing again writes the real profile here: your goals, training split, food rules and limits, routine and how you like answers.`;
  }
  const profile = { text: profileText, updatedAt: new Date().toISOString() };
  await redis(env, [['SET', K.profile(), JSON.stringify(profile)]]);
  return res.status(200).json({ profile, spend: spendOut(await readSpend(env)) });
}
