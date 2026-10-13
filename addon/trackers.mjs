/**
 * **Outbound tracking — one direction, and only what you watched or rated.**
 *
 * Everything this app knows about you is in its own Library: the pins, the rating grid on
 * a title page, the progress a player reports. A tracker is told about those; it is never
 * asked what it thinks. That is why there is no read path in this file at all — a list kept
 * on Trakt or SIMKL cannot rewrite a row, so connecting one can only ever add.
 *
 * **A rating is the same write as a watch.** `POST /tracking/rate` on the title page lands
 * here: the number is handed to every tracker that is connected, and the answer says which
 * ones took it. The app keeps the rating either way — the grid is *yours*, and the tracker
 * is a copy of it.
 *
 * A service is only written to when it holds an access token. The **key** a tracker pane
 * asks for is its client id (the app *you* register on the service's site); the **token** is
 * what an authorisation flow hands back afterwards. With the id and no token there is
 * nothing to write *as*, so the service answers with that instead of a fake success.
 */
import { getSettings } from "./settings.mjs";

const TRAKT = "https://api.trakt.tv";
const SIMKL = "https://api.simkl.com";

/** The TMDB id a pin carries, without its `tmdb:` prefix — `""` when it has none. */
const tmdbOf = (item) => {
  const id = String(item?.id || "").replace(/^tmdb:/, "");
  return /^\d+$/.test(id) ? id : "";
};

/** A pin's kind in the trackers' words. */
const kindOf = (item) => (item?.type === "series" || item?.type === "show" ? "show" : "movie");

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Trakt: a 1–10 rating on the title, with the shows' and films' own endpoints. */
async function pushTrakt(entry, item, rating) {
  const id = tmdbOf(item);
  if (!id) return { name: "trakt", ok: false, text: "this title has no TMDB id" };
  const token = String(entry.token || "").trim();
  const clientId = String(entry.clientId || entry.key || "").trim();
  if (!token) return { name: "trakt", ok: false, text: "no access token — connect Trakt in Settings → Tracking" };
  const res = await fetch(`${TRAKT}/sync/ratings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "trakt-api-version": "2",
      ...(clientId ? { "trakt-api-key": clientId } : {}),
    },
    body: JSON.stringify({ [kindOf(item) === "movie" ? "movies" : "shows"]: [{ ids: { tmdb: Number(id) }, rating: number(rating) || null }] }),
  });
  if (!res.ok) return { name: "trakt", ok: false, text: `Trakt said ${res.status}` };
  return { name: "trakt", ok: true, text: rating ? `rated ${rating}/10` : "rating cleared" };
}

/** SIMKL: `/sync/ratings` takes one title, in the same 1–10 voice. */
async function pushSimkl(entry, item, rating) {
  const id = tmdbOf(item);
  if (!id) return { name: "simkl", ok: false, text: "this title has no TMDB id" };
  const token = String(entry.token || "").trim();
  const clientId = String(entry.clientId || entry.key || "").trim();
  if (!token) return { name: "simkl", ok: false, text: "no access token — connect SIMKL in Settings → Tracking" };
  const res = await fetch(`${SIMKL}/sync/ratings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(clientId ? { "simkl-api-key": clientId } : {}),
    },
    body: JSON.stringify({ [kindOf(item) === "movie" ? "movies" : "shows"]: [{ ids: { tmdb: id }, rating: number(rating) || 0 }] }),
  });
  if (!res.ok) return { name: "simkl", ok: false, text: `SIMKL said ${res.status}` };
  return { name: "simkl", ok: true, text: rating ? `rated ${rating}/10` : "rating cleared" };
}

const WRITERS = { trakt: pushTrakt, simkl: pushSimkl };

/**
 * Hand a rating to every connected tracker.
 *
 * The answer is a line per service — `pushed` — so the app can say what happened without
 * pretending: a service with no token reports that, and the rating is kept here anyway.
 */
export async function pushRating(item, rating) {
  const tracking = getSettings()?.tracking || {};
  const pushed = [];
  for (const [name, write] of Object.entries(WRITERS)) {
    const entry = { ...(tracking[name] || {}) };
    // A key with the switch off is a service you have not connected; it is not written to.
    if (!entry.enabled && !entry.token) continue;
    try {
      pushed.push(await write(entry, item || {}, rating));
    } catch (err) {
      pushed.push({ name, ok: false, text: String(err?.message || err) });
    }
  }
  return { ok: true, pushed };
}

/* ------------------------------------------------------------ a watch, going out ---- */

/**
 * **Started and finished are the same kind of write as a rating.** The Library is the app's
 * own record of what you are watching; a tracker is a copy of it, so the two marks the app
 * makes by itself — *started* at 5% of a title and *finished* at the end — are handed to the
 * same connected services. Nothing is read back: a service can never move a row here.
 */
async function watchTrakt(entry, item, watched) {
  const id = tmdbOf(item);
  if (!id) return { name: "trakt", ok: false, text: "this title has no TMDB id" };
  const token = String(entry.token || "").trim();
  const clientId = String(entry.clientId || entry.key || "").trim();
  if (!token) return { name: "trakt", ok: false, text: "no access token — connect Trakt in Settings → Tracking" };
  const kind = kindOf(item) === "movie" ? "movies" : "shows";
  const res = await fetch(`${TRAKT}/sync/history`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "trakt-api-version": "2",
      ...(clientId ? { "trakt-api-key": clientId } : {}),
    },
    // **Only a finish is history.** "Started" is what Trakt calls a *playback* — a scrobble
    // in progress — and a history entry for it would say you have seen a title you are ten
    // minutes into. A finished title is history; a started one is left alone.
    body: JSON.stringify(watched ? { [kind]: [{ ids: { tmdb: Number(id) } }] } : { [kind]: [] }),
  });
  if (!res.ok) return { name: "trakt", ok: false, text: `Trakt said ${res.status}` };
  return { name: "trakt", ok: true, text: watched ? "marked watched" : "started" };
}

async function watchSimkl(entry, item, watched) {
  const id = tmdbOf(item);
  if (!id) return { name: "simkl", ok: false, text: "this title has no TMDB id" };
  const token = String(entry.token || "").trim();
  const clientId = String(entry.clientId || entry.key || "").trim();
  if (!token) return { name: "simkl", ok: false, text: "no access token — connect SIMKL in Settings → Tracking" };
  const key = kindOf(item) === "movie" ? "movies" : "shows";
  const res = await fetch(`${SIMKL}/sync/history`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(clientId ? { "simkl-api-key": clientId } : {}),
    },
    body: JSON.stringify(watched ? { [key]: [{ ids: { tmdb: id } }] } : {}),
  });
  if (!res.ok) return { name: "simkl", ok: false, text: `SIMKL said ${res.status}` };
  return { name: "simkl", ok: true, text: watched ? "marked watched" : "started" };
}

const WATCH_WRITERS = { trakt: watchTrakt, simkl: watchSimkl };

/** Hand a *started* / *finished* mark to every connected tracker. */
export async function pushWatch(item, watched) {
  const tracking = getSettings()?.tracking || {};
  const pushed = [];
  for (const [name, write] of Object.entries(WATCH_WRITERS)) {
    const entry = { ...(tracking[name] || {}) };
    if (!entry.enabled && !entry.token) continue;
    try {
      pushed.push(await write(entry, item || {}, Boolean(watched)));
    } catch (err) {
      pushed.push({ name, ok: false, text: String(err?.message || err) });
    }
  }
  return { ok: true, pushed };
}
