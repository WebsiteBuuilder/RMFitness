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
} | null = null;

/** Also send duel rooms through Firebase instead of phone-to-phone (off: rooms stay as they are). */
export const firebaseRooms = false;
