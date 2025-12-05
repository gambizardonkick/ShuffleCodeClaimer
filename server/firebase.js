const admin = require('firebase-admin');

let firebaseApp;
let database;

function initializeFirebase() {
  if (firebaseApp) {
    return { app: firebaseApp, db: database };
  }

  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY 
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : null;

    if (!privateKey || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_DATABASE_URL) {
      throw new Error('Missing Firebase credentials. Please ensure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and FIREBASE_DATABASE_URL are set in environment variables.');
    }

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });

    database = admin.database();
    console.log('✅ Firebase initialized successfully');

    return { app: firebaseApp, db: database };
  } catch (error) {
    console.error('❌ Firebase initialization failed:', error.message);
    throw error;
  }
}

function getDatabase() {
  if (!database) {
    const init = initializeFirebase();
    return init.db;
  }
  return database;
}

module.exports = {
  initializeFirebase,
  getDatabase,
  admin,
};
