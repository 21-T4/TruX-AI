/* Tool declarations offered to the model and their executors. The model
   decides whether to call any of them; Google Search is the built-in tool. */
import { executeComposioTool, getComposioGeminiTools, PLUGIN_CATALOG } from '../lib/composio.js';
import { forgetMemory, MEMORY_TOOL_DECLARATIONS, saveMemory } from '../lib/memory.js';
import { addUsage, checkQuota } from '../lib/usage.js';
import { saveBuffer, userMediaKey, userVideoPrefix } from '../lib/storage.js';
import { generateImage, generateVideo } from '../lib/vertex.js';
import { downloadBuffer } from '../lib/storage.js';
import { executeTruxWebTool, TRUX_WEB_TOOL_DECLARATIONS } from '../lib/web-tools.js';
import { DEVICE_TOOL, deviceLabel, prepareDeviceAction } from './device.js';

const IMAGE_TOOL = {
  name: 'trux_generate_image',
  description: 'Generate or edit a raster image with Gemini image generation. The image is shown to the user automatically under your reply; do not paste links to it.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed visual description: subject, style, composition, lighting, colours, text to render.' },
      aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
      useAttachedImage: { type: 'boolean', description: 'Edit the image the user attached in this message instead of creating from scratch.' }
    },
    required: ['prompt']
  }
};

const VIDEO_TOOL = {
  name: 'trux_generate_video',
  description: 'Generate an 8-second video clip with Veo. Takes a few minutes. The video is shown to the user automatically.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Shot description: subject, action, camera movement, style, audio/ambience.' },
      aspectRatio: { type: 'string', enum: ['16:9', '9:16'] }
    },
    required: ['prompt']
  }
};

const COMPOSIO_DISCOVERY_TOOL = {
  name: 'trux_composio_discover_tools',
  description: 'Find callable actions in the user\'s connected apps. Describe the desired outcome; matching real actions become callable on your next step. Discovery does not perform anything.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
};

const LABELS = {
  trux_web_open: args => 'Reading ' + (() => { try { return new URL(args?.url).hostname; } catch { return 'page'; } })(),
  trux_memory_save: () => 'Saving to memory',
  trux_memory_forget: () => 'Updating memory',
  trux_generate_image: () => 'Generating image',
  trux_generate_video: () => 'Generating video',
  trux_composio_discover_tools: () => 'Finding app actions',
  trux_device_action: args => deviceLabel(args)
};

export class Toolbox {
  constructor({ env, user, memories, personalization, connectedSlugs, attachedImageKey, attachedImageMime, origin, writer, send, canVideo, device }) {
    Object.assign(this, { env, user, memories, personalization, connectedSlugs, attachedImageKey, attachedImageMime, origin, writer, send, canVideo, device });
    this.composioMeta = new Map();
    this.dynamic = [];
  }

  get capabilities() {
    return {
      hasComposio: this.connectedSlugs.length > 0,
      canImage: true,
      canVideo: this.canVideo,
      memoryEnabled: this.personalization.memoryEnabled,
      device: this.device
    };
  }

  geminiTools() {
    const declarations = [...TRUX_WEB_TOOL_DECLARATIONS, IMAGE_TOOL];
    if (this.personalization.memoryEnabled) declarations.push(...MEMORY_TOOL_DECLARATIONS);
    if (this.canVideo) declarations.push(VIDEO_TOOL);
    if (this.connectedSlugs.length) declarations.push(COMPOSIO_DISCOVERY_TOOL);
    if (this.device) declarations.push(DEVICE_TOOL);
    declarations.push(...this.dynamic);
    return [{ functionDeclarations: declarations }, { googleSearch: {} }];
  }

  label(call) {
    const meta = this.composioMeta.get(call.name);
    if (meta) return `${meta.toolkitName} · ${meta.name}`;
    return (LABELS[call.name] || (() => call.name))(call.args || {});
  }

  /** Runs one call; returns { response, stop } where stop ends the turn. */
  async run(call, signal) {
    const args = call.args || {};
    switch (call.name) {
      case 'trux_web_open':
        return { response: await executeTruxWebTool({ name: call.name, args, signal }) };
      case 'trux_memory_save': {
        const result = await saveMemory(this.user.uid, args.text, this.memories);
        if (result.ok && !result.duplicate) this.send({ type: 'memory', action: 'saved', id: result.id, text: result.text });
        return { response: result };
      }
      case 'trux_memory_forget': {
        const result = await forgetMemory(this.user.uid, args.id);
        this.memories = this.memories.filter(m => m.id !== result.id);
        if (result.ok) this.send({ type: 'memory', action: 'forgot', id: result.id });
        return { response: result };
      }
      case 'trux_generate_image': return { response: await this.image(args, signal) };
      case 'trux_generate_video': return { response: await this.video(args, signal) };
      case 'trux_composio_discover_tools': return { response: await this.discover(args) };
      case 'trux_device_action': {
        // Runs on the user's device: the client receives it over the stream.
        const prepared = prepareDeviceAction(args, this.device);
        if (!prepared.ok) return { response: prepared };
        this.send({ type: 'device_action', action: prepared.action });
        return { response: { ok: true, status: 'sent_to_device', note: prepared.note } };
      }
      default:
        if (this.composioMeta.has(call.name)) return this.composio(call);
        return { response: { ok: false, error: 'Unknown tool: ' + call.name } };
    }
  }

  async image(args, signal) {
    const quota = await checkQuota(this.user, 'images');
    if (!quota.ok) return { ok: false, error: `Monthly image limit reached (${quota.limit}). Tell the user it resets next month.` };
    let referenceImage = null;
    if (args.useAttachedImage && this.attachedImageKey) {
      referenceImage = { mimeType: this.attachedImageMime, data: (await downloadBuffer(this.attachedImageKey)).toString('base64') };
    }
    const image = await generateImage({ prompt: args.prompt, aspectRatio: args.aspectRatio, referenceImage, signal });
    const extension = image.mimeType.includes('jpeg') ? 'jpg' : image.mimeType.split('/')[1] || 'png';
    const objectKey = userMediaKey(this.user.uid, extension);
    await saveBuffer(objectKey, Buffer.from(image.data, 'base64'), image.mimeType, { prompt: String(args.prompt).slice(0, 500) });
    addUsage(this.user.uid, 'images').catch(() => {});
    const media = { kind: 'image', objectKey, mimeType: image.mimeType, prompt: String(args.prompt).slice(0, 500) };
    this.writer.update({ media: [...this.writer.state.media, media] });
    this.send({ type: 'media', media });
    return { ok: true, note: 'Image generated and already displayed to the user.' };
  }

  async video(args, signal) {
    const bucket = this.env.TRUX_BUCKET_NAME;
    const prefix = userVideoPrefix(this.user.uid);
    const result = await generateVideo({
      prompt: args.prompt,
      aspectRatio: args.aspectRatio,
      outputGcsUri: `gs://${bucket}/${prefix}/`,
      signal,
      onStatus: status => this.send({ type: 'status', status })
    });
    const objectKey = result.gcsUri.replace(`gs://${bucket}/`, '');
    if (!objectKey.startsWith(`users/${this.user.uid}/videos/`)) return { ok: false, error: 'Video was written to an unexpected location.' };
    addUsage(this.user.uid, 'videos').catch(() => {});
    const media = { kind: 'video', objectKey, mimeType: result.mimeType, prompt: String(args.prompt).slice(0, 500) };
    this.writer.update({ media: [...this.writer.state.media, media] });
    this.send({ type: 'media', media });
    return { ok: true, note: 'Video generated and already displayed to the user.' };
  }

  async discover(args) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, error: 'Describe the action you want to find.' };
    const found = await getComposioGeminiTools(this.env, this.connectedSlugs, query);
    const known = new Set(this.dynamic.map(d => d.name));
    for (const declaration of found.declarations || []) {
      if (!known.has(declaration.name) && this.dynamic.length < 60) this.dynamic.push(declaration);
    }
    for (const [name, meta] of found.metadata || []) this.composioMeta.set(name, meta);
    return {
      ok: true,
      actions: (found.declarations || []).map(d => ({ name: d.name, description: d.description, app: this.composioMeta.get(d.name)?.toolkitName })),
      note: (found.declarations || []).length ? 'These actions are now callable.' : 'No matching actions; try a different description.'
    };
  }

  async composio(call) {
    const meta = this.composioMeta.get(call.name);
    const plugin = PLUGIN_CATALOG.find(p => p.slugs.includes(meta.toolkitSlug));
    const callbackUrl = this.origin + '/?trux_plugins=1&plugin=' + encodeURIComponent(plugin?.id || '') + '&composio_callback=1';
    const result = await executeComposioTool(this.env, this.user.uid, call.name, call.args || {}, meta, callbackUrl);
    if (result?.authRequired) {
      this.send({
        type: 'plugin_auth_required',
        pluginId: plugin?.id || '',
        pluginName: plugin?.name || meta.toolkitName,
        toolkitSlug: meta.toolkitSlug,
        redirectUrl: result.reconnectUrl || null,
        message: result.error
      });
    }
    let text = '';
    try { text = JSON.stringify(result); } catch { text = String(result); }
    return { response: text.length > 40_000 ? { ...result, result: text.slice(0, 40_000) + '…[truncated]' } : result };
  }
}
