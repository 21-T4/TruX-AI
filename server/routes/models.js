/* Owner-only list of Gemini models available in the project. */
import { requireUser } from '../lib/firebase.js';
import { HttpError, json } from '../lib/http.js';
import { listAvailableGeminiModels } from '../lib/model-catalog.js';

export const routes = {
  'GET /api/models': async request => {
    const user = await requireUser(request);
    if (!user.owner) throw new HttpError(403, 'Only the owner can list models.');
    return json(await listAvailableGeminiModels());
  }
};
