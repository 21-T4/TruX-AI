/* Checks that the Realtime Database security rules deployed in the project are the ones in database.rules.json.
   Chats, memories and personalization all sit behind those rules: when they were never deployed (or are older), every
   signed-in user is refused with PERMISSION_DENIED and chats cannot be read or saved.
   Set TRUX_SYNC_DB_RULES=1 to let the server publish database.rules.json itself when they differ (needs the
   Firebase Realtime Database Admin role, which the setup workflow grants). Otherwise it only reports. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './firebase.js';

const RULES_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'database.rules.json');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export async function checkDatabaseRules() {
  const local = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const db = await getDb();
  let deployed;
  try { deployed = await db.getRulesJSON(); }
  catch (error) { return { state: 'unknown', detail: error?.message || String(error) }; }
  if (JSON.stringify(canonical(deployed?.rules)) === JSON.stringify(canonical(local.rules))) return { state: 'current' };
  if (String(process.env.TRUX_SYNC_DB_RULES || '') === '1') {
    await db.setRules(local);
    return { state: 'updated' };
  }
  return { state: 'outdated' };
}

export async function reportDatabaseRules() {
  try {
    const result = await checkDatabaseRules();
    if (result.state === 'current') console.log('[startup] Database rules match database.rules.json.');
    else if (result.state === 'updated') console.log('[startup] Database rules differed and were updated from database.rules.json.');
    else if (result.state === 'outdated') {
      console.error('[startup] The deployed Database rules are NOT the ones in database.rules.json, so signed-in users get PERMISSION_DENIED and chat history is locked. ' +
        'Run the "Google Cloud setup" workflow, paste database.rules.json into Firebase console > Realtime Database > Rules, or set TRUX_SYNC_DB_RULES=1.');
    } else console.warn('[startup] Could not read the deployed Database rules:', result.detail);
  } catch (error) {
    console.warn('[startup] Database rules check failed:', error?.message || error);
  }
}
