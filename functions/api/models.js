import { requireFirebaseUser } from "../firebase-auth.js";
import { listAvailableGeminiModels } from "../vertex-model-catalog.js";

const OWNER_EMAIL = "ekagraavn2003@gmail.com";

export async function onRequestGet({ request, env } = {}) {
  const headers = { "Cache-Control": "no-store" };
  let user;
  try {
    user = await requireFirebaseUser(request, env);
  } catch {
    return Response.json({ error: "Authentication required." }, { status: 401, headers });
  }

  if (String(user?.email || "").trim().toLowerCase() !== OWNER_EMAIL) {
    return Response.json({ error: "Owner access required." }, { status: 403, headers });
  }

  try {
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const models = await listAvailableGeminiModels({ refresh });
    return Response.json({ models }, { headers });
  } catch (error) {
    return Response.json(
      { error: String(error?.message || "Could not load the Google Cloud Gemini model catalog.") },
      { status: 503, headers }
    );
  }
}
