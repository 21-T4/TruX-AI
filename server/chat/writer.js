/* Persists an assistant message to the Realtime Database.
 *
 * Cost model: the answer is streamed to the browser over SSE (free), NOT written to the database while it is being
 * generated. The database only sees
 *   1. one small placeholder when the turn starts   (status "working", so a refresh / reopen / other device can show
 *      "TruX is working in the background"),
 *   2. tiny throttled progress writes (tool list, activity label, heartbeat) while a long answer runs, and
 *   3. ONE bundled write when the model is done: text, sources, media, tools, status and the chat's list meta, all in a
 *      single atomic multi-path update. The thinking summary goes to its own path (users/{uid}/thinking/...) so it is
 *      never mixed into the answer and never downloaded with the chat's message list.
 * The final write replaces the placeholder in place (same node), so nothing is "removed and re-added".
 */
import { getDb } from '../lib/firebase.js';

const PROGRESS_MIN_MS = 1500;      // at most one progress write per this long
const HEARTBEAT_MS = 20_000;       // keeps `updatedAt` moving on long turns so other screens can tell the turn is alive
const MAX_TEXT = 390_000;          // database rules allow 400 000 characters
const MAX_THINKING = 30_000;       // rules allow 100 000
const FINAL_ATTEMPTS = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Realtime Database refuses `undefined` anywhere in a payload and one bad field used to make every write fail silently,
   so the answer was never stored. A JSON round trip drops undefined values and anything that is not plain data. */
function plain(value) { return JSON.parse(JSON.stringify(value)); }

function clamp(text, max, note = '') {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max - note.length) + note : value;
}

/* Turns still running in this process, so a shutdown can store what they have instead of leaving them "working". */
const activeWriters = new Set();

export async function abandonActiveWriters(reason = 'The server restarted while answering. Please try again.') {
  await Promise.all([...activeWriters].map(writer => writer.finish('error', { error: reason }).catch(() => {})));
}

export class MessageWriter {
  constructor({ uid, chatId, messageId, enabled = true, db = null }) {
    this.enabled = enabled;
    this.uid = uid;
    this.chatId = chatId;
    this.messageId = messageId;
    this.getDatabase = db ? async () => db : getDb;
    this.path = `users/${uid}/messages/${chatId}/${messageId}`;
    this.state = { role: 'model', text: '', thinking: '', status: 'working', tools: [], sources: [], media: [], createdAt: Date.now() };
    this.started = false;
    this.finished = false;
    this.progressDirty = false;
    this.lastProgressAt = 0;
    this.progressTimer = null;
    this.heartbeat = null;
    this.pending = Promise.resolve();
    this.finishing = null;
    this.persisted = false;
  }

  /* Writes the small "working" placeholder. `alsoWrite` carries other paths (relative to users/{uid}) that belong to
     the same moment, e.g. the user's message and the chat's list meta, so the whole start is one write. */
  async start(extra = {}, alsoWrite = {}) {
    Object.assign(this.state, extra);
    if (!this.enabled) return;
    const db = await this.getDatabase();
    this.root = db.ref(`users/${this.uid}`);
    this.ref = db.ref(this.path);
    const now = Date.now();
    this.state.startedAt = now;
    const placeholder = { role: 'model', status: 'working', createdAt: this.state.createdAt, startedAt: now, updatedAt: now };
    if (this.state.mode) placeholder.mode = this.state.mode;
    await this.root.update(plain({ ...alsoWrite, [`messages/${this.chatId}/${this.messageId}`]: placeholder }));
    this.started = true;
    this.lastProgressAt = now;
    activeWriters.add(this);
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /* In-memory only: nothing below touches the database until finish() (or a throttled progress write). */
  update(patch) {
    Object.assign(this.state, patch);
    if ('tools' in patch || 'activity' in patch) this.progress();
  }

  appendText(delta) { this.state.text += delta; }

  appendThinking(delta) {
    if (this.state.thinking.length < MAX_THINKING) this.state.thinking += delta;
  }

  setTool(id, label, status) {
    const tools = this.state.tools.filter(t => t.id !== id);
    tools.push({ id, label, status });
    this.update({ tools: tools.slice(-20), activity: status === 'running' ? label : this.state.activity });
  }

  /* Tool and activity changes are the only things worth showing to someone who is not watching the live stream. */
  progress() {
    if (!this.enabled || !this.started || this.finished) return;
    this.progressDirty = true;
    if (this.progressTimer) return;
    const wait = Math.max(0, PROGRESS_MIN_MS - (Date.now() - this.lastProgressAt));
    this.progressTimer = setTimeout(() => { this.progressTimer = null; this.writeProgress(); }, wait);
    this.progressTimer.unref?.();
  }

  beat() {
    if (!this.enabled || !this.started || this.finished) return;
    if (Date.now() - this.lastProgressAt < HEARTBEAT_MS - 1000) return;
    this.progressDirty = true;
    this.writeProgress();
  }

  writeProgress() {
    if (!this.enabled || !this.started || this.finished || !this.progressDirty) return this.pending;
    this.progressDirty = false;
    this.lastProgressAt = Date.now();
    const patch = { updatedAt: this.lastProgressAt };
    if (this.state.tools.length) patch.tools = this.state.tools;
    if (this.state.activity) patch.activity = String(this.state.activity).slice(0, 200);
    this.pending = this.pending
      .then(() => { if (!this.finished) return this.ref.update(plain(patch)); })
      .catch(error => console.warn('[writer] progress write failed:', error?.message));
    return this.pending;
  }

  /* The one bundled write. Resolves true when the answer is stored. Safe to call twice (the second call waits for the first). */
  finish(status, extra = {}) {
    if (this.finishing) return this.finishing;
    this.finishing = this.doFinish(status, extra);
    return this.finishing;
  }

  async doFinish(status, extra) {
    clearTimeout(this.progressTimer); this.progressTimer = null;
    clearInterval(this.heartbeat); this.heartbeat = null;
    Object.assign(this.state, extra, { status });
    this.finished = true;
    activeWriters.delete(this);
    if (!this.enabled) return true;
    await this.pending.catch(() => {});          // a late progress write must not land after the final one
    const { text, thinking, tools, sources, media, model, error, mode, createdAt } = this.state;
    const now = Date.now();
    const message = { role: 'model', text: clamp(text, MAX_TEXT, '\n\n[Answer shortened to fit storage.]'), status, createdAt, updatedAt: now, completedAt: now };
    if (tools.length) message.tools = tools;
    if (sources.length) message.sources = sources;
    if (media.length) message.media = media;
    if (model) message.model = model;
    if (mode) message.mode = mode;
    if (error) message.error = String(error).slice(0, 400);
    if (thinking.trim()) message.hasThinking = true;
    const updates = {
      [`messages/${this.chatId}/${this.messageId}`]: message,
      [`chats/${this.chatId}/updatedAt`]: now,
      [`chats/${this.chatId}/lastStatus`]: status
    };
    updates[`thinking/${this.chatId}/${this.messageId}`] = thinking.trim() ? clamp(thinking.trim(), MAX_THINKING) : null;

    let lastError;
    for (let attempt = 1; attempt <= FINAL_ATTEMPTS; attempt++) {
      try {
        const root = this.root || (await this.getDatabase()).ref(`users/${this.uid}`);
        await root.update(plain(updates));
        this.persisted = true;
        return true;
      } catch (e) {
        lastError = e;
        console.warn(`[writer] final write failed (attempt ${attempt}/${FINAL_ATTEMPTS}):`, e?.message);
        if (attempt < FINAL_ATTEMPTS) await sleep(300 * attempt * attempt);
      }
    }
    /* Last resort: the plain answer alone, so a bad optional field (sources, media, tools) can never lose it. */
    try {
      const root = this.root || (await this.getDatabase()).ref(`users/${this.uid}`);
      await root.update(plain({
        [`messages/${this.chatId}/${this.messageId}`]: { role: 'model', text: message.text, status, createdAt, updatedAt: now, completedAt: now, ...(message.error ? { error: message.error } : {}) },
        [`chats/${this.chatId}/lastStatus`]: status
      }));
      this.persisted = true;
      console.error('[writer] stored the answer without its extras after:', lastError?.message);
      return true;
    } catch (e) {
      console.error('[writer] could not store the answer:', e?.message || lastError?.message);
      return false;
    }
  }

  /** Calls onStop when the client sets stopRequested on this message. */
  watchStop(onStop) {
    if (!this.enabled || !this.ref) return () => {};
    const stopRef = this.ref.child('stopRequested');
    const listener = stopRef.on('value', snap => { if (snap.val()) onStop(); });
    return () => stopRef.off('value', listener);
  }
}
