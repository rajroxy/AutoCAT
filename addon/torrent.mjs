/**
 * The torrent engine, **on the server**.
 *
 * ## Why it moved here
 *
 * A torrent has no address to hand to a `<video>`: the add-on publishes an info hash and
 * the file lives in a swarm. The page used to join the swarm itself with WebTorrent, and
 * that cannot work in general — a browser only speaks WebRTC, and the public swarms speak
 * TCP/UDP, so a magnet sat at "looking for peers…" forever and no frame ever appeared.
 * That is the whole of "torrents do not start" without a debrid account.
 *
 * Node has no such limit: it opens TCP and UDP sockets and speaks the DHT, so the swarm a
 * public magnet points at is reachable. The server joins it, picks the file, and pipes it
 * to the browser over the same HTTP pipe the stream proxy already uses — with `Range`
 * support, because a `<video>` element seeks by asking for a byte range.
 *
 * ## What it is not
 *
 * - **Nothing is written to disk.** A file is read as a stream as its pieces arrive.
 * - **Nothing is kept.** A swarm is dropped after `IDLE_MS` without a request.
 * - **A debrid account still wins.** This is the fallback, not a replacement: a cached
 *   torrent on a debrid service starts instantly, while this has to find real peers.
 *
 * The engine is optional. Without it the app falls back to the in-page WebTorrent and
 * says so, rather than failing at the first Play.
 */

/** How long a swarm is kept after the last request for it. */
const IDLE_MS = Number(process.env.AUTOCAT_TORRENT_IDLE_MS) || 15 * 60 * 1000;
/** How many swarms may be alive at once; the oldest idle one is dropped. */
const MAX_TORRENTS = Number(process.env.AUTOCAT_TORRENT_MAX) || 3;
/** How long to wait for the metadata before giving up on a magnet. */
const METADATA_MS = Number(process.env.AUTOCAT_TORRENT_METADATA_MS) || 45 * 1000;

const VIDEO_RE = /\.(mp4|m4v|webm|mkv|mov|ogv|avi|ts|m2ts)$/i;

let engine = null;      // the WebTorrent constructor
let client = null;      // the one client, created on first use
let loadState = "loading"; // loading | ready | missing
let loadError = "";
const swarms = new Map(); // infoHash → { torrent, timer, addedAt }

/** Types a `<video>` element will accept, by extension. */
const TYPES = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".mov": "video/quicktime", ".ogv": "video/ogg",
  ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t",
};
export const contentType = (name) => TYPES[String(name || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0]] || "application/octet-stream";

/**
 * Load the engine once, **in the background**.
 *
 * Called at module load so the answer is already known by the time anyone opens Settings
 * or presses Play. A failure is remembered rather than retried on every request: an app
 * without the optional dependency should say so once, not once per stream.
 */
export function warmTorrent() {
  if (engine || loadState === "missing") return Promise.resolve(engine);
  return import("webtorrent")
    .then((mod) => {
      engine = mod?.default || mod?.WebTorrent;
      if (typeof engine !== "function") throw new Error("the package did not export a constructor");
      loadState = "ready";
      return engine;
    })
    .catch((err) => {
      loadState = "missing";
      loadError = String(err?.message || err);
      return null;
    });
}
// Fire and forget at import time — nothing waits on it.
warmTorrent();

/** Can this server play a magnet itself? Answered synchronously for Settings. */
export const torrentReady = () => loadState === "ready";
/** Why not, when the answer is no. */
export const torrentState = () => ({ ready: loadState === "ready", state: loadState, text: loadState === "missing" ? loadError : "" });

function getClient() {
  if (client) return client;
  client = new engine();
  // A client-level error must not take the process down; the swarm reports its own.
  client.on("error", () => { /* reported per torrent */ });
  return client;
}

/** Drop a swarm and its timer. */
function drop(infoHash) {
  const entry = swarms.get(infoHash);
  if (!entry) return;
  clearTimeout(entry.timer);
  swarms.delete(infoHash);
  try { entry.torrent.destroy(); } catch { /* already gone */ }
}

/** Keep the newest `MAX_TORRENTS` and no more. */
function prune() {
  if (swarms.size <= MAX_TORRENTS) return;
  const oldest = [...swarms.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt);
  for (const [hash] of oldest.slice(0, Math.max(0, swarms.size - MAX_TORRENTS))) drop(hash);
}

/** Mark a swarm as just used, and re-arm its idle timer. */
function touch(infoHash) {
  const entry = swarms.get(infoHash);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => drop(infoHash), IDLE_MS);
  entry.timer.unref?.();
}

const hashOf = (magnet) => String(String(magnet || "").match(/xt=urn:btih:([a-z0-9]+)/i)?.[1] || "").toLowerCase();

/**
 * The file a stream names: its `fileIdx` when the add-on gave one, else the largest video.
 * A season pack publishes an episode as an index, so that is what is honoured first.
 */
export function pickFile(torrent, fileIdx) {
  const files = torrent?.files || [];
  if (!files.length) return null;
  // **`null` is not `0`.** `Number(null)` is zero, so an add-on that names no index at
  // all would silently get the torrent's *first* file — which in a season pack is an
  // episode nobody asked for. Only a real number is honoured.
  const named = fileIdx === null || fileIdx === undefined || fileIdx === "" ? NaN : Number(fileIdx);
  if (Number.isInteger(named) && named >= 0 && named < files.length) return files[named];
  const video = files.filter((f) => VIDEO_RE.test(f?.name || "") || /^video\//.test(f?.type || ""));
  const pool = video.length ? video : files;
  return pool.slice().sort((a, b) => (b.length || 0) - (a.length || 0))[0] || null;
}

/** Wait for a torrent's metadata, or explain why it did not arrive. */
const ready = (torrent) =>
  new Promise((resolve, reject) => {
    if (torrent.ready && torrent.files?.length) return resolve(torrent);
    const timer = setTimeout(() => {
      cleanup();
      const peers = Number(torrent.numPeers) || 0;
      reject(new Error(peers
        ? `the swarm has ${peers} peer${peers === 1 ? "" : "s"} but no metadata yet — try again shortly`
        : "no peers answered the trackers or the DHT"));
    }, METADATA_MS);
    const done = () => { cleanup(); if (torrent.files?.length) resolve(torrent); else reject(new Error("this torrent holds no files")); };
    const failed = (err) => { cleanup(); reject(new Error(String(err?.message || err || "the torrent failed"))); };
    function cleanup() { clearTimeout(timer); torrent.removeListener("ready", done); torrent.removeListener("metadata", done); torrent.removeListener("error", failed); }
    torrent.once("ready", done);
    torrent.once("metadata", done);
    torrent.once("error", failed);
  });

/**
 * Add a magnet to the client and come back **at once**.
 *
 * A swarm already alive is reused, which is the common case: one Play is dozens of range
 * requests, and every one of them must not re-resolve the magnet.
 *
 * **The wait for metadata is not this function's job.** Joining a swarm takes as long as
 * it takes; a request that waits for it is a request a proxy in front of this server will
 * give up on (which is where "HTTP 502" on a torrent comes from). So this starts the
 * swarm and answers, and the player asks `torrentStatus` how it is getting on.
 */
export function prepareTorrent({ magnet = "", infoHash = "" } = {}) {
  if (!torrentReady()) return { ok: false, error: loadError || "loading" };
  const hash = String(infoHash || hashOf(magnet) || "").toLowerCase();
  if (!hash) return { ok: false, error: "no info hash in this stream" };
  let entry = swarms.get(hash);
  if (!entry) {
    const c = getClient();
    const torrent = c.add(magnet && magnet.startsWith("magnet:") ? magnet : `magnet:?xt=urn:btih:${hash}`, { path: undefined });
    entry = { torrent, addedAt: Date.now(), timer: null, error: "" };
    torrent.on("error", (err) => { entry.error = String(err?.message || err || "the torrent failed"); });
    swarms.set(hash, entry);
    prune();
  }
  touch(hash);
  return { ok: true, infoHash: hash };
}

/**
 * Add a magnet and wait for the file to play.
 *
 * Used by the stream route, which is only ever reached **after** the player has been told
 * the swarm is ready (see `prepareTorrent`), so the wait is normally already over.
 */
export async function openTorrent({ magnet = "", infoHash = "", fileIdx = null } = {}) {
  if (loadState === "loading") await warmTorrent();
  if (!torrentReady()) throw new Error(`the server has no torrent engine (${loadError})`);
  const started = prepareTorrent({ magnet, infoHash });
  if (!started.ok) throw new Error(started.error);
  const entry = swarms.get(started.infoHash);
  await ready(entry.torrent);
  const file = pickFile(entry.torrent, fileIdx);
  if (!file) throw new Error("nothing playable in this torrent");
  return { infoHash: started.infoHash, file, name: file.name, length: file.length };
}

/**
 * The live readout for the player: where the swarm is, and the file once it is known.
 *
 * `state` is what the player waits on — `loading` until the metadata arrives, `ready`
 * with the file behind it, or `error` with the reason. That is the whole of the
 * "the torrent does not start" conversation: the note under the picture says which of
 * the three the swarm is in instead of a black rectangle saying nothing.
 */
export function torrentStatus(infoHash, fileIdx = null) {
  const entry = swarms.get(String(infoHash || "").toLowerCase());
  if (!entry) return { state: "idle", peers: 0, progress: 0, downloadSpeed: 0 };
  const t = entry.torrent;
  const base = {
    peers: Number(t.numPeers) || 0,
    progress: Number(t.progress) || 0,
    downloadSpeed: Number(t.downloadSpeed) || 0,
    uploaded: Number(t.uploaded) || 0,
    downloaded: Number(t.downloaded) || 0,
    timeRemaining: Number(t.timeRemaining) || 0,
  };
  if (entry.error) return { ...base, state: "error", error: entry.error };
  if (!t.ready || !t.files?.length) return { ...base, state: "loading" };
  const file = pickFile(t, fileIdx);
  if (!file) return { ...base, state: "error", error: "nothing playable in this torrent" };
  return { ...base, state: "ready", name: file.name, length: file.length, fileIdx: t.files.indexOf(file) };
}

/** An open byte range of a file, as a stream — webtorrent fetches the pieces it needs. */
export function fileStream(file, { start = 0, end = undefined } = {}) {
  return file.createReadStream({ start, end });
}

/** Stop everything (server shutdown). */
export function closeTorrents() {
  for (const hash of [...swarms.keys()]) drop(hash);
  try { client?.destroy(); } catch { /* already gone */ }
  client = null;
}

/**
 * `bytes=start-end`, as a `<video>` element sends it.
 *
 * A browser asks for the tail (a moov atom, a seek) as often as it asks for the front, so
 * this is the difference between a torrent that plays and one that buffers forever.
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  let start = rawStart === "" ? null : Number(rawStart);
  let end = rawEnd === "" ? null : Number(rawEnd);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  else if (end === null || end >= size) end = size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

/**
 * The `GET /stream/torrent` handler.
 *
 * A magnet is resolved once and then serves every range the player asks for. A failure is
 * a **502 with the reason** — "no peers answered the trackers or the DHT" is a thing a
 * person can act on (try another stream, or add a debrid account), where a black rectangle
 * is not.
 */
export async function handleTorrentStream(req, res, { magnet = "", infoHash = "", fileIdx = null } = {}) {
  const send = (code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(body);
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS" });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, JSON.stringify({ error: "GET only" }));
  try {
    const { infoHash: hash, file, name, length } = await openTorrent({ magnet, infoHash, fileIdx });
    const total = Number(length) || 0;
    const range = parseRange(req.headers?.range, total);
    if (range?.unsatisfiable) {
      res.writeHead(416, { "content-range": `bytes */${total}`, "access-control-allow-origin": "*" });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, total - 1);
    const chunk = end - start + 1;
    const headers = {
      "content-type": contentType(name),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "content-length": String(chunk),
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${total}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = fileStream(file, { start, end });
    const stop = () => { try { stream.destroy(); } catch { /* gone */ } };
    // The player closing the tab, or seeking away, ends the read — and the swarm is left
    // alone to be reused by the next request.
    res.on("close", stop);
    stream.on("error", () => { try { res.destroy(); } catch { /* gone */ } });
    stream.pipe(res);
  } catch (err) {
    send(502, JSON.stringify({ error: String(err?.message || err) }));
  }
}
