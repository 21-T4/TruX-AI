/* Feedback form → email to the owner via Resend. */
import { FEEDBACK_FROM, OWNER_EMAIL } from '../lib/config.js';
import { requireUser } from '../lib/firebase.js';
import { HttpError, json, readJson } from '../lib/http.js';

const LABELS = {
  'bug-report': 'Bug report',
  'product-feedback': 'Product feedback',
  'feature-request': 'Feature request',
  'general-feedback': 'General feedback',
  'founder-query': 'Founder query'
};
const line = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

async function submit(request, { env }) {
  const user = await requireUser(request, { limit: { name: 'feedback', capacity: 5, refillPerSecond: 1 / 120 } });
  const body = await readJson(request, 18000);
  const type = Object.hasOwn(LABELS, body?.type) ? body.type : 'general-feedback';
  const label = LABELS[type];
  const subject = line(body?.subject, 160) || label;
  const message = String(body?.message ?? '').trim();
  if (message.length < 8) throw new HttpError(400, 'Please include a little more detail.');
  if (message.length > 12000) throw new HttpError(413, 'Your message is too long.');
  if (!env.RESEND_API_KEY) throw new HttpError(503, 'Email delivery is not configured on the server yet.');

  const text = [
    'New TruX-Omni ' + label, '',
    'Subject: ' + subject,
    'Submitted at: ' + new Date().toISOString(),
    'Account name: ' + (line(user.name, 120) || 'Not provided'),
    'Account email: ' + (user.email || 'Not provided'),
    'User ID: ' + user.uid,
    'Browser: ' + line(request.headers.get('user-agent'), 300), '',
    'Message:', message
  ].join('\n');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FEEDBACK_FROM,
      to: [OWNER_EMAIL],
      subject: '[TruX-Omni ' + label + '] ' + subject,
      text,
      ...(user.email ? { reply_to: user.email } : {})
    })
  });
  if (!response.ok) {
    console.warn('[feedback] provider rejected', response.status);
    throw new HttpError(502, 'The email service could not deliver this message right now.');
  }
  return json({ ok: true, message: type === 'founder-query' ? 'Your query was emailed to the founder.' : 'Your feedback was emailed to the founder.' });
}

export const routes = { 'POST /api/feedback': submit };
