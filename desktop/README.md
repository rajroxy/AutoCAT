# AutoCAT — desktop app

An Electron shell around the collection covers and catalog rows. It boots the
same server the web preview uses (`../serve.mjs`) on a random local port and
opens the app UI.

```
desktop/
  package.json      Electron app (devDependency: electron)
  main.js           main process — starts the embedded server, opens the window
  preload.cjs       tiny context bridge (flags the desktop shell)
  ui/               THE APP UI — plain web code (HTML/CSS/JS)
    index.html
    style.css
    app.js          home (icon boxes) · collection · settings
    config.js       API base override for the browser / Android TV builds
```

## Run

From the repo root — this is the command that opens the desktop app:

```sh
npm start          # starts the embedded server on a free port, opens the Electron window
```

Or from this folder:

```sh
cd desktop
npm start
```

**`npm start` opens the window — it never prints a server url.** The browser-only
version of the same UI is a different command:

```sh
npm run start:web  # prints "Nuvio gallery + catalog addon → http://0.0.0.0:4173"
```

Use `start:web` (or `npm run preview`, which is the same thing) when you want the
web app in a browser at `/app/`; use `npm start` when you want the desktop app.

`npm start` fetches Electron's binary once if it is missing, so a fresh clone does
not need its own install step — including on **npm 11.16 / 12**, which blocks
dependency install scripts unless they are approved. `desktop/package.json` lists
`electron` in `allowScripts` so npm runs its postinstall itself, and when a clone
predates that (or the approval is missing) `npm start` runs Electron's own
installer — `node node_modules/electron/install.js`, exactly what the blocked
postinstall would have done — instead of failing with *"Electron failed to
install correctly"*.

Requires **Electron ≥ 28** (the main process is an ES module).

**The first run needs a TMDB key.** `addon/settings.json` is git-ignored, so a
fresh clone has none and every row comes up empty. Put it in the environment
(`TMDB_API_KEY=your_key npm start`) or paste it once in the app under **Settings →
Providers → TMDB**, which writes it to `addon/settings.json` for every later run —
the Electron app, the browser preview and the addon all share that file.

Installing only the Capacitor CLI? `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`
skips Electron's ~100MB binary.

## Screens

Routing mirrors Nuvio:

| Screen | Route | Shows |
|---|---|---|
| Switch profile | `#/profiles` | **where the app starts** — pick `Movies & Shows` or `Live TV & Sports` |
| Home | `#/` | a **hero** panel, then **Movies / Shows** buttons, then the cards |
| Collection | `#/c/<key>` | the collection's cover + **its catalogs as rows**, each with **Shuffle** and **Explore** |
| Explore | `#/x/<key>/<catalogId>` | **one shuffled row** on top, then a divider, then the catalog **scrolling endlessly** — a **watchlist** catalog is just its header and your titles |
| Sources | `#/s/<id>/<name>` | providers as a **graph**, grouped by add-on / plugin |
| Calendar | `#/calendar` | a real **month calendar** of releases (films *and* shows) |
| Search | `#/search` | searches **titles**, collections and catalogs — in the Live TV profile it searches **channels** |
| Guide | `#/guide` | the Live TV profile's **TiviMate-shaped grid**: time ruler, channel column, programme blocks |
| Categories | `#/categories` | the Live TV profile's own categories, each with its channel count |
| Category | `#/categories/<group>` | one category's channels |
| Channel | `#/channel/<id>` | one channel: logo, groups, country, now/next, and its stream URL |
| Settings | `#/settings` | grouped, one tab per question: **This profile** (Profile · Content · Posters · Appearance & layout) · **Where it comes from** (Trackers & providers · Add-ons & plugins) · **Assistant** (AI) |

**Live TV & Sports replaces Settings entirely** while that profile is active:
**Source** (the **Premium & DTH catalogue** / **M3U** URL / **Xtream Codes** login),
**Countries** (**All countries**, or pick them), **Guide & EPG** (an XMLTV URL, plain
or gzipped), **Refresh** (follow Content, or 15/30/60/180 minutes), then **Profile &
playback** and **This device**. The default is not a public free-TV directory — it is
a catalogue of real DTH, cable and premium operators (`addon/dth.mjs`), shipped with
the app: pick the providers you subscribe to and Live TV draws **their** lineup and
**their** guide, because a provider's XMLTV feed declares its own channels as well as
its schedule. Streams are never shipped — a premium stream belongs to a subscriber's
box — so your own export (M3U or Xtream) supplies them and the two meet on
**`tvg-id`**. **Countries** scopes both Live TV cards. Content, Posters, Providers,
Add-ons, Plugins, Tracking and AI do not apply to a live playlist and are not
offered there; switching back restores them. The playlist URL and the Xtream
password are kept server-side — the page is told only that they are set.

**Live TV Home opens on a banner, then the switch, then two cards, and nothing
else.** The profile had no banner of its own; it now wears the one the Movies home
has — a kicker naming the tab (**Live TV**, or **Sports**), the **channel's name**,
what is on it now (or its group while no guide has been read), its groups as chips,
and its **logo** on the right, centred on the flat panel, with the frame a button into
that channel. A channel's picture is its logo and its name, and both are already
stable, so one channel is drawn per launch rather than rotated. The **Live TV /
Sports** buttons come **next** and the two cards sit **under them** — the same reading
as the Movies home. The cards wear the same box a Movies card does: a 16:9 frame
holding the first few rows of what is inside, with the name and a line under it. They
are the **Guide** and the **Channels** — the channels themselves with their count, not
a *Categories* card that listed category names you had not seen yet.

**The wall of one channel row per category is gone.** The profile used to fetch the
lineup and then a second request per category to draw a channel row for each — a dozen
calls to paint rows nobody asked for, and a long list under the cards. The lineup is
read **once** now, and the categories come from the server's own group list, which is
what the Channels screen draws its tiles from. The **Sports** tab is the same two cards
over the lineup filtered to sport (by channel name and group), falling back to the
whole list rather than showing an empty screen. **A channel plays in the app**: its page
carries **Play** as well as *Copy link*, and HLS is decoded by `hls.js` **vendored at
`ui/vendor/hls.min.js`**, so the Electron window and the APK play with no CDN
(Safari and Android TV use their own player). Escape or **Close** leaves it.

**Content** is one switch: SFW / NSFW, plus **Refresh catalogs & metadata**
(15 / 30 / 60 / 180 minutes or *Only when you ask*, and **Refresh now**). The
banner runs on its own clock — **Spotlight moves every ten seconds** at random and
freezes under the cursor — and every **card** redraws its artwork **on app start**,
not on the refresh clock. **Both pickers are gone.** The language one
read as if it moved the regional cards (it never did — rows are served in English
and the server's `language` still rides on every catalog URL as `?lang=`), and the
country one only ever named the regional OTT services. The country is still real
server state (`POST /settings {"country":"NZ"}`), it is just not a switch in the app —
and it no longer decides what the Regional OTT cards hold: those publish every region's
services, each row carrying its own region.

**Content source lives under Providers.** TMDB and TVDB are providers; which one
supplies the titles inside a row belongs next to their keys, not in a second
section that drifts from them.

**Profile** also holds **what this profile shows**: *pick the rows, cards and
catalogs for this profile*, off by default. On, it gives one switch for Movies and
Shows, one per card, and one per catalog row inside each card (indented under it),
remembered per profile in `localStorage` (`nuvio.visibility`). The editor is split
into a **Media rows** section and a **Cards** section, and inside *Cards* each card
is its own panel with its catalog rows in it — so "which rows belong to
this card?" is answered by the box they sit in, and the block's own switch reports
how many of its rows are on. The same master switch is drawn in **Settings → AI** as
*Pick the cards for you*.

**Appearance** is the accent colour (the whole app is tinted from `--accent-rgb` /
`--accent-deep`, so one pick re-tints buttons, chips, highlights
together — Gold is the default, not the only colour) and **Motion** (*Follow
system* / *Always animate* / *No animation*, covering the screen transition, hover
lifts and the row highlight).

**Profile picks the app up.** A launch with no specific link lands on the
**switch-profile screen** (`#/profiles`), listing the two profiles as tiles; picking
one enters Home. At any time the **profile icon** in the top-left reopens that
screen; the picker carries no *Manage profiles* button.

**Settings → Profile** shows **only the profile you are on** — its **avatar**, its
name, and an **Edit** button — and it lists no other profile and offers no switch.
Switching happens on the switch-profile screen, which the top-bar icon opens. The
avatar is a **drawn mark**: a clapperboard for Movies & Shows, a screen taking a signal
for Live TV & Sports, a person for anything else (SVG in the SVG namespace, so it
paints). **Edit** opens the profile editor — one switch per media row, per card, and
per catalog row inside each card — and becomes **Done**; closed, nothing is hidden.

**One surface language, on every screen.** Nothing is drawn with a hairline: cards,
tiles, the banner, panels, fields, buttons and the rail are single flat fills that
lift or brighten under the cursor, and the accent goes on what you act on — the chosen
chip, the primary button, a focused field, the letter you picked, the profile you are
on. The lines that remain mean something: the calendar's grid, the guide's ruler and
channel column, the section dividers, the plate on the tag arrows, and the ring around
a chosen colour. **One pill** carries every chip — a card's catalog tags, the search
panel's filter choices, the model chips — and **one voice** carries every caption: the
labels that used to be small-caps with letter-spacing (result heads, filter labels,
card subtitles, the guide corner, the calendar's weekday row) are bold sentence case.
The tag arrows are the deliberate exception to the flat pass — a stroked chevron on a
bordered, accent-tinted plate is what makes them read as something to press.

**Top bar:** no app logo or label, **no Movies/Shows tabs** and **no counts** (the
old `Movies & Shows · 21 collections · 534 catalogs` line is gone). On **Home** it
reads left to right as a **profile icon**, the **calendar** button, a **vertical
divider**, the **Home** tab, then **search** and **Settings**. Every one of those
controls is the same drawn 24px stroke icon (no emoji glyphs), and both dividers are
painted lines, not faint near-transparent ones. Settings is a **real cog** — the old
glyph was a centre dot with eight even spokes, which reads as a brightness/sun icon,
not as settings.

**The four doors are Home's.** The profile switch, the calendar, search and Settings
are all ways *into* something, and drawn on a card, a channel or a settings pane they
sat over the content as a second, unrelated set of controls — so the whole left-hand
group and both right-hand icons render on **Home only**. Every other screen carries a
**back arrow** instead, and nothing else of its own.

**The bar names the screen you are on.** Not Home, which keeps the clickable tab,
and not the screens that never had a title of their own (settings, search, the
calendar, the guide, the live screens), which wear the **arrow alone**. The three
that do name themselves put that name in the slot beside the arrow:

| Screen | The bar reads |
|---|---|
| Collection (card) | the **card's** name |
| Explore | the **catalog** you are inside — the genre, country or runtime chip you picked (`30–44 mins`) |
| Title | the **title** itself |

The name is **a touch larger and heavier than Home's tab** (`16px` / `800` against
`14px` / `700`) with the same **vertical rule** to its left. It is **text, not a
door**: it used to be a Home button, which threw you out of the card you were reading,
so it is now a `span` with no click, no hover and no focus stop. Leaving is the
**arrow's** job, right beside it.

A title's route is `#/t/<type>/<id>` — an id, not a name — so its page hands the name
in once its own data has arrived, and the bar draws again; a late answer from a screen
you have already left is dropped.

The **body breadcrumb is gone.** An Explore page drew `Runtimes › 30–44 mins` under
this bar as well; with the catalog now up here it was the same two words twice, so
the line — and the switcher that hung off it — went with the duplication. A **title
page** lost its big `h1` for the same reason: the name is in the bar.

**The title page's banner is artwork and nothing else, in a taller card.** With the name
gone and **Play** and the pins moved down onto the page, the banner holds one picture — and the card itself is **compact** (`min-height: 40vh`, so Play, the pins and Ratings fit the first screen), cropping from the bottom instead of the top — so a wide shot loses
less off its top and bottom instead of showing only its middle band. The picture is
never stretched: the art stays `cover`, at its own shape, and a title with no wide
shot keeps its poster **as a poster** — whole, rounded, shadowed, on a dark wash.
(Stretching the picture was tried and reverted: it slimmed every face in the frame.)
There is **no scrim**: it darkened the picture for a name and buttons that moved off
it, so every banner read as murky — artwork and nothing else means nothing dimming it.
**Play and the pins are the page's first row**, under the banner and **above the ratings**.

## Torrents

Most Stremio add-ons answer with **torrents** — an `infoHash`, a `fileIdx` and a list
of trackers — rather than with a URL. The server keeps them (`readStreams` in
`addon/streams.mjs` builds a **magnet** out of them) and the player opens the magnet
with **WebTorrent**, vendored at `ui/vendor/webtorrent.min.js` exactly the way
hls.js is (`npm run vendor:webtorrent`, which copies it out of
desktop/node_modules), so nothing is fetched from a CDN at play time.

The Sources drawer marks a torrent and says how many seeders it has; the swarm's own
peers / progress / speed ride in a note over the picture while it fills in, because a
torrent that has found no peers must not look like one that is playing. Only the
magnet is opened — a stream that names a video file (`fileIdx`, otherwise the
biggest video in the torrent) is streamed into the `<video>` element with
`file.streamTo`. Switching source or closing the player destroys the swarm.

A torrent is **not** a live channel: the live profile's channel streams are
continuous URLs, so a torrent handed to one is dropped rather than sitting at 0%
forever.

**The page keeps its place.** Every screen remembers where it was scrolled: going
back returns you to the spot you left, and re-rendering the screen you are already on
— a pin, a filter, a settings toggle, a row switch — does not move the page at all.
A brand-new screen starts at the top. The browser's own scroll restore is switched
off, so the two cannot fight over it.

**A poster plate is never left empty.** A calendar plan stores only the fields the
app draws, and any picture can fail to load, so a card with no artwork to show draws
the title's own **initials** instead of a dark rectangle.

**Movies and Shows are buttons under the hero banner.** Movies is selected by
default; picking Shows swaps both the cards *and* the hero banner to that row. The
banner shows no counters — only its **Explore** action.

The banner reads **left to right: text, then picture**. The wording and the card's
own catalog chips sit on the **left**, the artwork frame holds the **right-hand
slot** (it was moved to the left by mistake and is back), and the frame is a
**button**: the landscape shot is the way into the title on it (falling back to the
collection before the shot arrives).

The banner **is its card and says so**: **Spotlight**, then the **card's title** where
the film's name used to be, then only that card's own tags. There is **no Explore
button** and **no other cards' labels** on it, and the ten-second picture rotation
never overwrites the title with whatever film is on screen. The frame also wears **no
generated vector scene at any point**: while the backdrop is on its way you see the
app's own flat panel.

A **boot screen** covers the app until the first screen is drawn, then fades out — it is
a real element, so what appears behind it is a finished page and not an empty shell.
With *motion* off (or the system reduced-motion preference) it simply goes.

The banner calls itself **Spotlight**. It shows **one landscape picture** — a backdrop,
not a 2:3 poster, at `w1280` so a full-width banner is not blurry — drawn from the
row that means "out now": **Now Playing** on movies, **On the Air** on shows. Every
ten seconds it moves to another title **in that same catalog** (never the one already
on screen), so the banner refreshes its picture; it does not walk the cards, and its
name is the name of the title on it. It used to move to a different card every ten seconds,
and **holds still while the cursor is on it** — reading it is a reason for it not to
change under you — then picks up again on the way out.

A row of titles scrolls **smoothly**: the wheel only moves a target and a frame loop
eases the row toward it, instead of snapping the row a wheel-notch at a time.

**A tag line is a two-row window with up/down arrows.** The big cards carry nearly
two hundred tags, and as one wall of pills they pushed the rows off the screen — so
the line never grows: the arrows scroll it a row at a time (the wheel works over it
too) and each one dims at its own end of the list. Nothing is expanded in place.
Short cards get no control at all — and **neither does a line that fits its rows**, even
when it holds more than eight tags: *Runtime* folds nine pills and *Genres* about
twenty, both fit their two rows whole, and arrows that scroll nothing were sitting
under them. The count only decides whether the question is asked; the **layout**
decides the answer, so a card like **Countries**, which really is held back, keeps its
arrows. Both arrows are drawn as **buttons** — a bordered,
accent-tinted plate with a stroked chevron, sized and hovered like every other
control — so they read as something to press rather than as marks on the background.
The chevron is built with `document.createElementNS`, in the **SVG namespace**:
`el("svg", …)` makes an HTML element merely *named* "svg", whose paths are never
painted, which is why the control used to come out as two empty pills.

**Explore has an alphabet rail** down the right-hand gutter, and it indexes the
**titles in the row**: every letter from A to Z, and picking one **shows only that
letter's titles** — the grid is filtered to them, and the catalog is **paged in
until the letter is filled out**, so it is all of them rather than the one or two
the first window happened to hold. The chosen letter is filled on the rail, a line
above the grid names it and carries the way back (**Show all**), and picking the
same letter again restores the whole row. Letters the loaded pages do not cover are
dimmed, never dead. The rail is a **column in the grid's own row**
(`.explore-body`), so it starts with the catalog row rather than the shuffle sample
above it, and it is `sticky` at `50vh` — its letters sit level with the **middle of
the screen** beside the poster columns, in the gutter, never an overlay. Its
`translateY(-50%)` used to carry the rail's top half a rail-height **above** its own
box, and that box is the top of `.explore-body` — so the letters came up across the
page header and the **Shuffle** button over them. The same half-height is handed back
as a top margin now: the rail's drawn top lands on the grid's own top edge and
nothing above it is covered.

**A card's own titles replace its cover — and the cover is never drawn.** Every
card, the banner and a card page wear `art-blank` from the first paint, so what
opens is the app's own **flat panel**; the moment the titles arrive (`art-filled`) a
card on Home becomes its own **poster wall** — padded and gapped, each picture keeping
its own shape — while **a card page's frame holds one landscape backdrop** from that
same card, full-bleed in its 16:9 box. The generated vector scene is not on screen at
any point — it used to be the layer under all of this, which made every card arrive as an illustration of
itself and then change under you. The cut changes **once per launch** (the banner is
the one thing that redraws while the app runs: every ten seconds, at random, frozen
under the cursor).

**A card does not lift.** The grid used to raise every card on hover; a transform
makes a stacking context, so the raised card painted *over* the floated top bar and
its rounded corners cut across what sat behind them. The hover response is now a fill
and an inset ring, the card is `overflow: hidden`, and the poster strip is clipped to
the frame's radius — nothing a card draws can leave its own box.

The cards run **For You first** and end on **your own three**: **Watchlist**,
**Upcoming** and **Custom**, with a **vertical divider** before the Watchlist so the
block reads as one group at the bottom of the page. The cards are always in the
published order, and every card appears — there is no picked subset on Home any more.
**Upcoming** is the card that shows what is on its way — TMDB's upcoming films, and the
nearest first-air dates for shows — and it is drawn as a **spotlight** (the card the
manifest marks `spotlight`): the **same 16:9 frame every card has**, so it sits **in the
same row** as the Watchlist and the Custom card, but the frame holds **one still**
instead of a wall of four posters, and that still **changes every ten seconds** the way
the hero banner's does (one of its own titles each time, never the one on screen, and
it holds still while the cursor is over it — see `startSpotlight`). The still **names
itself**: the title, its year and its rating ride over a bottom gradient on the picture
(`drawSpotlight`), because the label underneath names the *card* and opening the card
to learn the title defeats a card that is not a door. **Nothing in it is
clickable**: there is no artwork button, so it is not a focus stop, it takes no hover
lift, and a title rotating through it is a glance rather than a link.
**Airing This Week** is no longer one of the banner's
rows: what is on the air is the banner's job, what is coming is this card's. The **Watchlist** card's frame
holds **two** posters: it is three rows of your own pins, and a wider wall of them
read as a chart rather than as "what you are watching". A card is also only ever
drawn with the rows the addon's **manifest** publishes, so a retired catalog cannot
be left behind as a chip that 404s when it is opened.

The **Watchlist** card is the one card that redraws **immediately**: its artwork *is*
its contents, so a pin or an unpin drops the draw and refetches it then and there,
while every other card holds its artwork until the next launch. It holds the three
states a pinned title moves through:
**Plan to Watch**, **Watching**, **Watched** — and nothing else: the *Add cards in
watchlist* row is gone from the card, from the title modal and from the addon, so
no *add cards* catalog is published at all. Open any title and pick a state in its
modal to pin it there (picking the state it is already in unpins it), and the card
updates. The pins live on the server (`/watchlist` → `addon/watchlist.json`) so
Nuvio sees the same rows. Those rows are requested with a cache-busting `_=<n>` and
answered `cache-control: no-store`, so a removed title is gone the moment you come
back — an ordinary catalog row keeps its `max-age` and is not re-fetched pointlessly.

**The For You rows are dealt, not walked.** Its rows are one title's own recommendations
each (`More Like …`), and TMDB's recommendation lists overlap — a film stays popular
whatever you seed with — so the card showed the same title in two of its rows. Three
things stop it now: the order is **shuffled on every open**; every row of one open
carries the same **open-nonce** (`?open=`, minted per open in `renderCard`) and reads
and writes the **one shared memory for that open**, which the deal **skips** rather than
pushing to the back — Node answers the card's simultaneous requests one at a time, so
each row sees what the rows above it dealt (see `dealForYou` in `addon/index.mjs`). A
second open mints a new nonce and re-deals instead of echoing the first: two opens deal
160 distinct titles each with only the genuinely shared titles in common. What a row
passes over is skipped rather than left as a hole — a second pass tops the window back
up — so a row that has to skip ten is still a full row. Every card page keeps its **chip
line**, the For You card included: it was dropped once as unasked duplication and put
back — the line is how a card's rows are named in one place.

**Catalog labels are clickable** — in the hero banner and on a collection page each
catalog name is a chip that opens that catalog inside the card.

**Explore** carries one control, and which one depends on the row. Every ordinary
card — **including the plain Global OTT and Regional OTT cards** — gets a **Shuffle**
that redraws its sample rows with fresh random draws from the row **and from other
origin countries** it holds, so a shuffle is not the same American chart every time;
the draws are requested with a cache-busting `_=<n>` parameter and answered
`cache-control: no-store`, because a cached identical URL is what made Shuffle look
like a button that did nothing.

**The two ◆ Top 10 OTT cards get an order dropdown instead** — **Latest · Newest ·
Trending · Popular · Top rated** — and **only there, on their Explore page**: a Top 10
is one service's best, so "best by what?" is the one question worth asking of it. The
plain Global OTT and Regional OTT cards publish the whole service in published order
and ask no such question, and **no card asks it from its card page** — a card page is
a wall of its own rows.

**The wheel moves the row, never the page.** Pointing at a strip and scrolling
scrolls that strip sideways; at either end the row simply stops, so the page cannot
be dragged away while the cursor is on the titles. The page scrolls normally
anywhere the cursor is not over a row, and strips draw no scrollbar. Under the
header sits **one sample row**, drawing a random 12 titles from that catalog. It is
drawn **exactly like a normal row**: no label of its own and no control of its own.
A **horizontal divider** closes it off from the catalog below, and there is **one
Shuffle button at the top right of the header** which draws a fresh sample. A
**watchlist** catalog has none of the three: there is no random twelve to draw from
your own pins, so its Explore page is the header and the titles.
Everything below the divider is the normal, endlessly scrolling catalog.

**Search goes as deep as a row does, and the bar carries no magnifier.** The field
is the panel: one flat fill, the text edge to edge, and the **Filters** control
closing it. The field draws no focus ring of its own either — the accent ring belongs
to the whole bar. It searches **titles**, and only titles: the *Collections* and
*Catalogs* lists that used to open under the results were **labels** standing where
the contents should be, and they are gone (the suggestion dropdown still offers a
collection or a catalog to jump to). A query (or a browse with no text) reads
**six pages of TMDB per row type** to fill the first window, and then **the results
page themselves in** — a sentinel at the foot of the list reads the next window as it
comes into view, so the count under each group keeps climbing and the list never looks
like it stopped at 120. There is **no button**: a search that ends in a *Load more*
control is one that looks finished. It used to keep only the first page, which is why
"disney+" looked like it answered with about twenty titles. `◆ Top 10` rows are the
deliberate exception.

**Where the next window starts is the server's answer.** A window stops early at a
short TMDB page, so a search with forty results is finished on page two — and
"six pages further on" then stepped past the end, which is why the old button looked
dead. The response carries `next`, the page to continue from (null when the row type
is finished), and the sentinel stops on that.

**The filter panel is four lines: Type, Country, Genre, Time — then Sort.** A
country already narrows the ground a continent did, a mood is a genre under another
name, and a service filter only means anything once you have said where you are, so
**Continent, OTT, Mood and Theme are gone**. Country and Genre hold every choice and
are the **same two-row window the card tag lines use**: a pair of up/down arrows that
step them a row at a time, each dimming at its own end, with your chosen chip
scrolled into view — instead of a *More (N)* pill that expanded the line in place.
They follow the **same rule about being needed**, too, and that rule is the one place
it matters most here: the panel is built **shut**, so a line with no box yet cannot be
measured — the choice the card lines make on `ResizeObserver` size changes is what lets
*Genre* (about twenty chips, two rows, no arrows needed) and *Country* or *Time* (every
country, every year on its own, arrows genuinely needed) be told apart once it opens.

The depth comes from the server: it reads TMDB 20 titles at a time into a growing,
10-minute cache per catalog, so each 40-title window continues where the last
stopped, repeats are free, and a row can serve up to 300 titles. `◆ Top 10` rows
stop at ten by design — and **nothing else is capped**: the OTT cards' rows used to
carry a `take` of 30/40, which is why an OTT row ended while every other row kept
going. A strip in a collection also loads the next window as you scroll it to the
end.

**Calendar** is a real month grid: pick a day to see what releases on it, with
previous/next month navigation — not a list of Latest/Newest rows. A day
lists **films and shows together** (each card is tagged with which it is), clicking
the selected day again **deselects** it, and the grid carries no caption text.
Every release has its own **Plan to Watch** pin, and it is a **toggle**: a planned
release says **planned** and pressing it puts the plan back. It was briefly
add-only — a plan about a date must not be deleted by a stray click — but with no
other way to remove one, a plan you had changed your mind about sat there for good.
The pin is not a watchlist row: it is plan-only, while the Watchlist card scans every
state whatever the date. Calendar plans live in their own stored row
(`calendar-plans`, via `/customrows`) and are never published as a catalog, so
pinning a release never fills the Watchlist card. **The grid carries no *Recently
planned* shelf**: the plans live on the day they belong to, and there is nothing to
prune.

A tile is entered by clicking its **artwork** — not the whole tile. Back (Escape /
← button) returns home; Escape in Explore goes back to the collection. A
collection with no catalogs yet opens to a "cover art only" message.

Each catalog row carries its own **Explore** button on the label line. There is no
shuffle icon there: reordering a card's catalogs is not what "shuffle" means — the
only shuffle lives in Explore, over the titles.

**AI** (Settings) starts with the providers: **Groq Cloud** (the default),
**Google AI Studio**, **OpenRouter** and **Cerebras Cloud** — all free-tier, each
with its own key box, a **Test connection** button, a **Load models** button that
lists the models the provider actually serves as pickable chips, and a link to get
a key, plus an
optional **model** override. Paste a key and the ask box stops being a text box:
the server calls the provider, turns "a lonely detective in the rain" into a search
query, and hands it to the title search. **Pick movies or shows for me** narrows
that search to one row (the search screen's *Type*), or leaves it on Both. With no key it searches the words you
typed, so it still works. **Whether a key is set is the server's answer, not the
page's** — the page reads `/ai.json` at boot, so a key that lives in the environment
(or was pasted for a provider other than the chosen one) is used, and the Ask box no
longer falls back to a literal search on a server that had a working key. Keys never
reach the page (`/settings` and `/ai.json` say
only whether one is set), and every call is plain `fetch` from Node — no SDK.

The section also requests the next-bigger artwork size for classic posters and
banners, and takes a typed or spoken sentence in its ask box (*pick the cards for
you* is gone: the cards Home shows are the published set, in the published order).
Speech uses the browser's
`SpeechRecognition` when the build has it; otherwise the ask box falls back to
typing.

**Posters** is where the poster service lives: it is **on by default** and upgrades
every poster through a URL pattern (`{imdb_id}` / `{tmdb_id}` are filled in per
title). The upgrade is silent — no `BTTR` badge is drawn on the cards. There is an
API-key box and a **Check service** button that verifies the
pattern really returns an image.

**Providers** (TMDB / TVDB / MDBList — plus the content-source switch) and
**Tracking** (Trakt / SIMKL / MyAnimeList / AniList / Letterboxd, then a divider,
MyDramaList)
take a key and an enable toggle. Keys are POSTed to the server's `/settings`, which
stores them in `addon/settings.json` (git-ignored); the response never returns a
key, only whether one is set, and **Check connection** verifies it. TMDB is the
live catalog source — pasting a key changes the rows immediately, with unchanged
names — and MDBList replaces each title's rating.

**Content source** (top of the Content section) is a separate, explicit choice:
**TMDB** (default) or **TVDB**. TMDB is the only provider that can build a row —
its discover endpoint answers "90s action on Netflix" — while TVDB supplies a
title's name, translation, year and artwork. So choosing **TVDB** makes every
catalog show TVDB's content in the Settings language, while the rows themselves
stay TMDB's. It needs the TVDB provider enabled *with a key*; without one the
option says so in place and the app keeps serving TMDB content rather than empty
rows (`/addon-status.json` reports `contentSource`, `contentSourceActive` and
`contentSourceStats`). Title ids stay `tmdb:`, so watchlist pins and the modal do
not move when the source does.

**Add-ons** and **Plugins** are separate sections, and both are read **through the
server** (`POST /api/source`). That is what fixes third-party sources: the browser
cannot read a foreign host's `manifest.json` because of CORS. Add-ons are read via
their manifest (name + catalogs); a CloudStream repo is read via `repo.json` →
`plugins.json` and every plugin is listed as a provider.

**Home layout**, profile, providers, tracking and the AI options persist in
`localStorage` (`nuvio.layout`, `nuvio.profile`, `nuvio.providers`,
`nuvio.tracking`, `nuvio.ai`). Keys — including the AI ones — are mirrored to the
server so the addon can use them; the watchlist is server-side state, not stored in
the page.

## How it gets data

`main.js` calls `startServer()` (exported by `../serve.mjs`) with `port: 0`, so
the OS picks a free port, then **loads the UI from that server** —
`http://127.0.0.1:<port>/app/`. Loading it over http rather than `file://` is what
makes the app work: the catalogs, the cover images and the add-on / plugin /
repository lookup (`POST /api/source`) are then same-origin, exactly as in the
browser preview, where from a `file://` page every one of them would be a
cross-origin request. The UI reads:

| Endpoint | Used for |
|---|---|
| `/collections.json` | every card, its cover, and the catalogs it owns |
| `/catalog/{type}/{id}.json` | one live row of titles (TMDB) |
| `/settings` (GET/POST) | profile, provider/tracking/AI keys, AI options, the **content source**, **language** and **country**, plus the language/country `options` the Content pane is built from |
| `/watchlist` (GET/POST) | your pins and their states (`Plan to Watch` / `Watching` / `Watched`) |
| `/ai/ask`, `/ai/verify` | the Ask box and its key check |
| `/search.json` | title search (what the Ask box feeds), and the panel's own filters while browsing |
| `/search/filters.json` | the filter panel's vocabulary — one row per card line |
| `/live/channels.json`, `/live/guide.json`, `/live/status.json` | the Live TV profile's channels, its XMLTV guide, and the source's state |
| `/live/countries.json` | the public directory's country table (name, ISO code, flag) for the settings picker |
| `/addon-status.json` | diagnostics: keys present, catalog count, region, language, content source + how many titles it upgraded |

## Android TV — the Capacitor project is generated and TV-ready

A real Android project now exists at `desktop/android/` (Capacitor 6), and it is
configured as an **Android TV (leanback) app**:

- `AndroidManifest.xml` declares `android.software.leanback`, drops the
  touchscreen requirement, adds the `LEANBACK_LAUNCHER` intent-filter (so it
  appears on the TV home screen), pins landscape, and sets a banner
- `cap sync` embeds the whole UI into
  `android/app/src/main/assets/public/`
- D-pad navigation is already in `app.js` (arrows + Enter + Escape/Back)

```sh
cd desktop
npm install
npm run android:sync      # copies ui/ into the APK assets
# then, on a machine with a JDK + Android SDK:
npm run android:build     # → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:apk       # release build
npm run android:open      # opens the project in Android Studio
```

**Or let CI build it**: `.github/workflows/android-apk.yml` builds the debug APK on
a runner with a JDK and the Android SDK and uploads it as the
`nuvio-collections-debug-apk` artifact (Actions → Android TV APK → Run workflow).
Set the repository variable `AUTOCAT_HOST` to bake the server host in.

**This build cannot be compiled on the Freebuff sandbox**: there is no `java`,
no `gradle` and no Android SDK (`ANDROID_HOME` is unset). Running the build there
fails at the first step with:

```
ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
```

That is the only missing piece — the project, the TV manifest, the embedded UI
and the Gradle wrapper are all in place, so a machine with the Android toolchain
produces the APK with the two commands above.

### Standalone vs thin client

The APK is a **thin client**: Capacitor's WebView renders the UI, but the catalog
server is Node (`serve.mjs`), which cannot run inside an Android APK without
bundling Node (`nodejs-mobile`). So before building, set the host in
`ui/config.js`:

```js
window.AUTOCAT_HOST = "https://your-addon-host.example.com";
```

Use an **https** host: Android blocks cleartext HTTP. `serve.mjs` already
advertises `https://` for any non-local host, so a deployed copy works directly —
and so does the Freebuff preview url (`https://<preview-host>`), which is the
quickest way to try the APK. With `AUTOCAT_HOST` empty the app starts and reports
that it cannot reach the server rather than failing silently.

Then build and install:

```sh
npm run android:sync     # after setting AUTOCAT_HOST — it is copied into the APK
npm run android:build    # debug APK
adb connect <tv-ip>:5555
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Or copy the APK to a USB stick and install it from a file manager on the device.
It appears in the Android TV **Apps** row; the D-pad drives the UI.

## Notes

- The UI **is verified headlessly**: `npm run test:ui` (at the repo root) runs
  `desktop/ui` in jsdom against the running server and walks every screen — top
  bar, the switch-profile screen, Home/Movies/Shows, a collection, Explore, the title modal,
  the sources screen, Calendar, Search and Settings — failing on any uncaught
  error. That check caught real crashes (a null `props` in Settings, a spread of
  an element, and tiles rendering `<img>` with no `src`).
- The Electron window and the APK cannot be *launched* in the Freebuff sandbox
  (headless, no JDK/SDK), but the Android project is generated and TV-configured.
- `npm install` here downloads the Electron binary; set
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` when you only need the Capacitor CLI.
- `desktop/android/app/src/main/assets/public/` is generated by `android:sync`
  and git-ignored, so the UI is never committed twice.
