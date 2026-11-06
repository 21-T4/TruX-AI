/* Device actions (call, text, email, open a link, navigate, play media).
   The model asks for an action with trux_device_action; the server only
   validates it and forwards it to the client, which opens the matching
   tel:/sms:/mailto:/maps/https link. This works the same in a browser,
   the installed PWA and the Play Store (Trusted Web Activity) build. */

const ACTIONS = ['call', 'message', 'email', 'open_url', 'navigate', 'search_maps', 'play_media'];
const PLATFORMS = ['android', 'ios', 'desktop'];

export const DEVICE_TOOL = {
  name: 'trux_device_action',
  description: 'Do something on the user\'s phone or computer: start a call, a text or an email, open a link, start navigation, search maps, or play a song/video. Only call it when the user asks for the action. The device opens the right app and the user confirms there.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      target: { type: 'string', description: 'Phone number (call/message), email address, URL (open_url), destination or place query (navigate/search_maps), or app for play_media (youtube, spotify, youtube music).' },
      text: { type: 'string', description: 'Message or email body, or the song/video/query for play_media.' },
      subject: { type: 'string', description: 'Email subject.' }
    },
    required: ['action']
  }
};

export function normalizeDevice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const platform = PLATFORMS.includes(raw.platform) ? raw.platform : 'desktop';
  return { platform, installed: raw.installed === true };
}

export function deviceManifest(device) {
  return '- trux_device_action: act on the user\'s ' + (device.platform === 'desktop' ? 'computer' : 'phone') +
    ' when they ask — call or text a number, write an email, open a link, navigate somewhere, search maps, or play something on YouTube/Spotify. ' +
    'The action opens the dialer, messages, mail, maps or media app and the user confirms there. You cannot read contacts, so ask for a number when the user names a person you have no number for. Never start a call or message the user did not ask for.';
}

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

export function prepareDeviceAction(args, device) {
  if (!device) return { ok: false, error: 'No device is connected to this chat.' };
  const action = ACTIONS.includes(args?.action) ? args.action : '';
  if (!action) return { ok: false, error: 'Unknown device action.' };
  const out = { action, target: clean(args.target, 300), text: clean(args.text, 2000), subject: clean(args.subject, 200) };
  if (['call', 'message', 'email', 'open_url', 'navigate', 'search_maps'].includes(action) && !out.target) {
    return { ok: false, error: 'A target is required for ' + action + '.' };
  }
  if ((action === 'call' || action === 'message') && !/^[+\d][\d\s().-]{2,}$/.test(out.target)) {
    return { ok: false, error: 'A phone number is required; ask the user for it.' };
  }
  if (action === 'open_url' && !/^https?:\/\//i.test(out.target)) out.target = 'https://' + out.target.replace(/^\/+/, '');
  return { ok: true, action: out, note: 'Opened on the device; the user confirms there.' };
}

export function deviceLabel(args) {
  const t = clean(args?.target, 40);
  switch (args?.action) {
    case 'call': return 'Calling ' + (t || 'contact');
    case 'message': return 'Texting ' + (t || 'contact');
    case 'email': return 'Writing email';
    case 'open_url': return 'Opening link';
    case 'navigate': return 'Starting navigation';
    case 'search_maps': return 'Searching maps';
    case 'play_media': return 'Playing ' + (clean(args?.text, 30) || 'media');
    default: return 'Using your device';
  }
}
