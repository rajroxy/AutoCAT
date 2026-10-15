# AutoCAT

A catalogue browser for films and series, and the addon that feeds it.

The app is one screen of **cards** — Watchlist, Discover, Genres, Decades, Countries,
Seasons, Updates, Upcoming, the streaming services — and every card opens onto live rows
of titles from TMDB. It runs as a desktop window (Electron) or as the same UI in a
browser; both talk to the server in this repository, which is also a Stremio/AutoCAT
addon, so the same rows can be read from Stremio itself.

## Run it

Node 20+ is the only requirement.

```sh
TMDB_API_KEY=your_key npm start      # the desktop window
npm run start:web                    # the same UI in a browser, http://0.0.0.0:4173/app/
```

The key can also be pasted in the app (Settings → Environment) and is written back to
the server's settings for that profile. With no key, every row answers empty and says so.

Covers are committed, so nothing has to be generated to run the app. To rebuild them:

```sh
npm run generate      # cd scripts && npm install && npm run generate
```

## The app

**Home** is a grid of cards for the tab you are on — *Movies* or *Shows*. A card is one
cover, its name, and its first three rows of posters; pressing it opens the card's own
page with every row it publishes. Cards and their rows can be reordered in
Settings → Layout.

**Explore** reads one row to its end: a card's own wall keeps its ten or twenty-five, and
the Explore page asks the server for the same row uncapped (`deep`), so a row of
thousands keeps going instead of stopping at the card's edge.

**A title page** carries the hero, the facts (year, runtime or seasons, rating), Play,
Watch Along, the cast, the seasons or the collection it belongs to, and the trailer.

**Search**, **Library** (your own rows), **Calendar** (release dates), **Activity** (a
dashboard of what you have watched, with the numbers, a fortnight of it, and the timeline
under it) and **Settings** are the other screens. Settings holds Layout, Content (country,
language, quality, the content source), Providers, Add-ons, Sources, Subtitles, Debrid,
the AI providers behind Ask, Profiles and the environment.

**Profiles.** Two people, each with their own Watchlist, Library, settings and keys. The
profile you are on is drawn as a solid plate with the app's own ink on it; the avatar on
it is the app's accent disc with an ink mark, deepened on the chosen card rather than
replaced with a black circle.

## The catalogue

Cards and rows are declared once, in `scripts/collections.mjs`, and turned into TMDB
queries by `addon/catalogs.mjs` — so the cover art, the card, and the rows behind it can
never drift apart. A row is a TMDB question (a sort, a genre, a decade, a country, a
provider, a runtime bucket), and the addon publishes one catalog per row.

**No empty rows.** A row that cannot fill a page is not published, so a card never opens
onto a wall of empty frames (the provider ids and keyword ids that do return titles are
recorded in `scripts/tmdb-verified.json`).

**SFW is enforced twice** — the switch rides along as `?adult=1`, and the metas are
filtered again before they are built, because several TMDB endpoints take no such
parameter. The SFW and NSFW pools are keyed separately, so one can never answer the other.

**Leaving and arriving.** Every title is in the app from the day it is released, and the
app carries it for a fixed stay: **180 days for a film, 365 for a series** — a series
arrives an episode at a time over months, a film arrives complete. The stay is per title,
not one number for everything, and the leaving date is `release + stay` for that title.

The **Updates** card is the two ends of that window, and it is a **schedule** rather than a calendar —
the way a subscription's own "coming soon" and "leaving soon" lists are:

| Row | What it is |
|---|---|
| **Leaving Soon** | the last 30 days of the stay — everything on it is out of the app within a month, and its leaving date is on the poster |
| **Arriving Soon** | the month's arrival wave: the titles landing in the app over the next **30 days**, in the order they land, the most notable first within a day, each poster wearing its own date — `Arrives today` on the day itself |

**Game Pass is the model, and it is a service schedule rather than a release calendar.** Xbox's
"Coming to Game Pass" list is not a calendar of game releases: it is day-level dates for what is
joining the *library* (waves announced twice a month, a few titles each, the day-one ones marked in
words), and its "Leaving soon" filter is the other end of the same schedule — titles exiting *"in the
next two weeks"*. In this app a title joins on the day it is released, so the wave *is* release days —
but the row is read as a schedule: ordered **by the day it lands**, most notable first within a day,
and drawn from TMDB's most popular releases inside the window, because in a month of releases the
notability is what makes a wave a list rather than a dump.

**The two cards divide the calendar, so no poster is on both.** `SOON_DAYS` (30, in
`scripts/collections.mjs`, one number read by both rows) is the near end of the Upcoming card's window
as well: `after: SOON_DAYS + 1` in `UPCOMING_ROWS` means the Upcoming card starts the day after the
wave ends — the `+ 1` because a window that ends on day 30 and another that begins on day 30 share
that day, which measured as three films and five series on both cards. That is the answer to the first
thing said about this row — that it *was* the Upcoming card's first page, the same titles twice on one
home screen — and it holds by construction: the two rows cannot share a title, and a check reads both
off the running server and fails if the boundary ever moves on one side only.

The dates are written down per title (`addon/lineup.json`, machine-wide, git-ignored) and
put on the title's own card — a title on the Arriving Soon row is one the rest of the app now knows
is on its way, which is what keeps it off the rows that claim a title is on **now**.

**Leaving and arriving are two different rules.** A title the Leaving Soon row has named is
**out of the app from that moment** — dropped from every row, from the search and from the
filters — and the two places it is still on screen are the Updates card that named it, wearing
its leaving date, and your own Watchlist and Library, which are yours to keep. A title that has
**not landed yet** is the other way round: it is *in* the app like any other — findable, in its
genre, country and decade rows, in the filters — and the only thing it lacks is something to
play, which its title page says (`Arriving 4 Nov` in place of Play). The one kind of row it
waits off is the card whose rows claim a title is **on now** (Now Playing, Airing Today, On the
Air), where TMDB's own pre-release windows would otherwise put the same poster twice.

## The player

Sources come from the Stremio add-ons you added (Settings → Add-ons); the server asks them
because a browser cannot call another host's `/stream/…`.

- **Torrents** need something that can hold a swarm: a Debrid account (the magnet is
  resolved to a plain HTTPS link) or the server's own engine (`/stream/torrent`, reported
  in the app as `options.torrent.ready`). When neither is available, the player opens the
  **first source that can actually play here** instead of a magnet the page can never open,
  and the torrents stay one press away in the Sources drawer.
- **A stream that will not load** — no CORS on the manifest, a file that only answers its
  own site's headers — is retried once through the app's own server (`/stream/proxy`), which
  fetches it with the referer and rewrites an HLS manifest's segments to come back the same
  way.
- **HLS** is played by the browser where it can, and by the vendored `hls.js` where it
  cannot. The seek bar's elapsed part is painted in the accent as it plays.

## Watch Along

A watch party in the shape Stremio or a Discord call has: a room, a code you read out, who
is in it, and the talk under it. A room is one code per title — another profile on the same
machine, or a phone on the same Wi-Fi, opens Watch Along on that title and joins with it.
The room and its notes live on the server (`addon/party.mjs`), so both watchers see the same
room.

**Find a pairing pairs people, not titles.** It lists the profiles set up on this machine
and, from each one's own watchlist, what they have to do with the title — pinned it, are
watching it, finished it, or can simply join with the code. Pressing a person opens the room
for them or hands over its code. The assistant has its own button on the title page; the
Watch Along box is not one.

## Routes

`serve.mjs` serves the app, the cover gallery and the addon from one origin.

| Route | What it returns |
|---|---|
| `/` | redirects to `/app/` — the web app, the same UI as the desktop window |
| `/gallery` | every cover, with its SVG and PNG |
| `/manifest.json` | the addon manifest — one row per catalog for the configured country |
| `/catalog/{type}/{id}.json` | one live row of titles, e.g. `/catalog/movie/autocat-discover--trending.json` |
| `/catalog/{type}/{id}/skip=N.json` | the same row, paged (`?deep=1` lifts the card's own cap) |
| `/catalog/{type}/{id}/shuffle=N.json` | a random sample of the row |
| `/collections.json` | every card, its cover, and the rows it owns |
| `/settings` | GET/POST the app's settings for a profile — providers, tracking, AI, content source, language, country, live source. Keys and passwords are never returned, only whether they are set |
| `/watchlist.json`, `/watchlist` | the pins: read them, or pin / move / unpin a title |
| `/activity.json` | the watchlist store read as a timeline |
| `/party.json` | the watch party for a title: its room, who joined, and the notes |
| `/pair/{type}/{id}.json` | the people to watch this title with, and why each one |
| `/landscape/{type}/{id}.json` | a title's wide artwork: key art, a backdrop, or a frame from its trailer |
| `/streams/{type}/{id}.json` | the streams the add-ons answer for a title |
| `/stream/proxy`, `/stream/torrent`, `/torrent/prepare`, `/debrid/resolve` | playback: the proxy that adds a stream's own headers, the server's swarm, and a Debrid account's resolve |

## Layout

```
serve.mjs            the server: the app, the gallery, and the addon on one origin
addon/
  index.mjs          the handler: manifest, catalogs, search, the app's own routes
  catalogs.mjs       the plan: a card's rows → TMDB queries
  tmdb.mjs           the TMDB client (paging pools, genre resolution, caching)
  lineup.mjs         what has left and what has not arrived, with the dates
  watchlist.mjs      the pins: Plan to Watch / Watching / Watched
  party.mjs          Watch Along: the room, its code, and the notes
  proxy.mjs          the stream proxy (referer, cookies, rewritten manifests)
  stores are `<name>.<profile>.json` — one file per profile, plain and unscoped for
  callers that name no profile (Stremio, the scripts, the tests)
desktop/
  main.js            the Electron window (starts the same server on a free port)
  ui/                the app itself: app.js, style.css, index.html, vendor/
scripts/
  collections.mjs    the card set — the single source of truth for art and rows
  generate-covers.mjs  the cover generator (SVG master + 1920×1080 PNG)
  tmdb-verified.json   GENERATED: provider ids, regional services and keyword ids
                       that are verified to return titles
```

## Covers

Vector scenes drawn procedurally in SVG, one per card, exported at 1920×1080 with Inter at
weight 800. Titles render at one uniform size so no card is smaller than another; the
subtitle under a title names the rows inside the card. No photographs, no hue shifting, and
motion is off under `prefers-reduced-motion`.

```
covers/
  movies/<card>.svg   animated master
  movies/<card>.png   1920×1080 export
  shows/<card>.svg
  shows/<card>.png
  manifest.json       the index: title, subtitle, row, paths
  index.html          open it in a browser to see every cover
```

Fonts: Inter by Rasmus Andersson (SIL Open Font License, see
`scripts/fonts/Inter-LICENSE.txt`).
