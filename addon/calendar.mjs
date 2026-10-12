/**
 * Release calendar — what actually comes out in a given month.
 *
 * A calendar is not "Latest" or "Newest": those are catalogs. This asks
 * TMDB discover for a date range and returns one entry per title with the date
 * it lands on, so the UI can draw a real month grid.
 *
 *   movies  → primary_release_date
 *   series  → first_air_date
 */
import { get, toMeta, tmdbPath } from "./tmdb.mjs";

const PAGE_SIZE = 20;
const MAX_PAGES = 3;

const dedupe = (items) => {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
};

/** First and last day of a `YYYY-MM` month, as ISO dates. */
export function monthRange(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) return null;
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return { start: `${match[1]}-${match[2]}-01`, end: `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}`, days: last };
}

/**
 * Every title releasing in `month` for one row type, each carrying
 * `releaseDate` (YYYY-MM-DD). Sorted by date.
 */
export async function calendarMonth(media, month, { adult = false } = {}) {
  const range = monthRange(month);
  if (!range) return null;
  const t = tmdbPath(media);
  const field = media === "movie" ? "primary_release_date" : "first_air_date";

  // **A month is read a week at a time.** The whole month in one date-ordered window is
  // the first sixty titles of the month and nothing else: TMDB answers `date.asc`, every
  // page is three pages deep, and the first of the month alone filled all three — so a
  // calendar whose month was real drew titles on day one and was empty for the other
  // thirty. Seven-day windows, each read for its most notable titles, cover the month the
  // way the calendar draws it.
  const windows = [];
  for (let day = 1; day <= range.days; day += 7) {
    const last = Math.min(day + 6, range.days);
    const mm = (n) => String(n).padStart(2, "0");
    windows.push([
      `${range.start.slice(0, 8)}${mm(day)}`,
      `${range.start.slice(0, 8)}${mm(last)}`,
    ]);
  }

  const pages = await Promise.all(
    windows.flatMap(([start, end]) =>
      Array.from({ length: MAX_PAGES }, (_, i) =>
        get(`/discover/${t}`, {
          [`${field}.gte`]: start,
          [`${field}.lte`]: end,
          sort_by: "popularity.desc",
          ...(adult ? { include_adult: true } : {}),
          page: i + 1,
        }).catch(() => ({ results: [] })),
      ),
    ),
  );

  // TMDB's list endpoint sometimes omits the date we filtered on — pass
  // `release_date.*` through when present, otherwise fall back to the field.
  const metas = dedupe(pages.flatMap((p) => p.results ?? []))
    // `include_adult` is a hint, and the calendar asks for a date range rather
    // than a list endpoint, so the `adult` flag is honoured here as well.
    .filter((item) => adult || !item.adult)
    .map((item) => {
      const date = (media === "movie" ? item.release_date : item.first_air_date) || null;
      return { ...toMeta(item, media), releaseDate: date };
    })
    .filter((m) => m && m.releaseDate)
    // Inside the month, whatever TMDB's own date field says.
    .filter((m) => m.releaseDate >= range.start && m.releaseDate <= range.end)
    // Nearest release first inside each day's own list, so the calendar's grid reads in
    // the order it draws.
    .sort((a, b) => String(a.releaseDate).localeCompare(String(b.releaseDate)));

  return { month, type: media, days: range.days, metas };
}
