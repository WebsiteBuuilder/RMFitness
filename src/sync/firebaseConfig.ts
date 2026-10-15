/**
 * Firebase web config. Paste the object from the Firebase console
 * (Project settings → Your apps → SDK setup) to turn on shared duelist accounts
 * (src/accounts). The values are public by design; access is controlled by the
 * rules in database.rules.json. Leave null to keep every profile on its phone.
 */
export const firebaseConfig: {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
} | null = {
  apiKey: 'AIzaSyDeih3PoOXPUr9SFcMM8htTDrhBeZ3etC8',
  authDomain: 'speed-duel-ac46b.firebaseapp.com',
  databaseURL: 'https://speed-duel-ac46b-default-rtdb.firebaseio.com',
  projectId: 'speed-duel-ac46b',
  storageBucket: 'speed-duel-ac46b.firebasestorage.app',
  messagingSenderId: '328753948581',
  appId: '1:328753948581:web:4c6fcdf73dd85396e12a4c',
};

/** Also send duel rooms through Firebase instead of phone-to-phone (off: rooms stay as they are). */
export const firebaseRooms = false;
