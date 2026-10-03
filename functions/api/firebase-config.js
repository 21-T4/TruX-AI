export async function onRequestGet(context) {
  const env = context?.env || process.env || {};
  const firebaseConfig = {
    apiKey: env.FIREBASE_API_KEY || "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q",
    authDomain: env.FIREBASE_AUTH_DOMAIN || "trux-ai.firebaseapp.com",
    projectId: env.FIREBASE_PROJECT_ID || "trux-ai",
    storageBucket: env.FIREBASE_STORAGE_BUCKET || "trux-ai.firebasestorage.app",
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "59313097411",
    appId: env.FIREBASE_APP_ID || "1:59313097411:web:32e4158bfb733fa7cfb076",
    measurementId: env.FIREBASE_MEASUREMENT_ID || "G-C32LC29QHC"
  };

  return Response.json(firebaseConfig);
}