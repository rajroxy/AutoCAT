// Where the UI looks for the catalog server.
//
//   Electron desktop  → the window loads http://127.0.0.1:<port>/app/, so the
//                       embedded server *is* the same origin (nothing to do).
//                       A ?api=… query still overrides it if ever needed.
//   Browser / preview → served by serve.mjs on the same origin (nothing to do)
//   Android TV (APK)  → the app is a thin client: there is no Node server on the
//                       device, so set AUTOCAT_HOST to the deployed host before
//                       building, e.g. "https://your-addon-host.example.com".
//
// `npm run android:sync` copies this file into the APK, so set it first, then sync.
window.AUTOCAT_HOST = "";

const params = new URLSearchParams(location.search);
const fromQuery = params.get("api");
// Capacitor serves the app from https://localhost, so a non-empty host is the
// only way the packaged app can reach data — an empty one shows a clear message.
const packaged = typeof window.Capacitor !== "undefined";
window.AUTOCAT_API = fromQuery || window.AUTOCAT_HOST || (packaged ? "" : "");
