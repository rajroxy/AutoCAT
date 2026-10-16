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
// **The address an installed APK was pointed at, remembered on the device.** A build with no
// host baked in (or one where the server has moved) is not a dead end: the app's own screen
// asks for the address and files it under this key, so no rebuild is needed to use the TV.
const savedHost = (() => {
  try {
    return localStorage.getItem("autocat.api") || "";
  } catch {
    return "";
  }
})();
// **The packaged app carries the server with it.** The APK starts the same catalog server
// the desktop app does, on the device, on this port (`scripts/android-node-folder.mjs`
// builds that project into `ui/nodejs/`, which `cap sync` copies into the APK), so the app
// asks itself and nothing has to be running anywhere else. It is pinned: a port chosen at
// run time would need a channel to be told through.
const IN_APP_SERVER = "http://127.0.0.1:4173";
// Capacitor serves the interface from https://localhost.
const packaged = typeof window.Capacitor !== "undefined";
// `?api=…` (a quick test), then an address saved on the device (the app's own screen asks
// for one when the in-app server cannot be reached), then the host a build was pointed at,
// then — in the APK — the server inside the app itself.
window.AUTOCAT_API = fromQuery || savedHost || window.AUTOCAT_HOST || (packaged ? IN_APP_SERVER : "");
