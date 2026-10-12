/**
 * Debrid: a torrent, turned into an ordinary HTTPS link.
 *
 * ## Why this exists
 *
 * A torrent stream is published by an add-on as an `infoHash` (with the trackers),
 * and the app used to hand that magnet to a torrent engine **inside the browser**.
 * A browser can only reach peers over WebRTC/WebSocket; the public swarms are
 * almost entirely TCP/UDP peers, which a page cannot dial at all. So the honest
 * user experience was "Looking for peers…" forever — the torrent never plays, and
 * nothing on screen explains why.
 *
 * A debrid account fixes that at the root: the service downloads the torrent on its
 * own servers (instantly, if someone else already cached that hash) and returns a
 * **direct URL**. The video element plays it like any other stream, so seeking and
 * range requests work, and no swarm is involved.
 *
 * ## Shape of the integration
 *
 * One adapter per service, each implementing the same small contract:
 *
 *   verify(key)                          -> { ok, text }        "is this key good?"
 *   add(key, magnet)                     -> { id }              "put it in my account"
 *   status(key, id)                      -> { ready, progress, files }
 *   link(key, id, file)                  -> { url }             "the direct URL"
 *
 * `resolveMagnet` walks the user's enabled services in order and stops at the first
 * one that answers. A service whose *own* server is failing is reported with its
 * name, never as a bare HTTP code, and the next service is still tried — being
 * unable to reach one provider must not hide that another can serve the file.
 *
 * ## What is cached, and why not the URL
 *
 * The **torrent id** is cached per service+hash: re-adding a magnet you have already
 * added is what makes a second play slow. The **link is never cached** — TorBox's
 * links are time-limited, and a stale URL is a stream that fails for no visible
 * reason. A link costs one fast call to build.
 */
import { debridServices, debridKey, DEBRID_ENV } from "./settings.mjs";

const UA = "AutoCAT/1.0";
const LABELS = {
  realdebrid: "Real-Debrid",
  alldebrid: "AllDebrid",
  premiumize: "Premiumize",
  torbox: "TorBox",
  debridlink: "Debrid-Link",
  deepbrid: "Deepbrid",
  putio: "Put.io",
};

export const DEBRID_SERVICES = Object.keys(DEBRID_ENV).map((name) => ({ name, label: LABELS[name] }));

/** Torrents that are already cached answer in seconds; a cold one can take minutes. */
const POLL_TIMEOUT_MS = Number(process.env.NUVIO_DEBRID_TIMEOUT_MS) || 45000;
const POLL_INTERVAL_MS = Number(process.env.NUVIO_DEBRID_POLL_MS) || 2500;
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

/** service+infoHash -> { id, files, at } — the added torrent, not the link. */
const added = new Map();
/** service+infoHash -> in-flight `add`, so two taps cannot add the same magnet twice. */
const inflight = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const VIDEO_RE = /\.(mp4|m4v|mkv|avi|mov|webm|ts|m2ts|flv|wmv|mpg|mpeg)$/i;
const SAMPLE_RE = /(sample|trailer|preview|screenshot|\.nfo$|\.txt$|\.jpg$|\.png$|\.srt$|\.ass$|\.sub$)/i;

/**
 * `fetch`, with a deadline and a User-Agent.
 *
 * Every debrid API here is behind a CDN that wants a real client: the default Node
 * agent on a token-bearing request is the shape bot rules refuse first. The abort is
 * what keeps a dead provider from holding the whole play button for a minute.
 */
async function call(url, { method = "GET", headers = {}, body, timeout = 20000 } = {}) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { "user-agent": UA, accept: "application/json", ...headers },
      body,
      signal: control.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON: keep the text */ }
    return { status: res.status, ok: res.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
}

const form = (params) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
  return body;
};

/** A provider's own words for a failure, without ever echoing the key. */
function failure(name, r, fallback) {
  // A service often pairs a numeric `error` code with a human `message`; the message is
  // what belongs on screen, so only strings are considered and the code is skipped.
  const candidates = [
    r?.data?.error_string,
    r?.data?.detail,
    typeof r?.data?.error === "string" ? r.data.error : "",
    r?.data?.message,
    typeof r?.data === "string" ? r.data : "",
    r?.text,
  ];
  const detail = candidates.find((x) => typeof x === "string" && x.trim()) || "";
  const short = String(detail).replace(/\s+/g, " ").slice(0, 160);
  if (r?.status === 401 || r?.status === 403) {
    return { ok: false, message: `the key was refused by the service (HTTP ${r.status})`, text: `key refused by the service (HTTP ${r.status})` };
  }
  const text = short || fallback || `the service answered HTTP ${r?.status || "?"}`;
  return { ok: false, message: text, text };
}

/**
 * Which file of a torrent to play.
 *
 * The add-on's `fileIdx` indexes **its** file list, and a debrid service returns the
 * torrent's list in its own order — the two do not reliably line up, so an index is
 * a hint and not a decision. What is reliable is the *name*: an add-on that labels a
 * stream "S02E04 1080p" means that episode. So the name is matched first, and the
 * largest video file is the fallback — which is what a human would pick.
 */
export function pickFile(files, hint) {
  const list = (files || []).filter((f) => f && f.name && !SAMPLE_RE.test(f.name));
  const videos = list.filter((f) => VIDEO_RE.test(f.name));
  const pool = videos.length ? videos : list;
  if (!pool.length) return null;
  const wanted = String(hint || "").toLowerCase();
  if (wanted) {
    const keys = wanted.match(/s\d{1,2}\s?e\d{1,2}/) || wanted.match(/\b(19|20)\d{2}\b/) || [];
    const hit = pool.find((f) => keys.some((k) => f.name.toLowerCase().includes(String(k).replace(/\s+/g, "")))) ||
      pool.find((f) => keys.some((k) => f.name.toLowerCase().includes(String(k))));
    if (hit) return hit;
  }
  return pool.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

/* ------------------------------------------------------------------ Real-Debrid */

const RD = "https://api.real-debrid.com/rest/1.0";
const rdHeaders = (key) => ({ authorization: `Bearer ${key}` });

const realdebrid = {
  name: "realdebrid",
  async verify(key) {
    const r = await call(`${RD}/user`, { headers: rdHeaders(key) });
    if (!r.ok) return failure("realdebrid", r, "the key was refused");
    const pre = r.data?.type === "premium" || Number(r.data?.premium) > 0;
    return { ok: true, text: `key is valid — ${r.data?.username || "account"}${pre ? " · premium" : " · free (torrents may not be cached)"}` };
  },
  async add(key, magnet) {
    const r = await call(`${RD}/torrents/addMagnet`, {
      method: "POST", headers: { ...rdHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ magnet }),
    });
    if (!r.ok || !r.data?.id) return failure("realdebrid", r, "the magnet was not accepted");
    // Files have to be chosen before Real-Debrid starts fetching: "all" is the
    // honest choice for a play request, since the add-on already picked the stream.
    await call(`${RD}/torrents/selectFiles/${r.data.id}`, {
      method: "POST", headers: { ...rdHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ files: "all" }),
    });
    return { ok: true, id: r.data.id };
  },
  async status(key, id) {
    const r = await call(`${RD}/torrents/info/${id}`, { headers: rdHeaders(key) });
    if (!r.ok) return failure("realdebrid", r, "could not read the torrent");
    const files = (r.data?.files || []).map((f) => ({
      name: String(f.path || "").replace(/^\//, ""), size: Number(f.bytes) || 0, id: f.id,
    }));
    const ready = r.data?.status === "downloaded";
    const done = (r.data?.files || []).filter((f) => f.selected).length;
    const total = (r.data?.files || []).length || 1;
    return { ok: true, ready, files, progress: r.data?.progress ? r.data.progress / 100 : done / total, state: r.data?.status };
  },
  async link(key, id, file) {
    const r = await call(`${RD}/torrents/info/${id}`, { headers: rdHeaders(key) });
    const links = r.data?.links || [];
    if (!links.length) return { ok: false, message: "Real-Debrid returned no links for this torrent" };
    const one = await call(`${RD}/unrestrict/link`, {
      method: "POST", headers: { ...rdHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ link: links[0] }),
    });
    if (!one.ok || !one.data?.download) return failure("realdebrid", one, "could not unrestrict the link");
    return { ok: true, url: one.data.download, file: file?.name || one.data?.filename || "" };
  },
};

/* -------------------------------------------------------------------- AllDebrid */

const AD = "https://api.alldebrid.com";
const adHeaders = (key) => ({ authorization: `Bearer ${key}` });
const adMagnets = (d) => {
  const m = d?.data?.magnets;
  if (Array.isArray(m)) return m;
  if (m && typeof m === "object") return Object.values(m);
  return [];
};

/** AllDebrid returns a file *tree*: directories carry `e`, files carry `l`. */
function walkAdFiles(nodes, out = [], prefix = "") {
  for (const n of nodes || []) {
    if (Array.isArray(n?.e) && n.e.length) { walkAdFiles(n.e, out, `${prefix}${n.n || ""}/`); continue; }
    if (n?.l) out.push({ name: `${prefix}${n.n || "file"}`, size: Number(n.s) || 0, link: n.l });
  }
  return out;
}

const alldebrid = {
  name: "alldebrid",
  async verify(key) {
    const r = await call(`${AD}/v4/user`, { headers: adHeaders(key) });
    if (!r.ok || r.data?.status !== "success") return failure("alldebrid", r, "the key was refused");
    const u = r.data?.data?.user || {};
    return { ok: true, text: `key is valid — ${u.username || "account"}${u.isPremium ? " · premium" : " · free"}` };
  },
  async add(key, magnet) {
    const r = await call(`${AD}/v4/magnet/upload`, {
      method: "POST", headers: { ...adHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ "magnets[]": magnet }),
    });
    const m = adMagnets(r.data)[0];
    if (!m?.id) return failure("alldebrid", r, "the magnet was not accepted");
    return { ok: true, id: m.id };
  },
  async status(key, id) {
    const r = await call(`${AD}/v4.1/magnet/status`, {
      method: "POST", headers: { ...adHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ id }),
    });
    if (!r.ok || r.data?.status !== "success") return failure("alldebrid", r, "could not read the torrent");
    const m = adMagnets(r.data)[0] || {};
    const files = walkAdFiles(m.files);
    // Newer AllDebrid moved the file list to its own endpoint; the status response
    // still carries `links` for many magnets, so either is enough here.
    return {
      ok: true,
      ready: m.status === "Ready" || Number(m.statusCode) === 4,
      files: files.length ? files : (m.links || []).map((l, i) => ({ name: `file ${i + 1}`, size: 0, link: l })),
      progress: Number(m.downloaded) && Number(m.size) ? Number(m.downloaded) / Number(m.size) : (Number(m.statusCode) === 4 ? 1 : 0),
      state: m.status,
    };
  },
  async link(key, id, file) {
    // The file's own `l` is already the direct link. An older magnet with no file
    // tree still answers from `/magnet/files`, which is asked for both parameter
    // spellings because AllDebrid accepts a single id and an id array.
    const found = (file?.link ? [file] : await alldebrid.files(key, id)).filter((f) => f?.link);
    if (!found.length) return { ok: false, message: "AllDebrid returned no link for this torrent" };
    let url = file?.link || found[0].link;
    if (!/^https?:/i.test(url)) {
      const un = await call(`${AD}/v4/link/unlock`, {
        method: "POST", headers: { ...adHeaders(key), "content-type": "application/x-www-form-urlencoded" },
        body: form({ link: url }),
      });
      if (un.ok && un.data?.status === "success" && un.data?.data?.link) url = un.data.data.link;
    }
    return { ok: true, url, file: file?.name || found[0].name || "" };
  },
  async files(key, id) {
    for (const param of ["id[]", "id"]) {
      const r = await call(`${AD}/v4/magnet/files`, {
        method: "POST", headers: { ...adHeaders(key), "content-type": "application/x-www-form-urlencoded" },
        body: form({ [param]: id }),
      });
      if (r.ok && r.data?.status === "success") {
        const m = adMagnets(r.data)[0] || {};
        const files = walkAdFiles(m.files);
        if (files.length) return files;
      }
    }
    return [];
  },
};

/* ------------------------------------------------------------------- Premiumize */

const PM = "https://www.premiumize.me/api";
const pmHeaders = (key) => ({ authorization: `Bearer ${key}` });

const premiumize = {
  name: "premiumize",
  async verify(key) {
    const r = await call(`${PM}/account/info`, { headers: pmHeaders(key) });
    if (!r.ok || r.data?.status !== "success") return failure("premiumize", r, "the key was refused");
    const until = r.data?.premium_until ? new Date(r.data.premium_until * 1000) : null;
    return { ok: true, text: `key is valid${until && until > new Date() ? ` · premium until ${until.toISOString().slice(0, 10)}` : " · free account (torrents are limited)"}` };
  },
  async add(key, magnet) {
    const r = await call(`${PM}/transfer/create`, {
      method: "POST", headers: { ...pmHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ src: magnet }),
    });
    if (r.data?.id === undefined || r.data?.id === null) return failure("premiumize", r, "the magnet was not accepted");
    return { ok: true, id: String(r.data.id), folder: r.data.folder_id ? String(r.data.folder_id) : "" };
  },
  async status(key, id) {
    const r = await call(`${PM}/transfer/list`, { headers: pmHeaders(key) });
    const t = (r.data?.transfers || []).find((x) => String(x.id) === String(id));
    if (!t) return failure("premiumize", r, "the transfer is not in the account");
    const ready = t.status === "finished" || t.status === "seeding";
    const files = t.folder_id ? await premiumize.files(key, t.folder_id) : [];
    return {
      ok: true, ready, files, progress: Number(t.progress) || (ready ? 1 : 0), state: t.status,
      folder: t.folder_id ? String(t.folder_id) : "",
    };
  },
  async files(key, folder) {
    const r = await call(`${PM}/folder/list?id=${encodeURIComponent(folder)}`, { headers: pmHeaders(key) });
    return (r.data?.content || []).filter((f) => f?.link).map((f) => ({ name: f.name || "file", size: Number(f.size) || 0, link: f.link }));
  },
  async link(key, id, file) {
    if (file?.link) return { ok: true, url: file.link, file: file.name };
    const found = await premiumize.files(key, id);
    if (!found.length) return { ok: false, message: "Premiumize returned no link for this torrent" };
    return { ok: true, url: found[0].link, file: found[0].name };
  },
};

/* ---------------------------------------------------------------------- TorBox */

const TB = "https://api.torbox.app/v1/api";
const tbHeaders = (key) => ({ authorization: `Bearer ${key}` });

const torbox = {
  name: "torbox",
  async verify(key) {
    const r = await call(`${TB}/user/me`, { headers: tbHeaders(key) });
    if (!r.ok || r.data?.success === false) return failure("torbox", r, "the key was refused");
    const d = r.data?.data || {};
    const plan = ["free", "essential", "pro", "standard"][Number(d.plan)] || d.plan;
    return { ok: true, text: `key is valid${d.isSubscribed ? ` · plan: ${plan}` : " · free account"}` };
  },
  async add(key, magnet) {
    const body = new FormData();
    body.append("magnet", magnet);
    const r = await call(`${TB}/torrents/createtorrent`, { method: "POST", headers: tbHeaders(key), body });
    const id = r.data?.data?.torrent_id ?? r.data?.data?.torrentId ?? r.data?.data?.id;
    if (r.data?.success === false || id === undefined || id === null) return failure("torbox", r, "the magnet was not accepted");
    return { ok: true, id: String(id) };
  },
  async status(key, id) {
    const r = await call(`${TB}/torrents/mylist?id=${encodeURIComponent(id)}&bypass_cache=true`, { headers: tbHeaders(key) });
    if (r.data?.success === false || !r.data?.data) return failure("torbox", r, "could not read the torrent");
    const t = Array.isArray(r.data.data) ? r.data.data[0] : r.data.data;
    // TorBox's docs warn against `download_state` alone: `download_finished` is the
    // field that actually means "the file is there".
    const ready = t?.download_finished === true || t?.downloadFinished === true || t?.download_state === "completed";
    const files = (t?.files || []).map((f) => ({ name: f.name || f.short_name || "file", size: Number(f.size) || 0, id: f.id }));
    return { ok: true, ready, files, progress: Number(t?.progress) || (ready ? 1 : 0), state: t?.download_state };
  },
  async link(key, id, file) {
    // `requestdl` authenticates with the token in the query, not the header, and
    // every link it mints is time-limited — which is exactly why links are never
    // cached and are rebuilt for each play.
    const r = await call(`${TB}/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${encodeURIComponent(id)}&file_id=${encodeURIComponent(file?.id ?? 0)}`, { headers: tbHeaders(key) });
    const url = r.data?.data;
    if (r.data?.success === false || typeof url !== "string") return failure("torbox", r, "could not mint a download link");
    return { ok: true, url, file: file?.name || "" };
  },
};

/* ------------------------------------------------------------------- Debrid-Link */

const DL = "https://debrid-link.com/api/v2";
const dlHeaders = (key) => ({ authorization: `Bearer ${key}` });
/** v2 wraps every answer in `{ success, value }`; the payload is what matters. */
const dlValue = (d) => (d && typeof d === "object" && "value" in d ? d.value : d);

const debridlink = {
  name: "debridlink",
  async verify(key) {
    const r = await call(`${DL}/account/infos`, { headers: dlHeaders(key) });
    if (!r.ok || r.data?.success === false) return failure("debridlink", r, "the token was refused");
    const v = dlValue(r.data) || {};
    const premium = Number(v.premiumLeft) > 0 || String(v.accountType || "").toLowerCase() === "premium";
    return { ok: true, text: `token is valid — ${v.username || v.email || "account"}${premium ? " · premium" : " · free (seedbox may be limited)"}` };
  },
  async add(key, magnet) {
    // The seedbox endpoint takes the magnet as form field `url`. `wait` asks it to answer
    // once the torrent is in the account; the download itself continues in the background.
    const r = await call(`${DL}/seedbox/add`, {
      method: "POST",
      headers: { ...dlHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ url: magnet, wait: "true" }),
    });
    const v = dlValue(r.data) || {};
    if (r.data?.success === false || !v.id) return failure("debridlink", r, "the magnet was not accepted");
    return { ok: true, id: String(v.id), folder: "" };
  },
  async status(key, id) {
    const r = await call(`${DL}/seedbox/list?ids=${encodeURIComponent(id)}&perPage=1`, { headers: dlHeaders(key) });
    if (r.data?.success === false) return failure("debridlink", r, "could not read the torrent");
    const value = dlValue(r.data);
    const list = Array.isArray(value) ? value : value ? [value] : [];
    const t = list.find((x) => String(x?.id) === String(id)) || list[0];
    if (!t) return failure("debridlink", r, "the torrent is not in the account");
    // `downloadPercent` is the API's own 0–100 progress; a torrent at 100 has its
    // per-file `downloadUrl`s filled in, which is the real "ready" signal.
    const files = (t.files || []).filter((f) => f && f.name).map((f) => ({ name: f.name, size: Number(f.size) || 0, link: f.downloadUrl || "" }));
    const pct = Number(t.downloadPercent);
    const ready = Number.isFinite(pct) ? pct >= 100 : files.length > 0 && files.every((f) => f.link);
    return { ok: true, ready, files, progress: Number.isFinite(pct) ? pct / 100 : ready ? 1 : 0, state: t.status };
  },
  async link(key, id, file) {
    if (file?.link) return { ok: true, url: file.link, file: file.name };
    const st = await debridlink.status(key, id);
    const hit = (st.files || []).find((f) => f.link && f.name === file?.name) || (st.files || []).find((f) => f.link);
    if (!hit) return { ok: false, message: "Debrid-Link has no download link for that file yet" };
    return { ok: true, url: hit.link, file: hit.name };
  },
};

/* ---------------------------------------------------------------------- Deepbrid */

const DB = "https://www.deepbrid.com/api/v1";
const dbHeaders = (key) => ({ authorization: `Bearer ${key}` });

const deepbrid = {
  name: "deepbrid",
  async verify(key) {
    const r = await call(`${DB}/user`, { headers: dbHeaders(key) });
    if (!r.ok || Number(r.data?.error) === 401) return failure("deepbrid", r, "the key was refused");
    const type = String(r.data?.type || "").toLowerCase();
    const until = r.data?.expiration ? String(r.data.expiration) : "";
    return { ok: true, text: `key is valid — ${r.data?.username || "account"}${type ? ` · ${type}` : ""}${until ? ` until ${until}` : ""}` };
  },
  async add(key, magnet) {
    const r = await call(`${DB}/torrents/add`, {
      method: "POST",
      headers: { ...dbHeaders(key), "content-type": "application/x-www-form-urlencoded" },
      body: form({ magnet }),
    });
    // The docs do not publish the add-response body, so the id is read from wherever it
    // appears rather than from one guessed shape.
    const id = r.data?.id ?? r.data?.torrent_id ?? r.data?.torrentId ?? r.data?.data?.id;
    if (Number(r.data?.error) === 401 || id === undefined || id === null) return failure("deepbrid", r, "the magnet was not accepted");
    return { ok: true, id: String(id), folder: "" };
  },
  async status(key, id) {
    const r = await call(`${DB}/torrents/info?id=${encodeURIComponent(id)}`, { headers: dbHeaders(key) });
    if (Number(r.data?.error) === 1) return failure("deepbrid", r, "the torrent is no longer in the account");
    if (Number(r.data?.error) === 2) return failure("deepbrid", r, "Deepbrid torrents need a Premium account");
    const t = Array.isArray(r.data) ? r.data.find((x) => String(x?.id) === String(id)) : r.data;
    const state = String(t?.status || "").toLowerCase();
    // The API names its terminal states; polling a dead torrent until the deadline is
    // a minute of the user's time for nothing.
    const failed = ["error", "dead", "magnet_error", "virus"].includes(state);
    const links = Array.isArray(t?.links) ? t.links.filter((l) => typeof l === "string" && l) : [];
    // Deepbrid gives one link per file but no per-file name, so each link carries the
    // torrent's own name; `pickFile` then falls back to the first, which is fine.
    const files = links.map((link, i) => ({
      name: t?.filename ? (links.length > 1 ? `${t.filename} (${i + 1})` : t.filename) : `file ${i + 1}`,
      size: 0,
      link,
    }));
    return {
      ok: true,
      ready: state === "downloaded" && files.length > 0,
      files,
      progress: (Number(t?.progress) || 0) / 100,
      state,
      failed,
    };
  },
  async link(key, id, file) {
    if (file?.link) return { ok: true, url: file.link, file: file.name };
    const st = await deepbrid.status(key, id);
    const hit = (st.files || []).find((f) => f.link);
    if (!hit) return { ok: false, message: "Deepbrid has no download link for that torrent yet" };
    return { ok: true, url: hit.link, file: hit.name };
  },
};

/* ----------------------------------------------------------------------- Put.io */

const PI = "https://api.put.io/v2";
/**
 * Put.io authenticates a personal token on the query string as `oauth_token` — the
 * scheme its own documentation and every add-on integration use. A Bearer header works
 * too, but the query form is the one a user-generated token is meant for.
 */
const piUrl = (key, path, params = {}) => {
  const u = new URL(`${PI}${path}`);
  u.searchParams.set("oauth_token", key);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
};
/** transfer id -> the folder id the transfer produced, so a finished transfer — which
 *  leaves `/transfers/list` — can still be read. */
const putioFolders = new Map();

const putio = {
  name: "putio",
  async verify(key) {
    const r = await call(piUrl(key, "/account/info"));
    if (!r.ok || r.data?.status === "ERROR") return failure("putio", r, "the token was refused");
    const info = r.data?.info || {};
    const until = info.plan_expiration_date ? String(info.plan_expiration_date).slice(0, 10) : "";
    return { ok: true, text: `token is valid — ${info.username || "account"}${until ? ` · plan until ${until}` : ""}` };
  },
  async add(key, magnet) {
    const r = await call(piUrl(key, "/transfers/add"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ url: magnet }),
    });
    const t = r.data?.transfer || {};
    if (r.data?.status === "ERROR" || t.id === undefined) return failure("putio", r, "the magnet was not accepted");
    if (t.file_id) putioFolders.set(String(t.id), String(t.file_id));
    return { ok: true, id: String(t.id), folder: t.file_id ? String(t.file_id) : "" };
  },
  async status(key, id) {
    // `/transfers/list` holds *active* transfers only: a finished one drops out of it, so
    // its absence is the cue to read the files the transfer produced under its folder.
    const list = await call(piUrl(key, "/transfers/list"));
    if (list.data?.status === "ERROR") return failure("putio", list, "could not read the transfers");
    const t = (list.data?.transfers || []).find((x) => String(x.id) === String(id));
    const folder = t?.file_id ? String(t.file_id) : putioFolders.get(String(id)) || "";
    const state = String(t?.status || "");
    const done = !t || state === "COMPLETED" || state === "SEEDING";
    if (!done) {
      return { ok: true, ready: false, files: [], progress: Number(t?.percent_done) || 0, state: state || "downloading" };
    }
    if (!folder) return { ok: true, ready: false, files: [], progress: 1, state: state || "completed" };
    const fl = await call(piUrl(key, "/files/list", { parent_id: folder, per_page: 1000 }));
    if (fl.data?.status === "ERROR") return failure("putio", fl, "could not read the torrent's files");
    const files = (fl.data?.files || [])
      .filter((f) => f && f.name && f.file_type !== "FOLDER")
      .map((f) => ({ name: f.name, size: Number(f.size) || 0, id: f.id, link: "" }));
    return { ok: true, ready: files.length > 0, files, progress: 1, state: state || "completed" };
  },
  async link(key, id, file) {
    // A link is minted per play: Put.io's download URLs are time-limited, which is exactly
    // why they are never cached here.
    let target = file;
    if (!target?.id) {
      const st = await putio.status(key, id);
      target = pickFile(st.files || [], "");
    }
    if (!target?.id) return { ok: false, message: "Put.io has no file to link for this torrent" };
    const one = await call(piUrl(key, `/files/${encodeURIComponent(target.id)}/url`, { notunnel: 1 }));
    if (!one.ok || typeof one.data?.url !== "string") return failure("putio", one, "could not mint a download link");
    return { ok: true, url: one.data.url, file: target.name };
  },
};

const PROVIDERS = { realdebrid, alldebrid, premiumize, torbox, debridlink, deepbrid, putio };

/* ------------------------------------------------------------------- the flow */

/**
 * Find (or add) the torrent in one service's account, then wait for it to be ready.
 *
 * The add is cached per service+hash: the second time you play the same stream the
 * torrent is already in the account, so the wait is only as long as the CDN needs.
 * Concurrent calls share one in-flight add, so double-tapping Play cannot add the
 * same magnet twice.
 */
async function ensure(name, key, magnet, infoHash) {
  const svc = PROVIDERS[name];
  const cacheKey = `${name}:${infoHash}`;
  // What the cache saves is the **add**, never the check: a torrent already in the
  // account still has to be read for its file list and its readiness. Returning the
  // cached handle alone made the second play of a stream report "no video file",
  // because a handle is not a file list.
  let entry = added.get(cacheKey);
  if (entry && now() - entry.at >= SEEN_TTL_MS) entry = null;

  if (!entry) {
    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    const job = (async () => {
      const made = await svc.add(key, magnet);
      if (!made.ok) return made;
      const rec = { id: made.id, folder: made.folder || "", at: now() };
      added.set(cacheKey, rec);
      return { ok: true, ...rec };
    })();
    inflight.set(cacheKey, job);
    try {
      const r = await job;
      if (!r.ok) return r;
      entry = { id: r.id, folder: r.folder || "", at: r.at };
    } finally {
      inflight.delete(cacheKey);
    }
  }

  const deadline = now() + POLL_TIMEOUT_MS;
  let last = { ok: true, ready: false, files: [], progress: 0 };
  for (;;) {
    last = await svc.status(key, entry.id);
    if (!last.ok) {
      // A broken read is not a missing torrent: keep the cached handle and report it.
      return last;
    }
    if (last.failed) return { ok: false, message: `the torrent is "${last.state || "dead"}" on ${LABELS[name]} — it will not finish` };
    if (last.ready && last.files?.length) return { ok: true, id: entry.id, files: last.files, folder: last.folder || entry.folder };
    if (now() >= deadline) {
      return {
        ok: false, pending: true,
        message: `still being fetched by ${LABELS[name]} (${Math.round((last.progress || 0) * 100)}%${last.state ? `, ${last.state}` : ""}) — try again shortly`,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Resolve a torrent to a direct URL, across every enabled service.
 *
 * Returns `{ ok:true, url, service, label, file }`, or `{ ok:false, message }` where
 * the message names the service that failed. A `pending` result means the service is
 * still downloading the torrent — that is not an error, and the UI says so.
 */
export async function resolveMagnet({ magnet, infoHash, name } = {}) {
  const hash = String(infoHash || "").trim().toLowerCase();
  const link = String(magnet || "").trim() || (hash ? `magnet:?xt=urn:btih:${hash}` : "");
  if (!link) return { ok: false, message: "this stream has no magnet or info hash to resolve" };
  const services = debridServices();
  if (!services.length) {
    return {
      ok: false, unconfigured: true,
      message: "no debrid service is enabled — add one in Settings → Debrid to play torrents",
    };
  }
  const tried = [];
  const key = hash || link;
  for (const svc of services) {
    try {
      const got = await ensure(svc.name, svc.key, link, key);
      if (!got.ok) { tried.push(`${LABELS[svc.name]}: ${got.message}`); if (got.pending) return { ok: false, pending: true, message: `${LABELS[svc.name]}: ${got.message}` }; continue; }
      const file = pickFile(got.files, name);
      if (!file) { tried.push(`${LABELS[svc.name]}: the torrent holds no video file`); continue; }
      const made = await PROVIDERS[svc.name].link(svc.key, got.id, file);
      if (!made.ok) { tried.push(`${LABELS[svc.name]}: ${made.message}`); continue; }
      return { ok: true, url: made.url, service: svc.name, label: LABELS[svc.name], file: made.file || file.name, size: file.size || 0, cached: true };
    } catch (err) {
      tried.push(`${LABELS[svc.name]}: ${err?.message || err}`);
    }
  }
  return { ok: false, message: tried.join(" · ") || "no debrid service could resolve this torrent" };
}

/** Verify one service's key, for the Settings screen. */
export async function verifyDebrid(name, key) {
  const svc = PROVIDERS[name];
  if (!svc) return { ok: false, text: "unknown service" };
  const own = key || debridKey(name);
  if (!own) return { ok: false, text: "paste a key first" };
  try {
    return await svc.verify(own);
  } catch (err) {
    return { ok: false, text: `could not reach ${LABELS[name]} — ${err?.message || err}` };
  }
}

/** Which services would answer a torrent right now, in order — for the UI. */
export const debridReady = () => debridServices().map((s) => ({ name: s.name, label: LABELS[s.name] }));

/** Test seam: forget every cached torrent handle. */
export const _clearDebridCache = () => { added.clear(); inflight.clear(); };
