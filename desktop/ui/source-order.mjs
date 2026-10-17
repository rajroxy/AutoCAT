/**
 * **The order the player walks a title's sources in.**
 *
 * The address is the add-ons' order, and it is the order of *their* catalogue, not of what can
 * play: Torrentio answers a Korean film with a hundred and eighty-six torrents and PlavioHD
 * with twenty-odd scraped HTTP files, and whichever add-on answered first owns the top of the
 * list. The player walks the list from the top and stops after a dozen tries, so on the day the
 * torrents came first it spent every one of them on swarms with no seeders and said *"no source
 * of this title would open"* with a playable file sitting at number 30 — the report this exists
 * for ("many sources will not play").
 *
 * Two rules, and both come from how the two kinds fail:
 *
 *   1. **A file a player can open directly goes first.** An `http(s)` URL that needs no swarm
 *      either plays or answers with a status, and either way it costs a second or two. A
 *      torrent costs a metadata fetch from the swarm before it can even answer, and on a
 *      machine with no open port or a blocked DHT it never answers at all.
 *   2. **A torrent with no seeders goes last.** `seeders: 0` is not "maybe": nothing can be
 *      fetched from a swarm that is not there, and a debrid account's resolved link does not
 *      arrive as a torrent (it arrives as a `url`), so a zero-seeder magnet is the one row in
 *      the list that is a guaranteed wait. Torrents whose seeder count is unknown are kept
 *      ahead of the zeroes, and the well-seeded ones ahead of those.
 *
 * Nothing here is filtered out — every source the add-ons sent is still offered, in order, and
 * the Sources drawer still lists them exactly as they arrived.
 */

/** How many seeders a torrent has, with anything unknown sorted below a known count. */
const seedRank = (s) => {
  const n = Number(s?.seeders);
  if (!Number.isFinite(n)) return 1; // unknown: behind a known count, ahead of a known zero
  return n > 0 ? 0 : 2;
};

/**
 * The player's pool, in the order it should be walked: direct files, then swarms that exist,
 * then the ones that cannot answer.
 *
 * @param {Array<object>} streams sources that already carry a `url` or a magnet
 * @returns {Array<object>} the same rows, re-ordered (the input is not changed)
 */
/**
 * **How likely the element is to be able to open it at all.** A direct file is only "playable" if the
 * container inside it is one Chromium can decode, and a Korean film's list is full of `.mkv` files
 * whose HEVC video or AC3 audio the element refuses outright — *"media error 4 —
 * MEDIA_ELEMENT_ERROR: Format error"*, over and over, while an `.mp4` sits below the twelve tries the
 * player allows. So the walk now reads the address first: a playlist (the engine handles it), then a
 * plain file the element opens, then the containers it usually cannot, and only then the ones with no
 * extension to judge by.
 *
 * Nothing is dropped — every source is still offered, and the Sources drawer still lists them in the
 * order the add-ons sent (see `orderSources`); this is the order the player *walks*.
 */
const containerRank = (target) => {
  const url = String(target || "").toLowerCase().split("?")[0].split("#")[0];
  if (/\.(m3u8|mpd)$/.test(url)) return 0;   // a playlist the engine can drive
  if (/\.(mp4|m4v|webm|ts)$/.test(url)) return 1;   // a container the element decodes
  if (/\.(mkv)$/.test(url)) return 3;   // MKV: fine if the codecs happen to be, refused most of the time
  if (/\.(avi|flv|wmv|mov|mpg|mpeg|3gp|vob|rmvb|divx)$/.test(url)) return 4;
  return 2;   // no extension to judge by: better than a known-bad one
};

export function orderSources(streams = []) {
  const rows = [...streams];
  const kind = (s) => (s?.torrent ? 1 : 0);
  const shape = (s) => containerRank(s?.torrent ? s?.magnet : s?.url);
  return rows
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const byKind = kind(a.s) - kind(b.s);
      if (byKind) return byKind;
      // Among the direct files, the ones the element can actually open come first.
      if (!kind(a.s)) {
        const byShape = shape(a.s) - shape(b.s);
        if (byShape) return byShape;
      }
      const bySeed = seedRank(a.s) - seedRank(b.s);
      if (bySeed) return bySeed;
      // A stable walk: two sources of the same kind keep the order the add-on gave them.
      return a.i - b.i;
    })
    .map((row) => row.s);
}
