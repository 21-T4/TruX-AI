/* Tool declarations offered to the model and their executors. The model
   decides whether to call any of them; Google Search is the built-in tool. */
import { executeComposioTool, getComposioGeminiTools, PLUGIN_CATALOG } from '../lib/composio.js';
import { forgetMemory, MEMORY_TOOL_DECLARATIONS, saveMemory } from '../lib/memory.js';
import { rateLimit } from '../lib/ratelimit.js';
import { callSandbox, sandboxSession } from '../lib/sandbox.js';
import { addUsage, checkQuota } from '../lib/usage.js';
import { saveBuffer, userMediaKey, userVideoPrefix } from '../lib/storage.js';
import { generateImage, IMAGE_RATIOS } from '../lib/vertex.js';
import { cleanLength, produceVideo, VIDEO_LENGTHS } from '../lib/video.js';
import { executeTruxWebTool, TRUX_WEB_TOOL_DECLARATIONS } from '../lib/web-tools.js';
import { DEVICE_TOOL, deviceLabel, prepareDeviceAction } from './device.js';

const IMAGE_TOOL = {
  name: 'trux_generate_image',
  description: 'Create or edit a raster image with Nano Banana Pro (photos, artwork, posters, product shots, infographics, images with accurate text). The image is shown to the user automatically under your reply; do not paste links to it.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed visual description: subject, style, composition, lighting, colours, exact text to render. For edits, describe the change.' },
      aspectRatio: { type: 'string', enum: IMAGE_RATIOS },
      size: { type: 'string', enum: ['1K', '2K', '4K'], description: 'Output resolution. Default 2K; 4K only when asked for print or very high detail.' },
      reference: { type: 'string', enum: ['none', 'attached', 'previous'], description: 'attached = edit/use the image(s) the user attached in this message; previous = edit the last image you generated in this chat.' }
    },
    required: ['prompt']
  }
};

const VIDEO_TOOL = {
  name: 'trux_generate_video',
  description: 'Produce a video. Gemini 4 Argon designs the shots, Veo 3.1 renders the opening 8 s with native audio, and Gemini Omni extends it to 18 or 28 s or edits an attached video. Takes several minutes; the video and storyboard are shown to the user automatically.',
  parameters: {
    type: 'object',
    properties: {
      brief: { type: 'string', description: 'What the video should show: story, subject, style, mood, dialogue, music. Pass the user\'s idea faithfully; the director expands it.' },
      length: { type: 'integer', enum: VIDEO_LENGTHS, description: 'Seconds. Omit to let the director choose.' },
      aspectRatio: { type: 'string', enum: ['16:9', '9:16'] },
      reference: { type: 'string', enum: ['none', 'image', 'edit_video'], description: 'image = animate the attached image; edit_video = edit the attached video.' }
    },
    required: ['brief']
  }
};

const BASH_TOOL = {
  name: 'trux_bash',
  description: 'Run a bash command in your private Linux sandbox for this chat (Ubuntu with curl, wget, git, jq, Python 3 + pip, Node.js + npm, ffmpeg, ImageMagick, Playwright/Chromium). Files persist in the working directory for this chat for 30 minutes. Use it to call APIs with curl, download and inspect files, run or test code, do data analysis, convert media and so on. Returns stdout, stderr, exit code and changed files.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash script to run. Non-interactive; chain steps with && or newlines.' },
      timeout: { type: 'integer', description: 'Seconds before the command is killed (default 60, max 280).' }
    },
    required: ['command']
  }
};

const BROWSER_TOOL = {
  name: 'trux_browser',
  description: 'Drive a real Chromium browser in your sandbox (1280x800, keeps cookies for this chat). Runs the actions in order and returns the page URL, title, visible text, links and a screenshot you can see. Use it for sites that need JavaScript, clicking, forms, logins the user gives you, or to look at a page visually.',
  parameters: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'Steps, e.g. [{"type":"goto","url":"https://…"},{"type":"click","text":"Sign in"},{"type":"fill","selector":"#q","value":"cats"},{"type":"press","key":"Enter"}].',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['goto', 'click', 'fill', 'type', 'press', 'scroll', 'wait', 'back', 'evaluate'] },
            url: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string', description: 'Visible text to click.' },
            role: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, key: { type: 'string' },
            x: { type: 'number' }, y: { type: 'number', description: 'Click y, or scroll amount for scroll.' }, ms: { type: 'integer' },
            script: { type: 'string', description: 'JavaScript expression for evaluate.' }
          },
          required: ['type']
        }
      },
      fullPage: { type: 'boolean', description: 'Capture the whole page instead of the viewport.' },
      showUser: { type: 'boolean', description: 'Also show the final screenshot to the user.' }
    },
    required: ['actions']
  }
};

const SCREENSHOT_TOOL = {
  name: 'trux_screenshot',
  description: 'Open a URL in the sandbox browser and show the user a screenshot of it (you see it too).',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string' }, fullPage: { type: 'boolean' } },
    required: ['url']
  }
};

const SHARE_FILE_TOOL = {
  name: 'trux_share_file',
  description: 'Send a file from your sandbox working directory to the user (images and videos are shown inline; other files become a download). Use it when you produced a file the user should get.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the working directory.' } },
    required: ['path']
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
  trux_generate_image: () => 'Creating image with Nano Banana Pro',
  trux_generate_video: () => 'Producing video',
  trux_bash: args => 'Running ' + String(args?.command || 'command').split('\n')[0].slice(0, 48),
  trux_browser: args => {
    const go = (args?.actions || []).find(a => a?.type === 'goto');
    try { return 'Browsing ' + new URL(/^https?:/.test(go?.url) ? go.url : 'https://' + go.url).hostname; } catch { return 'Using the browser'; }
  },
  trux_screenshot: args => 'Screenshot of ' + (() => { try { return new URL(/^https?:/.test(args?.url) ? args.url : 'https://' + args.url).hostname; } catch { return 'page'; } })(),
  trux_share_file: args => 'Sharing ' + String(args?.path || 'file').split('/').pop().slice(0, 40),
  trux_composio_discover_tools: () => 'Finding app actions',
  trux_device_action: args => deviceLabel(args)
};

export class Toolbox {
  constructor({ env, user, chatId, memories, personalization, connectedSlugs, attachments, previousImage, origin, writer, send, canVideo, device }) {
    Object.assign(this, { env, user, chatId, memories, personalization, connectedSlugs, attachments, previousImage, origin, writer, send, canVideo, device });
    this.composioMeta = new Map();
    this.dynamic = [];
    this.sandboxCalls = 0;
  }

  gs(objectKey) { return `gs://${this.env.TRUX_BUCKET_NAME}/${objectKey}`; }

  get capabilities() {
    return {
      hasComposio: this.connectedSlugs.length > 0,
      canImage: true,
      canVideo: this.canVideo,
      sandbox: true,
      memoryEnabled: this.personalization.memoryEnabled,
      device: this.device
    };
  }

  geminiTools() {
    const declarations = [...TRUX_WEB_TOOL_DECLARATIONS, IMAGE_TOOL, BASH_TOOL, BROWSER_TOOL, SCREENSHOT_TOOL, SHARE_FILE_TOOL];
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
        const result = await saveMemory(this.user.uid, args, this.memories, this.chatId);
        if (result.ok && !result.duplicate) this.send({ type: 'memory', action: 'saved', id: result.id, text: result.text });
        return { response: result };
      }
      case 'trux_memory_forget': {
        const result = await forgetMemory(this.user.uid, args, this.memories);
        this.memories = this.memories.filter(m => m.id !== result.id);
        if (result.ok) this.send({ type: 'memory', action: 'forgot', id: result.id });
        return { response: result };
      }
      case 'trux_generate_image': return { response: await this.image(args, signal) };
      case 'trux_generate_video': return { response: await this.video(args, signal) };
      case 'trux_composio_discover_tools': return { response: await this.discover(args, signal) };
      case 'trux_bash': return this.bash(args, signal);
      case 'trux_browser': return this.browser(args, signal);
      case 'trux_screenshot': return this.browser({ actions: [{ type: 'goto', url: args.url }], fullPage: args.fullPage, showUser: true }, signal);
      case 'trux_share_file': return this.shareFile(args, signal);
      case 'trux_device_action': {
        // Runs on the user's device: the client receives it over the stream.
        const prepared = prepareDeviceAction(args, this.device);
        if (!prepared.ok) return { response: prepared };
        this.send({ type: 'device_action', action: prepared.action });
        return { response: { ok: true, status: 'sent_to_device', note: prepared.note } };
      }
      default:
        if (this.composioMeta.has(call.name)) return this.composio(call, signal);
        return { response: { ok: false, error: 'Unknown tool: ' + call.name } };
    }
  }

  addMedia(media) {
    this.writer.update({ media: [...this.writer.state.media, media] });
    this.send({ type: 'media', media });
  }

  async image(args, signal) {
    const quota = await checkQuota(this.user, 'images');
    if (!quota.ok) return { ok: false, error: `Monthly image limit reached (${quota.limit}). Tell the user it resets next month.` };
    let referenceImages = [];
    if (args.reference === 'attached') {
      referenceImages = this.attachments.filter(a => a.mimeType.startsWith('image/')).map(a => ({ uri: this.gs(a.objectKey), mimeType: a.mimeType }));
      if (!referenceImages.length) return { ok: false, error: 'No image is attached to this message.' };
    } else if (args.reference === 'previous') {
      if (!this.previousImage) return { ok: false, error: 'There is no earlier generated image in this chat.' };
      referenceImages = [{ uri: this.gs(this.previousImage.objectKey), mimeType: this.previousImage.mimeType }];
    }
    const image = await generateImage({ prompt: args.prompt, aspectRatio: args.aspectRatio, size: args.size, referenceImages, signal });
    const extension = image.mimeType.includes('jpeg') ? 'jpg' : image.mimeType.split('/')[1] || 'png';
    const objectKey = userMediaKey(this.user.uid, extension);
    await saveBuffer(objectKey, Buffer.from(image.data, 'base64'), image.mimeType, { prompt: String(args.prompt).slice(0, 500) });
    addUsage(this.user.uid, 'images').catch(() => {});
    const media = { kind: 'image', objectKey, mimeType: image.mimeType, prompt: String(args.prompt).slice(0, 500) };
    this.previousImage = media;
    this.addMedia(media);
    return { ok: true, note: 'Image generated and already displayed to the user.' };
  }

  async video(args, signal) {
    if (!this.canVideo) return { ok: false, error: 'Video generation is available on the Pro plan.' };
    const bucket = this.env.TRUX_BUCKET_NAME;
    const prefix = userVideoPrefix(this.user.uid);
    const image = args.reference === 'image' ? this.attachments.find(a => a.mimeType.startsWith('image/')) : null;
    const source = args.reference === 'edit_video' ? this.attachments.find(a => a.mimeType.startsWith('video/')) : null;
    if (args.reference === 'image' && !image) return { ok: false, error: 'No image is attached to animate.' };
    if (args.reference === 'edit_video' && !source) return { ok: false, error: 'No video is attached to edit.' };
    const result = await produceVideo({
      brief: args.brief || args.prompt,
      length: cleanLength(args.length),
      aspectRatio: args.aspectRatio,
      image: image && { uri: this.gs(image.objectKey), mimeType: image.mimeType },
      video: source && { uri: this.gs(source.objectKey), mimeType: source.mimeType },
      outputPrefix: `gs://${bucket}/${prefix}`,
      signal,
      onEvent: event => {
        if (event.stage === 'plan') {
          this.writer.update({ storyboard: event.plan });
          this.send({ type: 'storyboard', plan: event.plan });
        } else {
          this.send({ type: 'status', status: event.label, stage: event.stage, shot: event.shot });
        }
      }
    });
    const objectKey = result.uri.replace(`gs://${bucket}/`, '');
    if (!objectKey.startsWith(`users/${this.user.uid}/videos/`)) return { ok: false, error: 'Video was written to an unexpected location.' };
    addUsage(this.user.uid, 'videos').catch(() => {});
    this.addMedia({ kind: 'video', objectKey, mimeType: result.mimeType, prompt: String(args.brief || '').slice(0, 500), title: result.plan.title });
    return { ok: true, title: result.plan.title, shots: result.plan.shots.map(s => s.caption), note: ('Video produced and already displayed to the user. ' + result.note).trim() };
  }

  /* ---------- sandbox ---------- */
  sandboxGuard() {
    if (++this.sandboxCalls > 40) return 'Sandbox step limit for this answer reached; summarise what you have.';
    if (!rateLimit(this.user.uid + ':sandbox', { capacity: 60, refillPerSecond: 0.2 })) return 'Too many sandbox runs right now; wait a minute.';
    return '';
  }

  get sid() { return sandboxSession(this.user.uid, this.chatId); }

  async bash(args, signal) {
    const blocked = this.sandboxGuard();
    if (blocked) return { response: { ok: false, error: blocked } };
    const timeout = Math.min(Math.max(Number(args.timeout) || 60, 1), 280);
    const result = await callSandbox('/exec', { sid: this.sid, command: String(args.command || ''), timeout }, { signal, timeoutMs: (timeout + 30) * 1000 });
    return { response: { ok: result.exitCode === 0, ...result } };
  }

  async browser(args, signal) {
    const blocked = this.sandboxGuard();
    if (blocked) return { response: { ok: false, error: blocked } };
    const result = await callSandbox('/browser', { sid: this.sid, actions: args.actions || [], fullPage: !!args.fullPage }, { signal, timeoutMs: 180_000 });
    const { screenshot, ...rest } = result;
    if (args.showUser && screenshot?.data) {
      const objectKey = userMediaKey(this.user.uid, 'jpg');
      await saveBuffer(objectKey, Buffer.from(screenshot.data, 'base64'), screenshot.mimeType, { prompt: 'Screenshot of ' + String(result.url).slice(0, 300) });
      this.addMedia({ kind: 'image', objectKey, mimeType: screenshot.mimeType, prompt: 'Screenshot · ' + String(result.title || result.url).slice(0, 200) });
      rest.note = 'The screenshot is already displayed to the user.';
    }
    return {
      response: { ok: true, ...rest },
      parts: screenshot?.data ? [{ inlineData: { mimeType: screenshot.mimeType, data: screenshot.data } }] : []
    };
  }

  async shareFile(args, signal) {
    const blocked = this.sandboxGuard();
    if (blocked) return { response: { ok: false, error: blocked } };
    const file = await callSandbox('/file', { sid: this.sid, path: String(args.path || '') }, { signal, timeoutMs: 120_000 });
    const extension = (file.name.split('.').pop() || 'bin').slice(0, 8);
    const objectKey = userMediaKey(this.user.uid, extension);
    await saveBuffer(objectKey, Buffer.from(file.data, 'base64'), file.mimeType, { prompt: file.name });
    const kind = file.mimeType.startsWith('image/') ? 'image' : file.mimeType.startsWith('video/') ? 'video' : 'file';
    this.addMedia({ kind, objectKey, mimeType: file.mimeType, name: file.name, size: file.size, prompt: file.name });
    return { response: { ok: true, note: `${file.name} is now shown to the user.` } };
  }

  async discover(args, signal) {
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, error: 'Describe the action you want to find.' };
    const found = await getComposioGeminiTools(this.env, this.connectedSlugs, query, signal);
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

  async composio(call, signal) {
    const meta = this.composioMeta.get(call.name);
    const plugin = PLUGIN_CATALOG.find(p => p.slugs.includes(meta.toolkitSlug));
    const callbackUrl = this.origin + '/?trux_plugins=1&plugin=' + encodeURIComponent(plugin?.id || '') + '&composio_callback=1';
    const result = await executeComposioTool(this.env, this.user.uid, call.name, call.args || {}, meta, callbackUrl, signal);
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
