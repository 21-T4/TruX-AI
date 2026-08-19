export async function onRequestGet() {
  const firebaseConfig = {
    apiKey: "AIzaSyAs_GDrzlBaucHfiff0Y6cA8GVHjFTA62Q",
    authDomain: "trux-ai.firebaseapp.com",
    projectId: "trux-ai",
    storageBucket: "trux-ai.firebasestorage.app",
    messagingSenderId: "59313097411",
    appId: "1:59313097411:web:32e4158bfb733fa7cfb076",
    measurementId: "G-C32LC29QHC"
  };

  return Response.json(firebaseConfig);
}