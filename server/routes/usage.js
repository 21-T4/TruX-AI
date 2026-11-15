/* GET /api/usage: plan, model catalog and today's usage for the signed-in user. */
import { requireUser } from '../lib/firebase.js';
import { json } from '../lib/http.js';
import { DEFAULT_MODEL, publicCatalog } from '../lib/models.js';
import { usageSummary } from '../lib/usage.js';

export const routes = {
  'GET /api/usage': async request => {
    const user = await requireUser(request, { limit: { name: 'usage', capacity: 30, refillPerSecond: 1 } });
    const summary = await usageSummary(user);
    return json({
      tier: user.tier,
      owner: user.owner,
      defaultModel: DEFAULT_MODEL,
      catalog: publicCatalog(user),
      ...summary
    }, 200, { 'Cache-Control': 'no-store' });
  }
};
