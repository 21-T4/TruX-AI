// Server-side checks for the chat storage path: the bundled RTDB writes and the agent loop's thinking handling.
// Run with `npm test`. Uses in-memory fakes, so it needs no Firebase or Vertex access.
import assert from 'node:assert/strict';
import { MessageWriter, abandonActiveWriters } from '../server/chat/writer.js';
import { runAgent } from '../server/chat/agent.js';

/* A tiny fake of the Admin SDK's database: ref(path).update(), root multi-path update, child(), on/off. */
function fakeDb({ failFirst = 0, rejectUndefined = true } = {}) {
  const data = {};
  const writes = [];
  let failures = failFirst;
  const setPath = (path, value) => {
    const parts = path.split('/').filter(Boolean);
    let node = data;
    parts.slice(0, -1).forEach(k => { node = node[k] ??= {}; });
    if (value === null) delete node[parts.at(-1)]; else node[parts.at(-1)] = JSON.parse(JSON.stringify(value));
  };
  const check = v => { if (rejectUndefined && JSON.stringify(v, (k, x) => x === undefined ? '__undef__' : x).includes('__undef__')) throw new Error('contains undefined'); };
  const ref = base => ({
    async update(values) {
      check(values);
      if (failures > 0) { failures--; throw new Error('simulated outage'); }
      writes.push({ base, keys: Object.keys(values) });
      for (const [k, v] of Object.entries(values)) setPath(base ? base + '/' + k : k, v);
    },
    child: name => ref(base + '/' + name),
    on() { return () => {}; }, off() {}
  });
  return { ref, data, writes };
}

const mk = (db, extra = {}) => new MessageWriter({ uid: 'u1', chatId: 'chat1', messageId: 'm1', db, ...extra });
const msg = db => db.data.users.u1.messages.chat1.m1;

// 1. Streaming costs nothing: only the placeholder is written, then ONE bundled write with everything.
{
  const db = fakeDb(); const w = mk(db);
  await w.start({ createdAt: 100, mode: 'chat' }, { 'messages/chat1/u0': { role: 'user', text: 'hi' }, 'chats/chat1/lastStatus': 'working' });
  assert.equal(msg(db).status, 'working'); assert.equal(msg(db).text, undefined);
  assert.equal(db.data.users.u1.messages.chat1.u0.text, 'hi');            // user message in the same write
  for (let i = 0; i < 400; i++) w.appendText('word ');                     // 400 "chunks"
  w.appendThinking('**Plan** step one'); w.appendThinking('\nstep two');
  assert.equal(db.writes.length, 1, 'no database writes while text streams');
  w.update({ sources: [{ title: 'a', uri: 'https://a', domain: undefined }], media: [{ kind: 'image', objectKey: 'k', prompt: undefined }] });
  assert.equal(await w.finish('done'), true);
  assert.equal(db.writes.length, 2, 'placeholder + one bundled write');
  assert.equal(msg(db).status, 'done'); assert.equal(msg(db).text.length, 2000);
  assert.equal(msg(db).hasThinking, true);
  assert.ok(!('thinking' in msg(db)) && !msg(db).text.includes('Plan'), 'thinking is not part of the answer');
  assert.match(db.data.users.u1.thinking.chat1.m1, /\*\*Plan\*\*/);
  assert.equal(db.data.users.u1.chats.chat1.lastStatus, 'done');
  assert.equal(await w.finish('error'), true);                              // second call is a no-op
  assert.equal(msg(db).status, 'done');
}

// 2. A flaky database: the final write is retried; a bad optional field cannot lose the answer.
{
  const db = fakeDb({ failFirst: 0 }); const w = mk(db); await w.start({ createdAt: 1 });
  db.ref('').update; w.appendText('kept answer');
  const real = db.ref('users/u1').update; let n = 0;
  db.ref = (base => { const r = db.ref.bind(db); return p => { const o = r(p); if (p === 'users/u1') { const u = o.update; o.update = async v => { n++; if (n === 1) throw new Error('blip'); return u(v); }; } return o; }; })();
  w.root = db.ref('users/u1');
  assert.equal(await w.finish('done'), true);
  assert.equal(msg(db).text, 'kept answer'); assert.ok(n >= 2, 'retried after the first failure');
}

// 3. Incognito never touches the database.
{
  const db = fakeDb(); const w = mk(db, { enabled: false });
  await w.start(); w.appendText('x'); assert.equal(await w.finish('done'), true); assert.equal(db.writes.length, 0);
}

// 4. Progress writes are tiny and throttled; nothing lands after the final write.
{
  const db = fakeDb(); const w = mk(db); await w.start({ createdAt: 1 });
  for (let i = 0; i < 10; i++) w.setTool('t' + i, 'Searching', 'running');
  await new Promise(r => setTimeout(r, 1700));
  const progress = db.writes.filter(x => x.base.endsWith('/m1'));
  assert.equal(progress.length, 1, 'ten tool updates collapse into one write');
  assert.ok(msg(db).tools.length > 0 && msg(db).activity);
  w.setTool('late', 'x', 'running'); await w.finish('done');
  await new Promise(r => setTimeout(r, 1700));
  assert.equal(msg(db).status, 'done', 'a late progress write never overwrites the final state');
  assert.equal(msg(db).tools.at(-1).id, 'late');
}

// 5. Shutdown stores what a running answer has so far instead of leaving it "working".
{
  const db = fakeDb(); const w = mk(db); await w.start({ createdAt: 1 }); w.appendText('partial answer');
  await abandonActiveWriters('restarted');
  assert.equal(msg(db).status, 'error'); assert.equal(msg(db).text, 'partial answer'); assert.equal(msg(db).error, 'restarted');
}

// 6. Agent loop with a fake Vertex client: thought parts never reach the answer, and an empty round is retried.
const streamOf = chunks => (async function* () { for (const c of chunks) yield c; })();
const chunk = (parts, extra = {}) => ({ candidates: [{ content: { parts }, ...extra }] });
{
  const calls = [];
  const client = { models: { generateContentStream: async req => {
    calls.push(req.config.thinkingConfig);
    if (calls.length === 1) return streamOf([chunk([{ thought: true, text: '**Weighing** options' }], { finishReason: 'STOP' })]);   // only thinking
    return streamOf([chunk([{ thought: true, text: 'more thought' }, { text: 'Hello ' }]), chunk([{ text: 'there.' }], { finishReason: 'STOP' })]);
  } } };
  const db = fakeDb(); const w = mk(db); await w.start({ createdAt: 1 });
  const events = [];
  const toolbox = { geminiTools: () => [], label: () => '', run: async () => ({ response: {} }) };
  const out = await runAgent({ model: 'm', thinking: 'high', contents: [], systemInstruction: '', toolbox, writer: w, send: e => events.push(e), signal: new AbortController().signal, client });
  assert.equal(out.text, 'Hello there.'); assert.equal(w.state.text, 'Hello there.');
  assert.match(w.state.thinking, /Weighing[\s\S]*more thought/);
  assert.equal(calls.length, 2, 'the thinking-only round was retried once');
  assert.equal(calls[1].thinkingLevel, 'LOW', 'the retry thinks lightly');
  assert.ok(events.filter(e => e.type === 'thinking').length === 2 && events.filter(e => e.type === 'chunk').every(e => !/thought|Weighing/.test(e.text)));
  await w.finish('done');
}

// 7. A model that refuses thought summaries is asked again without them.
{
  const seen = [];
  const client = { models: { generateContentStream: async req => {
    seen.push(!!req.config.thinkingConfig?.includeThoughts);
    if (req.config.thinkingConfig?.includeThoughts) throw Object.assign(new Error('INVALID_ARGUMENT: includeThoughts unsupported'), { status: 400 });
    return streamOf([chunk([{ text: 'ok' }], { finishReason: 'STOP' })]);
  } } };
  const w = mk(fakeDb(), { enabled: false });
  const out = await runAgent({ model: 'm', thinking: 'low', contents: [], systemInstruction: '', toolbox: { geminiTools: () => [], label: () => '', run: async () => ({}) }, writer: w, send() {}, signal: new AbortController().signal, client });
  assert.equal(out.text, 'ok'); assert.deepEqual(seen, [true, false]);
}

console.log('chat storage tests passed');
process.exit(0);
