/* Vertex AI Gemini publisher-model catalog (owner model picker). */
import { getAccessToken as getCloudRunAccessTokenShared } from './config.js';
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedModels = null;
let cacheExpiresAt = 0;
let inFlightList = null;

const getCloudRunAccessToken = getCloudRunAccessTokenShared;

/**
 * Lists Google's Gemini publisher models through the official Vertex AI
 * Model Garden API. The five-minute cache avoids a catalog request per turn.
 */
async function listAvailableGeminiModels({ refresh = false } = {}) {
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
      const baseUrl = "https://aiplatform.googleapis.com/v1beta1/publishers/google/models";
      const url = new URL(baseUrl);
      // Keep each page at a conservative size and request full metadata first.
      url.searchParams.set("pageSize", "100");
      url.searchParams.set("view", "PUBLISHER_MODEL_VIEW_FULL");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const requestOptions = {
        method: "GET",
        headers: { Authorization: "Bearer " + accessToken }
      };
      let response = await fetch(url, requestOptions);

      // Retry HTTP 400 with the documented default BASIC view and default page size.
      // This avoids making model selection depend on optional catalog query parameters.
      if (response.status === 400) {
        const fallbackUrl = new URL(baseUrl);
        if (pageToken) fallbackUrl.searchParams.set("pageToken", pageToken);
        response = await fetch(fallbackUrl, requestOptions);
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let detail = errorBody;
        try {
          const parsed = JSON.parse(errorBody);
          detail = parsed?.error?.message || parsed?.message || errorBody;
        } catch {}
        detail = String(detail || "").trim().slice(0, 500);
        throw new Error(
          "Google Cloud Vertex AI model catalog returned HTTP " +
          response.status +
          (detail ? ": " + detail : ".")
        );
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

export { listAvailableGeminiModels };
