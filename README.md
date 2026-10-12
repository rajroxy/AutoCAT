# Nuvio — collection covers & catalog addon

Two things that ship together:

1. **Cover art** — landscape (16:9) covers for every Nuvio collection, in both the
   **movies** and **shows** rows, as animated SVG masters and 1920×1080 PNG exports.
2. **A catalog addon** — a Stremio/Nuvio addon that turns each cover into a live
   home-screen row, backed by TMDB.

```
covers/
  movies/<collection>.svg   animated SVG master (vector — crisp at any size)
  movies/<collection>.png   1920×1080 export (rendered with Inter)
  shows/<collection>.svg
  shows/<collection>.png
  manifest.json             machine-readable index (title, subtitle, row, paths)
  index.html                open this in a browser to preview every cover
addon/
  index.mjs                 addon handler: /manifest.json + /catalog/*
  catalogs.mjs              the plan: each collection → TMDB queries
  tmdb.mjs                  TMDB client (cache, genre resolution)
  watchlist.mjs             the pins: plan to watch / watching / watched
  watchlist.json            RUNTIME: your pinned titles (git-ignored)
  ai.mjs                    the free AI providers behind the Ask box
  watchlist.mjs             the pins and their states (Plan to Watch / Watching /
                            Watched), stored in addon/watchlist.json
  customrows.mjs            the custom rows you fill yourself, stored in
                            addon/customrows.json
scripts/
  collections.mjs           the collection set — single source of truth
  tmdb-verified.json        GENERATED: provider ids, regional OTT services,
                            keyword ids — every one verified to return titles
  regional-candidates.mjs   the OTT brands tried for each country
  keyword-candidates.mjs    the keyword phrases tried for the moods / themes cards
  preview-imagery.mjs       previews a cover's generated scene
  preview-options.mjs       previews the scene options a cover picks from
  generate-covers.mjs       renders the SVG masters and the PNG exports
desktop/                    Electron desktop app; ui/ is plain web so the same
                            UI ports to Android TV via Capacitor (see its README)
  android/                  the generated Capacitor Android TV project
desktop/android/            leanback manifest + Gradle wrapper (needs a JDK to build)
serve.mjs                   server: gallery + addon on one origin
```

Every card × 2 rows = one cover per card per row. In the app the order opens on
**For You** and ends on **your own three cards** — and `CARD_ORDER` in
`collections.mjs` is the only place that order is written, so a card cannot drift. The
names below are the app's own labels for the cards; the two service cards are **Global**
and **Regional** in the app, while the generated covers still carry the older **Global
OTT** / **Regional OTT** wording (the app never draws a cover):

1. For You
2. Discover Plus
3. Discover
4. Genre from ◆ Decades
5. Genres
6. Decades
7. Continental
8. Countries
9. Runtimes
10. Based on the
11. Moods & Vibes
12. Themes & Tags
13. Global | Top 10
14. Global
15. Regional | Top 10
16. Regional
17. **Watchlist**
18. **Upcoming** — `Upcoming`, one row per row type: TMDB's own upcoming films, and
    the first-air-date order from today on for shows (**nearest first**), so what is
    coming next is the first thing on the card. This is the one card published with
    **`spotlight`**: its frame is the same 16:9 box every card has — so it sits **in
    the same row** as the Watchlist and the Custom card — but the frame holds **one
    still**, and that still **changes every ten seconds** the way the hero banner's
    does. It is **not clickable**: no artwork button, no focus stop, no hover lift
19. **Custom**

A vertical rule sits between **Watchlist** and **Upcoming**, because that is the line
between your own list and what is on its way to it.

**Airing This Week is gone from the banner.** *On the Board* — the hero banner's own
source, never drawn as a card — publishes **Now Playing** (movies) and **Airing
Today · On the Air** (shows) now: what is on the air already answers "what can I watch
now?", and what is *coming* is the Upcoming card's job.

Five more entries are defined and covered but **not drawn on Home**: *On the Board*
(the banner's own source), *Popular by ◆ Genre*, *Top Rated ◆ Genre*, *Popular by
Decade* and *Top Rated ◆ Decade*. Their rows are reachable, their covers exist, and
their ids keep resolving — they are simply not in the grid.

## Design

- **Vector scenes.** Every cover pairs the collection title with a scene drawn procedurally in
  SVG — stage beams, radar sweeps, contour lines, orbit rings and so on. One distinct scene per
  collection. No photographs, so the set is perfectly consistent and infinitely crisp.
- **Typography** — Inter throughout, weight 800, tight `-0.035em` tracking. Every cover title
  renders at one uniform size (the largest that fits every collection), so no card's text is
  smaller than another's.
- **Subtitles** — under the title, a card names the catalogs that live inside it (e.g. Discover
  → Latest · Newest · Trending · Popular · Top Rated; On the Board → Now Playing for movies,
  Airing Today · Airing This Week · On the Air for shows). Names wrap and shrink to fit. Never an
  editorial descriptor. A card with no catalogs is title-only.
- **Colour** — a single near-black field (`#08090C`, matching the Nuvio home background) with a
  panel of hairline ivory strokes and a soft champagne glow. One accent colour (`#C8A96A`) used
  sparingly; **no hue shifting anywhere**.
- **Rows** — the **shows** scene is mirrored horizontally so the two rows stay related but
  distinct, without rotating hue.
- **Animated** — the SVG masters breathe the champagne glow slowly. No hue rotation. Motion is
  disabled under `prefers-reduced-motion`.
- **Crisp** — the PNGs are rasterised straight from the vector at 1920×1080, so there is no
  upscaling blur. The SVGs stay sharp at any resolution.

## Catalog addon

`serve.mjs` serves the cover gallery **and** the addon from one origin:

| Route | What it returns |
|---|---|
| `/` | redirects to `/app/` — the web app (same UI as the desktop app) |
| `/app/` | the app UI: movies/shows, collections, live rows |
| `/app/...` | the app UI assets |
| `/gallery` | the cover gallery (every cover, with PNG/SVG downloads) |
| `/manifest.json` | addon manifest — one row per catalog (**1 824** catalogs for the configured country, every (type, id) unique) |
| `/catalog/{type}/{id}.json` | one live row of titles, e.g. `/catalog/movie/nuvio-discover--trending.json` |
| `/catalog/{type}/{id}/skip=100.json` | the same row, paged |
| `/catalog/{type}/{id}/shuffle=12.json` | a random sample of that row |
| `/collections.json` | every card + the catalogs it owns (used by the desktop app) |
| `/settings` | GET/POST the app's settings (profile, providers, tracking, AI, **content source**, **language**, **country**, and the **live** source: mode, playlist, Xtream login, EPG, refresh), plus the language and country lists the Content pane is built from. Keys, the playlist URL and the password are never returned — only whether they are set |
| `/watchlist.json` | GET the pinned titles + per-state counts |
| `/watchlist` | POST `{item, state}` to pin/move, or `{item, remove:true}` to unpin |
| `/catalog/{type}/nuvio-watchlist--*.json` | your pins — requested with a cache-buster and answered `cache-control: no-store` |
| `/ai.json` | which free AI providers exist, which is chosen, whether a key is set |
| `/ai/ask` | POST `{prompt}` — turns a sentence into a search query via that provider |
| `/ai/verify` | POST `{provider}` — checks that provider's stored key live |
| `/search.json` | `?q=` — title search across movies and shows. Browsing (no `q`) takes the panel's filters: `continent`, `country`, `provider`, `category`, `mood`, `theme`, `period`, `sort`, `type` |
| `/search/filters.json` | the panel's vocabulary — the cards' own continents, countries, platforms, genre lists, mood and theme keywords, periods and sorts |
| `/live/status.json` | the Live TV source's state: mode, channel count, categories, whether an EPG is set (never the playlist URL or the password) |
| `/live/channels.json` | the channel catalog — `?group=` one of the playlist's categories, `?q=` by name, `?country=`, `?force=1` to re-read now, each channel with its logo, groups, country and stream URL |
| `/live/guide.json` | `?hours=6` — the XMLTV guide: the lineup plus programme blocks per channel id, and `epg: false` when no EPG URL is configured |
| `/providers.json` | the same, plus which provider is active |
| `/providers/verify` | POST `{name}` — checks that provider's stored key live |
| `/api/source` | POST `{type,url}` — reads an add-on's manifest or a repo's `repo.json` **server-side** |
| `/calendar/{type}/{YYYY-MM}.json` | every title releasing that month, each with its date |
| `/posters/check` | verifies the configured poster service returns an image |
| `/auth/me` | who this browser is, if anyone: the user, what is configured, and the account this machine remembers |
| `/auth/local` | **POST** `{name, email?}` — sign in on this machine. No name means "come back as the account you already are"; answers with the session cookie, like a provider's callback does |
| `/auth/local/forget` | **POST** — take this machine's account off the machine, and end the session with it |
| `/auth/signout` | **POST** — end the session, keeping the account |
| `/auth/{provider}/start` | redirects to Google's or GitHub's consent page (a plain navigation — the handshake has to happen in the address bar) |
| `/auth/{provider}/callback` | the provider's way back: the code is spent server-to-server and turned into a session cookie |
| `/addon-status.json` | diagnostics (does it see a TMDB key, how many catalogs) |

Each catalog that lives inside a card is published as its own row — the same names
drawn on the cover:

| Card | Catalogs (movies / shows) |
|---|---|
| Watchlist | `Plan to Watch` · `Watching` · `Watched` (both) — served from your pins, not from TMDB |
| Discover Plus | `Acclaimed` · `Picks` · `Hidden Gems` · `Cult Classics` · `Landmarks` · `Fresh`, each **Top 25** (both) — every row a sort plus the vote floor that makes it mean something |
| On the Board | Now Playing / Airing Today · Airing This Week · On the Air |
| Discover | Latest · Newest · Trending · Popular · Top Rated (both) |
| Popular by ◆ Genre | `Popular in <Genre>` — movie genres / TV genres |
| Genres | `<Genre>` — the movie genres / TV genres, and nothing else (Anime and Asian Drama are keywords, not genres) |
| Popular by ◆ Decade | `Popular in <decade>s` (both) |
| Decades | `<decade>s`, 1950s–2020s (both) |
| Genre from ◆ Decades | `<Genre> ◆ 1950 → Present` — movie genres / TV genres (both) |
| Global \| Top 10 | `Latest \| Top 10` · `Newest \| Top 10` · `Trending \| Top 10`, then `<Platform> \| Top 10` — the six platforms the card carries: Netflix · Prime Video · Disney+ · Max · Apple TV+ · Paramount+ (both) |
| Global | `<Platform>` — everything on that platform, **followed by that platform's own `<Platform> Originals` row** (both) |
| Regional \| Top 10 | `Latest \| Top 10` · `Newest \| Top 10` · `Trending \| Top 10`, then `<Service> \| Top 10` — the services of the region set in Settings → Content (both) |
| Regional | `<Service>` — everything on each of those services, plus the two Asian-catalogue services (both) |
| Continental | continent names (both) |
| Countries | **countries with 50+ titles on a row type, less the places asked out** — 79 publish a movies row and 45 a shows row, of 251 known; out are the rows under fifty, the 36 territories TMDB returns nothing for, **and 37 named removals** (below). **Pakistan, Bangladesh and Southeast Asia (less Brunei, Myanmar, Timor-Leste) are exempt by name** and publish wherever they have anything |
| Runtimes | `30+ mins … 120+ mins` (**movies**) / `4 · 6 · 8 · 10 Episodes` (**shows**) |
| Based on the | Books · Comics · Graphic Novels · Video Games · True Stories · Plays · Short Stories (both) |
| Moods & Vibes | 75 moods: Adrenaline Rush · Mind Bending · Cozy & Comforting · Epic & Sweeping · Feel Good · Slow Burn · Tearjerkers · Dark & Gritty · Nostalgic · Suspenseful · Whimsical · Romantic · Cerebral · Melancholy · Dreamlike · Atmospheric · Chilling · Bittersweet · Uplifting · Charming · Campy · Eerie · Hopeful · Intimate · Spooky · Stylish · Steamy · Thought-Provoking · Gripping · Playful · Witty · Wholesome · Harrowing · Triumphant · Meditative · Frenetic · Nerve-Wracking · Gentle · Somber · Zany · Offbeat · Surreal · Cold · Bright · Kitschy · Cynical · Sleek · Sultry |
| Themes & Tags | 182 themes and tags (both rows — 185 labels, less *Anime*, *Asian Drama* and *Documentary* below): Detective · Gangster · Superhero · Time Loop · Animal Attack · Slasher · Possession · Zombie · Heist · Spy · Dystopia · Artificial Intelligence · Vampire · Werewolf · Witch · Alien · Amnesia · Courtroom · Sports · Survival · Revenge · Cursed · Road Trip · Prison · Military · Martial Arts · Samurai · Ninja · Pirate · Cowboy · Medieval · Mythology · Fairy Tale · Magic · Dragon · Kaiju · Dinosaur · Space · Cyberpunk · Steampunk · Disaster · Assassin · Kidnapping · Cult · Occult · Ghost · Monster · Mutant · Virtual Reality · Hacker · Conspiracy · Politics · Journalism · Medical · Teen · College · Family · Wedding · Christmas · Music · Dance · Food · Fashion · Racing · Body Swap · Twins · Immortality · Devil · Circus · Betrayal · Undercover · Bounty Hunter · Island · Train · Submarine · Aviation · Firefighter · Police · Anime · Asian Drama · Vigilante · Smuggling · Gambling · Revolution · Terrorism · Hostage · World War · Holocaust · Slavery · Apartheid · Addiction · Mental Illness · Autism · Disability · Adoption · Pregnancy · Dating · Supernatural · Alternate Reality · Telepathy · Dreams · Genetic · Spaceship · Mars · Cannibal · Voodoo · Cryptid · Shark · Snake · Spider · Wolf · Horse · Dog · Cat · Football · Basketball · Winter · Storm · Volcano · Farming · Village · Library · Restaurant · Amusement Park — **not Documentary**: that is a genre, not a theme. **Anime** is the TMDB `anime` keyword and is well covered; **Asian Drama** is backed by TMDB's `japanese drama` keyword, because TMDB has no Korean-drama keyword (searching "korean drama" returns nothing), so that row is real but thin — and neither is published as a row of its own: they are **keywords, not genres**, so they are not in Themes & Tags and not in the **Genres** card either. The cards that genuinely hold that content carry it — Japan in Countries, Crunchyroll and Viki on the OTT cards |

**No country is dropped for being small.** `tmdb-verified.json` records each country's
**actual totals** — measured with the same filters its own row uses
(`with_origin_country` + `vote_count.gte=5`, separately per row type) — and a country is
published when it has **anything at all** on that row type (`MIN_COUNTRY_TITLES = 1`).
There used to be a floor of ten here, and it was wrong twice: first it was compared
against a table that held one page's worth of each country (20 at most), where eleven
films and seven thousand were the same number; then, measured properly, it turned
TMDB's *coverage* of a country into a verdict on the country. Pakistan (38 films, 14
shows), Bangladesh (132/11), Sri Lanka (30/3), Nepal (20 films), Uzbekistan (7),
Qatar (41/2) and Tonga (1 show) all had rows and lost them. They are all back. The
question is asked **per row type**, so most countries have films and no shows and keep
their films row; the only countries left out besides the named removals are the 36
TMDB genuinely returns nothing for (Anguilla, Vanuatu, San Marino, the Maldives, and
the like) — a row for one of those would be an empty screen with a country's name on
it.

**Twenty-nine places are removed by name** (`REMOVED_COUNTRY_NAMES` in
`scripts/collections.mjs`) — the sets the user picked: the **uninhabited territories**
(Antarctica, the French Southern Territories, South Georgia, Svalbard & Jan Mayen),
the **one-title rows** (American Samoa, Belize, "Guadaloupe", Guyana, Kiribati,
Mayotte, Nauru, Niue, Norfolk Island, Oman, Timor-Leste, Tokelau, Tonga, the Turks
and Caicos, Tuvalu, the US Virgin Islands) and the **administered territories**
(Bermuda, the Falklands, the Faeroes, French Polynesia, Gibraltar, Greenland, Guam,
Martinique, Réunion). It is a **list, not a size rule** — Pakistan (38/14), Bangladesh
(132/11), Vietnam (117/9) and every other country stay whatever their counts — and one
function enforces it everywhere a country can appear: the Countries card's rows, the
search panel's country chips, the cross-country shuffle pool, the continent rows, the
settings country picker, **and the Regional OTT cards** (a service row stays only while
its region's country is published).

**Global OTT publishes six platforms and only those six** — Netflix · Prime Video ·
Disney+ · Max · Apple TV+ · Paramount+. A platform the probe verifies later is kept
as a fact in `PLATFORMS` but is deliberately not published as a global row, so the
card cannot quietly grow a seventh. Hulu is a US service and was never one of the
six.

**The two `Popular …` OTT cards are gone.** `Popular Global OTT` and `Popular
Regional OTT` were the same services read in popularity order, one press away from
the cards that already hold them — and they were the cards that kept coming back
with the same handful of names. The Top 10 and everything cards stay.

**Each platform is followed by its own `<Platform> Originals` row.** An "original"
is not a catalog, it is a studio: each platform's production company was looked up
against TMDB and only the ones that really return titles were kept (Netflix's films
come from company 178464, its shows from 185004; Disney's from Walt Disney Pictures
and Walt Disney Television), so the rows are real. The Originals rows are in the
**Global OTT** card only — the Top 10 card stays one row per platform.

The two **Regional OTT** cards publish the **regional OTT data itself** — not one
country's slice of it and not the **Countries** card's list. `tmdb-verified.json`
records each region under its own name with its ISO code on the entry, and
`REGIONAL_SERVICES(type)` folds those entries into one list: **one row per service**
(128 of them, up to ten services per region, 132 distinct services in the table — 7plus, aha, Arte, BBC iPlayer, BINGE, Canal+, CBC Gem,
Crave, Go3, JioHotstar, Peacock Premium, Pluto TV, Shahid VIP, Sky Go, SkyShowtime,
Stan, TVING, Viaplay, Viu, Voyo, Zee5, …), in name order, each row
carrying the region it was verified in. A service verified in several regions is one
row scoped to one of them, so the card has no empty duplicates, and the last two rows
are Crunchyroll and Viki — the Asian-catalogue services, which are not regional data,
so `activeRegion()` scopes them per request. The cards are title-only on the cover
because they are the same everywhere, and each row id carries its own region
(`nuvio-regional-ott--jiohotstar-in`), so two regions can never collide on one
catalog id.

**The country setting no longer decides what is in the Regional OTT cards** — they
hold every region's services. It still scopes the rows that have *no* region of their
own (`activeRegion()` in `addon/catalogs.mjs`) and the per-country counts
`/settings` reports.

**One surface language, on every screen.** The app draws **no hairline outlines**:
cards, tiles, the banner, the panels, the fields, the buttons and the rail are single
flat fills that lift or brighten under the cursor, and the accent is spent on what you
act on — the chosen chip, the primary button, a focused field, the letter you picked,
the profile you are on. The few lines that are left mean something: the calendar's grid,
the guide's ruler and its channel column, the dividers between sections, the plate on
the tag arrows, and the ring around a chosen colour. **One pill** carries every chip in
the app — a card's catalog tags, the search panel's filter choices, the model chips —
and **one voice** carries every caption: the labels that used to be small-caps with
letter-spacing (the result heads, the filter labels, the card subtitles, the guide
corner, the calendar's weekday row) are bold sentence case now, which is what makes the
screens read as one product instead of five.

**Home opens on a boot screen** that fades out once the first screen is drawn. The
opening spells **AutoCAT**, and its C is a **cat curled into it**: the animal resolves in
out of an out-of-focus turn once the line under the name has filled, then keeps living —
blinking and flicking its tail — while the last two letters arrive. Only the curl is
drawn; the pose that used to sit up and fall over is gone. The banner — **Spotlight** — shows
banner — **Spotlight** — shows **one landscape backdrop** drawn from the row that means
*out now* (**Now Playing** on movies, **On the Air** on shows) and moves to another
title **in that same catalog** every ten seconds, holding still while the cursor is on
it; the name on the banner is the name of the title on it. A tag line is a **two-row window with up/down arrows that scroll
it** a row at a time (the wheel works over it too, and each arrow dims at its own end
of the list): the Themes & Tags card carries nearly two hundred tags, and expanding
them in place pushed every row off the page. The arrows are drawn as **buttons** —
a bordered, accent-tinted plate with a stroked chevron inside, 32×28 with a hover
lift and a focus ring — not a bare mark on the background. Rows scroll with an
eased frame loop rather than jumping a wheel-notch at a time.

**A card's artwork is the card's own titles — and the generated cover is never
drawn.** Every frame carries `art-blank` from the first paint: the card, the banner
and a card page open as the app's own **flat panel**, and become that card's own art
the moment it answers. A card on Home is a **wall** of its titles — padded from the
frame's edges, separated by a gap, each picture keeping its own shape (`object-fit:
cover`, never stretched) — while **a card page's frame holds one landscape backdrop**
from the same titles, full-bleed in its 16:9 box (the wide shot the banner uses),
not five posters. The collection's vector scene used to be the layer under all of
that, so every card arrived as an illustration of itself and then changed under you; it is no longer on
screen at all. `art-filled` still marks "the pictures are here"; `art-blank` is what
the frame is before that. Which
slice of a card is drawn is decided **once per launch**, so the artwork changes on
app start; the banner is the one thing that redraws while the app runs, every ten
seconds.

**A card does not lift, and nothing spills out of its corners.** The grid lifted
every card on hover; a transform makes a stacking context, so the lifted card painted
*over* the floated top bar and its rounded corners cut across what sat behind them —
the reported "both upper corners and upper lines go over". The response is a fill and
an inset ring (no geometry change), the card is `overflow: hidden`, and the poster
strip is clipped to the frame's radius, so a photograph can never cross a card's edge.

**The name and its tags read on the left, the artwork frame on the right** — on the
banner and on a card page alike. On the **home banner** that left column reads as the
banner's own heading: its own name — **Spotlight** — keeps the top-left corner at a step
larger than the same caption elsewhere, and the card's title and the tag chips under it are
**centred** in the column — across it and down it, on the column's own centre line.

**Watchlist** is a real card with a real row. A shared addon cannot know your
account, so the rows are served from the pins stored in `addon/watchlist.json`
(runtime state, git-ignored) rather than from TMDB — pin a title in the app and it
appears in `Plan to Watch`, `Watching` or `Watched`, and it appears in Nuvio too,
because the addon publishes those three catalogs like any other.

**Genre from ◆ Decades** used to publish the movie genres only, which left the
shows row empty. It publishes both now, each from its own verified list: TV
genres are a different set (there is no "Science Fiction", there is "Sci-Fi &
Fantasy"), and every combination was checked against TMDB to
return titles from 1950 before it was published — all 18 movie genres and all 16
show genres pass, so nothing is dropped.

### Live TV & Sports: channels and the guide

`addon/live.mjs` is the source behind that profile. Three modes, in the order the
settings offer them:

| Mode | What it reads |
|---|---|
| **Premium & DTH catalogue** (default) | a catalogue of **real DTH, cable and premium operators**, per country, shipped with the app in `addon/dth.mjs`: **281 providers across 107 countries** — Sky, DIRECTV, DISH, Xfinity, Tata Play, Airtel Digital TV, d2h, Sun Direct, DStv, GOtv, StarTimes, Astro, Unifi, Cignal, Sky Cable, Foxtel, Sky NZ, beIN, OSN, Canal+, Polsat Box, Digiturk, HOT, yes, now TV, Hikari TV, KT SkyLife, Magti, ZAP, my.t and the rest. **No public free-TV directory and no iptv-org** — a premium profile opening on free public streams is the wrong app. Pick the providers you subscribe to and Live TV draws their **lineup and their guide**: a provider's XMLTV feed declares its own channels (`<channel>`) as well as its schedule (`<programme>`), so one read answers both. **It is a curated starting set, not every operator that exists** — no such list does. Adding one is a single line in `addon/dth.mjs`. Providers with a public feed — Foxtel, Freeview Australia, Sky New Zealand — bring the schedule with them; every other provider's schedule comes from your own EPG URL, because `epg` is filled in only where a public XMLTV feed genuinely exists (an invented URL fails on the first read and looks like a broken app). |
| **M3U playlist** | your own `.m3u`/`.m3u8` URL, or a path on the server — what your set-top box or operator app exports. Parsed properly: attributes are optional, the name is the last comma-separated part, the trailing quality marker is dropped, and `group-title` is treated as the `;`-separated category list it is. |
| **Xtream Codes** | host + username + password; the live streams and their categories come from the panel, and the stream URL is composed per channel. |

**Streams are never shipped and never invented.** A premium channel's stream is
delivered to a subscriber's box; it is not a public URL, and the app has no business
inventing one. The catalogue supplies the **lineup and the guide**, and your own
export supplies the streams — the two meet on **`tvg-id`**, which is the key the
guide is built on, so an exported playlist lands exactly on the catalogue's lineup.

A **channel** is the same shape whatever it came from — id, name, logo, groups,
country, stream URL — and everything is **cached on disk** (git-ignored) and re-read
on the refresh clock (its own 15/30/60/180-minute setting, or the Content interval).
A failed read keeps the last good list rather than emptying Live TV, and reports
what went wrong.

The **country pick is the one switch that moves the whole profile**. `live.countries`
is a list of ISO codes and `live.allCountries` reads the whole directory; whichever
is set decides what `/live/channels.json` and `/live/guide.json` answer with, so the
Guide and the Categories card are scoped together. `/live/countries.json` serves the
directory's own country table (name, ISO code, flag; cached for a day) for the
settings picker, and a picked code is matched through a small equivalence set, so
`GB` (the table's spelling) and `UK` (the directory's) both mean the United Kingdom.

The **Guide** is XMLTV. `live.epg` is an XMLTV URL; channels are matched by their
`tvg-id` (or the Xtream `epg_channel_id`), and `parseXMLTV` scans the document
rather than DOM-parsing tens of megabytes of one flat element. With an EPG set, the
grid draws real programme blocks positioned by their own start and stop times; with
none, it draws the lineup and says so once — it does not invent a schedule. The
playlist URL and the Xtream password stay **server-side**; the browser is told only
whether they are set.

### No empty rows — and how that is guaranteed

TMDB data drifts (HBO Max became Max; Paramount+ in the US became "Paramount Plus
Premium"; its keyword search answers "based on novel" with "based on visual
novel"; Ghana has films but no series; the "uplifting" keyword has films but no
series). Guessing any of that produces a catalog row that is permanently empty.

So nothing in `collections.mjs` is guessed: every provider id, every region's OTT
services and every keyword id was asked of TMDB at build time and kept only where
it really returns titles — **per media type** — and the result is committed as the
fact table `scripts/tmdb-verified.json`. The candidate lists the facts were drawn
from are still in the repo (`scripts/regional-candidates.mjs`,
`scripts/keyword-candidates.mjs`), so a fact can be re-checked against live TMDB
with a key when TMDB renames or moves a service. Nothing here runs on its own: the
app reads the committed table.

A catalog is identified by `(type, id)`, and TMDB paths map the Stremio `series`
type to TMDB's `tv`. Three entry kinds need care: **genre** names are resolved to
TMDB ids at request time (movie and TV genre sets differ), **keywords** resolve each
candidate name and use the first hit, and **episodes** cannot be filtered by TMDB
discover — those rows are built from a pool of newest + popular shows and kept to
`<= N` episodes.

**Keyword rows carry no vote floor.** TMDB's keyword tagging is thin — `epic` has
barely a dozen films even with no floor — and a `vote_count` floor left rows like
*Epic & Sweeping* with three titles. Dropping it (popularity ordering still leads)
widened the thinnest rows — measured *Epic & Sweeping* 3 → 11, *Adrenaline Rush*
4 → 9, *Cozy & Comforting* 14 → 40 — and left the busy ones at 40.

**The For You rows are random titles from anywhere, named after the title they were
built from.** Every row is a *title* (`More Like <Title>`), never a genre, four per
row type. Your Watchlist supplies them while it holds enough; a fresh install holds
none, so the card tops the list up from a **random walk through the world's
catalogues** — a dozen countries drawn at random, one random page of each one's most
popular titles — rebuilt in the background on a half-hour clock. It used to top up
from TMDB's week's-trending list, which is the same handful of well-known names in
every market on earth, so the card read as the popular shelf with "More Like" in
front of it. Your own titles are no longer a fixed prefix either: both sources are
shuffled into one pool, so a roll is a genuine mix and consecutive opens differ
(the last two rolls' seeds are held aside and only replayed when the pool runs dry).

**The Regional OTT card publishes rows that resolve.** A row per service the
region's own data holds plus the two worldwide ones, and then a filter: the services
TMDB's own `/watch/providers` answer lists for the selected country (`watch_region`)
are the ones kept, primed in the background beside the For You pool and cached for
half a day. A service the card named and could not fill — *Viki* in Korea,
*Crunchyroll* in a country TMDB does not list it in — was an empty row wearing a
service's name; a region whose list has not arrived yet keeps every row, because an
unasked question is not a "no".

**Paging.** Rows read TMDB 20 titles at a time into a growing, cached pool, so a
window of 40 continues where the last stopped. A row serves up to 300 titles; the
`◆ Top 10` rows stop at ten (and **Discover Plus**'s rows at twenty-five).

**Nothing else is capped.** The OTT cards' `Popular`/everything rows used to carry
a `take` of 30/40, which made an OTT card the one place whose rows ended after a
couple of screens while every other card kept going — the reported "OTT cards
don't scroll". They are uncapped now, like the rest. In the app a row also keeps
loading as you scroll it: reaching the end of a strip asks the server for the next
window, so a row behaves the same whether you scroll it sideways or open it in
Explore.

**Explore carries an alphabet rail** down the right-hand gutter. It indexes the
**titles in the row**, not the card's tags: picking a letter **shows only that
letter's titles** — the grid is filtered to them and the row is **paged in until the
letter is filled out**, so it is all of that letter's titles rather than the one or
two the first window held. The chosen letter is filled on the rail, a line above the
grid names it and carries the way back, and picking the same letter again restores
everything. Letters the loaded pages do not cover are dimmed, never dead. The rail
is a column **in the grid's own row** (`.explore-body`, so it begins at the catalog
row and not at the shuffle sample above it), `sticky` at `50vh` so its letters sit
**level with the middle of the screen** beside the poster columns rather than pinned
under the header, and it is not an overlay. Its `translateY(-50%)` used to carry the
rail's top half a rail-height **above** its own box — and that box is the top of
`.explore-body` — so the letters came up across the page header and the **Shuffle**
button over them. The same half-height is now handed back as a top margin: the rail's
drawn top lands on the grid's own top edge, its middle finds the middle of the screen
as the row scrolls, and nothing above it is covered.

### Symbols on the covers

Covers render with the bundled Inter fonts and system fonts disabled, so a glyph
Inter lacks becomes an empty box. `◆`, `→`, `★`, `·`, `•`, `–` and `—` are all
present and safe to use — and, per the design, are used to set off `Top 10` and the
`from … to` ranges and separators. (The `◆ Top 25` suffix is gone: that card is
**Discover Plus** now, and its rows are named for what they ask.) Avoid `✦`, `➜` and
other decorative arrows: Inter does not contain them.

Only the `catalog` resource is advertised — **no search, no discover**. Rows are refreshed from
TMDB and cached in memory for the interval in **Settings → Content → Refresh
catalogs & metadata** (15 / 30 / 60 / 180 minutes, or *Only when you ask*), and the
app re-reads the screen on the same clock. One setting drives both halves of
"update itself": set it to an hour and the addon's cache may see new data every
hour, set it to *Only when you ask* and nothing changes behind your back until you
press **Refresh now**. `TMDB_CACHE_TTL_MS` still overrides both — that is what the
probes and tests use.

**Install it in Nuvio:** add `https://<your-host>/manifest.json` as an addon. Each catalog's
`name` is the same string drawn as the cover subtitle, so you can pair each row with its art.

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `TMDB_API_KEY` | — | **Required.** TMDB v3 key or v4 read token. Catalogs stay empty without it. |
| `NUVIO_REGION` | `US` | Default for the **country** setting: the region used to scope rows that carry no region of their own, and the per-country counts `/settings` reports. The Regional OTT rows each carry their own region, so the setting does not move them. |
| `NUVIO_LANGUAGE` | `en-US` | Default for the **language** setting: the language every row is served in, and the primary subtitle language. |
| `TMDB_CACHE_TTL_MS` | `1800000` | Catalog cache window. |

### Watchlist

A shared addon can't know your account, so the Watchlist is backed by
`addon/watchlist.json` — runtime state, written by the app, git-ignored. A title
is pinned **from the app**: open any title and choose `Plan to Watch`, `Watching`
or `Watched`. Choosing the state it is already in unpins it, so a mis-tap is one
click to undo, and a pin moves between rows as you progress through it. A pin is
keyed by type *and* id — TMDB numbers films and shows in one id space, so
`tmdb:550` as a film and as a show are two different pins.

```sh
curl localhost:4173/watchlist.json
curl -X POST localhost:4173/watchlist -H 'content-type: application/json' \
  -d '{"item":{"id":"tmdb:550","type":"movie","name":"Fight Club"},"state":"planned"}'
```

### Calendar plans are not watchlist rows

A plan made on the **Calendar** screen does not go into the watchlist. It lives in
its own custom row (`calendar-plans`), because the two mean different things: a
watchlist row is a *state you progress through* and lists everything in that state,
while a calendar pin is a plan about a **date** — a release you saw on the grid and
mean to get to. The Calendar shows only the **recent** pins (last 30 days); the
watchlist rows are unaffected.

```sh
curl -X POST localhost:4173/customrows -H 'content-type: application/json' \
  -d '{"row":"calendar-plans","item":{"id":"tmdb:550","type":"movie","name":"Fight Club"}}'
```

### Custom rows (the calendar's plans)

The store behind `/customrows` still exists, and it backs exactly one thing now:
the **calendar's** plan-to-watch pins. Each is a plan about a *date* — a release you
saw on the grid and mean to get to — so it lives in its own row (`calendar-plans`)
and is never published as a catalog. It therefore cannot appear in the Watchlist
card, which is what "the calendar pin showed up in my watchlist" was.

**The pin is a toggle, and the shelf came back with it.** A *Recently planned*
shelf under the grid was removed when the pin was add-only: a list you can add to
and never prune is a list that only grows. The pin removes its own plan again — a
planned release says **planned**, and pressing it puts the plan back — so the shelf
is back under the grid as **Your plans** (the last 30 days, newest first).

**It is drawn whatever day is open, including no day.** The plans used to be drawn
only inside the selected day's detail, so deselecting the day — or turning to
another month — took every plan off the screen while the pins were still stored,
which reads as if they had been deleted. The day list and the plans list are two
different things: one is a *view* of the grid, the other is what you planned. Each
plan carries the date it was planned for (`Fri, October 2`), and the pin on it is
the same toggle, so the shelf prunes itself.

**There is no "add cards" row any more.** The Watchlist card is its three states
and nothing else, the title modal offers the same three states, and no *Add cards
in watchlist* catalog is published at all — no row, no id, no button.

The **calendar's** plans are kept in `addon/customrows.mjs` (the store that used to
back that row) under `calendar-plans`, and are deliberately not published as a
catalog: a plan made on the grid is not a watch state, so it never appears in the
Watchlist card — and it is never published as one.

```sh
curl localhost:4173/customrows.json
curl -X POST localhost:4173/customrows -H 'content-type: application/json' \
  -d '{"row":"add-cards","item":{"id":"tmdb:550","type":"movie","name":"Fight Club"}}'
```

### Signing in

**Settings → Profile** holds one card: the account, and how to make one. It used to
be a sentence about environment variables and no controls at all — every caption in
the app is hidden by its own "no subtext" rule, so what a fresh install showed was
the words *Sign in* and **nothing to press**. That is a dead end, not a sign-in.

**Google and GitHub come first** — the accounts that belong to *you* — and **this
machine's own name follows** under a rule, where it reads as the fallback it is.

**This machine's own account is the one that needs nothing set up.** A name and an
optional address, kept in
`addon/account.json` (runtime state, git-ignored; `NUVIO_ACCOUNT_FILE` moves it, which
is how the tests stay out of the real one). No password, nothing verified, nothing
sent anywhere — and it is the way in that works with nothing configured. The session
it hands out is the same cookie a provider's sign-in sets and the same `/auth/me`, so
nothing downstream can tell them apart; the one difference is that **it survives a
restart**, because the file keeps the session id it has already accepted. Sign out
ends the session and keeps the name; **Forget** takes the name and the address off the
machine, which is the only way to stop the card offering them back.

**Google and GitHub are ordinary OAuth**, and their keys are pasted in
**Settings → Sign in** — one row per provider, with a **Client ID**, a **Client
secret**, a switch, and the exact **Redirect URI** to register, copied from the pane
rather than assembled by hand. That last string is the one thing that cannot be
guessed: a callback registered with a different host, port or trailing slash never
comes back, so the pane shows the string the server itself will send
(`redirectUri` in `addon/auth.mjs`) and the row carries a link straight to the
provider's console (**Create a Google sign-in app** / **Create a GitHub sign-in
app**). The secret is stored server-side and only ever reported back as a boolean.

The same pair can be set on the environment instead, and either way works — Settings
is read first, the environment second, so a folder install with a form and a server
with env vars both do the same thing:

```sh
NUVIO_GOOGLE_CLIENT_ID=…  NUVIO_GOOGLE_CLIENT_SECRET=…
NUVIO_GITHUB_CLIENT_ID=…  NUVIO_GITHUB_CLIENT_SECRET=…
NUVIO_PUBLIC_URL=https://tv.example.com      # the preview origin works too
```

The callback to register with the provider is `<NUVIO_PUBLIC_URL>/auth/<provider>/callback`
(without `NUVIO_PUBLIC_URL`, the origin the request arrived on is used — built from the
request, never from a query parameter, which would be an open redirect). Working keys
add **Continue with Google** / **Continue with GitHub** to the card at the top of
Settings → Profile; without them the card is the name field it always is, and says
where to put them rather than pretending.

**The desktop app pins its port, because a callback has to be registered in
advance.** The embedded server used to start on port **0** — an OS-picked free port,
a new one every launch — which is fine for the app's own pages and impossible for
OAuth. It is **4173** now (`NUVIO_DESKTOP_PORT` moves it), `NUVIO_PUBLIC_URL` is set
to that origin, and the callback is therefore the same string on every launch:
`http://127.0.0.1:4173/auth/google/callback`. If the port is taken the app still
opens on an OS-picked one, and Settings → Sign in shows the callback actually in use.

**What is never kept:** a password, or a provider token. The token is spent on one
request (*who is this?*) and dropped; what comes back is a name, an address and a
picture, behind an HttpOnly cookie the page cannot read. Provider sessions live in
memory, so a server restart signs those out — that is the honest default for an app
whose data is on this machine.

### Shuffle, and why it can look broken

`/catalog/{type}/{id}/shuffle=12.json` draws a random 12 from a pool several times
the sample size, so two draws are not the same handful reordered. Two things made
it *look* dead, and both are fixed: the URL was byte-identical every time, so the
browser answered out of its cache, and the response carried `max-age=900`. A
shuffle is now requested with a fresh `_=<n>` parameter and answered
`cache-control: no-store` — every JSON response declares its caching explicitly
now, so "answers differently each time" can never be cached by accident.

The same trap sat on the watchlist. Its rows were served with `max-age`, so
unpinning a title and going back to the card showed the cached copy with the title
still in it — "removing content does not remove it". The watchlist and custom rows
are now requested with the same cache-buster and answered `cache-control: no-store`,
while ordinary catalog rows keep their `max-age=900` — the two are set side by side
in `addon/index.mjs` so neither drifts.

A watchlist row is *your* list: in **Explore** it is the header and the titles, with
**no Shuffle, no sample row and no divider** — there is no random twelve to draw
from a list of your own pins. (Explore also stops after 40 windows on a catalog
that never runs out, instead of keeping the sentinel in view and re-asking for ever.)

### AI providers (free)

The Ask box in **Settings → AI** is a real integration, not a text box. Pick one of
the free-tier providers, paste its key, and "tell me what to watch" is turned into
a search query by the model; `POST /ai/ask` does the call, `POST /ai/verify` checks
the key, and the answer is handed to the title search (`/search.json`).

| Provider | Key | Free tier |
|---|---|---|
| **Groq Cloud** (default) | `GROQ_API_KEY` | yes — LPU inference, OpenAI-shaped |
| **Google AI Studio** | `GOOGLE_API_KEY` | yes — Gemini |
| **OpenRouter** | `OPENROUTER_API_KEY` | yes — its `:free` models |
| **Cerebras Cloud** | `CEREBRAS_API_KEY` | yes |

Every call is plain `fetch` from Node, so there is no SDK to install, and the key
is stored beside the provider keys in `addon/settings.json` — never returned to
the browser (`/settings` and `/ai.json` report only *whether* a key is set). With
no key the Ask box still works: it searches the words you typed. **Pick movies or
shows for me** sits under the box and tells it which row to answer with: pick
*Movies* and the answers are films (the same picker the search screen calls *Type*),
pick *Both* and nothing changes. The model can be
overridden in the same section, since providers rename models faster than this
ships.

**A retired model name is a hiccup, not an outage.** Groq dropped
`llama-3.1-8b-instant` while the same key still verified fine, so the model is
never trusted on its own: if a model is rejected the provider's own model list is
read and the small, general-chat ones (never a guard model or a transcriber) are
tried in turn, and that list is what the picker offers, so a retired model name
cannot leave the Ask box with nothing to answer with.

### SFW / NSFW

The app's Content setting rides along as `?adult=1` on a catalog request; the
addon maps it to TMDB's `include_adult`. TMDB excludes adult titles by default,
so the switch is only ever able to add them.

`include_adult` alone is not enough, though — it is a hint, and several endpoints
take no such parameter at all: `/trending`, `/now_playing`, `/airing_today` and
`/top_rated`. A title TMDB itself flags `adult: true` on a list item would reach a
safe-for-work app from any of them. So SFW is enforced a second time where the
metas are built (`metasFor` in `addon/index.mjs`), on the raw list items, before
the meta exists — and in the search, browse, episode-cap and calendar paths too.
The NSFW pools are keyed separately, so turning the switch on cannot be served
from a filtered cache: the NSFW pools are keyed `a`, the SFW ones `s`, so one can
never answer the other.

### Run it

```sh
npm start          # the Electron desktop app
npm run start:web  # or: the same UI in a browser at http://0.0.0.0:4173/app/
```

There is **no test script** in this project. It is opened, used, and judged by what
it draws.

### Better posters (on by default)

Every poster is upgraded through [BetterPosters](https://btttr.cc/), silently —
no `BTTR` badge is drawn on the cards. Its URL pattern is keyed by **IMDb id**: `https://btttr.cc/poster/imdb/poster-default/{imdb_id}.jpg`.
A TMDB list item has no IMDb id, so one is resolved from TMDB's `external_ids`
endpoint and cached for a day. A title with no IMDb id keeps its original
artwork, and the AI setting *"give the same treatment to posters without a better
poster"* upscales exactly those by requesting the next-bigger TMDB size. The
pattern and an optional API key live in **Settings → Posters**, so another service
can be used without touching code; `GET /posters/check` verifies the pattern
really returns an image.

### Second metadata provider

TMDB is the only source that can answer the discover queries, so it backs every
row. **MDBList** is wired as a real metadata provider: enable it with a key and
each title's rating is replaced by MDBList's aggregated one — the catalog names
are unchanged, the contents are richer. `POST /providers/verify {name}` checks a
stored key against the provider (TMDB, MDBList or TVDB) so "enabled" means
connected. Keys are stored in `addon/settings.json` (git-ignored) and are never
returned by any endpoint.

### Content source: TMDB or TVDB

**Settings → Content** picks which provider supplies what a row *shows*:

| Source | Rows are chosen by | Names, translations, artwork come from |
|---|---|---|
| **TMDB** (default) | TMDB discover | TMDB |
| **TVDB** | TMDB discover | **TVDB** |

TMDB is the only provider that can *generate* a row at all — its discover endpoint
is what answers "90s action on Netflix", and TVDB has no equivalent filter engine.
TVDB does have authoritative per-title content (name, translations, year,
artwork), keyed by the IMDb id every row already resolves for its poster. So with
the content source on **TVDB**, every catalog in the app and in Nuvio shows TVDB's
titles in the language set in Settings; the rows themselves — which titles are in
them — stay TMDB's.

Details that make it safe to switch:

- The title's `id` stays `tmdb:` — row membership, watchlist pins and the title
  modal do not move when the source does.
- TVDB needs to be enabled **with a key** (Settings → Trackers & providers). Asking for TVDB
  without one falls back to TMDB content rather than serving blank rows, and
  `/addon-status.json` says what is actually in force: `contentSource` (asked),
  `contentSourceActive` (in force) and `contentSourceStats` (how many titles were
  upgraded).
- Lookups are bounded to the first 8 titles of a row, cached for a day, and fail
  soft — a title TVDB cannot answer for keeps its TMDB content instead of dropping
  out of the row.
- When TVDB is the source it owns the artwork too: it runs after the poster
  service, so the poster pattern only stands for titles TVDB had no art for.

TVDB's own API shape is written from its published spec and was never exercised
against a live key, so `contentSourceStats` is the thing to look at once you add
one.

### Sources are read on the server

`POST /api/source` fetches an add-on's `manifest.json` (or a repository's
`repo.json` → `plugins.json`) **from the server**, which is what makes third-party
sources work: a browser is blocked by CORS from reading another host's manifest,
and a CloudStream repo lives on `raw.githubusercontent.com`. A GitHub URL is
translated to its raw files (trying `main`, then `master`), and every plugin in a
repo is listed as a provider. Verified against live hosts — Cinemeta returns its
5 catalogs, and `recloudstream/extensions` returns its 5 plugins.

## Desktop app

An Electron shell around the covers and catalogs, sharing the same server via
`startServer()` from `serve.mjs`:

```sh
npm start           # opens the Electron window
npm run start:web   # the browser version of the same UI (prints a url)
```

**`npm start` opens the window; `npm run start:web` (a.k.a. `npm run preview`)
prints the url.** They are the same server and the same UI — the only difference
is which shell shows it, and `npm start` fetches Electron's binary once if a
previous install skipped it. `cd desktop && npm start` does the same thing.

`desktop/ui/` is plain web code, so the **same UI is also the web app** — it is
served at `/` (redirects to `/app/`) by `serve.mjs`, where it talks to the server
on the same origin.

### Run it: the steps

On your own machine, from the repository root:

```sh
# 1. nothing to install to *look* at it — the app ships its own server
#    (Node 20+ is the only requirement)

# 2. give it a TMDB key, once (either of these; the app also writes it back)
TMDB_API_KEY=your_key npm start

# 3. open the desktop window
npm start

# — or the browser version of the same UI, on http://127.0.0.1:4173/app/
npm run start:web
```

`npm start` fetches Electron's ~100MB binary on the first run only, so a fresh clone
needs no separate install step. `npm run desktop:install` does just that half and
exits. If you only want the Android target, `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`
inside `desktop/` skips the binary.

**Android TV / APK.** `desktop/capacitor.config.json` sets `webDir: "ui"`, so
Capacitor ships `desktop/ui` — `app.js`, `style.css`, `index.html`, `config.js` and
now `vendor/hls.min.js` — as the app's assets:

```sh
cd desktop
npm run android:sync     # cap sync android — copies ui/ into the Android project
npm run android:build    # ./gradlew assembleDebug
npm run android:apk      # ./gradlew assembleRelease
```

The APK is a thin client with no Node server on the device, so point it at a
hosted addon first: set `window.AUTOCAT_HOST` in `desktop/ui/config.js`, *then*
`android:sync` (the sync is what copies `config.js` into the build).
`desktop/android/app/src/main/assets/public/` is git-ignored — it is generated by
`android:sync`, not source.

**Live streams.** The player needs no setup: `hls.js` is vendored at
`desktop/ui/vendor/hls.min.js`, so both the Electron window and the APK play HLS
with no CDN. To refresh that copy after a version bump:

```sh
cd desktop && npm install hls.js@^1 && cd .. && npm run vendor:hls
```

### Test it as an Electron app

**It cannot run on the sandbox** — Electron opens a window, and there is no display
here, so the preview url is the *web* app (`serve.mjs` + `desktop/ui`). To run the
real desktop shell, do it on your own machine:

```sh
npm start            # from the repo root; downloads Electron once, then opens the window
```

`main.js` starts the embedded server with `port: 0` (the OS picks a free port) and
loads the UI **from that server** — `http://127.0.0.1:<port>/app/`. Loading it over
http instead of `file://` keeps every request same-origin, so the catalogs, the
cover images and the add-on / plugin / repository lookup (`POST /api/source`) work
in the desktop app exactly as they do in the browser preview. The Electron app is
fully self-contained and needs no deployed host, unlike the APK. Only the *first*
run needs a TMDB key (environment variable or Settings → Trackers & providers → TMDB).

- `main.js` calls `startServer({ port: 0 })`, so the app picks its own free port
  and never fights the preview server. Nothing to configure.
- **First run needs a TMDB key.** `addon/settings.json` is git-ignored, so a fresh
  clone has no key and the rows come up empty. Either put the key in the
  environment before starting:

  ```sh
  TMDB_API_KEY=your_key npm start
  ```

  or paste it once in the running app under **Settings → Trackers & providers → TMDB**,
  which writes it to `addon/settings.json` for every later run (the Electron app
  and the preview share that file).
- **A missing Electron binary installs itself.** `npm start` runs
  `scripts/start-desktop.mjs`, which sees that Electron's binary is not in place,
  installs the desktop dependencies (clearing `ELECTRON_SKIP_BINARY_DOWNLOAD` for
  that run) and — because npm 11.16 / 12 block dependency install scripts unless
  they are approved — runs Electron's own installer
  (`node node_modules/electron/install.js`, what the blocked postinstall does)
  when the binary is still missing. `desktop/package.json` also lists `electron`
  under `allowScripts`, so npm's own postinstall works. `npm run desktop:install`
  does just the install half.
- **A headless machine cannot launch the window** — Electron needs a display. On a
  desktop OS it just opens; over SSH/X-forwarding you get a blank
  `Missing X server` style failure, which is the environment, not the app.
- Only the Capacitor CLI is needed for the Android target, so you can skip
  Electron's binary download with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`.

### Android TV APK

The Android project at `desktop/android/` is a **Capacitor 6 Android TV (leanback)
app**, already generated and TV-configured (`android.software.leanback`, no
touchscreen requirement, a `LEANBACK_LAUNCHER` intent-filter so it appears on the
TV home screen, landscape pinned, D-pad navigation in the UI).

**1 — point the app at a server.** The APK is a *thin client*: the catalog server
is Node (`serve.mjs`) and cannot run inside an APK, so the app needs a host. Set it
in `desktop/ui/config.js`:

```js
window.AUTOCAT_HOST = "https://4173-your-preview-host.e2b.app";  // the preview url works
```

Use **https** — Android blocks cleartext HTTP, and `serve.mjs` advertises `https`
for any non-local host, so a deployed copy works as-is. With it empty the app
starts and says it cannot reach the server instead of failing silently.

**2 — build.** This needs a JDK 17 and the Android SDK (`ANDROID_HOME` set) — it
**cannot** be built on the Freebuff sandbox, which has no `java` and no SDK:

```sh
cd desktop
npm install
npm run android:sync    # embeds desktop/ui into the APK assets (run after step 1)
npm run android:build   # debug → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:apk     # release build
npm run android:open    # open the project in Android Studio instead
```

On the sandbox `npm run android:build` stops on the first line with
`ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH` —
that is the only missing piece; the project, TV manifest, embedded UI and Gradle
wrapper are all in place.

**2b — or let GitHub build it for you.** `.github/workflows/android-apk.yml` runs
the same three steps on a runner that *has* a JDK and the Android SDK, and uploads
the debug APK as a downloadable artifact. From **Actions → Android TV APK → Run
workflow**, then open the run and download `nuvio-collections-debug-apk`. Set the
repository variable `AUTOCAT_HOST` (Settings → Secrets and variables → Actions →
Variables) to the deployed host and it is baked into the APK; with the variable
unset the app still builds and starts, and reports that it cannot reach the
server rather than failing silently.

**3 — install it on the TV.** Either sideload the APK:

```sh
adb connect <tv-ip>:5555
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

or copy the APK to a USB stick and install it with a file manager on the device.
It then appears in the Android TV **Apps** row (leanback launcher), and the D-pad
(arrows, Enter, Back/Escape) drives the whole UI.

The UI is Nuvio-shaped:

- **Start-up is two questions, in order: who, then how.** The app opens on the
  **profile screen** (`#/profiles`) — *who is watching* — and the **mode screen**
  (`#/modes`) follows it, *how you want to watch*, with **Movies & Shows** and
  **Live TV & Sports** as tiles. Picking a mode enters Home. The **profile icon** in the
  top bar reopens the profile screen at any time, and the mode screen carries a
  **Switch profile** button back to it (the picker itself has no *Manage profiles*
  button). A profile is a **name and a drawn mark, not an account** — no password,
  nothing that leaves the machine — and it is made, renamed and removed **on the profile
  screen itself**: a dashed **Add profile** slot sits after the tiles, the name is edited
  in place inside its own tile, and *remove* is offered only while another profile is
  left to enter with. Each profile has an
  **avatar** — a drawn mark, not a letter: a **clapperboard** for Movies & Shows, a
  **screen taking a signal** for Live TV & Sports, and a person for anything else, so
  a profile added later still gets one. The avatar is SVG in the SVG namespace
  (`svgNode`), sized as a share of the accent disc, so the same mark works at 84px on
  the picker and 46px in Settings.
- **Settings → Profile has an Edit button.** The profile in use is shown with its
  avatar and name, and **Edit** sits on that row. Pressing it opens the editor — one
  switch per **media row**, one per **card**, and one per **catalog row inside each
  card** — and the button becomes **Done**. The editor used to be a bare toggle with a
  paragraph under it, so "there is a profile editor at all" was something you had to
  notice. Closed, nothing is hidden; the picks live per profile in `localStorage`.
- **Top bar** — no app logo/label, **no Movies/Shows tabs** and **no counts line**.
  On the left, a **profile icon** (a person glyph — no name pill, no dropdown), the
  **calendar** button, then a **vertical divider**; on the right, a **search** button
  and **Settings** — a **real cog**, not the centre-dot-with-spokes glyph that read
  as a brightness control.
- **The page keeps its place** — every screen remembers its scroll. Going back
  returns to where you left; re-rendering the screen you are already on (a pin, a
  filter, a settings toggle, a row switch) does not move the page at all, and a
  screen you have not opened starts at the top. The browser's own scroll restore is
  switched off so the two cannot fight over it.
- **A poster plate is never left empty** — a calendar plan stores only the fields
  the app draws and any picture can fail to load, so a card with no artwork draws the
  title's own **initials** instead of a dark rectangle.
- **The grid has no holes.** `collectionGrid` puts a `v-divider` before the watchlist
  card: in the **rows** layout that is a 1px rule between two cards, but in the
  **grid** layout it became a grid item and stretched into a card-shaped hole — the
  "one card gap". It is drawn in rows and left out of the grid.
- **Live TV & Sports** — the second profile is a **different app**, and its Home is
  **two cards**. The first is the **Guide** (a preview of what is on now, opening the
  full grid); the second is **Categories** (the playlist's own categories with their
  channel counts, opening `#/categories`, then `#/categories/<group>` for one of
  them). Under the two cards are the same two buttons as Movies & Shows, named
  **Live TV** and **Sports**, and then a card per category holding a row of
  **channel tiles** (logo, name, group and country). The **Guide** is a
  TiviMate-shaped grid: a time ruler across the top with a "now" marker, a numbered
  channel column down the left, and one programme block per channel — real programmes
  with their times when an **XMLTV** URL is set, and an honest "no programme data"
  track when it is not. Clicking a channel opens its page (logo, groups, country,
  what is on now and next, and its stream URL). **Search** in this profile searches
  **channels**.
- **Live TV settings** — entering that profile **replaces the settings screen
  entirely**: **Source** (the **Premium & DTH catalogue** with a provider picker,
  your own **M3U** URL or file, or an **Xtream Codes** host/username/password),
  **Countries** (**All countries**, or pick the ones you want — **the whole list**, where the picker used to be cut at
  sixty countries, which on an alphabetical list stopped around **Denmark** and left
  everything after it unpickable), **Guide & EPG** (an
  XMLTV URL, `.xml` or `.xml.gz`), **Refresh** (follow the content setting, or
  15/30/60/180 minutes), then **Profile & playback** and **This device**. The
  catalogue is shipped with the app, so the provider and country pickers work with
  no network and nothing to log in to; picking a provider adds its lineup to Live TV
  and to the Guide, and each chip says whether that provider ships a public guide.
  **Layout** is
  the real Layout pane (it used to fall through to the Profile pane, so the tab said
  "Layout" and showed the profile). Content, Posters, Providers, Add-ons, Plugins,
  Tracking and AI do not apply to a live playlist, so they are not offered while it
  is active; switching back restores them. The playlist URL and the password are
  kept **server-side** — the browser is told only whether they are set.
- **A channel plays in the app.** Its page carries **Play** as well as *Copy link*,
  and the player is the app's own: an `.m3u8` live stream is handed to it and
  `hls.js` — **vendored at `desktop/ui/vendor/hls.min.js`**, not pulled from a CDN,
  so the Electron window and the APK work offline — decodes it. Browsers that play
  HLS natively (Safari, Android TV) use their own player. Escape or **Close**
  returns to the page you came from.
- **Live TV Home opens on a banner, then the switch, then two cards, and nothing
  else.** The profile had no banner of its own — it began at the buttons. It now
  wears the same box the Movies home does: a kicker naming the tab (**Live TV**, or
  **Sports** on that tab), the **channel's name**, what is on it now (or its group
  while no guide has been read), its own groups as chips, and its **logo** on the
  right, centred on the app's flat panel — the frame is a button into that channel.
  There is nothing to rotate the way the Movies banner refreshes a backdrop: a logo
  and a name are already stable, so one channel is drawn per launch. The **Live TV /
  Sports** buttons come next, and the **Guide** and **Channels** cards sit
  **under them** — the same reading as the Movies home, where the Movies/Shows buttons
  are above the cards. (They were the other way round, so the cards floated over the
  tabs that decide what they show.) The **wall of one channel row per category is
gone**: the profile used to fetch the lineup and then a second request per category to
  draw twelve rows nobody asked for, which is also why the first screen was slow. The
  second card is **Channels** — the channels themselves with the count — not a
  *Categories* card that listed category names you had not seen yet. The **Sports**
  tab is the same two cards over the lineup filtered to sport (by channel name and
  group), and it falls back to the whole list rather than showing an empty screen.
- **Home** — a **hero** panel, then **Movies** and **Shows** buttons, then the cards.
  There is **no heading under the buttons**: the switch already says which row you
  are on, so the *Movies* / *Shows* line that used to be drawn beneath it was a
  second label for the same fact, and it pushed the grid down for nothing.
  Movies is the default; picking Shows swaps both the cards *and* the hero banner.
  The banner carries no counters and **no Explore button** — it is a billboard, and
  the frame *is* the way in: clicking the artwork opens the title on it.
  The banner reads **left to right: text, then picture**. The wording and the
  **card's own catalog tags** sit on the **left**, and the artwork holds the
  **right-hand slot** — it was moved to the left by mistake and is back. The frame is
  a **button**: the landscape shot is the way into the title on it (falling back to
  the collection before the shot arrives).
  The banner is **its card**, and it says so: **Spotlight** above — in the column's
  top-left corner, a step larger than the same caption elsewhere — then the **card's
  title** where the film's name used to be, then only that card's own tags. The title and
  the tags are **centred** in that column, across it and down it; the live channel banner's
  column stays against the left edge. There is
  **no Explore button** and **no other cards' labels** on it, and the picture's
  rotation never overwrites the title with the name of whatever film is on screen.
  The frame wears **no generated vector scene at any point**: while the backdrop is on
  its way you see the app's own flat panel, never the collection's cover.
  A tile is opened by clicking its **artwork**, not the whole tile.
  The cards are always in the published order: *pick the cards for you* chooses
  **which** cards appear, never their order, so Home never looks shuffled.
- **Watchlist** — the first card, holding the three states a title moves through:
  **Plan to Watch**, **Watching**, **Watched** — and nothing else. Its frame holds
  **two posters**: it is three rows of *your own* pins, and a wider wall of them read
  as a chart rather than as "what you are watching". Pin a title from
  its modal (open any title and pick a state; picking the current state unpins it)
  and it lands in the matching row, tagged with its state. The three rows scan
  *everything* in that state; a *calendar* plan is not a watch state, so it never
  appears here. Same rows the addon publishes, so Nuvio sees them too.
- **Collection** — its cover, then its catalogs as rows. Each row names its catalog
  and carries an **Explore** button *on the label line* — there is no shuffle icon
  there, because reordering a card's catalogs is not what "shuffle" means.
  **Explore** scrolls endlessly, and its header carries only the card label and the
  catalog label. Under that header sits **one sample row** — a random 12-title draw
  from the catalog — drawn exactly like a normal row: **no label of its own and no
  control of its own**. A **horizontal divider** closes it off from the catalog
below, and there is **one Shuffle button, at the top right of the header**, which
draws a fresh sample. Everything under the divider is the normal, endlessly
scrolling catalog.
- **Scrolling** — the wheel moves the row of cards under the cursor sideways, and
  it never falls through to the page: at either end of a row the row simply stops,
  so the screen cannot be dragged away while you are browsing titles. The page
  scrolls normally anywhere the cursor is *not* over a row. Rows carry no visible
  scrollbar (the strip is still scrollable — it just is not drawn). Shift+wheel and
  trackpad horizontal gestures keep their normal meaning.
- **How deep a row goes** — the addon reads TMDB 20 titles at a time and keeps a
  growing, cached pool per catalog, so each window of 40 continues where the last
  stopped and repeat requests cost nothing. A row can serve up to **300 titles**
  (15 TMDB pages per query); the `◆ Top 10` rows stop at **ten** and the Discover
  **Discover Plus** card's rows at **twenty-five**, because that is what they claim — and
  nothing else is capped, OTT cards included. Episode-cap
  rows are bounded by what TMDB actually has — the `4 Episodes` row is short
  because few shows are that short. A strip in a collection keeps loading too:
  scrolling it to the end asks for the next window instead of stopping.
- **Sources** — opening a title's **Find sources** draws the providers as a graph:
  provider nodes linked to the add-on, plugin or repository that returns them, and
  the sources interlinked.
- **Calendar** — a real **month grid**: pick a day to see what releases on it,
  with previous/next month navigation (not a list of Latest/Newest rows).
  A day lists **films and shows together** (each card says which it is), clicking the
  selected day again **deselects** it, and the grid carries no captions — no
  "everything releasing this month", no "N titles" line over the results.
  Every release carries its own **Plan to Watch** pin, and it is a **toggle**: a
  planned release says **planned** and pressing it puts the plan back. (It was
  briefly add-only, which left a plan you had changed your mind about with no way
off the calendar.) It is deliberately not a watchlist row: a calendar pin is
**plan-only** (a dated release you mean to get to), while the Watchlist card lists
every Plan to Watch, Watching and Watched title whatever its date. Calendar plans
live in their own stored row (`calendar-plans`), so pinning a release never fills
the Watchlist card's Plan to Watch row with something you did not put there. **The
grid no longer carries a *Recently planned* shelf** — the plans live on the day they
belong to.
- **Search** — a **full-width bar** wearing the app's own panel styling. **No
  magnifier**: the bar is one flat panel and the field fills it, with the filter
  control that closes it as a **named control** — the funnel *and* the word
  **Filters**. The field inside the bar draws no border of its own — it used to carry
  `text-input` as well as `search-input`, so a second bordered box was painted inside
  the bar — and it draws **no focus ring of its own** either; the accent ring belongs
  to the whole bar (`:focus-within`), because the bar is the control. It searches
  **titles** (TMDB, through the server). The screen used to open a *Collections* and
  a *Catalogs* list under the results — a list of **labels** standing where the
  contents should be — and **it is gone**: the suggestion dropdown still offers a
  collection or a catalog to jump to, but the page itself is the titles. They come
  back as two lists, **Movies** then **Shows**, never one mixed grid:
  the row type is the first thing you want to know about a result. A query reads
  **six pages of TMDB per row type** (20 results a page) to fill the first window, and
  then **the results page themselves in**: a sentinel at the foot of the list reads the
  next window as it comes into view, so the count under each group keeps climbing and
  the list never appears to stop at 120. There is **no ceiling and no button** — the
  *Load more results* control is gone, because a search that ends in a button is one
  that looks finished. It used to keep only its first page, which is why "disney+"
  looked like it had barely twenty results. Typing shows **suggestions**, and this is
  what the Ask box feeds.

  **Which page the next window starts at is the server's answer, not the app's
  arithmetic.** A window reads up to six TMDB pages and stops early at a short one —
  a search for forty titles is over on page two — so "six pages further on" stepped
  straight past the end of a short result set and the button appeared to do nothing.
  The response now carries `next`, the page to continue from (null when the row type
  is finished), and the button hides on that instead of on a number the client picked.
- **Search filters are four lines — Type, Country, Genre, Time — then Sort.** A
  **country** already narrows the ground a *continent* did, a **mood** is a genre
  under another name, and a **service** filter only means anything once you have said
  where you are; so **Continent, OTT, Mood and Theme are gone**, four fewer lines of
  chips to scroll past for an answer the lines under them already give. **Country**
  and **Genre** hold every choice, and both are the **same two-row window the card
  tag lines use**: a pair of up/down arrows stepping them a row at a time, each dimming
  at its own end, with the chip you picked scrolled into view. (They used to clamp to
  two rows behind a *More (N)* pill that expanded the line where it stood, which
  turned one filter into a wall of chips and pushed everything under it out of the
  panel.) The choices are the app's own **pills** — the same flat fill the tag lines
  and the card labels use, 999px radius, solid accent when chosen, no outline — and
  they are the cards' own vocabulary, served from `/search/filters.json`, so the panel
  can never offer a genre or a country TMDB does not have. An unknown value in a
  hand-written URL falls back to "all" instead of emptying the screen. Text searches
  can only honour what TMDB's search endpoint supports (genre and year); the screen
  says so when a filter can only apply while browsing.
- **Settings**, grouped, with the group name over its tabs, and **one tab per
  question** — nothing shares a pane with something else:
  **This profile** — **Profile** (only the profile you are on — switching happens on
  the switch-profile screen — plus **what this profile shows**), **Content**
  (SFW / NSFW and the refresh clock), **Posters**, **Appearance & layout** (the
  accent colour, how much the app moves, and how Home holds its cards — one tab,
  because all three answer "how does it look?");
  **Where it comes from** — **Trackers & providers** (the **trackers first**, in
  three groups: **Movies & TV** — Trakt, SIMKL, Letterboxd — then **Anime**
  (MyAnimeList, AniList) and **Asian drama** (MyDramaList) behind a divider; below
  them the **providers** — TMDB / TVDB / MDBList keys *and* which of them supplies
  the row content), **Add-ons & plugins** (a Stremio add-on read through
  `manifest.json`, and a Nuvio plugin's scrapers — one tab, two forms);
  **Assistant** — **AI** (the free providers — Groq Cloud, Google AI Studio,
  OpenRouter, Cerebras Cloud — each with its key box, a *Test connection* and a
  *Load models* that turns the models the provider really serves into pickable
  chips, plus the poster options and a text/voice ask box).
  There is no **Server** tab. **Posters** has no key box either: BetterPosters
  (bttr.cc) needs no key, and the one that does (RPDB) carries it inside its own
  URL — so the pane is a service picker (BetterPosters, RPDB) plus the URL pattern,
  which is the single input a poster service needs when its key lives in it.

**Settings → Content** is the **SFW / NSFW** switch (mapped to TMDB's
`include_adult`, and enforced on the addon's side for the endpoints that ignore
it), plus **Refresh catalogs & metadata** — 15 / 30 / 60 / 180 minutes or *Only
when you ask*, with a **Refresh now** button. The banner has its own clock and it
is not this one: **Spotlight moves every ten seconds** by default, at random, and
freezes while the cursor is on it. Every **card** redraws its artwork **on app
start** (one draw per launch), not on the refresh clock — a refresh re-reads the
rows, and the pictures stay with the launch. Both pickers that used to sit here are gone:

- **The app-language picker** read as if it changed the regional OTT cards and it
  never did — nothing about a row's *membership* is language-dependent. Rows are
  served in English, and the server's `language` still rides on every catalog URL
  as `?lang=`.
- **The country picker** only ever named the *regional OTT services* rather than
  changing what a row holds. It is still real server state (`/settings` →
  `country`, and the cards still follow it), but it is not a switch in the app.
  Setting it is a one-line POST:
  `curl -X POST localhost:4173/settings -H 'content-type: application/json' -d '{"country":"NZ"}'`.

**Content source lives in Settings → Trackers & providers.** TMDB and TVDB are providers; the
switch that says *which* one supplies the titles inside a row belongs next to the
keys that make it possible, not in a second place that drifts from it:

- **Content source** — TMDB (default) or TVDB. See *Content source* above: TMDB
  builds the rows either way, TVDB supplies their titles, translations and art.
  Choosing TVDB without a TVDB key says so in place, and the app keeps serving
  TMDB content rather than empty rows.

**Settings → Profile** also holds **what this profile shows** — *pick the rows,
cards and catalogs for this profile*:

- Off (the default) shows everything, so nothing disappears on its own.
- On gives one switch for **Movies** and **Shows**, one for **every card**, and one
  for **every catalog row** inside each card (indented under it). A hidden card is
  gone from Home and its catalog rows are gone from the card; a hidden row is gone
  from the card and from its catalog chips.
- The editor is **sectioned** rather than one long list: a *Media rows* block, then a
  *Cards* block where each card is its own panel holding that card's catalog
  rows, each box headed by its own switch and how many of its rows are on (`npm run
  test:ui` pins the structure).
- Picks are per profile and live in `localStorage` (`nuvio.visibility`). The same
  master switch is drawn in **Settings → AI** as *Pick the cards for you*, because
  that is where it used to live.

**Settings → Appearance & layout** is the accent and the motion:

- **Accent colour** — the colour the app is painted in. Every tint in the
  stylesheet is built from `--accent-rgb` and every gradient from `--accent-deep`,
  so one pick re-tints buttons, chips, highlights and the calendar
  together instead of leaving half the UI gold. Gold stays the default.
- **Motion** — *Follow system* (default, honours `prefers-reduced-motion`),
  *Always animate*, or *No animation*. It covers the screen-to-screen transition,
  hover lifts and the row highlight in one switch.

Both persist in `localStorage` (`nuvio.accent`, `nuvio.motion`) and are applied as
CSS custom properties on the document root.

Country, content source, the safety switch and the server-side language persist
through `POST /settings` (they are read by the addon, not just the page), and
mirror into `localStorage` for instant feedback.

**Add-ons** and **Plugins & repositories** are two separate sections. Stremio/Nuvio
add-ons (which this project is) are checked live — the app fetches `manifest.json`
and reports the add-on name and its providers. Nuvio plugins and CloudStream
repositories are stored and listed but not fetched (that is what used to show a
false "not reachable — HTTP 404"): CloudStream plugins are Android APKs and Nuvio
plugins run inside Nuvio, so only a native build can run them.

Provider and tracking keys are written to `addon/settings.json` (git-ignored) so
the server can use them; the public response never returns a key, only whether one
is set, and **Check connection** verifies it against the provider. Pasting a TMDB
key changes the live catalogs immediately with the same names; enabling MDBList
enriches every row's ratings from MDBList.

**CloudStream repositories are read live**: a repo URL is resolved to its
`repo.json` → `plugins.json` and each plugin is listed as a provider, so a repo
no longer reports a bare "not reachable — HTTP 404" for not being an add-on.

**Android TV target: a standalone installable app (not a browser).** The UI is
built to be wrapped into an APK; standalone means the server must run inside the
app (bundled Node) or be supplied by a host — see `desktop/README.md`.

## Use

Reference a PNG for maximum app compatibility, or an SVG where vector is welcome:

```
covers/movies/on-the-board.png
covers/shows/watchlist.svg
```

`covers/manifest.json` lists every cover with its title, subtitle (catalog name), row and paths.

A side-by-side exploration of alternative imagery directions lives in `covers/_options/` and is
regenerated with `node scripts/preview-imagery.mjs`.

## Regenerate

```sh
npm run generate   # cd scripts && npm install && npm run generate
```

The generator reads the bundled Inter fonts from `scripts/fonts/`, writes every SVG and PNG,
and fails the run if any title would overflow the frame. The collection list lives in
`scripts/collections.mjs` — the cover generator **and** the addon both read it, so the art and
the rows can never drift apart. Fonts: Inter by Rasmus Andersson (SIL Open Font License, see
`scripts/fonts/Inter-LICENSE.txt`).
