import { requireFirebaseUser } from "../firebase-auth.js";

const FEEDBACK_RECIPIENT = "ekagraavn2003@gmail.com";
const MAX_MESSAGE_LENGTH = 12000;
const NO_STORE = { "Cache-Control": "no-store, private, max-age=0" };
const FEEDBACK_LABELS = {
  "bug-report": "Bug report",
  "product-feedback": "Product feedback",
  "feature-request": "Feature request",
  "general-feedback": "General feedback",
  "founder-query": "Founder query"
};

function cleanSingleLine(value, maxLength) {
  return String(value ?? "").replace(/[\\r\\n\\t]+/g, " ").trim().slice(0, maxLength);
}

export async function onRequestPost({ request, env = {} }) {
  let user;
  try {
    user = await requireFirebaseUser(request, env);
  } catch (error) {
    const status = Number(error?.status) || 401;
    return Response.json(
      { error: status === 401 ? "Please sign in again before sending feedback." : "Could not verify your account." },
      { status, headers: NO_STORE }
    );
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 18000) {
    return Response.json({ error: "Your submission is too large. Please shorten it." }, { status: 413, headers: NO_STORE });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "The feedback form data was invalid." }, { status: 400, headers: NO_STORE });
  }

  const type = String(body?.type || "general-feedback");
  const label = FEEDBACK_LABELS[type];
  if (!label) {
    return Response.json({ error: "Choose a valid feedback type." }, { status: 400, headers: NO_STORE });
  }

  const subject = cleanSingleLine(body?.subject, 160) || label;
  const message = String(body?.message ?? "").trim();
  if (message.length < 8) {
    return Response.json({ error: "Please include a little more detail." }, { status: 400, headers: NO_STORE });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: "Your message is too long. Please shorten it." }, { status: 413, headers: NO_STORE });
  }

  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from = String(env.TRUX_FEEDBACK_FROM_EMAIL || "").trim();
  if (!apiKey || !from) {
    return Response.json(
      { error: "Email delivery is not configured on the server yet. Please try again later." },
      { status: 503, headers: NO_STORE }
    );
  }

  const submittedAt = new Date().toISOString();
  const accountEmail = String(user.email || "Not provided");
  const displayName = cleanSingleLine(user.name || user.displayName || "", 120) || "Not provided";
  const userAgent = cleanSingleLine(request.headers.get("user-agent") || "Not provided", 300);
  const text = [
    "New TruX-Omni " + label,
    "",
    "Subject: " + subject,
    "Submitted at: " + submittedAt,
    "Account name: " + displayName,
    "Account email: " + accountEmail,
    "Firebase user ID: " + String(user.uid || "Not provided"),
    "Submission type: " + type,
    "Browser/device: " + userAgent,
    "",
    "Message:",
    message
  ].join("\n");

  const email = {
    from,
    to: [FEEDBACK_RECIPIENT],
    subject: "[TruX-Omni " + label + "] " + subject,
    text,
    ...(accountEmail !== "Not provided" && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(accountEmail) ? { reply_to: accountEmail } : {})
  };

  try {
    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(email),
      signal: request.signal
    });
    const providerResult = await emailResponse.json().catch(() => ({}));
    if (!emailResponse.ok) {
      console.warn("[Feedback] Email provider rejected a submission:", emailResponse.status, providerResult?.message || providerResult?.name || "provider error");
      return Response.json(
        { error: "The email service could not deliver this message right now. Please try again later." },
        { status: 502, headers: NO_STORE }
      );
    }
  } catch (error) {
    if (request.signal?.aborted) return new Response(null, { status: 499, headers: NO_STORE });
    console.error("[Feedback] Email delivery request failed:", String(error?.message || "network error"));
    return Response.json(
      { error: "The email service is temporarily unavailable. Please try again later." },
      { status: 502, headers: NO_STORE }
    );
  }

  const successMessage = type === "founder-query"
    ? "Your query was emailed to the founder."
    : "Your feedback was emailed to the founder.";
  return Response.json({ ok: true, message: successMessage }, { status: 200, headers: NO_STORE });
}
