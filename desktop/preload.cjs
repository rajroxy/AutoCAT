// Preload bridge — deliberately tiny. The UI talks to the local server over
// HTTP, so it needs no privileged APIs; this only flags that we're in the
// desktop shell (the same UI runs in a browser/Capacitor where it is undefined).
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("autocat", { desktop: true });
