/* Phone/device actions (call, message, open an app, navigate, alarms…).
   The model asks for an action with trux_device_action; the server only
   validates it and forwards it to the client, which performs it with the
   Android app bridge or, in a browser, with tel:/sms:/maps links. */

const ACTIONS = ['call', 'message', 'email', 'open_app', 'open_url', 'navigate', 'search_maps', 'set_alarm', 'set_timer', 'open_camera', 'open_settings', 'play_media'];
const PLATFORMS = ['android-app', 'android-web', 'ios-web', 'desktop-web'];

export const DEVICE_TOOL = {
  name: 'trux_device_action',
  description: 'Do something on the user\'s phone or computer: place a call, start a text or email, open an installed app, open a link, start navigation, set an alarm or timer, open the camera or a settings page, or play media in an app. Only call it when the user asks for the action. The device performs it; for calls and messages the user may need to confirm on screen.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS },
      target: { type: 'string', description: 'Phone number or contact name (call/message), email address, app name (open_app, play_media), URL (open_url), destination or place query (navigate/search_maps), or settings page (wifi, bluetooth, display, sound, battery, apps, location, notifications, accessibility, assistant).' },
      text: { type: 'string', description: 'Message or email body, alarm/timer label, or the song/video/query for play_media.' },
      subject: { type: 'string', description: 'Email subject.' },
      time: { type: 'string', description: 'Alarm time, 24-hour HH:MM in the user\'s local time.' },
      seconds: { type: 'integer', description: 'Timer length in seconds.' }
    },
    required: ['action']
  }
};

export function normalizeDevice(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const platform = PLATFORMS.includes(raw.platform) ? raw.platform : 'desktop-web';
  return { platform, app: platform === 'android-app', version: String(raw.version || '').slice(0, 20) };
}

export function deviceManifest(device) {
  const line = '- trux_device_action: act on the user\'s device when they ask — call or text someone (by name or number), email, open an app, open a link, navigate somewhere, set an alarm or timer, open the camera or a settings page, play something in an app.';
  if (device.app) {
    return line + ' This is the TruX Android app with phone permissions: calls are placed directly, contacts are resolved by name on the phone, apps open by name, alarms and timers are set in the clock app. Confirm the exact contact or number in your reply. Never place a call or send a message the user did not ask for.';
  }
  return line + ' This is a web browser (' + device.platform + '): the action opens a link or app handler (dialer, messages, maps, mail) that the user confirms; you cannot resolve contact names here, so ask for a number when calling or texting. Opening other installed apps only works in the TruX Android app.';
}

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

export function prepareDeviceAction(args, device) {
  if (!device) return { ok: false, error: 'No device is connected to this chat.' };
  const action = ACTIONS.includes(args?.action) ? args.action : '';
  if (!action) return { ok: false, error: 'Unknown device action.' };
  const out = { action, target: clean(args.target, 300), text: clean(args.text, 2000), subject: clean(args.subject, 200) };
  if (args.time && /^\d{1,2}:\d{2}$/.test(String(args.time))) out.time = String(args.time);
  const seconds = Math.round(Number(args.seconds));
  if (Number.isFinite(seconds) && seconds > 0) out.seconds = Math.min(seconds, 24 * 3600);
  if (['call', 'message', 'email', 'open_app', 'open_url', 'navigate', 'search_maps'].includes(action) && !out.target) {
    return { ok: false, error: 'A target is required for ' + action + '.' };
  }
  if (action === 'open_url' && !/^https?:\/\//i.test(out.target)) out.target = 'https://' + out.target.replace(/^\/+/, '');
  if (action === 'set_alarm' && !out.time) return { ok: false, error: 'Alarm time (HH:MM) is required.' };
  if (action === 'set_timer' && !out.seconds) return { ok: false, error: 'Timer length in seconds is required.' };
  if (!device.app && (action === 'open_app' || action === 'set_alarm' || action === 'set_timer')) {
    return { ok: false, error: 'This action needs the TruX Android app. Tell the user it works there.' };
  }
  const note = action === 'call' || action === 'message' ? 'The device will show or place it; the user may need to confirm.' : 'Sent to the device.';
  return { ok: true, action: out, note };
}

export function deviceLabel(args) {
  const t = clean(args?.target, 40);
  switch (args?.action) {
    case 'call': return 'Calling ' + (t || 'contact');
    case 'message': return 'Texting ' + (t || 'contact');
    case 'email': return 'Writing email';
    case 'open_app': return 'Opening ' + (t || 'app');
    case 'open_url': return 'Opening link';
    case 'navigate': return 'Starting navigation';
    case 'search_maps': return 'Searching maps';
    case 'set_alarm': return 'Setting alarm';
    case 'set_timer': return 'Setting timer';
    case 'play_media': return 'Playing ' + (clean(args?.text, 30) || 'media');
    default: return 'Using your device';
  }
}
