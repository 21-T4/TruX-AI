const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedModels = null;
let cacheExpiresAt = 0;
let inFlightList = null;

async function getCloudRunAccessToken() {
  const response = await fetch(METADATA_BASE + "/instance/service-accounts/default/token", {
    headers: { "Metadata-Flavor": "Google" }
  });
  if (!response.ok) {
    throw new Error("Could not obtain the Cloud Run runtime identity token (HTTP " + response.status + ").");
  }
  const tokenData = await response.json();
  if (!tokenData || typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("The Cloud Run runtime identity did not return an access token.");
  }
  return tokenData.access_token;
}

/**
 * Lists Google's Gemini publisher models through the official Vertex AI
 * Model Garden API. The five-minute cache avoids a catalog request per turn.
 */
export async function listAvailableGeminiModels({ refresh = false } = {}) {
  if (!refresh && Array.isArray(cachedModels) && Date.now() < cacheExpiresAt) {
    return cachedModels;
  }
  if (!refresh && inFlightList) return inFlightList;

  const promise = (async () => {
    const accessToken = await getCloudRunAccessToken();
    const modelsById = new Map();
    let pageToken = "";
    let pagesRead = 0;

    do {
      const url = new URL("https://aiplatform.googleapis.com/v1beta1/publishers/google/models");
      url.searchParams.set("pageSize", "1000");
      url.searchParams.set("view", "PUBLISHER_MODEL_VIEW_FULL");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + accessToken }
      });
      if (!response.ok) {
        throw new Error("Google Cloud Vertex AI model catalog returned HTTP " + response.status + ".");
      }

      const payload = await response.json();
      const publisherModels = Array.isArray(payload?.publisherModels) ? payload.publisherModels : [];
      for (const item of publisherModels) {
        const resourceName = String(item?.name || "");
        const modelId = resourceName.split("/").pop() || "";
        if (!/^gemini-[a-z0-9][a-z0-9._-]*$/i.test(modelId)) continue;

        const stage = String(item?.launchStage || "").toUpperCase();
        const versionState = String(item?.versionState || "").toUpperCase();
        if (["DEPRECATED", "DISABLED", "UNAVAILABLE", "ARCHIVED"].includes(stage)) continue;
        if (["DEPRECATED", "DISABLED", "UNAVAILABLE", "ARCHIVED"].includes(versionState)) continue;

        const supportedActions = Array.isArray(item?.supportedActions)
          ? item.supportedActions.map(value => String(value))
          : [];
        if (supportedActions.length &&
            !supportedActions.some(action => /^(generateContent|streamGenerateContent)$/i.test(action))) {
          continue;
        }

        modelsById.set(modelId, {
          id: modelId,
          displayName: String(item?.displayName || modelId),
          launchStage: stage || "UNKNOWN"
        });
      }

      pageToken = String(payload?.nextPageToken || "");
      pagesRead++;
    } while (pageToken && pagesRead < 20);

    const models = Array.from(modelsById.values())
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    if (!models.length) {
      throw new Error("Google Cloud returned no Gemini models that support content generation.");
    }

    cachedModels = models;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return cachedModels;
  })();

  inFlightList = promise;
  try {
    return await promise;
  } finally {
    if (inFlightList === promise) inFlightList = null;
  }
}
