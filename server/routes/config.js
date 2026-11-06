/* Public Firebase web config, discovered from the project at runtime. */
import { getFirebaseWebConfig } from '../lib/config.js';
import { json } from '../lib/http.js';

export const routes = {
  'GET /api/config': async () => {
    const config = await getFirebaseWebConfig();
    return json({ firebase: config }, 200, { 'Cache-Control': 'public, max-age=3600' });
  }
};
