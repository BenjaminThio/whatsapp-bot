import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccount = await Bun.file("serviceAccountKey.json").json();

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();

export default db;