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
export function orderSources(streams = []) {
  const rows = [...streams];
  const kind = (s) => (s?.torrent ? 1 : 0);
  return rows
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const byKind = kind(a.s) - kind(b.s);
      if (byKind) return byKind;
      const bySeed = seedRank(a.s) - seedRank(b.s);
      if (bySeed) return bySeed;
      // A stable walk: two sources of the same kind keep the order the add-on gave them.
      return a.i - b.i;
    })
    .map((row) => row.s);
}
