export async function onRequestGet({ env }) {
  return Response.json({
    configured: !!env.FCM_VAPID_PUBLIC_KEY,
    vapidKey: env.FCM_VAPID_PUBLIC_KEY || null
  });
}
