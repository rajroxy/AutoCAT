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
// **Capacitor serves the interface from its own scheme and host.** `https://localhost` is that
// address, and it is a signal that does not depend on Capacitor's runtime having been injected
// into this page *yet* — which is what a first paint on a television caught it without. The app
// then believed it was a web page with nothing behind it, and asked for a server address it was
// already carrying ("first a server url box at start"). Both signals are read here, and `app.js`
// tries the in-app server whenever nothing else answers, so the address is never asked for when
// the app can answer itself.
const packaged =
  typeof window.Capacitor !== "undefined" ||
  (location.protocol === "https:" && location.hostname === "localhost");
// `?api=…` (a quick test), then the host a build was pointed at, then — in the app — **the server
// inside it**, and only then an address saved on the device. A saved address is what the app asks
// for when nothing answered, so it must not outrank the server that is right here: that ordering
// is what kept a television pointed at an address typed once, for ever.
window.AUTOCAT_API = fromQuery || window.AUTOCAT_HOST || (packaged ? IN_APP_SERVER : savedHost);
// Where the app's own server is, for `app.js` to fall back to.
window.AUTOCAT_IN_APP = IN_APP_SERVER;
