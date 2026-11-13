/* Persists an assistant message to RTDB while it streams, so a refresh or
   reopen shows the in-progress and final answer. Writes are coalesced. */
import { getDb } from '../lib/firebase.js';

export class MessageWriter {
  constructor({ uid, chatId, messageId, enabled = true }) {
    this.enabled = enabled;
    this.path = `users/${uid}/messages/${chatId}/${messageId}`;
    this.chatPath = `users/${uid}/chats/${chatId}`;
    this.state = { role: 'model', text: '', status: 'streaming', tools: [], sources: [], media: [], createdAt: Date.now() };
    this.timer = null;
    this.pending = Promise.resolve();
    this.dirty = false;
  }

  async start(extra = {}) {
    Object.assign(this.state, extra);
    if (!this.enabled) return;
    const db = await getDb();
    this.ref = db.ref(this.path);
    await this.ref.update(this.state);
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.dirty = true;
    if (!this.enabled || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 400);
  }

  appendText(delta) { this.update({ text: this.state.text + delta }); }

  setTool(id, label, status) {
    const tools = this.state.tools.filter(t => t.id !== id);
    tools.push({ id, label, status });
    this.update({ tools: tools.slice(-20) });
  }

  flush() {
    if (!this.enabled || !this.ref || !this.dirty) return this.pending;
    this.dirty = false;
    const { text, status, tools, sources, media, model, error } = this.state;
    const snapshot = { text, status, tools, sources, media, updatedAt: Date.now() };
    if (model) snapshot.model = model;
    if (error) snapshot.error = error;
    this.pending = this.pending.then(() => this.ref.update(snapshot)).catch(e => console.warn('[writer] flush failed:', e?.message));
    return this.pending;
  }

  async finish(status, extra = {}) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    Object.assign(this.state, extra, { status });
    this.dirty = true;
    await this.flush();
    if (this.enabled) {
      const db = await getDb();
      await db.ref(this.chatPath).update({ updatedAt: Date.now(), lastStatus: status }).catch(() => {});
      await db.ref(this.path + '/stopRequested').remove().catch(() => {});
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
