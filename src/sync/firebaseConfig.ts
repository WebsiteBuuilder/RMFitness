/**
 * Firebase web config. Paste the object from the Firebase console
 * (Project settings → Your apps → SDK setup) to turn on the Firebase transport.
 * The values are public by design; access is controlled by database rules.
 * Leave null to use the direct phone-to-phone transport only.
 */
export const firebaseConfig: {
  apiKey: string;
  authDomain: string;
  databaseURL: string;
  projectId: string;
  appId: string;
} | null = null;
