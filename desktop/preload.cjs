// Preload bridge — deliberately tiny. The UI talks to the local server over
// HTTP, so it needs almost no privileged APIs; this flags that we're in the
// desktop shell (the same UI runs in a browser/Capacitor where it is undefined)
// and lends the page the **one** thing a page cannot reliably read for itself:
// the operating system's clipboard.
//
// Why it has to come through here: a pasted address is the usual way an add-on,
// a Nuvio repository or a CloudStream repository is added, the page's own
// `navigator.clipboard.readText()` is a permission the browser has to grant (and
// Electron denies it unless the app says otherwise), and the fallback
// `document.execCommand("paste")` is refused outright in a modern renderer. The
// main process owns the real clipboard, so the question is asked there — see
// `ipcMain.handle("autocat:clipboard")` in main.js.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("autocat", {
  desktop: true,
  clipboard: () => ipcRenderer.invoke("autocat:clipboard"),
});
