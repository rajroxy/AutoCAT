// AutoCAT — renderer. Plain web code (no Node APIs), so this exact
// file runs under Electron, a browser, and a Capacitor Android TV build.
//
//   #/profiles                 switch profile — the screen the app starts on
//   #/                         home — hero, then Movies/Shows, then the cards
//   #/c/<key>                  one collection → its catalogs as rows
//   #/x/<key>/<catalogId>      Explore — one catalog, endless scroll + shuffle
//   #/s/<id>/<name>            Sources — providers linked to their source
//   #/calendar                 a real month calendar of releases
//   #/search                   search collections and catalogs
//   #/settings                 settings, organised in sections
//
// Everything the page needs comes from the server:
//   /collections.json                 cards + the catalogs they own
//   /catalog/{type}/{id}.json         a row of titles (better posters + TMDB)
//   /calendar/{type}/{YYYY-MM}.json   a month of releases
//   /api/source                       server-side add-on / plugin lookup
//   /settings (GET/POST)              profile, providers, posters, AI

const API = new URLSearchParams(location.search).get("api") || window.NUVIO_API || "";

// The top bar has no Movies/Shows labels any more — those are buttons on Home.
const TABS = [["home", "Home"]];

const KEY = {
  tab: "nuvio.tab",
  row: "nuvio.row",
  layout: "nuvio.layout",
  safe: "nuvio.safe",
  refresh: "nuvio.refresh",
  sources: "nuvio.sources",
  profile: "nuvio.profile",
  providers: "nuvio.providers",
  debrid: "nuvio.debrid",
  subtitles: "nuvio.subtitles",
  dns: "nuvio.dns",
  customSites: "nuvio.customSites",
  prefs: "nuvio.prefs",
  tracking: "nuvio.tracking",
  posters: "nuvio.posters",
  ratings: "nuvio.ratings",
  ai: "nuvio.ai",
  language: "nuvio.language",
  country: "nuvio.country",
  contentSource: "nuvio.contentSource",
  enrich: "nuvio.enrich",
  section: "nuvio.settingsSection",
  accent: "nuvio.accent",
  motion: "nuvio.motion",
  // The resolved accent colours, written for the boot script in `index.html`.
  theme: "nuvio.theme",
  pickCards: "nuvio.pickCards",
  visibility: "nuvio.visibility",
  // The three the user asked for by name: what the app sounds like, what it leans on to
  // tell you something, and the little preview panel a card opens on hover.
  sound: "nuvio.sound",
  notifications: "nuvio.notifications",
  previews: "nuvio.previews",
  liveRow: "nuvio.liveRow",
  liveSource: "nuvio.liveSource",
  ottSort: "nuvio.ottSort",
};

const PINNED = /\| Top 10|\| Top 25|^Upcoming$|Airing Today|On the Air|Now Playing|^Latest|^Newest|^Trending|^Plan to Watch$|^Watching$|^Watched$/;

/**
 * The five orders the OTT cards read their rows in — the dropdown in their header.
 *
 * It is a way of **reading one service**, not a setting for the app: each option asks a
 * different question of the same catalogue (what just came out, what is popular right
 * now, what is best reviewed). Only the OTT rows understand the parameter, so switching
 * it can never change a genre or a country list, and the choice is remembered.
 */
const OTT_SORTS = [
  ["latest", "Latest"],
  ["newest", "Newest"],
  ["trending", "Trending"],
  ["popular", "Popular"],
  ["top_rated", "Top rated"],
];

/**
 * The two OTT cards that read their rows **in an order** — the ◆ Top 10 pair.
 *
 * The dropdown belongs to those two and only those two, on their **Explore** page: a
 * Top 10 is a list of one service's best, so "best by what?" is the one question worth
 * asking of it. The plain **Global OTT** and **Regional OTT** cards publish the whole
 * service in published order, so they keep the **Shuffle** every other card has and
 * ask no such question — and neither card asks it from the card page, where the rows
 * are just a wall of their own titles.
 */
const isOttTop10Card = (card) => /^(global|regional)-ott-top-10$/.test(String(card?.key || ""));

/** The order the screen being drawn asks for — empty on every other screen. */
let activeOttSort = "";

// The watchlist rows are states, in the order a title moves through them.
const WATCH_STATES = [
  ["planned", "Plan to Watch"],
  ["watching", "Watching"],
  ["watched", "Watched"],
];
// **What a title page offers as pins.** Plan to Watch, then the Library rows — and no
// Watched and no Watching. A page is for deciding; Watched is something you *are*, and the
// app already knows it the moment the credits roll, so a button that says you have seen
// the thing you are looking at was an answer, not a choice.
const PIN_STATES = WATCH_STATES.filter(([id]) => id === "planned");

/**
 * **The people are not the modes.**
 *
 * `PROFILES` below are the two ways to *watch* — on demand, and live. These are the
 * people *watching*, and the app asks who before it asks how: the profile screen comes
 * first, the mode screen second, and Home after that.
 *
 * A profile is a name and a mark. There is no account behind it, no password, and
 * nothing about it leaves this machine — it is a label for the session, and it is kept
 * in this browser alone.
 */
const PEOPLE_KEY = "nuvio.people";
const WHO_KEY = "nuvio.who";
const DEFAULT_PEOPLE = [{ id: "you", name: "You" }];
/** An id nothing else will take, so two profiles can share a name without colliding. */
const personId = () => `p${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

// The profiles you can switch between. `IPTV` is the second one, and it is a
// different app: its own two buttons, its own cards, its own settings.
//
// Both were named after what they hold — `Movies & Shows` and `Live TV & Sports` —
// before the rename, and an installed copy still has one of those in localStorage.
// So the old spellings are still read and read *as* the new name; only the new
// name is ever written.
const LIVE_PROFILE = "IPTV";
const PROFILES = ["VOD", LIVE_PROFILE];
const LEGACY_PROFILES = { "Movies & Shows": PROFILES[0], "Live TV & Sports": LIVE_PROFILE };
/** The current name for whatever a stored setting says — legacy or unknown → the first. */
const profileName = (name) => LEGACY_PROFILES[name] || (PROFILES.includes(name) ? name : PROFILES[0]);

// How much of a playlist Live TV & Sports draws: rows for a playlist's biggest
// categories, a cap on the channels inside one row, and the guide's own window.
/**
 * How many channels one read of the channel list asks for.
 *
 * **The whole lineup.** This was 1500, and the lineup is tens of thousands of
 * channels across every country — so the profile held a slice of the alphabet, Star
 * Plus and Sony were never in it, and a channel opened from anywhere else answered
 * "channel not found in this playlist". The server already caps what it will serve;
 * asking for less only hid channels.
 */
const LIVE_CHANNEL_LIMIT = 60000;
// **The whole country, not the first forty.** A guide that stopped at 40 rows is
// why channels you picked a country for were "not in this playlist".
const LIVE_GUIDE_CHANNELS = 1500;
const LIVE_GUIDE_HOURS = 6;

const LAYOUTS = [
  ["grid", "Icon grid", "Collections as a grid of tiles — best for a TV remote."],
  ["rows", "Single row", "Collections in one horizontal row you scroll."],
];

/**
 * The accent the whole app is painted in.
 *
 * `rgb` is what every translucent gold tint is built from (`rgba(var(--accent-rgb), …)`),
 * so changing one pick re-tints buttons, chips, borders and highlights together
 * instead of leaving half the UI gold. Gold stays the default — it is the app's
 * own colour — but it is no longer the only one.
 */
const ACCENTS = [
  ["gold", "Gold", "200, 169, 106", "#c8a96a", "#a3873f"],
  ["amber", "Amber", "224, 160, 84", "#e0a054", "#b3762c"],
  ["violet", "Violet", "157, 137, 232", "#9d89e8", "#6f5bbf"],
  ["blue", "Blue", "112, 166, 232", "#70a6e8", "#3f74bd"],
  ["teal", "Teal", "90, 200, 186", "#5ac8ba", "#2f978a"],
  ["green", "Green", "123, 200, 132", "#7bc884", "#4e9a58"],
  ["rose", "Rose", "228, 120, 152", "#e47898", "#b04d6b"],
  ["slate", "Slate", "160, 172, 190", "#a0acbe", "#6f7c8e"],
  // The second row of choices: **warmer and cooler ends** of the same idea, so there is
  // something for a screen that is too dim or too bright for the first eight.
  ["crimson", "Crimson", "224, 92, 92", "#e05c5c", "#a83a3a"],
  ["coral", "Coral", "240, 138, 108", "#f08a6c", "#bd5a3d"],
  ["magenta", "Magenta", "216, 110, 196", "#d86ec4", "#a3448f"],
  ["indigo", "Indigo", "122, 130, 236", "#7a82ec", "#4c53bd"],
  ["lime", "Lime", "166, 214, 90", "#a6d65a", "#769f2f"],
  ["ice", "Ice", "126, 208, 226", "#7ed0e2", "#4b9cb1"],
];

const accentOf = (id) => ACCENTS.find(([key]) => key === id) || ACCENTS[0];

/**
 * The typefaces Settings offers.
 *
 * Every one is a **stack, not a download**: the app has to work with no network and no
 * web font in the page, so each option lists local families and falls back to the system
 * UI face. The first entry is the app's own default, so nothing changes for anyone who
 * never opens the Appearance pane.
 */
/**
 * The app's one typeface.
 *
 * It is a **stack, not a download**: the app has to work with no network and no web font
 * in the page, so this is local families and the system UI face. Settings used to offer six
 * of these; it offers none now, so this is the only place the face is named.
 */
const FONT_STACK = 'Inter Tight, Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * How much the app moves.
 *
 * "auto" follows the system's reduced-motion preference, "full" always animates,
 * "off" never does. It is one switch, and it covers every transition the app has
 * (view changes, hover lifts, row flashes) so the setting is not a half-truth.
 */
const MOTIONS = [
  ["auto", "Follow system", "Animate, unless this device asks for reduced motion."],
  ["full", "Always animate", "Smooth view transitions and hover motion, whatever the system prefers."],
  ["off", "No animation", "Nothing moves — for slow devices and for people who do not want it."],
];

const PROVIDERS = [
  ["tmdb", "TMDB", "Powers every catalog row and title metadata — pasting a key and enabling it changes the live contents immediately, with the same catalog names."],
  ["tvdb", "TVDB", "Extra series metadata (episode art, air dates)."],
  ["mdblist", "MDBList", "Aggregated ratings — enabling it replaces each title's rating with MDBList's."],
];

/**
 * The debrid services, in the order they are tried.
 *
 * A **debrid account is what makes a torrent stream playable at all** here. An
 * add-on publishes a torrent as an info hash; the app used to hand that magnet to a
 * torrent engine running in the page, but a browser can only reach peers that speak
 * WebRTC, and the public swarms speak TCP/UDP — so the picture never arrives. A
 * debrid service downloads the torrent on its own servers and returns a direct
 * HTTPS link, which is an ordinary stream from the player's point of view.
 *
 * The keys never reach this page: `keyRow` writes them to the server and only
 * `hasKey` comes back.
 */
const DEBRID_SERVICES = [
  ["realdebrid", "Real-Debrid", "Cached torrents plus a hoster unrestrictor. The widest support among add-ons, and the one most streams resolve through instantly."],
  ["alldebrid", "AllDebrid", "The same idea as Real-Debrid: cached torrents and an unrestricted download link, often with a different cache than Real-Debrid has."],
  ["premiumize", "Premiumize", "Cached torrents, and the account carries its own cloud storage as well."],
  ["torbox", "TorBox", "Cached torrents with a free tier. Its download links expire, so the app mints a fresh one for every play."],
  ["debridlink", "Debrid-Link", "Europe's largest debrid: a seedbox for torrents plus a hoster unrestrictor. Popular with Stremio add-ons, which is where a stream's magnet often expects it."],
  ["deepbrid", "Deepbrid", "Cached torrents and a hoster unrestrictor on its own documented REST API. A Premium plan is required for torrents."],
  ["putio", "Put.io", "A cloud that plays torrents rather than a plain HTTPS link: it downloads the torrent into your account and streams the file. Its download links are per-play, like TorBox's."],
];

/** The enabled service that holds a key — the one a torrent will go through. */
const debridActive = () => DEBRID_SERVICES.find(([n]) => state.debrid?.[n]?.enabled && state.debrid?.[n]?.hasKey) || null;
const debridLabel = () => debridActive()?.[1] || "";

/**
 * The subtitle services beyond OpenSubtitles, which has a block of its own (it carries a
 * login as well as a key). Each is searched only when it is switched on and holds a key,
 * and each needs its own free key from that service's account page.
 */
const SUBTITLE_SERVICES = [
  ["subdl", "SubDL", "A large catalogue with a great deal of television and non-English releases. Create a free API key in your SubDL account."],
  ["subsource", "SubSource", "Another broad catalogue behind a single key — often carrying a release the others miss."],
  ["wyzie", "Wyzie", "An aggregator: one key reaches several smaller subtitle sites at once, which is where an obscure title often lives."],
];

/** The subtitle services that would be searched right now, as their labels. */
const subtitleActive = () =>
  [
    ["opensubtitles", "OpenSubtitles"],
    ...SUBTITLE_SERVICES.map(([n, l]) => [n, l]),
  ]
    .filter(([n]) => state.subtitles?.[n]?.enabled && state.subtitles?.[n]?.hasKey)
    .map(([, l]) => l);

/**
 * Tracking services, in two groups.
 *
 * Film & TV first (including the two anime databases, because they track the same
 * shows), then a divider, then the drama trackers — a different catalogue of
 * titles entirely, so it reads as its own group rather than one long list.
 */
/**
 * The trackers, in three groups and in this order.
 *
 * **Movies & TV** first — Trakt, then SIMKL, then Letterboxd — then **Anime**
 * (MyAnimeList, AniList) and then **Asian drama** (MyDramaList), each on its own
 * side of a rule. They were one flat list, which put the anime databases between
 * the film trackers and made "which of these is for what?" a question the screen
 * never answered.
 */
const TRACKER_GROUPS = [
  {
    title: "Global",
    hint: "One history across films, shows and anime — the two services that keep a Western catalogue and an Asian one in the same list.",
    services: [
      ["trakt", "Trakt", "Scrobbling and watched history for films and shows."],
      ["simkl", "SIMKL", "Watched history across films, shows and anime."],
    ],
  },
  {
    // **Anime and Asian drama are one group.** They were two — "Anime" and "Asian
    // drama" — which put three services that answer the same question (where do you
    // keep the titles this app has no Western equivalent for?) under two headings.
    // MyDramaList belongs beside MAL and AniList, not under a heading of its own.
    title: "Asian",
    hint: "The catalogues that keep anime and Asian drama as their own lists — MAL, AniList and MyDramaList.",
    divider: true,
    services: [
      ["myanimelist", "MyAnimeList", "Anime lists and watched episodes — MAL."],
      ["anilist", "AniList", "Anime and manga lists, with airing progress."],
      ["mydramalist", "MyDramaList", "Asian drama lists, ratings and watched episodes — MDL."],
    ],
  },
];

/**
 * Poster services. Each entry is a URL **pattern** — `{imdb_id}`, `{tmdb_id}`,
 * `{type}` and `{rpdb_key}` are filled in per title.
 *
 * **No service is bundled any more.** The artwork the providers serve is already 2:3
 * and tagged with the year; a poster service exists to *replace* it with one carrying
 * the ratings, so it is a choice, and "None" is a real choice. RPDB is the one that
 * covers films, series and anime alike and puts the ratings on the art; anything else
 * that takes an id in its URL goes in the pattern box.
 */
const POSTER_SERVICES = [
  ["none", "None", "", "Keep the artwork the provider served. Nothing is requested from a poster service."],
  [
    "rpdb",
    "RatingPosterDB (RPDB)",
    "https://api.ratingposterdb.com/{rpdb_key}/imdb/poster-default/{imdb_id}.jpg",
    "Films, series and anime with the ratings printed on the poster. Keyed by IMDb id, so a TMDB title has its IMDb id resolved first — one extra lookup per title. Needs your own RPDB key, pasted below.",
  ],
  ["custom", "Something else", "", "Any URL that takes an id — {imdb_id}, {tmdb_id}, {type} and {rpdb_key} are filled in per title."],
];

const TRACKERS = TRACKER_GROUPS.flatMap((group) => group.services);

// The AI providers whose free tier can back the Ask box. Each one is called by
// the server with the key pasted here — the browser never talks to a provider
// directly, so the key is not readable from the page.
const AI_PROVIDERS = [
  ["groq", "Groq Cloud", "https://console.groq.com/keys", "Free tier with the most generous limits — this is the default."],
  ["google", "Google AI Studio", "https://aistudio.google.com/app/apikey", "Free tier with a daily quota; Gemini models."],
  ["openrouter", "OpenRouter", "https://openrouter.ai/keys", "Free tier — one key reaching many models, including the free ones."],
  ["cerebras", "Cerebras Cloud", "https://cloud.cerebras.ai", "Free tier on wafer-scale hardware."],
];

// Only two kinds of source: a Stremio add-on (one URL, manifests everything) and
// a Nuvio plugin (a repository of scrapers). The Nuvio add-on and CloudStream repo
// entries are gone.
const ADDON_TYPES = [
  ["stremio", "Stremio add-on", "A Stremio add-on URL — its manifest is read for you, so its catalogs, metadata, streams and subtitles all appear as providers."],
];
// **Nuvio plugins are gone.** A plugin is Javascript the Nuvio app runs itself; the
// settings pane, the source type and the server-side runner for it have all been
// removed. The one kind of source left is a Stremio add-on.
const PLUGIN_TYPES = [];
const SOURCE_TYPES = [...ADDON_TYPES, ...PLUGIN_TYPES];
// (Both are kept only so `typeLabel` still names a source added before plugins were
// removed; nothing offers a plugin as a choice any more.)
const typeLabel = (t) => SOURCE_TYPES.find(([v]) => v === t)?.[1] ?? t;

/**
 * Settings, as groups of tabs.
 *
 * It used to be one flat row of ten names in no particular order (Profile,
 * Posters, Providers, Tracking, AI, Content, Add-ons, Plugins, Layout, Server),
 * which hid the two things you actually come here to change: what the catalogs
 * show, and who they are read from. The sections are grouped now, with the group
 * name above its tabs.
 *
 * **One tab, one thing.** Nothing shares a pane with something else: this profile
 * (Profile, Content, Posters), how it looks (Appearance & layout), where its
 * content and its history come from (Trackers & providers, Add-ons & plugins), and
 * the assistant (AI). The **Server** tab is gone.
 */
const SETTINGS_GROUPS = [
  {
    // **No headings.** The sections used to sit under "This profile" and "Where it comes
    // from", which named the settings rather than opening them: two labels to read before
    // you could find the tile you wanted. Every section is now a tile of its own on one
    // board, in the order you would think of them — what the catalogs show, how the app
    // looks, what it sounds like, what it tells you about, where its content comes from,
    // and the assistant.
    group: "",
    sections: [
      ["profile", "Profile"],
      ["content", "Content"],
      ["posters", "Posters"],
      // **Looks, placed, and moving are three questions.** "Appearance & layout" was one
      // pane answered with one accent row and one layout list, so finding the animation
      // setting meant reading past two things it was not.
      ["appearance", "Appearance"],
      ["layout", "Layout"],
      ["animation", "Animation"],
      ["sound", "Sound"],
      ["notifications", "Notifications"],
      // **The card you fill yourself.** It was "Custom Rows" here and "Custom" on Home —
      // two names for one thing, neither of them the word the card should wear.
      ["customrows", "Library"],
      ["tracking", "Trackers"],
      ["providers", "Providers"],
      ["addons", "Add-ons"],
      // **Websites you added yourself are where a stream can come from**, the same idea as
      // an add-on you pasted — so they sit beside the add-ons, and are called what they are.
      ["customsites", "Website"],
      ["debrid", "Debrid"],
      // The network, not the content: which resolver every request uses is a property of
      // the machine, not a catalogue choice.
      ["dns", "DNS"],
      // Playback, not content: subtitles are what happens to the picture once it plays.
      ["subtitles", "Subtitles"],
      ["ratings", "Ratings"],
      ["ai", "Assistant"],
    ],
  },
];

// The flat list, in the order the groups define — this is what "which tab is
// active" and "what does an unknown section fall back to" are answered from.
const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((g) => g.sections);

/**
 * The Live TV & Sports profile's own settings — the whole screen, not an extra
 * tab: where the channels come from, where the guide comes from, how often both
 * update. The Movies & Shows sections (Content, Posters, Providers, Tracking, AI,
 * Trackers, AI, Add-ons) do not apply to a live playlist, so they are not offered
 * while that profile is active.
 */
const LIVE_SETTINGS_GROUPS = [
  {
    // The same board as the other profile, with the sections that only a live playlist
    // has: where the channels and guide come from, which countries they are read from, and
    // how often both update. Appearance, layout, animation, sound and notifications are
    // **this profile's own copies**, not the other profile's — a live playlist wants a
    // different guide density and different row heights.
    group: "",
    sections: [
      ["livesource", "Source"],
      ["livecountries", "Countries"],
      ["liverefresh", "Refresh"],
      ["addons", "Add-ons"],
      ["dns", "DNS"],
      ["appearance", "Appearance"],
      ["layout", "Layout"],
      ["animation", "Animation"],
      ["sound", "Sound"],
      ["notifications", "Notifications"],
      ["profile", "Profile"],
    ],
  },
];
const LIVE_SETTINGS_SECTIONS = LIVE_SETTINGS_GROUPS.flatMap((g) => g.sections);
const settingsGroups = () => (liveProfile() ? LIVE_SETTINGS_GROUPS : SETTINGS_GROUPS);
const settingsSections = () => (liveProfile() ? LIVE_SETTINGS_SECTIONS : SETTINGS_SECTIONS);

const readJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const writeJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

const state = {
  tab: "home",
  // The catalog ids the addon's manifest publishes. `null` until it answers, and
  // `rowOf` filters nothing while it is null.
  publishedCatalogs: null,
  row: localStorage.getItem(KEY.row) || "movie", // movie | series
  layout: localStorage.getItem(KEY.layout) || "grid",
  safe: readJSON(KEY.safe, true),
  // How often the screen re-reads itself, in minutes (0 = only when you ask). The
  // addon's own cache follows the same setting server-side.
  refresh: readJSON(KEY.refresh, 60),
  // Bumped by a refresh so a re-read is a new URL for the browser cache too.
  gen: 0,
  profile: profileName(localStorage.getItem(KEY.profile)),
  profiles: PROFILES,
  // The people on this machine (the profile screen) and the one that is on. Kept in
  // this browser only — a profile is a name, not an account.
  people: readJSON(PEOPLE_KEY, DEFAULT_PEOPLE),
  who: localStorage.getItem(WHO_KEY) || "",
  // Which profile's name is being edited on the profile screen ("" = none).
  renaming: "",
  // Live TV & Sports: which of its two rows is showing, and the channels, groups
  // and guide the server has answered with.
  liveRow: localStorage.getItem(KEY.liveRow) || "livetv",
  liveSource: readJSON(KEY.liveSource, { mode: "dth", m3u: "", host: "", username: "", password: "", epg: "", providers: [], refreshMinutes: 0 }),
  live: { loading: false, loaded: false, all: [], total: 0, groups: [], rows: [], updated: 0, error: "", guide: null, guideLoading: false, guideError: "", guideCountry: "", guideCategory: "", guideSportsOnly: false },
  recordings: readJSON("nuvio.recordings", []),
  providers: readJSON(KEY.providers, { tmdb: { enabled: true }, tvdb: { enabled: false }, mdblist: { enabled: false } }),
  // Debrid: which service turns a torrent into a direct link. Only `enabled` and
  // `hasKey` are ever stored here — the key itself lives on the server and is
  // never sent back to the page.
  debrid: readJSON(KEY.debrid, { realdebrid: { enabled: false }, alldebrid: { enabled: false }, premiumize: { enabled: false }, torbox: { enabled: false }, debridlink: { enabled: false }, deepbrid: { enabled: false }, putio: { enabled: false } }),
  // Subtitles: OpenSubtitles' key and login, and the language to look in. As with
  // debrid, the page only ever learns whether a key is set — never the key itself.
  subtitles: readJSON(KEY.subtitles, { opensubtitles: { enabled: false, hasKey: false, hasLogin: false }, subdl: { enabled: false, hasKey: false }, subsource: { enabled: false, hasKey: false }, wyzie: { enabled: false, hasKey: false }, language: "" }),
  // DNS: which resolver the server's own requests use. Read back from the server, which
  // owns the setting — the page only draws it.
  dns: readJSON(KEY.dns, { enabled: false, provider: "cloudflare", primary: "1.1.1.1", secondary: "1.0.0.1", servers: [], presets: [] }),
  // Custom Websites: the sites the user added, by category, plus the repositories they
  // came from. Held locally so the pane draws before the server answers.
  customSites: readJSON(KEY.customSites, { categories: [], repositories: [] }),
  prefs: readJSON(KEY.prefs, { searchOnPlay: true, sourcesSummary: true, lastCategory: "movies" }),
  // **Extracted streams live in memory, not on disk.** They are re-extracted every play
  // because a stream URL expires; keeping them here means they survive closing the player
  // and are gone on a restart, which is exactly the requested lifetime. */
  customStreams: {},
  tracking: readJSON(KEY.tracking, {
    trakt: { enabled: false },
    simkl: { enabled: false },
    myanimelist: { enabled: false },
    anilist: { enabled: false },
    mydramalist: { enabled: false },
  }),
  posters: readJSON(KEY.posters, { enabled: false, source: "none", pattern: "" }),
  // Which ratings service the title page reads (Settings → Ratings). Mirrored from the
  // server like everything else, so the pane draws before the first answer.
  ratings: readJSON(KEY.ratings, { source: "free" }),
  ai: readJSON(KEY.ai, {
    enabled: true,
    provider: "groq",
    model: "",
    hasKey: {},
    enhanceArtwork: true,
    enhanceMissing: true,
    // "Pick for me" — which row the Ask box searches. "" = both.
    pickRow: "",
  }),
  // id → watch state, mirrored from the server so the modal can show the state
  // a title is already pinned in.
  watchlist: {},
  // What was typed into the Sign in card, kept across the redraw that shows a refusal.
  signInDraft: null,
  // Every pin, with its state and where it was made — the calendar needs to
  // tell its own plan-to-watch pins apart from the watchlist rows.
  watchItems: [],
  // The custom rows you fill yourself: which row each stored title is in.
  customItems: [],
  // The custom card's rows (Settings → Custom Rows): `[{ id, name, order, count }]`.
  customRows: [],
  // Who is signed in, as the server knows: `{ configured, providers, user }`. Mirrored
  // from `/settings` like everything else, and only ever *displayed* — the session lives
  // in an HttpOnly cookie this page cannot read, which is the point of it.
  account: { configured: false, providers: [], user: null },
  // The Custom card's label (a setting — see Settings → Content).
  customLabel: "Library",
  sources: migrateSources(readJSON(KEY.sources, [])),
  // App language and the country whose services the regional OTT cards show.
  language: localStorage.getItem(KEY.language) || "en-US",
  country: localStorage.getItem(KEY.country) || "US",
  // The order the OTT cards' rows are drawn in — that dropdown, and nothing else.
  ottSort: localStorage.getItem(KEY.ottSort) || "popular",
  // Which provider supplies the content inside a row: "tmdb" (default) or
  // "tvdb". Row membership is always TMDB's — this picks whose titles, artwork
  // and translations every catalog shows.
  contentSource: localStorage.getItem(KEY.contentSource) || "tmdb",
  // **TMDB and TVDB work together**: TMDB builds the row, TVDB fills the fields it
  // left empty, and each half can be turned off here (Settings → Trackers &
  // providers → Enrichment).
  enrich: readJSON(KEY.enrich, { tmdb: true, tvdb: true }),
  // The choices the server offers (languages, countries), and the search screen's
  // filter vocabulary (regions, categories per row type, periods, sorts).
  options: { languages: [], countries: [] },
  searchVocab: null,
  settingsSection: localStorage.getItem(KEY.section) || "profile",
  accent: localStorage.getItem(KEY.accent) || "gold",
  motion: localStorage.getItem(KEY.motion) || "auto",
  // **Sound, notifications and hover previews.** Each is a small map of switches rather
  // than a single flag, because they are separate questions: a click when you press
  // something is not the same as music under the browsing, and a calendar reminder is not
  // the same as a release date being announced.
  sound: readJSON(KEY.sound, { clicks: false, music: false, musicVolume: 35 }),
  notifications: readJSON(KEY.notifications, { calendar: true, releases: false, live: false }),
  previews: readJSON(KEY.previews, { cards: true, catalogs: false }),
  // "Pick the cards for you": when it is on, the per-profile visibility below
  // decides which rows, cards and catalog rows this profile shows. Off means every
  // card shows, which is the default so nothing disappears on its own.
  pickCards: readJSON(KEY.pickCards, false),
  // Per profile: rows.movie / rows.series, cards.<key>, catalogs.<id>. A missing
  // entry means "shown", so a card added later is visible without a migration.
  visibility: readJSON(KEY.visibility, {}),
  collections: [],
  order: {},
  calendar: { month: new Date().toISOString().slice(0, 7), day: null },
};

/** A pin is keyed by type *and* id — TMDB numbers films and shows in one space. */
const watchKey = (m) => `${m?.type === "series" ? "series" : "movie"}:${m?.id || ""}`;

/** Only the fields the app draws are pinned. */
const pinOf = (m) => ({
  id: m.id,
  type: m.type,
  name: m.name,
  poster: m.poster,
  background: m.background,
  releaseInfo: m.releaseInfo,
  // **A calendar plan is a plan about a *date*.** The day is drawn from the calendar the
  // pin was made on, and a stored plan that forgets it is a poster with no answer to
  // "planned for when?" — so the date travels with the pin.
  releaseDate: m.releaseDate,
  imdbRating: m.imdbRating,
  description: m.description,
  hasBetterPoster: Boolean(m.hasBetterPoster),
});

/**
 * Sources are **carried over**, not dropped.
 *
 * This build lists two kinds — a Stremio add-on and a Nuvio plugin — and an entry
 * saved under an older kind is translated into the one it really was rather than
 * thrown away: dropping them is what made a stored add-on and its providers vanish
 * from Settings without a word. "nuvio" was a manifest add-on, so it becomes a
 * Stremio add-on; the old CloudStream "repo" becomes a Nuvio plugin.
 */
function migrateSources(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => {
      const type = s?.type === "nuvio" ? "stremio" : s?.type === "repo" ? "nuvio-plugin" : s?.type;
      return s && s.url && SOURCE_TYPES.some(([t]) => t === type) ? { ...s, type } : null;
    })
    .filter(Boolean);
}

function applyWatchlist(payload) {
  const map = {};
  const items = payload?.items || [];
  for (const item of items) map[`${item.type}:${item.id}`] = item.state;
  state.watchlist = map;
  state.watchItems = items;
}

/**
 * The stored rows, as the app reads them.
 *
 * Only the **calendar's** plans use a stored row now: the Watchlist card is the
 * three states and nothing else, and there is no "add cards" row anywhere.
 */
function applyCustomRows(payload) {
  state.customItems = payload?.items || [];
  if (Array.isArray(payload?.rows)) state.customRows = payload.rows;
}

const rowKey = () => state.row;
const apiType = () => state.row;
const setRow = (row) => {
  state.row = row;
  localStorage.setItem(KEY.row, row);
};
const cardByKey = (key) => state.collections.find((c) => c.key === key);
/**
 * A card's catalogs **as the addon publishes them**.
 *
 * A card's own list used to be drawn whatever it said, so a stale card list (or an
 * addon that no longer serves a row) left a chip and a row behind for a catalog id
 * that answers 404 — "Anime" and "Asian Drama" were the visible pair. Every read of
 * a card goes through here, so the fix is one place: until the manifest answers,
 * nothing is filtered, and after it does a row the addon does not publish simply
 * is not drawn.
 */
const rowOf = (c) => {
  const r = c[rowKey()] || { cover: "", catalogs: [] };
  const live = state.publishedCatalogs;
  if (!live || !live.size || !r.catalogs.length) return r;
  // **A `more like` row is kept whatever the manifest says.** The For You rows are
  // rebuilt from your own titles on every request, so the ids the card list carries
  // and the ids the manifest published a moment earlier are never the same list.
  // Filtering on them dropped every For You row — the card read as "cover art only"
  // with an empty wall. Their ids always resolve server-side (`findCatalog` reads the
  // title back out of the id), so there is nothing here to drop.
  const catalogs = r.catalogs.filter((cat) => cat.kind === "recommend" || live.has(cat.id));
  return catalogs.length === r.catalogs.length ? r : { ...r, catalogs };
};

/**
 * A card's name **on the row you are looking at**.
 *
 * One card is not the same thing on Movies and on Shows: the Runtimes card holds
 * minutes on one and episode counts on the other, so the addon names each row and
 * the app reads that name. Cards that only have one name fall back to it.
 */
const titleOf = (c, row = rowKey()) => c?.[row]?.title || c?.title || "";

/**
 * A read from the app server.
 *
 * **Every one of them has a deadline.** With no deadline a request to a server that is
 * restarting (or a tunnel in front of it that has stopped answering) hangs until the
 * browser gives up, and a screen waiting on it is a screen with nothing on it: the boot
 * screen fades after its own few seconds and what is left is the top bar over black —
 * "the app opens on a blank page instead of anything". Answering in `ms` turns that into
 * a message the screen already knows how to show.
 */
const GET_TIMEOUT_MS = Number(globalThis.NUVIO_GET_TIMEOUT_MS) || 25000;
const get = async (path, { timeoutMs = GET_TIMEOUT_MS } = {}) => {
  let res;
  try {
    res = await fetch(API + path, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(err?.name === "TimeoutError" ? `the app server did not answer in ${Math.round(timeoutMs / 1000)}s` : String(err?.message || err));
  }
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
};

/**
 * The one read that is not JSON: a subtitle file.
 *
 * The player hands the answer straight to a `<track>`, so it needs the **text**, not a
 * parsed body — and a failure carries its reason in the JSON error the server wrote,
 * which is what stops "could not load the subtitles" from being all you get.
 */
const getText = async (path) => {
  const res = await fetch(API + path);
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json())?.error || message;
    } catch {
      /* not a JSON error — the status is the answer */
    }
    throw new Error(message);
  }
  return res.text();
};

/**
 * `unreachable` marks a failed **transport**, not a failed add-on.
 *
 * Without it a 503 from this app's own server and a 503 from an add-on were the same
 * object, so a source row blamed the add-on for a request that never reached it —
 * "HTTP 503" appeared on every source at once, including ones whose hosts do not even
 * resolve. Two different failures must not share a word.
 */
const post = async (path, body) => {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // **A 502/503 here is not the route failing — it is the app server gone.** The tunnel in
  // front of this app answers those two itself when nothing is listening, so "Custom Sites
  // could not be searched — HTTP 502" was really "there was no server to ask". Say that,
  // and say what to do about it, instead of printing the status code at the user.
  if (!res.ok) {
    const gone = res.status === 502 || res.status === 503 || res.status === 504;
    return {
      ok: false,
      unreachable: true,
      message: gone
        ? `the app server did not answer (HTTP ${res.status}) — it may have just restarted. Try again.`
        : `HTTP ${res.status}`,
    };
  }
  return res.json().catch(() => ({}));
};

/** Which settings write is the newest, so an older answer cannot undo a newer edit. */
let settingsPush = 0;

async function pushSettings(patch) {
  const seq = ++settingsPush;
  try {
    const res = await post("/settings", patch);
    // **Only the newest answer merges.** Two edits in a row — two presses of a position
    // arrow — leave two writes in flight, and the slower one's answer carries the
    // *older* list, which would put the add-ons back where they were a moment ago.
    // The server applies them in the order it receives them, so the newest answer is
    // the one that is true of it.
    if (res && seq === settingsPush) mergeServerSettings(res);
  } catch {
    /* offline — the local copy still applies */
  }
}

function mergeServerSettings(res) {
  const fold = (group, store, key) => {
    for (const name of Object.keys(store)) {
      const on = group?.[name]?.enabled;
      if (typeof on === "boolean") store[name].enabled = on;
      if (group?.[name]?.hasKey) store[name].hasKey = true;
    }
    writeJSON(key, store);
  };
  if (res.account) state.account = res.account;
  if (res.providers) fold(res.providers, state.providers, KEY.providers);
  if (res.tracking) fold(res.tracking, state.tracking, KEY.tracking);
  if (res.debrid) fold(res.debrid, state.debrid, KEY.debrid);
  if (res.subtitles) {
    // A row per service: `enabled` and `hasKey`, plus OpenSubtitles' `hasLogin` (a second
    // secret on its row), then the shared language and the list of services that are live.
    const next = { ...state.subtitles };
    for (const name of ["opensubtitles", ...SUBTITLE_SERVICES.map(([n]) => n)]) {
      const sv = res.subtitles[name];
      if (!sv) continue;
      next[name] = { ...state.subtitles[name], enabled: sv.enabled === true, hasKey: Boolean(sv.hasKey) };
      if (name === "opensubtitles") next[name].hasLogin = Boolean(sv.hasLogin);
    }
    next.language = typeof res.subtitles.language === "string" ? res.subtitles.language : state.subtitles.language;
    next.ready = res.subtitles.ready === true;
    if (Array.isArray(res.subtitles.services)) next.services = res.subtitles.services;
    state.subtitles = next;
    writeJSON(KEY.subtitles, state.subtitles);
  }
  if (Array.isArray(res.sources)) {
    // The server's copy is the one the player reads, so it wins — but only when it
    // actually holds something. A server that has never seen a source must not wipe
    // the add-ons this device already has; it is told about them instead.
    if (res.sources.length || !state.sources.length) {
      state.sources = migrateSources(res.sources);
      writeJSON(KEY.sources, state.sources);
    } else {
      pushSettings({ sources: state.sources });
    }
  }
  if (res.dns) {
    state.dns = { ...state.dns, ...res.dns };
    writeJSON(KEY.dns, state.dns);
  }
  if (res.customSites) {
    state.customSites = {
      ...state.customSites,
      categories: res.customSites.categories || [],
      // The pane draws the flat, tagged list; the per-category view is kept for anything
      // that still reads it, and for a server that is older than this page.
      sites: res.customSites.sites || state.customSites.sites || [],
      tags: res.customSites.tags || state.customSites.tags || [],
      repositories: res.customSites.repositories || [],
    };
    writeJSON(KEY.customSites, state.customSites);
  }
  if (res.prefs) {
    state.prefs = { ...state.prefs, ...res.prefs };
    writeJSON(KEY.prefs, state.prefs);
  }
  if (res.posters) {
    state.posters = { ...state.posters, ...res.posters };
    writeJSON(KEY.posters, state.posters);
  }
  if (res.ratings && typeof res.ratings.source === "string") {
    state.ratings = { ...state.ratings, source: res.ratings.source };
    writeJSON(KEY.ratings, state.ratings);
  }
  if (res.ai) {
    state.ai = { ...state.ai, ...res.ai };
    writeJSON(KEY.ai, state.ai);
  }
  if (typeof res.safe === "boolean") {
    state.safe = res.safe;
    writeJSON(KEY.safe, state.safe);
  }
  if (res.refresh && typeof res.refresh.minutes === "number") {
    state.refresh = res.refresh.minutes;
    writeJSON(KEY.refresh, state.refresh);
  }
  if (typeof res.language === "string" && res.language) {
    state.language = res.language;
    localStorage.setItem(KEY.language, state.language);
  }
  if (typeof res.country === "string" && res.country) {
    state.country = res.country;
    localStorage.setItem(KEY.country, state.country);
  }
  if (typeof res.customLabel === "string" && res.customLabel) state.customLabel = res.customLabel;
  if (res.content?.source === "tmdb" || res.content?.source === "tvdb") {
    state.contentSource = res.content.source;
    localStorage.setItem(KEY.contentSource, state.contentSource);
  }
  if (res.enrich && typeof res.enrich === "object") {
    state.enrich = { tmdb: res.enrich.tmdb !== false, tvdb: res.enrich.tvdb !== false };
    writeJSON(KEY.enrich, state.enrich);
  }
  if (res.options) state.options = res.options;
}

/**
 * What every catalog-ish request carries: the SFW switch and the content
 * language. The language is in the URL so a switch is a different URL for the
 * browser cache as well as for the server's pools.
 */
function catalogQuery() {
  const params = new URLSearchParams();
  if (!state.safe) params.set("adult", "1");
  if (state.language) params.set("lang", state.language);
  // Only present after a refresh: it makes the re-read a different URL, so the
  // browser cannot answer it out of its own copy of the row.
  if (state.gen) params.set("gen", String(state.gen));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Last-resort upscale for a TMDB url (used when a better poster is missing). */
function tmdbUpscale(url) {
  if (!url) return url;
  return url.replace("/w500/", "/w780/").replace("/w780/", "/w1280/").replace("/w185/", "/w500/");
}

/**
 * Move a title between watch states (or off the list when `next` is null) and
 * redraw — both the modal's buttons and the watchlist rows behind it.
 */
async function setWatchState(item, next) {
  const body = next === null ? { item: pinOf(item), remove: true } : { item: pinOf(item), state: next };
  try {
    const res = await post("/watchlist", body);
    if (res && Array.isArray(res.items)) applyWatchlist(res);
  } catch {
    /* offline — the list simply does not change */
  }
  // The watchlist card *is* its contents, so a pin or an unpin redraws it now —
  // unlike every other card, which holds its artwork until the next launch.
  forgetCardArt(watchlistCard());
  refreshPins(item);
}

/**
 * **Watching starts itself at 5%.**
 *
 * Press Play, get five percent in, and the title belongs in the Watching row — that is
 * where a list of what you are watching comes from, and asking someone to also press a
 * button after they have started watching is asking them to keep the list by hand. Only
 * a title with **no state at all** is moved: something marked Plan to Watch or Watched
 * on purpose stays where it was put, and the write happens once per player, not on every
 * `timeupdate`.
 */
const WATCH_AT = 0.05;
let watchedMarked = "";
async function watchedPast(meta, ratio) {
  const item = meta || {};
  if (!item.id || ratio < WATCH_AT) return;
  const key = watchKey(item);
  if (watchedMarked === key) return;
  watchedMarked = key;
  if (state.watchlist[key]) return;
  await setWatchState(item, "watching");
}

/**
 * The poster to show. A "better poster" (btttr.cc) is used as-is; anything the
 * poster service could not cover gets the upscale treatment, which is the
 * "apply it to the ones without a better poster" option in AI settings.
 */
function posterOf(m) {
  if (!m) return "";
  if (!state.ai?.enabled || !state.ai?.enhanceArtwork) return m.poster || "";
  if (m.hasBetterPoster) return m.poster || "";           // already the good one
  if (state.ai.enhanceMissing === false) return m.poster || "";
  return tmdbUpscale(m.poster);
}

function backdropOf(m) {
  if (!m) return "";
  const url = m.background || "";
  if (!state.ai?.enabled || !state.ai?.enhanceArtwork) return url;
  return url.replace("/w780/", "/w1280/");
}

/**
 * The banner's picture: a **landscape** backdrop, at the largest size TMDB serves.
 *
 * The banner's frame is 16:9. A 2:3 poster in it is either cropped into a letterbox
 * or blown up until it is blurry, so the banner never uses a poster: it uses the
 * backdrop (shot wide) and asks for `w1280` even when the row was served `w500`,
 * which is what keeps it sharp across a full-width banner.
 */
function heroImage(m) {
  const wide = m?.background || m?.poster || "";
  return wide ? wide.replace(/\/w\d+\//, "/w1280/") : "";
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  // Deep-flatten: panes and rows legitimately return nested arrays of nodes.
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/* ------------------------------------------------------------------- modal */

let modalItem = null;

/** The state a pinned title is in, drawn on its watchlist row card. */
function watchTag(m) {
  const label = WATCH_STATES.find(([id]) => id === m.state)?.[1];
  return label ? el("span", { class: `watch-tag ${m.state}`, text: label }) : null;
}

/* ------------------------------------------------------- the Custom card */

/** The row the **Custom** card publishes — your own list, filled from the modal. */
const CUSTOM_ROW = "add-cards";
const customLabel = () => state.customLabel || "Library";

/** Is this title already in your custom list? */
const inCustomRow = (m, rowId = CUSTOM_ROW) =>
  state.customItems.some(
    (i) => i.row === rowId && String(i.id) === String(m?.id) && (i.type === "series") === (m?.type === "series"),
  );

/**
 * Add the title to your custom list, or take it out again.
 *
 * One button that toggles, exactly like the watch states: a mis-click is one click
 * to undo, and the list is read back from the server so the Custom card's row is
 * redrawn with what it now holds.
 */
async function toggleCustomRow(item, rowId = CUSTOM_ROW) {
  try {
    const res = await post("/customrows", { row: rowId, item: pinOf(item) });
    if (res && Array.isArray(res.items)) applyCustomRows(res);
  } catch {
    /* offline — the list simply does not change */
  }
  if (!refreshPins(item)) render();
}

/**
 * Redraw the pin buttons after a pin, an unpin or a custom-row toggle.
 *
 * They live on the **title page** (`#title-pins`) now, so they are replaced where
 * they stand instead of by reopening a card over the page you are reading. Returns
 * `true` when it found them, so a caller only re-renders a screen that needs it.
 */
function refreshPins(item) {
  const host = document.getElementById("title-pins");
  if (!host) return false;
  host.replaceChildren(...pinButtons(item));
  return true;
}

const modal = {
  root: null,
  open(item, coverUrl) {
    modalItem = item;
    this.root.hidden = false;
    const hero = document.getElementById("modal-hero");
    const art = backdropOf(item) || coverUrl;
    hero.style.backgroundImage = art ? `url("${art}")` : "none";
    document.getElementById("modal-title").textContent = item.name || "";
    document.getElementById("modal-meta").textContent =
      [item.releaseInfo, item.imdbRating ? `★ ${item.imdbRating}` : ""].filter(Boolean).join("  ·  ");
    document.getElementById("modal-desc").textContent = item.description || "";

    // Pin the title to a watch state. Clicking the state it is already in
    // unpins it, so a mis-tap is one click to undo.
    const current = state.watchlist[watchKey(item)] || "";
    const customOn = inCustomRow(item);
    document.getElementById("modal-pins").replaceChildren(
      ...WATCH_STATES.map(([id, label]) =>
        el("button", {
          class: `btn pin focusable${current === id ? " active" : ""}`,
          type: "button",
          id: `pin-${id}`,
          title: current === id ? `Pinned as ${label} — click to unpin` : `Pin as ${label}`,
          "aria-pressed": String(current === id),
          text: current === id ? `${label} · pinned` : label,
          onclick: () => setWatchState(item, current === id ? null : id),
        }),
      ),
      // The Custom card's own row: the one list that is neither a watch state nor
      // a catalog — the titles you put there yourself.
      el("button", {
        class: `btn pin focusable${customOn ? " active" : ""}`,
        type: "button",
        id: "pin-custom",
        title: customOn ? `In ${customLabel()} — click to remove` : `Add to ${customLabel()}`,
        "aria-pressed": String(customOn),
        text: customOn ? `${customLabel()} · added` : `Add to ${customLabel()}`,
        onclick: () => toggleCustomRow(item),
      }),
    );
  },
  close() {
    this.root.hidden = true;
  },
};

/* --------------------------------------------------------------- data rows */

function posterCard(m, opts = {}) {
  const poster = posterOf(m);
  // The calendar mixes films and series in one grid, so it asks for the row type
  // to be drawn on the card.
  const kind = opts.kind ? (m.type === "movie" ? "Movie" : "Series") : "";
  return el(
    // `data-id` lets the checks tell a real duplicate apart from two TMDB
    // titles that share a name.
    "button",
    {
      class: "poster focusable",
      type: "button",
      "data-id": m.id || "",
      // **What the hover preview reads.** The card itself draws no caption (the
      // artwork is the picture and nothing else), so the name, year, kind and rating
      // travel on the element for the preview panel to pick up — see `showPreview`.
      "data-name": m.name || "",
      "data-year": releaseYear(m.releaseInfo) || "",
      "data-kind": m.type === "series" ? "Series" : "Movie",
      "data-rating": m.imdbRating || m.rating || "",
      // The card page's frame follows the title you point at, so the backdrop it
      // should show travels on the poster itself.
      "data-backdrop": backdropOf(m) || heroImage(m) || "",
      // A poster opens the title's **page**, not a quick-look modal: the page is
      // where the cast, the studio, the franchise, the seasons and the sources are.
      onclick: () => go(`#/t/${m.type === "series" ? "series" : "movie"}/${String(m.id || "").replace(/^tmdb:/, "")}`),
    },
    // A card always shows something. A plan made from the calendar stores only the
    // fields the app draws, and any picture can fail to load — either way the plate
    // used to be left empty, which is the dark rectangle "glitching" on a pin. The
    // title's own initials stand in for it instead.
    poster
      ? el("img", {
          src: poster,
          alt: m.name,
          loading: "lazy",
          onerror: (event) => {
            const img = event.currentTarget;
            if (!img || !img.parentElement) return;
            // A better poster the service does not have 404s; the original artwork
            // the server kept is drawn instead of dropping straight to initials.
            const backup = m.posterBackup || "";
            if (backup && img.getAttribute("src") !== backup) {
              img.setAttribute("src", backup);
              return;
            }
            img.replaceWith(posterFallback(m.name));
          },
        })
      : posterFallback(m.name),
    // **A poster is the picture and nothing else.** No name, no year, no rating over
    // the artwork anywhere it has artwork — the label was the "text, year and rating
    // on catalogs" that would not go away. **Nothing is drawn over a poster at all**
    // now, on any screen: not the name, not the year, not the rating. The plate is the
    // artwork and nothing else, and a title's name is carried by the page it opens.
    // The `caption` option is kept so callers that pass it still mean what they say,
    // it simply has nothing left to switch on.
    opts.watch ? watchTag(m) : null,
  );
}

/**
 * One window of a catalog row.
 *
 * A watchlist (or calendar) row is your own state, so it is requested with a
 * fresh `_=` every time and the server answers it `no-store`. Without both, the
 * browser serves its cached copy of the row and a title you just unpinned is
 * still on screen — which is exactly what "removing it from the watchlist does
 * not remove it" was.
 */
/** The first letters of a title, drawn when there is no poster to draw. */
const initialsOf = (name) =>
  String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("") ||
  "?";

const channelResolution = (name = "") => {
  const text = String(name || "").toLowerCase();
  if (text.match(/\b(2160p|4k|uhd)\b/)) return "4K";
  if (text.match(/\b(1440p|qhd|wqhd)\b/)) return "QHD";
  if (text.match(/\b(1080p|fhd|full hd)\b/)) return "FHD";
  if (text.match(/\b(720p|hd|hdtv)\b/)) return "HD";
  if (text.match(/\b(576p|480p|pal|ntsc|sd)\b/)) return "SD";
  return "";
};

const posterFallback = (name) => el("div", { class: "poster-fallback", text: initialsOf(name).toUpperCase() });

async function fetchCatalog(catalog, skip = 0, count = 0) {
  const suffix = skip ? `/skip=${skip}` : "";
  const stateful = catalog.kind === "watchlist" || catalog.kind === "custom";
  // **The query is built here, not by string-glueing.** `count` asks for several
  // pages in one round trip (Explore uses it to fill a letter out), and a
  // stateful row still carries its cache-buster as a real parameter rather than as
  // a `&_=` glued onto a query that may be empty.
  const params = new URLSearchParams();
  if (!state.safe) params.set("adult", "1");
  if (state.language) params.set("lang", state.language);
  if (state.gen) params.set("gen", String(state.gen));
  if (count) params.set("count", String(count));
  // **The OTT rows' own order.** Only those cards set it (see `render`), so this is a
  // no-op on every other row, and the server ignores a value it does not know.
  if (activeOttSort) params.set("sort", activeOttSort);
  // **What this card's other For You rows have already shown.** A title that is
  // popular stays popular whatever row you seed with, so `More Like A` and `More Like
  // B` can both open on the same film; the ids already on screen ride along here and
  // the server deals past them (see `dealForYou`).
  if (catalog.kind === "recommend") {
    const exclude = forYouExclude(catalog.id);
    if (exclude) params.set("exclude", exclude);
    if (forYouOpen) params.set("open", forYouOpen);
  }
  if (stateful) params.set("_", String(Date.now()));
  const query = params.toString();
  return get(`/catalog/${apiType()}/${encodeURIComponent(catalog.id)}${suffix}.json${query ? `?${query}` : ""}`);
}

/**
 * Every title the For You card has put on screen **in this open**, per row.
 *
 * The card's rows are one title's recommendations each, and those lists overlap:
 * the same film is recommended for a dozen different seeds. Its own memory is not
 * enough (that is *between* opens), so the rows are drawn in one screen and each one
 * is asked to leave out what the others have already drawn — which needs the page to
 * remember them, since the server answers one row per request.
 */
const forYouServed = new Map();

/** Forget it: a fresh open of the card is a fresh deal. */
function clearForYouServed() {
  forYouServed.clear();
}

/**
 * The current open of the For You card, as a short nonce.
 *
 * Every row of one open carries it (`?open=`), so the server's shared deal memory is
 * per open: a second open re-deals instead of echoing the first. Without it the rows
 * of an open share one memory with every open before it, and once the pools are
 * memorized every row tops back up from the same titles — the same titles, every
 * time, on every row.
 */
let forYouOpen = "";

/** The ids the *other* rows of this card have shown, as the server takes them. */
function forYouExclude(ownId) {
  const ids = [];
  for (const [id, set] of forYouServed) {
    if (id === ownId) continue;
    ids.push(...set);
  }
  return ids.slice(0, 400).join(",");
}

/** Remember a row's own titles so the rows beside it can be dealt past them. */
function noteForYouServed(id, metas) {
  const set = forYouServed.get(id) || new Set();
  for (const m of metas) if (m?.id) set.add(String(m.id));
  forYouServed.set(id, set);
}

/**
 * What an empty row means depends on the row. A watchlist row is empty because
 * nothing has been pinned yet, not because the catalog failed.
 */
function emptyRowText(catalog) {
  if (catalog.kind === "watchlist") {
    return `${catalog.name} is empty — open a title and pin it as ${catalog.state || "planned"}.`;
  }
  if (catalog.kind === "custom") {
    return `${catalog.name} is empty — open any title and add it to this row.`;
  }
  return "No titles returned for this catalog.";
}

/**
 * Fill a catalog row. The strip is not a fixed window: scrolling it to the end
 * asks the server for the next one, so a row keeps going the way Explore does.
 * (A row used to stop dead after its first window, which is what "this row does
 * not scroll" meant.)
 */
async function fillStrip(strip, catalog) {
  let skip = 0;
  let done = false;
  let busy = false;

  const onScroll = () => {
    if (strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 600) load();
  };

  const load = async () => {
    if (busy || done) return;
    busy = true;
    try {
      const { metas } = await fetchCatalog(catalog, skip);
      if (!skip) strip.replaceChildren();
      if (!metas.length) {
        done = true;
        strip.removeEventListener("scroll", onScroll);
        strip.append(
          el("p", { class: skip ? "empty strip-end" : "empty", text: skip ? "End of catalog." : emptyRowText(catalog) }),
        );
        return;
      }
      for (const m of metas) strip.append(posterCard(m, { watch: catalog.kind === "watchlist" }));
      // A For You row hands its titles to the card's *other* rows — see
      // `forYouServed` — so two of them cannot open on the same film.
      if (catalog.kind === "recommend") noteForYouServed(catalog.id, metas);
      skip += metas.length;
    } catch (err) {
      done = true;
      strip.removeEventListener("scroll", onScroll);
      if (!skip) {
        strip.replaceChildren(
          el("p", { class: "empty", text: `Could not load “${catalog.name}” — ${err.message}` }),
        );
      }
    } finally {
      busy = false;
    }
  };

  strip.addEventListener("scroll", onScroll, { passive: true });
  await load();
}

function lazyStrip(catalog) {
  const strip = el("div", { class: "strip" });
  for (let i = 0; i < 6; i++) strip.append(el("div", { class: "placeholder" }));
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      observer.disconnect();
      fillStrip(strip, catalog);
    }
  }, { rootMargin: "400px" });
  observer.observe(strip);
  return strip;
}

/**
 * A clickable catalog-name chip.
 *
 * Clicking a chip takes you to the row itself: it opens the card and scrolls that
 * catalog's row into view. It used to drop straight into Explore, which skipped
 * the other rows of the collection you were looking at.
 */
/**
 * A drawn icon, in the **SVG namespace**.
 *
 * `el("svg", …)` cannot draw one: `document.createElement` makes an HTML element
 * merely *named* "svg", and its `<path>` children are never rendered. That is why
 * the tag-line arrows came out as empty pills — a filled plate with an invisible
 * mark — and the search funnel and the shuffle mark were missing too. Everything
 * built here is a real SVG node, so every stroked glyph (`.glyph svg`,
 * `.search-glyph svg`) paints.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
function svgNode(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  for (const child of children.flat(Infinity)) if (child) node.append(child);
  return node;
}

/**
 * One stroked mark on the player's control bar.
 *
 * The player is drawn by this app, so its controls are drawn too — the same 24px
 * stroked grid the top bar uses, never an emoji or a word. `size` is the drawn size
 * in px (the centre target is larger than the bar's).
 */
function playerGlyph(paths, size = 18) {
  return el(
    "span",
    { class: "player-glyph", "aria-hidden": "true" },
    svgNode("svg", { viewBox: "0 0 24 24", width: String(size), height: String(size) }, ...paths.flat(Infinity).filter(Boolean)),
  );
}

/** A drawn chevron, for the show-more control. */
const chevronDown = () =>
  el(
    "span",
    { class: "glyph", "aria-hidden": "true" },
    svgNode("svg", { viewBox: "0 0 24 24" }, svgNode("path", { d: "M6 9l6 6 6-6" })),
  );
const chevronUp = () =>
  el(
    "span",
    { class: "glyph", "aria-hidden": "true" },
    svgNode("svg", { viewBox: "0 0 24 24" }, svgNode("path", { d: "M6 15l6-6 6 6" })),
  );

/** One row of the tag track, measured, so a step is a row and not a guess. */
const trackRow = (track) => {
  const first = track.firstElementChild;
  const height = first?.getBoundingClientRect?.().height || first?.offsetHeight || 26;
  return height + 8;
};

/**
 * A line of chips, held to two rows with **up/down arrows that scroll it**.
 *
 * A card page and the banner carry one chip per catalog, and the big cards hold
 * nearly two hundred tags — a wall of pills that pushes the rows off the screen. So
 * the line is a two-row window: the arrows step it a row at a time (and the wheel
 * over it scrolls it too), each arrow going dim at its own end of the list. A short
 * list gets no control at all. Nothing is expanded in place — the line stays two
 * rows tall however many tags there are.
 */
const CHIP_CLAMP_AT = 8;

/**
 * **Arrows only where they are needed.**
 *
 * A running count is a poor judge of that: *Runtime* holds nine pills and *Genres*
 * about twenty, and both fit their two rows whole — so buttons that scroll nothing
 * were sitting under them. The real question is not how many tags a line has but
 * whether **any of them are out of reach**, and only the layout can answer it. So the
 * layout is asked directly, through a `ResizeObserver` on the track: it fires once the
 * line is in the document, again when the window changes size, and again when a line
 * that was **hidden** is opened — which is exactly what the search panel's filter
 * lines do, since they are built while the panel is shut. Nothing has to know when to
 * ask, and `apply` is told the answer both ways, so a line that starts to overflow
 * gets its arrows back.
 *
 * A DOM that reports no layout at all (jsdom, a WebView before first paint) cannot
 * answer it, and the control is **kept** rather than dropped on a guess — the same
 * reason `sync` will not call an arrow "at the end" there.
 */
function watchArrowFit(track, apply) {
  let observer = null;
  function stop() {
    observer?.disconnect();
    observer = null;
    window.removeEventListener("resize", measure);
  }
  function measure() {
    if (!track.isConnected) return stop();
    // Not laid out yet, or in a panel nobody has opened: ask again when it has a box.
    if (!track.clientHeight) return;
    apply(track.scrollHeight <= track.clientHeight + 2);
  }
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(measure);
    observer.observe(track);
  } else {
    // An older DOM with no observer: the frame after the line is drawn, and the
    // window's own changes, are the two moments this can change. `measure` takes the
    // listener back off once the line is gone.
    requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
  }
  return measure;
}

function chipLine(children, { className = "cats" } = {}) {
  if (children.length <= CHIP_CLAMP_AT) return el("div", { class: className }, ...children);
  const track = el("div", { class: "chip-track", tabindex: "0" }, ...children);
  const up = el(
    "button",
    { class: "chip-arrow up focusable", type: "button", title: "Scroll the tags up", "aria-label": "Scroll the tags up", onclick: () => step(-1) },
    chevronUp(),
  );
  const down = el(
    "button",
    { class: "chip-arrow down focusable", type: "button", title: "Scroll the tags down", "aria-label": "Scroll the tags down", onclick: () => step(1) },
    chevronDown(),
  );

  function step(direction) {
    track.scrollBy({ top: direction * trackRow(track), behavior: reducedMotion() ? "auto" : "smooth" });
  }

  // Each arrow dims at its own end, so the line says where it is without a label.
  // "At the end" is only claimed when the track can actually be measured: a DOM
  // with no layout (jsdom, a WebView before first paint) reports every height as
  // zero, and the control must stay usable there rather than look finished.
  const sync = () => {
    const measurable = track.scrollHeight > track.clientHeight + 2;
    const hidden = track.scrollHeight - track.clientHeight - track.scrollTop;
    down.disabled = measurable && hidden <= 2;
    up.disabled = measurable && track.scrollTop <= 2;
    down.classList.toggle("at-end", down.disabled);
    up.classList.toggle("at-end", up.disabled);
  };

  const label = `${children.length} tags — use the arrows to scroll them`;
  const plate = el("div", { class: "chip-scroll" }, up, down);
  const line = el("div", { class: `${className} chip-block chip-clamped`, title: label }, track, plate);
  // The plate is held back only where it would scroll nothing (see `watchArrowFit`),
  // and the "use the arrows" title goes with it.
  watchArrowFit(track, (fits) => {
    line.classList.toggle("chip-fits", fits);
    if (fits) line.removeAttribute("title");
    else line.setAttribute("title", label);
    sync();
  });
  track.addEventListener("scroll", sync, { passive: true });

  return line;
}

/**
 * A card's tag.
 *
 * It is a **label**, not a control: the tags on the banner and on a card page name
 * what is inside the card, and turning them into buttons made every tag a hidden
 * door into a catalog nobody meant to open. They are plain text in the app's own
 * pill, so pointing at one does nothing.
 */
function catalogChip(card, cat) {
  return el("button", {
    class: "chip focusable",
    type: "button",
    title: `Go to ${cat.name}`,
    text: cat.name,
    onclick: () => openRow(card.key, cat.id),
  });
}

/**
 * Open a card and bring one of its rows to the top of the screen.
 *
 * The page renders asynchronously (each row fetches its own titles), so the scroll
 * is retried over a few frames until the row exists — and it is a no-op when we are
 * already on that card.
 */
function openRow(key, catalogId) {
  const here = parseHash();
  if (here.view !== "card" || here.key !== key) go(`#/c/${encodeURIComponent(key)}`);
  const find = () => document.querySelector(`.cat-row[data-catalog="${CSS.escape(catalogId)}"]`);
  let tries = 0;
  const jump = () => {
    const node = find();
    if (node) {
      // Guarded: a bare DOM implementation (jsdom, an old WebView) has no
      // scrollIntoView, and jumping is a nicety, not a requirement.
      if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start", behavior: "smooth" });
      node.classList.add("row-flash");
      setTimeout(() => node.classList.remove("row-flash"), 1200);
      return;
    }
    if (tries++ < 40) requestAnimationFrame(jump);
  };
  requestAnimationFrame(jump);
}

/* ---------------------------------------------------------------- routing */

function parseHash() {
  const [raw, rawQuery = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const hash = raw;
  const query = new URLSearchParams(rawQuery);
  if (hash.startsWith("c/")) return { view: "card", key: decodeURIComponent(hash.slice(2)) };
  if (hash.startsWith("x/")) {
    const [key, id] = hash.slice(2).split("/");
    return { view: "explore", key: decodeURIComponent(key), id: decodeURIComponent(id || "") };
  }
  if (hash.startsWith("s/")) {
    const [id, name] = hash.slice(2).split("/");
    return { view: "sources", id: decodeURIComponent(id || ""), name: decodeURIComponent(name || "") };
  }
  // A title's own page, and the list behind any name on it (a person, a studio, a
  // genre, a franchise, a season). Both are real routes, so they can be linked to,
  // go Back to, and remember where they were scrolled.
  if (hash.startsWith("t/")) {
    const [type, id] = hash.slice(2).split("/");
    return { view: "title", type: decodeURIComponent(type || "movie"), id: decodeURIComponent(id || "") };
  }
  if (hash.startsWith("l/")) {
    // Three segments, not two: a season's list is `l/season/<show>/<season>`, and
    // reading only two dropped the season number — every season then opened season 1.
    const [kind, id, extra] = hash.slice(2).split("/");
    return {
      view: "list",
      kind: decodeURIComponent(kind || "person"),
      id: decodeURIComponent(id || ""),
      extra: decodeURIComponent(extra || ""),
      type: query.get("type") || "",
    };
  }
  if (hash.startsWith("channel/")) return { view: "channel", id: decodeURIComponent(hash.slice(8)) };
  if (hash === "guide") return { view: "guide" };
  if (hash === "recordings") return { view: "recordings" };
  if (hash.startsWith("categories/")) return { view: "category", group: decodeURIComponent(hash.slice(11)) };
  if (hash === "categories") return { view: "categories" };
  if (hash === "profiles") return { view: "profiles" };
  if (hash === "modes") return { view: "modes" };
  if (hash === "calendar") return { view: "calendar" };
  if (hash === "search") return { view: "search" };
  if (hash === "settings") return { view: "settings" };
  return { view: "home" };
}

const go = (hash) => {
  location.hash = hash;
};

/* ------------------------------------------------------------------ shuffle */

function applyShuffle(key, catalogs) {
  const pinned = catalogs.filter((c) => PINNED.test(c.name));
  const rest = catalogs.filter((c) => !PINNED.test(c.name));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  state.order[key] = [...pinned, ...rest].map((c) => c.id);
}

/* -- what this profile shows ------------------------------------------------- */

/**
 * The visibility of the current profile: which media rows, cards and catalog rows
 * it shows. Missing means shown, so a card or row added in a later version appears
 * without touching what you have already hidden.
 */
function visFor() {
  const key = state.profile || PROFILES[0];
  if (!state.visibility[key]) state.visibility[key] = { rows: { movie: true, series: true }, cards: {}, catalogs: {} };
  const v = state.visibility[key];
  v.rows = v.rows || { movie: true, series: true };
  v.cards = v.cards || {};
  v.catalogs = v.catalogs || {};
  return v;
}

const saveVisibility = () => writeJSON(KEY.visibility, state.visibility);

/** A pick only takes effect when the profile is picking — otherwise all shows. */
const picking = () => state.pickCards === true;
const rowEnabled = (row) => !picking() || visFor().rows[row] !== false;
const cardVisible = (card) => !picking() || visFor().cards[card.key] !== false;
const catalogVisible = (cat) => !picking() || visFor().catalogs[cat.id] !== false;

function orderedCatalogs(card) {
  const catalogs = rowOf(card).catalogs;
  const order = state.order[card.key];
  if (order) {
    const byId = new Map(catalogs.map((c) => [c.id, c]));
    const sorted = order.map((id) => byId.get(id)).filter(Boolean);
    for (const c of catalogs) if (!order.includes(c.id)) sorted.push(c);
    return sorted;
  }
  return catalogs;
}

// A drawn icon, like the rest of the controls — not the ⇄ text glyph.
const shuffleIcon = () =>
  el(
    "span",
    { class: "glyph", "aria-hidden": "true" },
    svgNode(
      "svg",
      { viewBox: "0 0 24 24" },
      svgNode("path", { d: "M4 7h3.2l9.6 10H20" }),
      svgNode("path", { d: "M17 14l3 3-3 3" }),
      svgNode("path", { d: "M4 17h3.2l9.6-10H20" }),
      svgNode("path", { d: "M17 4l3 3-3 3" }),
    ),
  );

/* -------------------------------------------------------------------- views */

/* ---- switch profile ------------------------------------------------------- */

/** Pick a profile and enter the app. */
function chooseProfile(name) {
  state.profile = name;
  localStorage.setItem(KEY.profile, name);
  pushSettings({ profile: name });
  // Each profile's settings are its own: entering Live TV & Sports lands on its
  // Source section, and entering Movies & Shows lands on Content — so the two
  // never share a section that does not exist for them.
  const first = name === LIVE_PROFILE ? "livesource" : SETTINGS_SECTIONS[0][0];
  state.settingsSection = first;
  localStorage.setItem(KEY.section, first);
  // **The link you arrived on, once you have said who you are.** Set by `boot()`; a
  // normal start (no link) has nothing here and lands on Home.
  const target = pendingDeepLink;
  pendingDeepLink = "";
  location.hash = target || "#/";
  render();
}

/**
 * A profile's avatar — a drawn mark, not a letter.
 *
 * The two profiles are not people, they are **ways of watching**, so each gets the
 * mark that says which: a screen with a play mark for **VOD**, a television taking a
 * signal for **IPTV**. Anything else falls back to a person, so a profile added later
 * still has one. Drawn with `svgNode`, in the SVG namespace — `el("svg", …)` makes an
 * HTML element that merely has the name, whose paths never paint.
 */
function avatarNode(name) {
  // **A mode is not a mascot.** These discs used to hold the app's own cat, which
  // says "this app" — on the one screen whose whole job is to say *which mode* you
  // are picking. The two drawn marks below answer that question: a screen with a
  // play mark for on-demand, a television taking a signal for live.
  if (name === LIVE_PROFILE) {
    // IPTV — a screen being fed: the set, its stand, and the aerial with its signal.
    return svgNode(
      "svg",
      { class: "avatar-mark", viewBox: "0 0 48 48", "aria-hidden": "true" },
      svgNode("rect", { x: "7.5", y: "17.5", width: "33", height: "20", rx: "3.5" }),
      svgNode("path", { d: "M24 37.5v4M17.5 41.5h13" }),
      svgNode("path", { d: "M24 7v5" }),
      svgNode("path", { d: "M17.5 12.5a9 9 0 0 1 13 0" }),
      svgNode("path", { d: "M20.5 9a5 5 0 0 1 7 0" }),
    );
  }
  if (name === PROFILES[0]) {
    // VOD — on demand: a screen, and the play mark that says *you* choose when.
    return svgNode(
      "svg",
      { class: "avatar-mark", viewBox: "0 0 48 48", "aria-hidden": "true" },
      svgNode("rect", { x: "6.5", y: "11", width: "35", height: "26", rx: "4" }),
      svgNode("path", { d: "M20.5 18.5l9 5.5-9 5.5z" }),
    );
  }
  // A profile added later still gets a mark rather than an empty disc.
  return svgNode(
    "svg",
    { class: "avatar-mark", viewBox: "0 0 48 48", "aria-hidden": "true" },
    svgNode("circle", { cx: "24", cy: "17", r: "7.5" }),
    svgNode("path", { d: "M10 40c0-7.5 6.3-12 14-12s14 4.5 14 12" }),
  );
}

/**
 * Dress the top-left button in the mark of the mode you are in.
 *
 * That corner holds the switch-mode button, and it drew a person — which answers
 * "who is this?" in an app whose two profiles are **ways of watching**. The same mark
 * the switch screen uses answers "which mode am I in?" instead. It is redrawn only
 * when the mode actually changes, so a render cannot steal focus from the button you
 * are standing on.
 */
function syncProfileMark() {
  const button = document.getElementById("profile");
  if (!button) return;
  const title = `${currentPerson().name} · ${state.profile} — switch profile`;
  button.title = title;
  button.setAttribute("aria-label", title);
  if (button.dataset.mark === state.profile) return;
  button.dataset.mark = state.profile;
  const mark = avatarNode(state.profile);
  if (mark) button.replaceChildren(mark);
}

/**
 * **Signing in — the account, and however you want to make one.**
 *
 * The app keeps an account of its own: a name and an optional address, on this machine
 * (`addon/account.json`, no password, nothing verified, nothing sent anywhere) and that is
 * the way in that works on a fresh install. Google and GitHub are still here as the two
 * provider buttons that appear when their keys are set, and they go through the same
 * session cookie and the same `/auth/me` — a provider sign-in and a local one are the same
 * thing to everything downstream.
 *
 * **What was wrong with the card.** Every `.option-desc` in the app is hidden by the
 * "no subtext" rule, so a card made only of an `.option-desc` was the word **Sign in** with
 * nothing to press: on a machine with no provider keys it drew *zero* controls. What it
 * draws now is the thing itself — a name, an address if you have one, and Continue.
 */
function signInCard() {
  const account = state.account || {};
  const providers = Array.isArray(account.providers) ? account.providers : [];
  // What this machine remembers. It is what makes the card useful before anything is
  // typed: the name is filled in, and the button says whose session it would resume.
  const local = account.local || null;
  const live = providers.filter((p) => p.configured);
  // A provider's refusal comes back on the hash (`#/settings?signin_error=…`); this
  // app's own comes back on the state, so it survives the redraw that shows it.
  const said = new URLSearchParams(location.hash.split("?")[1] || "").get("signin_error") || account.refused || "";
  // **What was typed is not thrown away.** The redraw that shows a refusal would
  // otherwise clear the fields, so the name worth correcting is the name that is gone.
  const draft = state.signInDraft || { name: local?.name || "", email: local?.email || "" };

  if (account.user) {
    const user = account.user;
    const via = (providers.find((p) => p.key === user.provider) || {}).label
      || (user.provider === "local" ? "this device" : user.provider);
    return el(
      "div",
      { class: "provider", id: "account" },
      el(
        "div",
        { class: "account-row" },
        user.picture
          ? el("img", { class: "account-avatar", src: user.picture, alt: "", loading: "lazy" })
          : el("span", { class: "account-avatar", text: (user.name || user.email || "?").slice(0, 1).toUpperCase() }),
        el(
          "div",
          { class: "account-body" },
          el("span", { class: "option-title", text: user.name || user.email || "Signed in" }),
          el("span", { class: "option-desc", text: [user.email, via ? `via ${via}` : ""].filter(Boolean).join(" · ") }),
        ),
        el("button", {
          class: "btn focusable",
          type: "button",
          id: "sign-out",
          text: "Sign out",
          title: "End this session. The account stays where it is.",
          onclick: signOutAccount,
        }),
        // **This machine's account can be taken off this machine.** A provider's cannot —
        // that one is not ours to delete — so it gets Sign out and nothing more.
        user.provider === "local"
          ? el("button", {
              class: "btn subtle focusable",
              type: "button",
              id: "account-forget",
              text: "Forget",
              title: `Remove ${user.name || "this account"} from this machine`,
              onclick: forgetAccount,
            })
          : null,
      ),
    );
  }

  const nameField = el("input", {
    class: "text-input focusable",
    type: "text",
    id: "sign-in-name",
    maxlength: "40",
    value: draft.name,
    placeholder: "Your name",
    "aria-label": "Your name",
  });
  const emailField = el("input", {
    class: "text-input focusable",
    type: "email",
    id: "sign-in-email",
    maxlength: "120",
    value: draft.email,
    placeholder: "Email (optional)",
    "aria-label": "Email (optional)",
  });
  const submit = () => signInOnThisMachine(nameField.value, emailField.value);
  // Enter in either field is the button: this is a two-field form, and a form whose last
  // press needs the mouse is a form that feels broken.
  for (const field of [nameField, emailField]) {
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); submit(); }
    });
  }
  const continueBtn = el("button", {
    class: "btn primary focusable",
    type: "button",
    id: "sign-in-continue",
    text: local ? `Continue as ${local.name}` : "Continue",
    title: local ? `Come back as ${local.name}` : "Sign in on this machine — the name stays here",
    onclick: submit,
  });
  // The button stops offering a name the moment the field stops holding it.
  nameField.addEventListener("input", () => {
    continueBtn.textContent = local && nameField.value.trim() === local.name ? `Continue as ${local.name}` : "Continue";
  });

  return el(
    "div",
    { class: "provider", id: "account" },
    el(
      "div",
      { class: "provider-head" },
      el(
        "div",
        {},
        el("span", { class: "option-title", text: "Sign in" }),
        el("span", {
          class: "option-desc",
          text: local
            ? `This machine remembers ${local.name}. Continue as them, or type another name.`
            : "A name is the whole account, and it stays on this machine — no password, and nothing sent anywhere.",
        }),
      ),
    ),
    said ? el("p", { class: "signin-said", text: said }) : null,
    el("div", { class: "account-row account-buttons" }, nameField, emailField, continueBtn),
    live.length
      ? el(
          "div",
          { class: "account-row account-buttons" },
          ...live.map((p) =>
            el("button", {
              class: "btn focusable",
              type: "button",
              id: `sign-in-${p.key}`,
              text: `Continue with ${p.label}`,
              // **A plain navigation, not a fetch.** The provider's page is a different
              // origin and the handshake has to happen in the address bar: this page
              // leaves, the provider comes back to `/auth/<provider>/callback`, and the
              // server returns here with a cookie set.
              onclick: () => { location.href = `/auth/${p.key}/start?next=${encodeURIComponent("/app/#/settings")}`; },
            }),
          ),
        )
      : null,
    local
      ? el("button", {
          class: "btn subtle focusable",
          type: "button",
          id: "account-forget",
          text: "Forget this account",
          title: `Remove ${local.name} from this machine`,
          onclick: forgetAccount,
        })
      : null,
    live.length
      ? null
      : el("p", {
          class: "option-desc",
          text: "Google and GitHub are offered here as well, when NUVIO_GOOGLE_CLIENT_ID and NUVIO_GOOGLE_CLIENT_SECRET (or the GitHub pair) are set and <this app>/auth/<provider>/callback is registered as the redirect.",
        }),
  );
}

/** Sign out of the session. Whatever this machine remembers is left alone. */
async function signOutAccount() {
  await post("/auth/signout", {}).catch(() => { /* the session is gone either way */ });
  state.account = { ...(state.account || {}), user: null, refused: "" };
  state.signInDraft = null;
  render();
}

/** Forget this machine's account — the name and the address, not just the session. */
async function forgetAccount() {
  await post("/auth/local/forget", {}).catch(() => { /* it is this machine's own file */ });
  state.account = { ...(state.account || {}), user: null, local: null, refused: "" };
  state.signInDraft = null;
  render();
}

/**
 * Sign in on this machine: a name, and an address if there is one.
 *
 * The answer is read here rather than through `post`, which turns a refusal into
 * "HTTP 400" — and the refusal is the thing worth showing (a name is needed; an address
 * that is not an address is not kept), so the sentence the server wrote goes on screen.
 */
async function signInOnThisMachine(name, email) {
  state.signInDraft = { name, email };
  let answer = {};
  let status = 0;
  try {
    const res = await fetch(`${API}/auth/local`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email }),
    });
    status = res.status;
    answer = await res.json().catch(() => ({}));
  } catch (err) {
    answer = { error: `The app server did not answer — ${err.message}` };
  }
  if (!answer.user) {
    state.account = { ...(state.account || {}), refused: answer.error || `That name was not taken (HTTP ${status}).` };
    render();
    return;
  }
  state.signInDraft = null;
  state.account = { ...(state.account || {}), user: answer.user, local: answer.local || (state.account || {}).local || null, refused: "" };
  render();
}


/**
 * **Who is watching — the screen the app starts on.**
 *
 * The app used to open on the mode screen, which asks *how* you want to watch before it
 * knows *who* is watching. The profile comes first now, and the mode screen follows it.
 *
 * **A profile is made here, not in Settings.** Adding, renaming and removing all live on
 * this screen, because this is the screen about profiles: a name is edited in place
 * (the tile keeps its shape and the field takes the name's place), and a profile can only
 * be removed while another one is left to enter with.
 */
function renderPeople() {
  const people = profileList();
  const current = currentPerson();
  const renaming = state.renaming || "";
  return [
    el(
      "section",
      { class: "profiles" },
      el("p", { class: "hero-kicker", text: "Profiles" }),
      el("h1", { class: "view-title", text: "Who's watching?" }),
      el("p", { class: "view-hint", text: "Pick a profile to start. How you want to watch comes next." }),
      el(
        "div",
        { class: "profile-grid" },
        ...people.map((person) => personSlot(person, person.id === current.id, renaming === person.id, people.length)),
        // **The slot that is not a profile yet.** Drawn dashed and named for what it
        // does, so adding a profile is on the screen rather than hidden in Settings.
        el(
          "div",
          { class: "profile-slot" },
          el(
            "button",
            {
              class: "profile-tile focusable add",
              type: "button",
              id: "profile-add",
              title: "Add a profile",
              onclick: addPerson,
            },
            el("span", { class: "avatar", "aria-hidden": "true" }, plusMark()),
            el("span", { class: "profile-tile-name", text: "Add profile" }),
            el("span", { class: "profile-tile-sub", text: "a new name and mark" }),
          ),
        ),
      ),
    ),
  ];
}

/** The plus a new profile wears — the one mark in the app that means "make one". */
const plusMark = () =>
  svgNode("svg", { class: "plus-mark", viewBox: "0 0 48 48", "aria-hidden": "true" },
    svgNode("path", { d: "M24 13v22M13 24h22" }));

/** One profile on the picker: the tile you enter with, and the two tools under it. */
function personSlot(person, active, editing, count) {
  const tools = el(
    "div",
    { class: "profile-tools" },
    el(
      "button",
      {
        class: "profile-tool focusable",
        type: "button",
        title: `Rename ${person.name}`,
        "aria-label": `Rename ${person.name}`,
        onclick: () => { state.renaming = person.id; render(); },
      },
      svgNode("svg", { class: "tool-mark", viewBox: "0 0 24 24", "aria-hidden": "true" },
        svgNode("path", { d: "M4.5 19.5h4L19 9l-4-4L4.5 15.5z" }),
        svgNode("path", { d: "M14.5 5.5l4 4" }),
      ),
    ),
    count > 1
      ? el(
          "button",
          {
            class: "profile-tool danger focusable",
            type: "button",
            title: `Remove ${person.name}`,
            "aria-label": `Remove ${person.name}`,
            onclick: () => removePerson(person.id),
          },
          svgNode("svg", { class: "tool-mark", viewBox: "0 0 24 24", "aria-hidden": "true" },
            svgNode("path", { d: "M6 6l12 12M18 6L6 18" }),
          ),
        )
      : null,
  );
  if (editing) {
    const field = el("input", {
      class: "profile-name-field",
      type: "text",
      maxlength: "24",
      value: person.name,
      "aria-label": `Name for ${person.name}`,
    });
    const commit = () => renamePerson(person.id, field.value);
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      if (event.key === "Escape") { event.preventDefault(); state.renaming = ""; render(); }
    });
    queueMicrotask(() => field.focus());
    return el(
      "div",
      { class: "profile-slot editing" },
      el(
        "div",
        { class: "profile-tile active" },
        el("span", { class: "avatar", "aria-hidden": "true" }, avatarNode(person.name)),
        field,
        el(
          "div",
          { class: "profile-rename-actions" },
          el("button", { class: "btn focusable", type: "button", text: "Save", onclick: commit }),
          el("button", {
            class: "btn subtle focusable",
            type: "button",
            text: "Cancel",
            onclick: () => { state.renaming = ""; render(); },
          }),
        ),
      ),
      tools,
    );
  }
  return el(
    "div",
    { class: `profile-slot${active ? " active" : ""}` },
    el(
      "button",
      {
        class: `profile-tile focusable${active ? " active" : ""}`,
        type: "button",
        "aria-current": active ? "true" : false,
        onclick: () => choosePerson(person.id),
      },
      el("span", { class: "avatar", "aria-hidden": "true" }, avatarNode(person.name)),
      el("span", { class: "profile-tile-name", text: person.name }),
      el("span", { class: "profile-tile-sub", text: active ? "current profile" : "switch to this profile" }),
    ),
    tools,
  );
}

/**
 * The mode screen — the two ways to watch, asked *after* who is watching.
 *
 * It used to be the first screen and the only picker. It is the second one now, so it
 * also carries the one way back: the profile it was entered as, and the way to change it.
 */
function renderModes() {
  const watcher = currentPerson().name;
  return [
    el(
      "section",
      { class: "profiles" },
      // These are **modes**, not accounts: VOD (films and series) and IPTV (live
      // channels and sport) are two ways to use the app, and the screen reads as a
      // mode picker.
      el("p", { class: "hero-kicker", text: "Modes" }),
      el("h1", { class: "view-title", text: "What do you want to watch?" }),
      el("p", { class: "view-hint", text: `Watching as ${watcher}. Each mode keeps its own settings.` }),
      el(
        "div",
        { class: "profile-grid" },
        ...PROFILES.map((name) =>
          el(
            "button",
            {
              class: `profile-tile focusable${name === state.profile ? " active" : ""}`,
              type: "button",
              "aria-current": name === state.profile ? "true" : false,
              onclick: () => chooseProfile(name),
            },
            el("span", { class: "avatar", "aria-hidden": "true" }, avatarNode(name)),
            el("span", { class: "profile-tile-name", text: name }),
            el("span", { class: "profile-tile-sub", text: name === state.profile ? "current mode" : "switch to this mode" }),
          ),
        ),
      ),
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        id: "switch-profile",
        text: `Switch profile — you are ${watcher}`,
        onclick: () => go("#/profiles"),
      }),
    ),
  ];
}

/* ------------------------------------------------------------ the profiles */

/** The profiles that exist: the stored list, or the one every install starts with. */
function profileList() {
  const list = Array.isArray(state.people) ? state.people.filter((p) => p && p.id && p.name) : [];
  return list.length ? list : DEFAULT_PEOPLE;
}

/** The profile that is on: the stored one, or the first that exists. */
function currentPerson() {
  const list = profileList();
  return list.find((p) => p.id === state.who) || list[0];
}

function savePeople(list) {
  state.people = list;
  writeJSON(PEOPLE_KEY, list);
}

function saveWho(id) {
  state.who = id;
  localStorage.setItem(WHO_KEY, id);
}

/** Pick the person watching, then ask how they want to watch. */
function choosePerson(id) {
  saveWho(id);
  state.renaming = "";
  if (parseHash().view === "profiles") go("#/modes");
  else render();
}

/**
 * A new profile, straight into its name field.
 *
 * A tile called "Profile 3" is nobody's name, so the field opens with it selected rather
 * than making the rename a second press.
 */
function addPerson() {
  const list = profileList();
  const taken = new Set(list.map((p) => p.name.toLowerCase()));
  let n = list.length + 1;
  while (taken.has(`profile ${n}`.toLowerCase())) n++;
  const person = { id: personId(), name: `Profile ${n}` };
  savePeople([...list, person]);
  state.renaming = person.id;
  render();
}

/** Rename a profile. An empty name is not a name: the edit is simply dropped. */
function renamePerson(id, raw) {
  const name = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (name) savePeople(profileList().map((p) => (p.id === id ? { ...p, name } : p)));
  state.renaming = "";
  render();
}

/** Remove a profile — never the last one, or there would be nobody to enter as. */
function removePerson(id) {
  const list = profileList();
  if (list.length < 2) return;
  const next = list.filter((p) => p.id !== id);
  savePeople(next);
  if (state.who === id) saveWho(next[0].id);
  state.renaming = "";
  render();
}

/* --------------------------------------- artwork drawn from a card's contents */

/**
 * One draw per app launch.
 *
 * A card's artwork is made of real images of the titles the card actually holds, and
 * which slice of them is drawn is decided once per launch from this value: the
 * pictures stay put while the app runs, and a new launch draws again — the requested
 * "all cards change on app start".
 */
const LAUNCH_SEED = Math.floor(Math.random() * 1e9);

/**
 * Up to `count` images from a card's first visible catalog.
 *
 * The generated cover stays the base layer, so the artwork is never blank — not
 * before the row answers, not without a provider key — and the card's own titles are
 * drawn over it, so the banner and every card show what is inside them. The images
 * come from the catalog endpoint the rows already use; nothing extra is fetched, and
 * a failure just leaves the cover showing.
 */
/** One draw per card per launch: a redraw reuses it instead of asking again. */
const contentDrawn = new Map();

/**
 * The poster window each card is drawing, and the ones already on screen.
 *
 * **No two cards show the same posters.** Each card draws `count` titles from its own
 * row, and the window it opens at is its own (`drawSeedFor`) — but two cards whose rows
 * happen to be the same length can still land on the same window, and then the home
 * screen reads as one picture repeated. So the screen deals: a card takes the next
 * window nobody has taken yet, falling back to its own hash when every window is spoken
 * for. It is **not** a de-duplication of titles: nothing is removed from any card's row,
 * and a card never sees a shorter pool because another card drew from it.
 *
 * The assignment is per launch and per refresh, and a redraw of a card keeps the window
 * it already has — which is what makes coming back to Home look like the same screen.
 */
const tileWindows = new Map();
const tileTaken = new Set();
/** A fresh deal: called when the drawn pictures are dropped (see `refreshNow`). */
function clearTileWindows() {
  tileWindows.clear();
  tileTaken.clear();
}

/**
 * Lay pictures into the frame, from this launch's slice of the card.
 *
 * The frame *becomes* the artwork: the generated cover is hidden the moment the
 * pictures arrive (`art-filled` on the frame), so what you see in the banner's inner
 * card and in every card's inner card is the titles themselves — not a vector scene
 * with a strip over it. A `backdrop` strip is the card page's frame, which holds
 * **one landscape shot** of one of the card's titles rather than `count` posters.
 */
/**
 * An artwork `<img>` that never stays broken.
 *
 * The poster service only has artwork for the titles it has catalogued, and its
 * URL 404s for the rest — which is what left a dark plate in a card's wall (the
 * "black band") and an initials mark on a calendar tile. When the better poster
 * fails, the **original artwork** the server kept is drawn instead.
 */
function artImage(src, m, attrs = {}) {
  const img = el("img", { ...attrs, src });
  img.addEventListener("error", () => {
    const backup = m?.posterBackup || "";
    if (backup && img.getAttribute("src") !== backup) img.setAttribute("src", backup);
    else img.removeAttribute("src");
  });
  return img;
}

/**
 * **Which slice of a card's pool that card draws — one window per card.**
 *
 * A card's posters are a window onto whatever its row returned. The window used to open
 * at the *same* offset on every card (`LAUNCH_SEED % (pool - count + 1)`), so two cards
 * whose rows came back in a similar order — two TMDB "popular" lists, which is the
 * common case — drew the same three posters, and the home screen read as one picture
 * repeated. The offset is derived from the card's own key now, so every card opens on a
 * different title **and** none of them is de-duplicated against another: each card's
 * draw is its own.
 *
 * The hash is FNV-1a over the card key mixed with the launch seed, so the whole screen
 * re-deals on a relaunch and two cards never agree while it is open.
 */
function drawSeedFor(key) {
  let h = 0x811c9dc5 ^ (LAUNCH_SEED >>> 0);
  for (const ch of String(key || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h);
}

function drawTiles(strip, art, count, layout) {
  if (layout === "backdrop") {
    // One wide shot from the card's own titles, picked once per launch. The banner
    // and the card page now read the same way: a landscape frame with a backdrop in
    // it, never a 2:3 poster cropped into a 16:9 hole.
    const shot = art[LAUNCH_SEED % art.length];
    const src = backdropOf(shot) || heroImage(shot) || shot?.poster || "";
    if (!src) return;
    strip.replaceChildren(artImage(src, shot, { class: "content-tile", alt: "", loading: "lazy" }));
  } else {
    // **The card's own window, and nobody else's.** (See `tileWindows`.)
    const span = art.length - count + 1;
    let start = 0;
    if (span > 1) {
      const held = tileWindows.get(strip._key);
      if (held !== undefined) {
        start = held;
      } else {
        start = drawSeedFor(strip._key) % span;
        for (let i = 0; i < span && tileTaken.has(`${art.length}:${start}`); i++) start = (start + 1) % span;
        tileWindows.set(strip._key, start);
        tileTaken.add(`${art.length}:${start}`);
      }
    }
    const picked = art.slice(start, start + count);
    strip.replaceChildren(
      ...picked.map((m) =>
        artImage(m.poster || m.background, m, { class: "content-tile", alt: "", loading: "lazy" }),
      ),
      // **Every slot is drawn, however few titles answered.** One pin used to be laid
      // in as a single tile, and `flex: 1` then stretched it across the whole frame —
      // so the Watchlist read as one big poster instead of as the two-poster wall it
      // is. The slots with no title behind them stay the card's own panel.
      ...Array.from({ length: Math.max(0, count - picked.length) }, () => el("div", { class: "content-tile blank" })),
    );
  }
  strip.classList.add("filled");
  // `closest` and not `parentElement`: the frame is whichever artwork container
  // the strip ended up in, and it is the frame that hides the generated cover.
  const frame = strip.closest(".icon-wrap, .hero-art, .section-art");
  if (frame) frame.classList.add("art-filled");
}

/**
 * A card with nothing to show still draws its poster slots.
 *
 * A card whose rows all came back empty used to fall back to its bare cover, which
 * reads as "this card holds nothing" rather than as "there is nothing in it yet".
 * The slots are drawn empty instead, so the frame keeps the shape the card was
 * designed with — **two** for your own lists (watchlist, custom), three for the rest.
 *
 * **The slots stay empty.** They used to be filled with the card's own cover art, so
 * a Watchlist with nothing in it still showed posters — which reads as "these are
 * your titles" when they are nobody's. An empty card now shows the shape of what
 * would be there and says nothing else.
 */
function drawEmptyTiles(strip, count) {
  if (!strip.isConnected || strip.classList.contains("filled")) return;
  const n = Math.max(1, count || 3);
  strip.replaceChildren(...Array.from({ length: n }, () => el("div", { class: "content-tile blank" })));
  strip.classList.add("filled");
}

/**
 * Forget a card's drawn pictures, so the next render asks for them again.
 *
 * The watchlist card is the one card whose contents change while the app runs: pin
 * or unpin a title and its wall of posters is stale the moment you do. Its draw is
 * dropped rather than replayed from the per-launch cache, which is what makes it
 * change *immediately* instead of on the next launch like every other card.
 */
function forgetCardArt(card) {
  if (!card) return;
  for (const key of [...contentDrawn.keys()]) {
    if (key.startsWith(`${card.key}:`)) contentDrawn.delete(key);
  }
}

/**
 * The OTT cards' order switch — the dropdown at the top right of those cards.
 *
 * It draws the app's own `dropdown`, so it opens, closes, hovers and dims its end the
 * way every other picker does, and the choice is remembered (`nuvio.ottSort`). Picking
 * one redraws the screen, which asks each row for that order: the server scopes the
 * row's pool by it, so the list is really re-read instead of re-sorted in the page.
 */
function ottSortControl() {
  const picker = dropdown(OTT_SORTS, state.ottSort, (value) => {
    state.ottSort = value;
    localStorage.setItem(KEY.ottSort, value);
    render();
  });
  picker.node.classList.add("sort-dropdown");
  picker.node.title = "Order these rows";
  return picker.node;
}

/** The card whose rows are your own pins. */
const watchlistCard = () =>
  state.collections.find((c) => rowOf(c).catalogs.some((cat) => cat.kind === "watchlist"));

/** Frames waiting for their pictures — filled a few at a time, not all at once. */
const contentJobs = [];
let contentBusy = 0;
const CONTENT_CONCURRENCY = 3;
/** How many of a card's rows one frame will read before it gives up. */
const CONTENT_ROW_TRIES = 3;

function contentStrip(card, row, count, layout) {
  const strip = el("div", {
    class: layout === "backdrop" ? "content-strip backdrop" : "content-strip",
    "aria-hidden": "true",
  });
  // The pictures are asked for **after** the screen is in the document — see
  // `hydrateContent`. A strip built during render has no frame to fill yet, and a
  // lazy observer over a detached node is how a card kept its cover for good.
  // `layout` is how the frame draws what it gets: a wall of posters, or (the card
  // page) one landscape backdrop. It is not part of the cache key — both layouts
  // want the same list of the card's titles.
  strip._job = { card, row, count, layout, key: `${card.key}:${row}` };
  // The card's own draw window (see `drawSeedFor`). Kept on the strip rather than looked
  // up again, because the strip outlives the job that built it.
  strip._key = strip._job.key;
  return strip;
}

/**
 * Fill every frame on the screen.
 *
 * Runs once a screen has been drawn, so the frames exist and the pictures have
 * somewhere to land, and it draws from the per-launch cache first — so a redraw
 * (the banner's ten-second move, or coming back to Home) reuses one draw instead
 * of asking again. Three are in flight at a time, so opening Home is not twenty
 * catalog calls at once.
 */
function hydrateContent() {
  for (const strip of document.querySelectorAll(".content-strip")) {
    const job = strip._job;
    if (!job || strip.classList.contains("filled")) continue;
    strip._job = null;
    // The **Upcoming** card's frame is not a wall of posters: it is one still that
    // changes on its own clock, so it is filled by `startSpotlight` instead.
    if (job.spotlight) {
      startSpotlight(strip, job.card, job.row);
      continue;
    }
    const cached = contentDrawn.get(job.key);
    if (cached) {
      drawTiles(strip, cached, job.count, job.layout);
      continue;
    }
    const cats = orderedCatalogs(job.card).filter(catalogVisible);
    // **A card with no rows still draws its slots** — the For You card has none until
    // something is pinned, and the frame keeps its shape either way.
    if (!cats.length) {
      drawEmptyTiles(strip, job.count);
      continue;
    }
    contentJobs.push({ strip, job, cats });
  }
  pumpContent();
}

function pumpContent() {
  while (contentBusy < CONTENT_CONCURRENCY && contentJobs.length) {
    const { strip, job, cats } = contentJobs.shift();
    contentBusy++;
    fillFrame(strip, job, cats, 0).finally(() => {
      contentBusy--;
      pumpContent();
    });
  }
}

/**
 * Ask a card's rows for pictures, and stop at the first one that answers.
 *
 * Reading only the **first** row is what kept the Watchlist card empty: its first
 * row is **Watching**, which holds nothing until you start something, while **Plan
 * to Watch** already held titles — so the frame stayed a cover with a full watchlist
 * behind it. The frame now walks on to the next row, bounded by `CONTENT_ROW_TRIES`
 * so a card of a hundred empty rows cannot turn one frame into a hundred requests.
 *
 * A **watchlist** card is the exception: its wall *is* your titles, so it collects
 * every state's posters instead of stopping at the first one that answered.
 */
async function fillFrame(strip, job, cats, from) {
  // The watchlist card's wall **is your watchlist**, so it is read from the
  // watchlist itself rather than from one of its three catalog rows. That is the fix
  // for "the two posters never come": those rows are per media type, so on the
  // Movies row a watchlist of shows answered nothing at all, however full Plan to
  // Watch was.
  if (cats.some((cat) => cat.kind === "watchlist")) {
    const pins = await watchlistArt(job.row);
    if (pins.length) {
      contentDrawn.set(job.key, pins);
      if (strip.isConnected) drawTiles(strip, pins, job.count, job.layout);
      return;
    }
  }
  // **For You shows one poster per row.** The card is four "more like your titles"
  // rows — four on Movies and four on Shows — so its wall draws one title from each
  // of them rather than four posters out of whichever row happened to answer first.
  // Every slot is then a different pick from a different row.
  if (cats.some((cat) => cat.kind === "recommend")) {
    const picks = await recommendWall(job.row, cats.slice(0, Math.max(1, job.count || 3)));
    if (picks.length) {
      contentDrawn.set(job.key, picks);
      if (strip.isConnected) drawTiles(strip, picks, job.count, job.layout);
      return;
    }
  }
  // A **custom** card whose row answered nothing is asked for the other row type's
  // list: your own list is not a per-type catalog, and an empty frame is a worse
  // answer than a poster from the other row (the same reasoning as the watchlist).
  const art = await collectArt(strip, job, job.row, cats, from, []);
  // **Nothing answered** (an empty watchlist, an empty custom row): the slots are
  // drawn empty rather than filled with the card's own cover art.
  if (!art.length) drawEmptyTiles(strip, job.count);
}

/**
 * The posters of your own pins, in the order the card's rows show them.
 *
 * Titles of the row you are on come first — the Movies card is your films. If that
 * row holds none, **every** pin is used instead: an empty frame is a worse answer
 * than a poster from the other row, and it is the one the card kept giving.
 */
async function watchlistArt(row) {
  let payload;
  try {
    // A cache-buster: a pin or an unpin must be visible on the next draw, and this
    // is the one list on the page that changes while the app is open.
    payload = await get(`/watchlist.json?_=${Date.now()}${Math.random().toString(36).slice(2, 7)}`);
  } catch {
    return [];
  }
  const items = (payload?.items || []).filter((i) => i && (i.poster || i.background));
  const forRow = items.filter((i) => (row === "movie" ? i.type === "movie" : i.type === "series"));
  const use = forRow.length ? forRow : items;
  const rank = (i) => (i.state === "watching" ? 0 : i.state === "planned" ? 1 : 2);
  return [...use].sort((a, b) => rank(a) - rank(b));
}

/**
 * One poster from each For You row, so the wall speaks for all of them.
 *
 * A For You row is named after the title it was built from and answers with that
 * title's own recommendations; one of its first posters is enough to stand for the
 * whole row. Reading them together is what makes the card four *different* "more
 * like" titles instead of four posters out of the first row — the four rows on
 * Movies and the four on Shows are the card's whole point.
 */
async function recommendWall(media, cats) {
  const picks = [];
  for (const cat of cats) {
    try {
      const { metas = [] } = await get(`/catalog/${media}/${encodeURIComponent(cat.id)}.json${catalogQuery()}`);
      const hit = metas.find((m) => (m.poster || m.background) && !picks.some((p) => String(p.id) === String(m.id)));
      if (hit) picks.push(hit);
    } catch {
      /* the next row may answer */
    }
  }
  return picks;
}

/** Read a card's rows for pictures, drawing each time something arrives. */
async function collectArt(strip, job, media, cats, from, art) {
  // A watchlist or custom card's wall *is* your titles, so it collects every row's
  // posters instead of stopping at the first row that answered — otherwise a Custom
  // card holding only shows drew nothing on the Movies row, which is "I added titles
  // and it still shows no posters".
  const gather = cats.some((cat) => cat.kind === "watchlist" || cat.kind === "custom");
  const last = Math.min(cats.length, from + CONTENT_ROW_TRIES);
  for (let i = from; i < last; i++) {
    const cat = cats[i];
    // A watchlist (or custom) row is *your* state, not a cached list: it is read
    // with a cache-buster and answered `no-store`, so a card drawn before a pin can
    // never be replayed over it.
    const stateful = cat.kind === "watchlist" || cat.kind === "custom";
    const bust = stateful ? `&_=${Date.now()}${Math.random().toString(36).slice(2, 7)}` : "";
    try {
      const { metas = [] } = await get(`/catalog/${media}/${encodeURIComponent(cat.id)}.json${catalogQuery()}${bust}`);
      const got = metas.filter((m) => m.poster || m.background);
      if (!got.length) continue;
      art.push(...got);
      contentDrawn.set(job.key, art);
      if (strip.isConnected) drawTiles(strip, art, job.count, job.layout);
      if (!gather) return art;
    } catch {
      /* the next row may answer */
    }
  }
  return art;
}

/* ------------------------------------------------------------- hero rotation */

/** How often the banner moves to another card. */
const HERO_ROTATE_MS = 10_000;
let heroTimer = null;
let heroKey = null;
// True while the cursor is over the banner — the rotation holds still then.
let heroHover = false;

/**
 * The cards the banner may show: visible, and actually holding rows.
 *
 * The **spotlight** card (Upcoming) is not one of them: it is a picture of its own, so
 * a banner wearing its name and tags over a shot from Now Playing would be two cards
 * in one frame.
 */
const heroCandidates = () => state.collections.filter((c) => cardVisible(c) && rowOf(c).catalogs.length && !c.spotlight);

/** The card the banner shows — one pick at launch, a new one every ten seconds. */
function heroCard() {
  const cards = heroCandidates();
  if (!cards.length) return null;
  const hit = cards.find((c) => c.key === heroKey);
  if (hit) return hit;
  heroKey = cards[Math.floor(Math.random() * cards.length)].key;
  return cards.find((c) => c.key === heroKey);
}

/* ------------------------------------------- the banner's one picture */

/** The catalog the banner is drawn from: Now Playing on movies, On the Air on shows. */
const HERO_CATALOG = { movie: "Now Playing", series: "On the Air" };

/** Every title the banner may show, from that one catalog, this launch. */
let heroList = [];
/** Which catalog `heroList` came from — the banner never moves off it. */
let heroCatKey = null;
/** The title on screen right now. */
let heroAt = 0;
/** The card the banner is on, so the left-hand labels can be redrawn with it. */
let heroFeatured = null;

/**
 * The row the banner draws from — **Now Playing** for films, **On the Air** for shows.
 *
 * The banner is a billboard for what is out now, so it is not a random card's first
 * row: it is the row that means "this just came out", whichever card happens to own
 * it, and the banner's own labels are that card's.
 */
function heroSource() {
  const want = (HERO_CATALOG[apiType()] || "").toLowerCase();
  if (!want) return null;
  for (const card of state.collections) {
    if (!cardVisible(card)) continue;
    const cat = orderedCatalogs(card).filter(catalogVisible).find((c) => String(c.name || "").toLowerCase() === want);
    if (cat) return { card, cat };
  }
  return null;
}

/**
 * Read the banner's catalog once, then show one title out of it.
 *
 * Cached per launch like every other card's artwork, so the ten-second move is a
 * redraw of one picture and never a new request.
 */
async function loadHeroArt(src, node) {
  const row = apiType();
  if (src) {
    const key = `hero:${row}:${src.cat.id}`;
    if (heroCatKey !== key) {
      heroCatKey = key;
      heroAt = 0;
      heroList = contentDrawn.get(key) || [];
      if (!heroList.length) {
        try {
          const { metas = [] } = await get(`/catalog/${row}/${encodeURIComponent(src.cat.id)}.json${catalogQuery()}`);
          heroList = metas.filter((m) => m.poster || m.background);
          if (heroList.length) {
            contentDrawn.set(key, heroList);
            // A different title each launch, like the cards.
            heroAt = LAUNCH_SEED % heroList.length;
          }
        } catch {
          heroList = [];
        }
      }
    }
  }
  drawHeroTile(node);
}

/** Put the current title's landscape picture in the banner's frame. */
function drawHeroTile(node) {
  // A freshly built banner is not in the document yet, so the caller's node wins
  // when it passes one; the ten-second redraw passes none and uses the page.
  const scope = node || document;
  // The banner shows **its card**: the card's own title, its own tags, and one of
  // its own pictures. So the title is not touched here — `heroBlock` sets it and
  // nothing overwrites it with the name of whatever film happens to be on screen,
  // which is what turned the banner into a title poster with the card's name lost.
  const shot = scope.querySelector(".hero-art .content-strip") || document.querySelector(".hero-art .content-strip");
  if (!shot || !heroList.length) return;
  const m = heroList[heroAt % heroList.length];
  shot.replaceChildren(el("img", { class: "content-tile", src: heroImage(m), alt: "", loading: "eager" }));
  // The same marker a card's strip carries: `filled` means "these are the pictures",
  // and the frame under it is what hides the generated cover.
  shot.classList.add("filled");
  const frame = shot.closest(".hero-art");
  if (frame) frame.classList.add("art-filled");
}

/**
 * Move the banner to another title in the **same** catalog, every ten seconds.
 *
 * The banner used to walk the cards, so its labels and its picture both changed;
 * what it refreshes is one picture from Now Playing (or On the Air), so it keeps its
 * card and its labels and redraws the shot — never the title already on screen.
 */
function startHeroRotation() {
  stopHeroRotation();
  heroTimer = setInterval(() => {
    // The banner is being read — hold it still until the cursor leaves it.
    if (heroHover) return;
    if (heroList.length < 2) return;
    heroAt = (heroAt + 1 + Math.floor(Math.random() * (heroList.length - 1))) % heroList.length;
    drawHeroTile();
  }, HERO_ROTATE_MS);
}

function stopHeroRotation() {
  if (heroTimer) clearInterval(heroTimer);
  heroTimer = null;
}

/* ------------------------------------------- the Upcoming card's one still */

/**
 * The Upcoming card's **one picture**, changed the way the hero banner's is.
 *
 * The card is a window on what is coming rather than a shelf of posters: one
 * still out of its own row, replaced every ten seconds by another one, never the one
 * already on screen. It holds still while the cursor is over it, for the banner's own
 * reason — reading it is a reason for it not to change under you.
 *
 * Nothing here is a door: the frame is a `div` with no click and no focus stop (see
 * `iconBox`), so a title rotating through it is a glance, not a link.
 */
const SPOTLIGHT_ROTATE_MS = 15_000;
let spotlightTimer = null;
let spotlightStrip = null;
let spotlightList = [];
let spotlightAt = 0;
/**
 * The poster the card is holding in its **right-hand slot**.
 *
 * The shift is anchored to *this poster*, not to a list index: the row is re-read
 * from time to time, and an index into a list that has been rebuilt points somewhere
 * else entirely — which is what put two brand-new posters on the card instead of
 * moving the right-hand one across.
 */
let spotlightAnchor = "";
/** True while the cursor is over the card — the rotation holds still then. */
let spotlightHover = false;
/**
 * Which call owns the card.
 *
 * The card is started again on every render, and a start **waits on the row read**
 * before it installs its clock. Two starts can therefore be in flight at once — the
 * home screen draws twice on launch — and each one used to install its own clock, so
 * the card took **two** posters per cycle: the pair shifted the moment it was drawn,
 * and the whole card looked like it was being replaced twice as often as it should.
 * Only the newest call owns the card; an older one stops at the door.
 */
let spotlightRun = 0;

/**
 * The picture one of the card's frames holds: a **16:9 frame takes 16:9 artwork**, so the
 * wide shot first and the poster only as the last resort. A portrait poster cannot be
 * fitted into this frame — cutting it into a band is what made the posters read as
 * backdrops.
 */
function spotlightArt(m) {
  return backdropOf(m) || heroImage(m) || posterOf(m) || "";
}

/**
 * Every wide shot the card has already fetched.
 *
 * Putting a new `src` on the tile's image clears whatever is painted there until the new
 * file arrives — an empty plate with the new title on it. That empty frame was the
 * glitch: the poster that was arriving blinked, while the poster that was *moving* across
 * stayed put. The next pictures are fetched here ahead of their move, so a move is one
 * picture replaced by another, never by a hole.
 */
const warmedArt = new Set();
function warmArtwork(src) {
  if (!src || warmedArt.has(src)) return;
  warmedArt.add(src);
  const pre = new Image();
  pre.decoding = "async";
  pre.src = src;
}

/**
 * Put artwork on a tile's plate **without ever showing the plate empty**.
 *
 * The first picture goes straight on (the plate was bare anyway). A **swap** waits for the
 * incoming file first: only once it is in hand is it drawn, so the frame goes from one
 * picture to the next with no blank between them.
 */
function putSpotlightArt(img, art, backup) {
  img.dataset.backup = backup;
  if (!art) {
    img.removeAttribute("src");
    img.classList.add("blank");
    return;
  }
  if (img.getAttribute("src") === art) {
    img.classList.remove("blank");
    return;
  }
  const paint = () => {
    img.setAttribute("src", art);
    img.classList.remove("blank");
  };
  // A bare tile takes its picture straight away. The card's **first pair is filled
  // before it is put on the page**, so waiting for the element to be in the document
  // left both of the first two plates empty — the card opened on two grey frames.
  if (!img.getAttribute("src")) {
    paint();
    return;
  }
  const pre = new Image();
  pre.decoding = "async";
  pre.onload = paint;
  // A file that fails still goes on: the tile's own error handling draws the original
  // artwork instead, or the app's flat plate when there is nothing to fall back to.
  pre.onerror = paint;
  pre.src = art;
}

/** A wide shot that will not load: the original artwork, then the app's flat plate. */
function spotlightArtFailed(img) {
  const backup = img.dataset.backup || "";
  if (backup && img.getAttribute("src") !== backup) {
    img.setAttribute("src", backup);
    return;
  }
  img.removeAttribute("src");
  img.classList.add("blank");
}

async function startSpotlight(strip, card, row) {
  stopSpotlight();
  if (!strip) return;
  const run = spotlightRun;
  spotlightStrip = strip;
  strip.addEventListener("mouseenter", () => { spotlightHover = true; });
  strip.addEventListener("mouseleave", () => { spotlightHover = false; });
  const cat = orderedCatalogs(card).filter(catalogVisible)[0];
  if (!cat) return;
  // Read once per launch, like every other card's artwork: the ten-second move is a
  // redraw of one picture, never a new request.
  const key = `spotlight:${row}:${cat.id}`;
  spotlightList = contentDrawn.get(key) || [];
  if (!spotlightList.length) {
    try {
      const { metas = [] } = await get(`/catalog/${row}/${encodeURIComponent(cat.id)}.json${catalogQuery()}`);
      // A newer start took the card while this one was reading: it owns the pair now,
      // and drawing here would move the card on a second time.
      if (run !== spotlightRun) return;
      // **Landscape titles.** This card's two frames are 16:9, so it wants the
      // landscape artwork — a portrait poster has to be cut down to a band to fit one.
      spotlightList = metas.filter((m) => m.background || m.poster);
      if (spotlightList.length) {
        contentDrawn.set(key, spotlightList);
        // **Continue where the card left off**, if the poster it was holding is still
        // in the row. A different title each launch only when there is nothing to
        // carry over — a re-read must not restart the pair somewhere else.
        const at = spotlightList.findIndex((m) => String(m.id) === spotlightAnchor);
        spotlightAt = at >= 0 ? at : LAUNCH_SEED % spotlightList.length;
      }
    } catch {
      spotlightList = [];
    }
  }
  if (run !== spotlightRun) return;
  drawSpotlight();
  if (spotlightList.length < 2) return;
  // One clock for one card: never leave a second one running beside this.
  if (spotlightTimer) clearInterval(spotlightTimer);
  spotlightTimer = setInterval(() => {
    if (spotlightHover) return;
    // **One poster per cycle, not two.** The pair shifts a slot to the left: the
    // right-hand poster takes the left slot, the left-hand one leaves, and a new
    // title arrives on the right. The poster is looked up in the row as it is *now*,
    // so a re-read cannot move the card off the pair it is showing.
    const len = spotlightList.length;
    if (!len) return;
    const at = spotlightList.findIndex((m) => String(m.id) === spotlightAnchor);
    spotlightAt = at >= 0 ? at : (spotlightAt + 1) % len;
    drawSpotlight();
  }, SPOTLIGHT_ROTATE_MS);
}

/** Put the current title's landscape picture in the card's frame. */
/**
 * **Two poster cards, each naming itself.** The card's own label underneath says
 * Upcoming — the card — so each frame carries the tag and the title it holds, drawn
 * where the tagged artwork draws them.
 */
function spotlightTile() {
  return el(
    "figure",
    { class: "spotlight-tile" },
    el("img", {
      class: "spotlight-tile-art",
      alt: "",
      loading: "lazy",
      // A wide shot the service does not have falls back the way every other plate
      // does, instead of leaving the frame empty.
      onerror: (event) => spotlightArtFailed(event.currentTarget),
    }),
    el(
      "div",
      { class: "spotlight-frame", "aria-hidden": "true" },
      // The tag the card is about, drawn where the tagged artwork draws it: a pill
      // across the top, in the same voice BetterPosters uses for "Coming 9 Oct".
      el("span", { class: "spotlight-tag" }),
      el("span", { class: "spotlight-title" }),
    ),
  );
}

/**
 * Point one tile at a title, **in place**.
 *
 * The tile is reused rather than rebuilt, so the poster that is staying on the card
 * keeps its image element: nothing is re-requested, nothing re-decodes, and the
 * picture does not blink out for a frame in the middle of a move.
 */
function fillSpotlightTile(node, m) {
  const art = spotlightArt(m);
  node.dataset.id = String(m.id || "");
  const img = node.querySelector(".spotlight-tile-art");
  if (img) putSpotlightArt(img, art, m.posterBackup || "");
  node.querySelector(".spotlight-tag").textContent = upcomingTag(m);
  node.querySelector(".spotlight-title").textContent = m.name || "";
}

/**
 * Draw the card's two frames.
 *
 * The pair **shifts a slot** each cycle rather than being replaced — the right-hand
 * poster moves into the left slot, the left-hand one leaves the card, and the next
 * title arrives on the right — so one poster changes per cycle. The poster that
 * carries over is the *same tile element* moved across, so only the new one loads.
 */
function drawSpotlight() {
  const strip = spotlightStrip;
  if (!strip || !strip.isConnected || !spotlightList.length) return;
  const len = spotlightList.length;
  const shown = Math.min(2, len);
  const picks = Array.from({ length: shown }, (_, i) => spotlightList[(spotlightAt + i) % len]);

  let track = strip.querySelector(".spotlight-track");
  if (!track) {
    track = el("div", { class: "spotlight-track" });
    strip.replaceChildren(track);
  }
  const tiles = Array.from(track.children);
  const carries = shown === 2 && tiles.length === 2 && tiles[1].dataset.id === String(picks[0].id || "");
  if (carries) {
    // Swap the two tiles over: the one that was on the right is now on the left, and
    // the tile that came off the left is refilled with the title arriving on the right.
    track.replaceChildren(tiles[1], tiles[0]);
    fillSpotlightTile(track.children[1], picks[1]);
  } else {
    track.replaceChildren(...picks.map((m) => {
      const tile = spotlightTile();
      fillSpotlightTile(tile, m);
      return tile;
    }));
  }

  // Fetch the artwork the next two moves will need **before** they need it, so a move
  // never lands on a plate that is still waiting on the network.
  for (const ahead of [2, 3]) {
    if (len > ahead) warmArtwork(spotlightArt(spotlightList[(spotlightAt + ahead) % len]));
  }

  // Remember what the right-hand slot is holding: the next cycle moves it across.
  spotlightAnchor = String(spotlightList[(spotlightAt + Math.min(1, len - 1)) % len]?.id || "");
  // The same marker a card's strip carries: `filled` means "this is the picture",
  // and the frame under it is the app's own flat panel until then.
  strip.classList.add("filled");
  const frame = strip.closest(".icon-wrap");
  if (frame) frame.classList.add("art-filled");
}

/**
 * **When a title lands**, in the voice the tagged artwork uses: `Coming 9 Oct`. TMDB
 * gives the day, not only the year, so the card prints it and falls back to `Coming
 * 2026` when that is all there is — the same tag BetterPosters bakes into its poster.
 */
function upcomingTag(m) {
  const raw = String(m.releaseDate || "").slice(0, 10);
  const date = raw ? new Date(`${raw}T12:00:00Z`) : null;
  if (date && !Number.isNaN(date.getTime())) {
    return `Coming ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date)}`;
  }
  const year = String(m.releaseInfo || "").trim();
  return year ? `Coming ${year}` : "Coming soon";
}

function stopSpotlight() {
  // Anything still waiting on a read is stale the moment the card is stopped.
  spotlightRun++;
  if (spotlightTimer) clearInterval(spotlightTimer);
  spotlightTimer = null;
  spotlightStrip = null;
}

/* -------------------------------------------------------- catalog refresh */

/**
 * How often the screen re-reads its catalogs and metadata.
 *
 * One setting drives both halves of "update itself": the addon's TMDB cache
 * lifetime is the same interval server-side, and the app re-reads the screen on
 * that clock. A refresh only runs while the app is on screen and on a browsing
 * view, and never over an open title — it cannot interrupt what you are doing.
 */
const REFRESH_CHOICES = [
  [30, "Every 30 minutes"],
  [60, "Every 60 minutes"],
  [0, "Manual"],
];

let refreshTimer = null;

/**
 * Re-read the screen now.
 *
 * `gen` rides on every catalog request, so a refresh is a different URL for the
 * browser cache as well as for the addon — without it the rows would be answered
 * from the copy the page already has and nothing would look refreshed.
 */
function refreshNow() {
  state.gen = Date.now();
  // A refresh is a **new deal**: the cards drew their posters from the rows as they were,
  // and the rows are being read again — so the windows go with them, and so does the
  // one-draw-per-launch cache. Without this the artwork was cached for the whole session
  // and a refresh re-read the rows underneath a strip of the pictures that were already
  // there, which is why "refresh" never changed a card's posters.
  clearTileWindows();
  contentDrawn.clear();
  // A refresh re-reads whatever the current screen is made of — including the
  // channel list and the guide, which are catalogs too.
  if (liveProfile()) {
    state.live = { ...state.live, loaded: false, guide: null };
    loadLive({ force: true });
    return;
  }
  render();
}

function startAutoRefresh() {
  stopAutoRefresh();
  const minutes = Number(state.refresh);
  if (!minutes || minutes <= 0) return;
  refreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (document.querySelector("#modal:not([hidden])")) return;
    if (!["home", "card", "explore"].includes(parseHash().view)) return;
    refreshNow();
  }, minutes * 60_000);
}

function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** The hero banner — which card it shows changes at random every ten seconds. */
function heroBlock() {
  const src = heroSource();
  const featured = src?.card || heroCard();
  if (!featured) return null;
  const row = rowOf(featured);
  // Which card the banner is on, so `drawHeroTile` can refresh the left-hand labels
  // with the picture instead of leaving them at whatever the first draw said.
  heroFeatured = featured;
  // The titles, their tags and the cards beside this one read on the **left**; the
  // artwork sits on the **right**, the way the cover is composed. (The two children
  // are in that order here, and the stylesheet only sizes them.) The frame is a
  // **button**: the landscape shot is the way into the title on it — the banner is a
  // thing you open, not a poster on the wall — and it falls back to the collection
  // when the picture has not arrived yet.
  //
  // The frame wears `art-blank` from the start: the *generated vector scene* is the
  // fallback for a card with nothing to draw, and the banner always has a title to
  // draw, so what you see while the backdrop is on its way is the app's own flat
  // panel — never the star-and-constellation cover underneath it.
  const node = el(
    "section",
    { class: "hero" },      el("div",
        { class: "hero-body" },
        // **The banner's own name, at the top left and at size.** It was centred over
        // the middle of the column at 11px — the one word that names the whole block was
        // the smallest thing on the banner, and it sat where the eye arrives last.
        el("p", { class: "hero-kicker", text: "Spotlight" }),
        // **The card's own title**, not the name of the film that happens to be on
        // the picture, and not a mix of every other card's labels — the **On the Board**
        // card included: it used to wear a drawn broadcast mark in place of the two words,
        // and it says what it is in the same words every other card uses for its name.
        el("h2", { class: "hero-title", text: featured.title }),
        // Just this card's catalog labels, each one a link into that catalog —
        // clamped to two rows, because a big card carries eighty of them. Nothing
        // else goes on the banner: no Explore button, no other cards' tags.
        chipLine(row.catalogs.map((cat) => catalogChip(featured, cat)), { className: "hero-cats" }),
      ),
    // The banner's artwork is **not a control**: it is the picture the banner wears,
    // and the banner is not the way into anything. It is an inert frame (no button,
    // no click, out of the tab order), not a hidden door.
    el(
      "div",
      { class: "hero-art art-blank", "aria-hidden": "true" },
      el("div", { class: "content-strip", "aria-hidden": "true" }),
    ),
  );
  // Reading the banner is a reason for it to hold still: while the cursor is over
  // it the ten-second rotation freezes, and it picks up again on the way out.
  node.addEventListener("mouseenter", () => { heroHover = true; });
  node.addEventListener("mouseleave", () => { heroHover = false; });
  queueMicrotask(() => loadHeroArt(src, node));
  return node;
}

function iconBox(c, row) {
  const r = rowOf(c);
  const name = titleOf(c, row);
  const count = r.catalogs.length;
  // **Three, not four.** A card's frame is a row of three posters; the two cards that
  // are *your own* lists hold **two** (a wider wall of them read as a chart rather than
  // as "what you are watching"), and Upcoming holds its **two** poster cards. The banner
  // is not one of these: it draws a **single** tile across the whole frame.
  const mine = r.catalogs.some((cat) => cat.kind === "watchlist" || cat.kind === "custom");
  // **The spotlight card** (Upcoming). Its frame holds **one** still, and that still
  // changes every ten seconds the way the hero banner's does — so a card that is a
  // glance at what is coming is a window rather than a shelf of posters. It has
  // **no artwork button**: nothing about it is clickable.
  const spotlight = Boolean(c.spotlight);
  const tiles = spotlight || mine ? 2 : 3;
  // The frame is filled by `startSpotlight`, not by the poster wall: the Upcoming
  // card is **two poster cards**, each carrying its own title and release date.
  const strip = contentStrip(c, row, tiles);
  if (spotlight) {
    strip.classList.add("spotlight-strip");
    strip._job.spotlight = true;
  }
  return el(
    "div",
    {
      class: `icon-box${spotlight ? " card-spotlight" : ""}`,
      // The tile says what it holds before it is opened (Settings → Animation →
      // Hover previews → Catalog tiles).
      "data-preview": name,
      "data-preview-meta": `${count} row${count === 1 ? "" : "s"}`,
    },
    // The artwork is the button; the card's own pictures are laid over it and never
    // take a click, so entering a card still happens on its artwork alone.
    //
    // `art-blank`: the generated vector scene is not drawn on load. The card is the
    // app's flat panel until its own posters answer, and then it is the posters.
    el(
      "div",
      { class: "icon-wrap art-blank" },
      // A spotlight card draws **no artwork button at all**: there is no focus stop, no
      // `Open …` label and nothing to press, because it is a glance at what is coming
      // rather than a catalog to walk into.
      spotlight
        ? null
        : el(
            "button",
            {
              class: "icon-art focusable",
              type: "button",
              title: `Open ${name}`,
              "aria-label": `Open ${name}`,
              onclick: () => {
                setRow(row);
                go(`#/c/${encodeURIComponent(c.key)}`);
              },
            },
            el("img", { src: r.cover, alt: name, loading: "lazy" }),
          ),
      strip,
    ),
    el(
      "span",
      { class: "icon-meta" },
      el("span", { class: "icon-name", text: name }),
      el("span", { class: "icon-sub", text: count ? `${count} catalog${count === 1 ? "" : "s"}` : "cover only" }),
    ),
  );
}

/**
 * Every card, in the published order.
 *
 * Home used to be able to show a random subset ("Pick the cards for you"), which
 * is what made the grid look like it had been rearranged: cards were missing and
 * their order was not the one the covers were designed around. The order is now
 * fixed in `scripts/collections.mjs` and Home shows all of it, always.
 */
function collectionList() {
  // A **hidden** card (the banner's own source, On the Board) is not a tile on
  // Home: its rows are already on the left of the banner.
  return state.collections.filter((c) => !c.hidden && cardVisible(c));
}

/** The collection grid, with the vertical divider before the marked card. */
function collectionGrid(row) {
  const container = el("div", { class: state.layout === "rows" ? "icons rows" : "icons grid" });
  for (const c of collectionList()) {
    if (c.divider) container.append(el("div", { class: "v-divider", "aria-hidden": "true" }));
    container.append(iconBox(c, row));
  }
  return container;
}

/** The Movies / Shows switch that lives under the hero banner. */
function rowSwitch() {
  return el(
    "div",
    { class: "row-switch", role: "tablist", "aria-label": "Movies or Shows" },
    ...[["movie", "Movies"], ["series", "Shows"]].filter(([value]) => rowEnabled(value)).map(([value, label]) =>
      el("button", {
        class: `row-btn focusable${state.row === value ? " active" : ""}`,
        type: "button",
        role: "tab",
        "aria-selected": String(state.row === value),
        text: label,
        onclick: () => {
          setRow(value);
          state.order = {};
          render();
        },
      }),
    ),
  );
}

function renderHome() {
  // If this profile hides the row you were on, land on the one it does show.
  if (!rowEnabled(state.row)) setRow(rowEnabled("movie") ? "movie" : "series");
  // **No heading under the switch.** It used to draw "Movies" or "Shows" on a line
  // of its own, directly under the Movies / Shows buttons that already say exactly
  // that — a second label for the same fact, pushing the grid down for nothing.
  return [heroBlock(), rowSwitch(), collectionGrid(state.row)].filter(Boolean);
}

/** One catalog row on a collection page: label, shuffle, explore. */
/**
 * One catalog row on a collection page: the catalog's name and Explore.
 *
 * There is no shuffle icon beside Explore. A shuffle here could only reorder the
 * rows of the collection — which is what it used to do, and what "shuffle" never
 * meant: the obvious reading is "redraw *this* catalog's titles", and that is what
 * Explore's own Shuffle does. So the rows stay in their published order and the
 * only shuffle lives in Explore, over the titles.
 */
function catalogRow(card, cat) {
  return el(
    "div",
    { class: "cat-row", "data-catalog": cat.id },
    el(
      "header",
      { class: "cat-head" },
      // The row's **title is a label, not a control**: it names what is below it,
      // and the **Explore** button beside it is the way in. Making the title itself
      // a button made every row heading a second, unexpected door.
      el("span", { class: "cat-name static", text: cat.name }),
      el(
        "div",
        { class: "cat-tools" },
        el("button", {
          class: "btn explore focusable",
          type: "button",
          text: "Explore",
          onclick: () => go(`#/x/${encodeURIComponent(card.key)}/${encodeURIComponent(cat.id)}`),
        }),
      ),
    ),
    lazyStrip(cat),
  );
}

/* --------------------------------------------------- the page's own backdrop */

/* The page used to wear the **colours of the title you were on**, as a blurred
   backdrop layer behind the rows. It is gone: it tinted the whole screen as you
   moved the cursor across a grid, which read as the content changing colour rather
   than as a background. A page is now its own flat panel again. */

async function renderCard(key) {
  let c = cardByKey(key);
  if (!c) return [el("p", { class: "empty", text: "Collection not found." })];
  // **For You re-rolls on entry.** Its "more like" rows are built from your
  // watchlist on every request, so the card is re-read here before it is drawn —
  // opening it hands you a fresh mix of your own titles instead of the one the app
  // fetched at launch. The manifest has to come with it: the new rows carry new
  // catalog ids, and the published-id filter would otherwise drop them.
  if (rowOf(c).catalogs.some((cat) => cat.kind === "recommend")) {
    await refreshCollections();
    c = cardByKey(key) || c;
    // **The card re-rolls on every open.** Its rows are your own titles in a fresh
    // order each time, so the wall it wears on Home is dropped here: coming back
    // draws four new picks rather than the four the app drew at launch — and what
    // the rows showed last time is forgotten too, so the new deal starts clean.
    // The open-nonce goes with it: this open's rows share one server memory.
    forYouOpen = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    forgetCardArt({ key });
    clearForYouServed();
  }
  const row = rowOf(c);
  // The catalogs this profile shows: a hidden row is not drawn here either, so the
  // card reads exactly as Home does (and the chip line cannot link to it).
  const catalogs = orderedCatalogs(c).filter(catalogVisible);
  // The tags the header draws, in the card's own order — the chips are all the page
  // needs up there now that the name lives in the top bar. Every card keeps them,
  // the For You card included: they were dropped once as "duplicating the headings"
  // and that was wrong — nobody asked for it, and the line is how a card's rows are
  // named in one place.
  const chips = row.catalogs.filter(catalogVisible);

  // Name and tags first, the artwork card second — the same reading order as the
  // banner — and the frame holds **one landscape backdrop** from the card's own
  // titles (see `drawTiles`), not the wall of posters a Home card draws.
  // There is **no artwork frame in the header any more**: the card page is its
  // rows, and the artwork is the page's own background (see `setPageBackdrop`),
  // brought up by pointing at a title.
  // **The card's name is not repeated here.** It is already up in the top bar (see
  // `renderTabs`), which is the label of the screen you are on — so the page itself
  // carries only what the bar cannot: the rows, and the tags that reach each one.
  const wrapper = el(
    "section",
    { class: "section" },
    // A card with nothing to put up there (no visible rows) draws no header at all
    // rather than an empty band above its rows.
    chips.length
      ? el(
          "header",
          { class: "section-head" },
          el(
            "div",
            { class: "section-meta" },
            chipLine(chips.map((cat) => catalogChip(c, cat))),
          ),
        )
      : null,
  );


  if (catalogs.length) {
    for (const cat of catalogs) {
      // A row marked `divider` gets a horizontal rule above it (the Watchlist's
      // Watching → Plan to Watch boundary).
      if (cat.divider) wrapper.append(el("div", { class: "h-divider", "aria-hidden": "true" }));
      wrapper.append(catalogRow(c, cat));
    }
  } else {
    wrapper.append(el("p", { class: "empty", text: "This collection is cover art only — it has no catalogs yet." }));
  }
  return [wrapper];
}

/**
 * The sample row at the top of an Explore page.
 *
 * It is a plain row — no label, no control of its own — so it reads like the
 * catalog below it rather than like a numbered "Shuffle 1/2/3" list. The one
 * Shuffle button in the header redraws all three (that is what `reload` is for).
 */
function shuffleRow(cat) {
  const strip = el("div", { class: "strip" });
  const load = async () => {
    strip.replaceChildren(...Array.from({ length: 5 }, () => el("div", { class: "placeholder" })));
    try {
      // The `_` is a fresh number per draw, and the server answers a shuffle with
      // no-store. Without it this URL is byte-identical every time, the browser
      // serves its cached copy, and Shuffle looks like a button that does nothing.
      const { metas } = await get(
        `/catalog/${apiType()}/${encodeURIComponent(cat.id)}/shuffle=12.json${catalogQuery()}&_=${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
      );
      strip.replaceChildren();
      if (!metas.length) {
        strip.append(el("p", { class: "empty", text: "Nothing to shuffle in this catalog yet." }));
        return;
      }
      for (const m of metas) strip.append(posterCard(m));
    } catch (err) {
      strip.replaceChildren(el("p", { class: "empty", text: `Could not shuffle — ${err.message}` }));
    }
  };
  queueMicrotask(load);

  return { node: el("div", { class: "cat-row shuffle-row" }, strip), reload: load };
}

/**
 * Explore: one catalog, scrolling endlessly, with a shuffle.
 * The header shows only the card label and the catalog label.
 */
function renderExplore(key, id) {
  const card = cardByKey(key);
  if (!card) return [el("p", { class: "empty", text: "Collection not found." })];
  const catalogs = rowOf(card).catalogs;
  const cat = catalogs.find((x) => x.id === id);
  if (!cat) return [el("p", { class: "empty", text: "Catalog not found." })];

  const grid = el("div", { class: "grid-titles" });
  const sentinel = el("div", { class: "sentinel" });
  // The chosen letter's own line: what is being shown, and the way back.
  const filterBar = el("div", { class: "explore-filter", hidden: true });

  // The single sample row the header's Shuffle redraws.
  const samples = [];

  // A watchlist (or calendar) catalog holds *your* titles, in your order and in
  // full. There is nothing to draw a random sample from and nothing to shuffle, so
  // Explore for those rows is just the header and the list — no Shuffle, no sample
  // row, no divider.
  const stateful = cat.kind === "watchlist" || cat.kind === "custom";
  // **Only the ◆ Top 10 OTT cards read their rows in an order**, and only here — the
  // plain Global OTT and Regional OTT cards keep the Shuffle every other card has
  // (they publish the whole service, so there is nothing to order it by).
  const ott = isOttTop10Card(card);
  // The Discover cards publish their titles in published order, so the sample row on
  // top of their Explore page is noise in front of the catalog — they get no shuffle
  // row, and the Shuffle button that drives it goes with it.
  // The Discover cards and the banner's own rows (Now Playing / Airing Today /
  // On the Air) get **no shuffle row and no Shuffle button**: there is nothing to
  // sample that the row itself does not already show.
  // The **For You** rows are named after the titles you watch (`More Like …`), so a
  // random sample on top would be a second, unlabelled copy of the same row — no
  // shuffle row, no Shuffle button.
  const sampled =
    !stateful &&
    !ott &&
    !String(card.key).startsWith("discover") &&
    card.key !== "on-the-board" &&
    card.key !== "for-you" &&
    card.key !== "upcoming";

  // **The header no longer names the page.** The bar above already carries the
  // catalog you are inside (see `renderTabs`), so the breadcrumb that said
  // `Runtimes › 30–44 mins` up here was the same two words twice — it is gone, and
  // so is the switcher that hung off it. What is left is the control that belongs to
  // the row itself: the OTT order dropdown, or the Shuffle that draws a fresh sample.
  // A row with neither draws no header at all rather than an empty band.
  // **The order dropdown is gone.** The OTT Top 10 cards carried a "best by what?"
  // picker in the corner of their Explore pages; those rows keep the server's own order
  // now, and a card with no control draws no header at all. The `ott` flag stays: it is
  // still what says a Top 10 publishes a *capped* list, so it still gets no Shuffle row.
  const tools = ott
    ? null
    : sampled
      ? el(
          "div",
          { class: "cat-tools" },
          el("button", {
            class: "btn subtle focusable",
            type: "button",
            id: "shuffle-samples",
            title: "Shuffle — draw a fresh sample",
            onclick: () => samples.forEach((row) => row.reload()),
          }, shuffleIcon(), el("span", { text: " Shuffle" })),
        )
      : null;
  const head = tools ? el("header", { class: "explore-head" }, tools) : null;

  // Endless scroll: keep paging until the catalog is exhausted.
  let skip = 0;
  let done = false;
  let busy = false;
  let pages = 0;
  const MAX_PAGES = 5000;

  /** Every title the row has handed over, in order, and whether it was already
   *  counted. The rail indexes this list; the grid draws the part of it the chosen
   *  letter covers. */
  const loaded = [];
  const seenIds = new Set();
  let letterFilter = null;
  const letterOf = (name) => String(name || "").trim().charAt(0).toUpperCase();
  const passes = (m) => !letterFilter || letterOf(m.name) === letterFilter;

  const loadMore = async (count = 0) => {
    if (busy || done) return;
    // Stop when the cap is reached instead of re-observing forever: a catalog that
    // never runs out would otherwise keep the sentinel in view and ask the server
    // for the next window for the rest of the session.
    if (pages >= MAX_PAGES) {
      done = true;
      observer.disconnect();
      sentinel.replaceChildren(
        el("p", { class: "view-hint inline", text: `Showing the first ${MAX_PAGES} pages of this catalog.` }),
      );
      return;
    }
    busy = true;
    try {
      const { metas } = await fetchCatalog(cat, skip, count);
      for (const m of metas) {
        const id = `${m.type || apiType()}:${m.id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        loaded.push(m);
        // A letter is being shown: only its titles reach the grid, and the rest
        // stay in `loaded` for when the letter is cleared.
        if (passes(m)) grid.append(posterCard(m, { caption: false }));
      }
      skip += metas.length;
      pages++;
      // The rail is an index of what is actually loaded, so it grows with the row.
      refreshRail();
      if (!metas.length) {
        done = true;
        observer.disconnect();
        sentinel.replaceChildren(
          el("p", {
            class: "view-hint inline",
            text: letterFilter ? `No more titles starting with ${letterFilter} in this catalog.` : "End of catalog.",
          }),
        );
      }
    } catch (err) {
      done = true;
      observer.disconnect();
      sentinel.replaceChildren(el("p", { class: "empty", text: `Could not load — ${err.message}` }));
    }
    busy = false;
  };

  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      loadMore().then(() => {
        // Re-observe so the next page loads while the sentinel is still in view.
        if (!done) {
          observer.disconnect();
          observer.observe(sentinel);
        }
      });
    }
  }, { rootMargin: "600px" });

  // ONE random sample on top, then a horizontal rule, then the normal endlessly
  // scrolling catalog — for a catalog that can be sampled at all.
  if (sampled) samples.push(shuffleRow(cat));
  const shuffles = sampled ? el("div", { class: "explore-shuffles" }, ...samples.map((row) => row.node)) : null;
  const rule = sampled ? el("div", { class: "h-divider", "aria-hidden": "true" }) : null;

  /* The alphabet rail — the **titles in this row**, by first letter.
   *
   * It is an index of the contents, not of the card's tags: a letter with titles
   * under it jumps straight to the first one (and greys out when the titles loaded
   * so far have nothing under it). The row loads page after page, so the rail is
   * refreshed as each page lands — a letter cannot be "empty" for a title that has
   * not arrived yet, it is simply not offered until it has.
   *
   * It is laid out *in the grid's own row* (`.explore-body`): a column in the right
   * gutter whose letters sit level with the poster columns, and `sticky` so it
   * rides down under the header as the row grows. It used to be `position: fixed`
   * at the middle of the viewport, which dropped it over the sample row at the top
   * of the page instead of beside the posters. */
  const alphaRail = el("nav", { class: "alpha-rail", "aria-label": "Titles by first letter" });
  const railIndex = new Map();
  const refreshRail = () => {
    railIndex.clear();
    for (const m of loaded) {
      const letter = letterOf(m.name);
      if (letter && !railIndex.has(letter)) railIndex.set(letter, m);
    }
    alphaRail.replaceChildren(
      ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map((letter) => {
        const has = railIndex.has(letter);
        const chosen = letterFilter === letter;
        const what = chosen
          ? `Showing only the titles starting with ${letter} — pick it again for all of them`
          : has
            ? `Show only the titles starting with ${letter}`
            : `Load and show the titles starting with ${letter}`;
        return el(
          "button",
          {
            class: `alpha focusable${has ? "" : " off"}${chosen ? " on" : ""}`,
            type: "button",
            text: letter,
            title: what,
            "aria-label": what,
            "aria-pressed": String(chosen),
            onclick: () => pickLetter(letter),
          },
        );
      }),
    );
  };

  /** Draw the grid from whatever the chosen letter covers. */
  const paintGrid = () => grid.replaceChildren(...loaded.filter(passes).map((m) => posterCard(m, { caption: false })));

  const updateFilterBar = () => {
    filterBar.hidden = !letterFilter;
    if (!letterFilter) return;
    filterBar.replaceChildren(
      el("span", { class: "explore-filter-text", text: `Titles starting with ${letterFilter}` }),
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Show all",
        onclick: () => pickLetter(letterFilter),
      }),
    );
  };

  /**
   * Pick a letter: Explore shows that letter's titles and nothing else.
   *
   * The grid is filtered to them, and the row is paged in as far as it takes to
   * fill the letter out — a letter the first page never mentioned still has its
   * titles, they are simply further down the catalog. Picking the same letter
   * again puts everything back.
   */
  const pickLetter = async (letter) => {
    letterFilter = letterFilter === letter ? null : letter;
    paintGrid();
    updateFilterBar();
    refreshRail();
    if (!letterFilter) return;
    const first = grid.firstElementChild;
    if (first && typeof first.scrollIntoView === "function") {
      first.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    // Page the row in **as far as it goes**: a letter's titles are scattered through
    // the whole catalog, and stopping as soon as twenty of them had turned up is what
    // made "A" look like it only held twenty Action films. The letter fills out until
    // the catalog runs out, with only a generous ceiling so a huge row cannot spin.
    // **Several pages per request.** Filling a letter used to be one page per round
    // trip, so a letter far down a big catalog meant a long chain of requests; the
    // server now hands back a `count`-sized window, and the grid is repainted once
    // at the end rather than after every page.
    const LETTER_WINDOW = 120;
    for (let i = 0; i < 5000; i += 1) {
      if (done) break;
      const before = pages;
      await loadMore(LETTER_WINDOW);
      if (pages === before) break;
    }
    paintGrid();
    refreshRail();
  };
  refreshRail();

  const body = el(
    "section",
    { class: "section explore" },
    head,
    shuffles,
    rule,
    el(
      "div",
      { class: "explore-body" },
      el("div", { class: "explore-grid" }, filterBar, grid, sentinel),
      alphaRail,
    ),
  );
  // The catalog's own rows move the page's backdrop; the shuffle rows do not.

  // Kick off the first page once the section is in the document.
  queueMicrotask(() => {
    loadMore().then(() => {
      if (!done) observer.observe(sentinel);
    });
  });
  return [body];
}

/* ------------------------------------------------------------------- search */

function allCatalogs() {
  const out = [];
  for (const c of state.collections) for (const cat of rowOf(c).catalogs) out.push({ card: c, cat });
  return out;
}

// A drawn funnel, like the rest of the controls.
const filterIcon = () =>
  el(
    "span",
    { class: "glyph", "aria-hidden": "true" },
    svgNode(
      "svg",
      { viewBox: "0 0 24 24" },
      svgNode("path", { d: "M3 5h18" }),
      svgNode("path", { d: "M6 12h12" }),
      svgNode("path", { d: "M10 19h4" }),
    ),
  );

/** The query string of the search screen, which *is* its state. */
function searchParams() {
  const hash = location.hash;
  const at = hash.indexOf("?");
  return new URLSearchParams(at === -1 ? "" : hash.slice(at + 1));
}

/** Used only if the server predates the vocabulary route, so the panel still works. */
const SEARCH_FALLBACK = {
  types: [["", "All"], ["series", "TV Series"], ["movie", "Movie"]],
  continents: [["all", "All continents"]],
  countries: [["all", "All countries"]],
  providers: [["all", "All services"]],
  moods: [["all", "All moods"]],
  themes: [["all", "All themes"]],
  categories: { movie: [], series: [] },
  // **No "Before" chip.** The list is the years that matter; "before 1950" was one
  // more pill at the end of a line nobody scrolls to. The server still understands
  // `period=before` (an old link keeps working), it is simply not offered.
  periods: [["all", "All Time Periods"]],
  sorts: [["popularity", "Popularity"], ["recent", "Recent"], ["rating", "High Rating"]],
};

/** One labelled row of filter chips. */
/**
 * One filter line: a label and its choices.
 *
 * A line with more choices than two rows can hold (Country has every country with
 * titles, Theme has every theme row) is clamped to two rows with the same chevron
 * the card tags use — unless the choice you already made is buried under the fold,
 * in which case the line opens so you can see it. Short lines get no control at all.
 */
const FILTER_CLAMP_AT = 12;

function filterRow(label, choices, active, onPick, { clamp = false } = {}) {
  const chips = choices.map(([value, text]) =>
    el("button", {
      class: `filter-chip focusable${value === active ? " active" : ""}`,
      type: "button",
      text,
      "aria-pressed": String(value === active),
      onclick: () => onPick(value),
    }),
  );
  const long = clamp && choices.length > FILTER_CLAMP_AT;
  if (!long) {
    return el(
      "div",
      { class: "filter-row" },
      el("span", { class: "filter-label", text: label }),
      el("div", { class: "filter-body" }, el("div", { class: "filter-options" }, ...chips)),
    );
  }
  // **The same control the card tag lines use**: a two-row window with up and down
  // arrows that step it a row at a time (and the wheel working over it). It used to
  // be a "More (N)" pill that expanded the line in place, which turned one filter
  // into a wall of chips and pushed every line under it off the screen.
  const options = el("div", { class: "filter-options clamped", tabindex: "0" }, ...chips);
  // A DOM with no layout (jsdom, a WebView before first paint) has no `scrollBy`, so
  // the arrows stay usable there instead of throwing on the first press.
  const step = (direction) => {
    if (typeof options.scrollBy !== "function") return;
    options.scrollBy({ top: direction * trackRow(options), behavior: reducedMotion() ? "auto" : "smooth" });
  };
  const up = el(
    "button",
    { class: "chip-arrow up focusable", type: "button", title: `Scroll ${label} up`, "aria-label": `Scroll ${label} up`, onclick: () => step(-1) },
    chevronUp(),
  );
  const down = el(
    "button",
    { class: "chip-arrow down focusable", type: "button", title: `Scroll ${label} down`, "aria-label": `Scroll ${label} down`, onclick: () => step(1) },
    chevronDown(),
  );
  // Each arrow dims at its own end, and "at the end" is only claimed once the track
  // can be measured, so a DOM with no layout keeps both arrows usable.
  const sync = () => {
    const measurable = options.scrollHeight > options.clientHeight + 2;
    const hidden = options.scrollHeight - options.clientHeight - options.scrollTop;
    down.disabled = measurable && hidden <= 2;
    up.disabled = measurable && options.scrollTop <= 2;
    down.classList.toggle("at-end", down.disabled);
    up.classList.toggle("at-end", up.disabled);
  };
  options.addEventListener("scroll", sync, { passive: true });
  const row = el(
    "div",
    { class: "filter-row" },
    el("span", { class: "filter-label", text: label }),
    el("div", { class: "filter-body" }, options, el("div", { class: "chip-scroll" }, up, down)),
  );
  // **The card tag line's rule, on the filter lines too.** *Genre* is about twenty
  // chips and *Country* is every country there is; only the layout can tell which of
  // them is actually held back, so the same helper decides — and because the whole
  // panel is built **shut** (`hidden: !filtersActive(filters)`), it has to be a
  // question that survives being asked of a line with no box yet. `watchArrowFit`
  // watches the track's size, so opening the panel answers it.
  watchArrowFit(options, (fits) => row.classList.toggle("chip-fits", fits));
  requestAnimationFrame(() => {
    sync();
    // The chip you already picked is always on screen, however far down the list it is.
    const chosen = options.querySelector(".filter-chip.active");
    if (chosen && typeof chosen.scrollIntoView === "function") chosen.scrollIntoView({ block: "nearest" });
  });
  return row;
}

/**
 * The search screen.
 *
 * The bar is wide, carries the filter control on its left, and suggests as you
 * type: collections and catalogs from the cards this row already has, plus titles
 * from TMDB. The filters are the screen's state — they live in the URL, so a
 * filtered browse is shareable and the Back button undoes a filter.
 */
function renderSearch() {
  const params = searchParams();
  const query = params.get("q") || "";
  // Where it is from (Country), what it is (Genre), when it is (Time), and how it
  // is ordered (Sort). **Continent, OTT, Mood and Theme are gone**: a country
  // already narrows the same ground a continent does, a mood is a genre under
  // another name, and a service filter only means something once you have said
  // where you are — four more lines of chips to scroll past for an answer the
  // three under them already give.
  const filters = {
    type: params.get("type") || "",
    // **The Region scopes the search.** "All countries" is still there to pick, but a
    // search that says nothing about where it is reads the region set in
    // Settings → Content — the same choice the Regional OTT cards follow — so the
    // app has one answer to "where am I" rather than two.
    country: params.get("country") || state.country || "all",
    category: params.get("category") || "all",
    period: params.get("period") || "all",
    // The **original language** of a title. There is no chip line for it (a wall of
    // 190 languages is not a filter anyone scrolls), but the value is real: the
    // title page's *Original language* opens every title made in it, and the line
    // below then says which language is in force and how to clear it.
    lang: params.get("lang") || "all",
    sort: params.get("sort") || "popularity",
  };
  const FILTER_KEYS = ["country", "category", "period", "lang"];
  const vocab = state.searchVocab || SEARCH_FALLBACK;

  // No `text-input` here: that class paints a bordered box, and inside the bar's own
  // panel it drew a second border around the placeholder.
  const input = el("input", {
    class: "search-input focusable",
    type: "search",
    placeholder: "Search titles…",
    value: query,
    id: "search-input",
    autocomplete: "off",
  });

  // Titles come from TMDB through the server. This is what the Ask box feeds:
  // "a lonely detective in the rain" only means something if search can find
  // *titles*, not just collection names.
  const titles = el("div", { class: "search-titles", id: "search-titles" });
  const suggestions = el("div", { class: "search-suggest", id: "search-suggest", hidden: true });
  let timer = null;

  const suggestRow = (kind, label, onclick) =>
    el(
      "button",
      { class: "suggest-item focusable", type: "button", onclick },
      el("span", { class: "suggest-kind", text: kind }),
      el("span", { class: "suggest-text", text: label }),
    );

  /**
   * The dropdown suggests **titles, and only titles**.
   *
   * It used to lead with matching Collections and Catalogs, so typing "home" showed
   * a `Catalog — Homeless — Themes & Tags` line above any film — the reported "why
   * is search showing this in place of contents". The box now suggests the titles
   * themselves, which is what searching for a film means.
   */
  // **Each suggestion says what it is**, on the left, where the label column is: a
  // film and a show with the same name are two different things, and "Title" on
  // every line told you nothing about which one this is.
  const drawSuggestions = (_text, metas = []) => {
    const nodes = metas.map((m) =>
      suggestRow(m.type === "series" ? "Show" : "Movie", m.name, () =>
        go(`#/t/${m.type === "series" ? "series" : "movie"}/${String(m.id || "").replace(/^tmdb:/, "")}`),
      ),
    );
    // The way **into** the results: the dropdown is what you get while typing, and
    // the wall of posters is what you get when you ask for it.
    const text = String(_text || "").trim();
    if (text) {
      nodes.push(
        el(
          "button",
          { class: "suggest-item suggest-more focusable", type: "button", onclick: () => submitNow(_text) },
          el("span", { class: "suggest-kind", text: "All" }),
          el("span", { class: "suggest-text", text: `More results for \u201c${text}\u201d` }),
        ),
      );
    }
    suggestions.replaceChildren(...nodes);
    suggestions.hidden = !nodes.length;
  };

  /** Run the search: the way out of the dropdown, and what Enter does. */
  const submitNow = (text) => {
    const p = new URLSearchParams(resultQuery());
    const value = String(text ?? input.value ?? "").trim();
    if (value) p.set("q", value);
    else p.delete("q");
    suggestions.hidden = true;
    go(`#/search?${p.toString()}`);
  };

  const resultQuery = () => {
    const p = new URLSearchParams();
    if (query.trim()) p.set("q", query.trim());
    if (filters.type) p.set("type", filters.type);
    for (const key of FILTER_KEYS) if (filters[key] !== "all") p.set(key, filters[key]);
    if (filters.sort !== "popularity") p.set("sort", filters.sort);
    if (!state.safe) p.set("adult", "1");
    return p.toString();
  };

  /* Results keep going instead of stopping at a number.

     A result window is a few TMDB pages of each row type, the same depth a catalog
     row is read at; **Load more results** asks the server for the next window and
     appends it. There is no ceiling — the button stays until the server says there
     is nothing left to ask for.

     Which page the next window starts at is the **server's** answer, not the app's
     arithmetic: the server stops reading a row type early when TMDB returns a short
     page, so "six pages further on" could step straight past the end and make the
     button look dead. `next` is the page to continue from, and it is null at the
     end. */
  let searchStart = 0;
  let searchBusy = false;
  const searchSeen = new Set();
  const groups = { movie: null, show: null };

  // Movies and shows are two lists, not one mixed grid: the row type is the first
  // thing you want to know about a result, and a name that exists as a film *and*
  // a series is two different answers.
  const groupNode = (key) => {
    if (groups[key]) return groups[key];
    const node = el(
      "section",
      { class: "search-group" },
      el("h3", { class: "result-head", text: key === "movie" ? "Movies" : "Shows" }),
      el("div", { class: "grid-titles" }),
    );
    groups[key] = node;
    return node;
  };

  // **The results page themselves in.** A window is six TMDB pages per row type —
  // 120 titles — and there used to be a *Load more results* button for the next
  // one, so a search looked like it had stopped at 120 whatever the catalogue
  // really held. The sentinel at the foot of the list does what Explore's does:
  // when it comes into view the next window is read and appended, and the count
  // beside each group climbs until TMDB has nothing left to hand over.
  const moreSentinel = el("div", { class: "sentinel", id: "search-sentinel" });
  let searchDone = true;
  let searchObserver = null;

  const appendMetas = (metas) => {
    for (const m of metas) {
      const key = m.type === "movie" ? "movie" : "show";
      const id = `${key}:${m.id}`;
      if (searchSeen.has(id)) continue;
      searchSeen.add(id);
      const node = groupNode(key);
      node.querySelector(".grid-titles").append(posterCard(m, { caption: false }));
      const label = key === "movie" ? "Movies" : "Shows";
      node.querySelector(".result-head").textContent = `${label} (${node.querySelectorAll(".poster").length})`;
      // Always in front of the sentinel, even when this group is new.
      if (!node.isConnected) titles.insertBefore(node, moreSentinel.isConnected ? moreSentinel : null);
    }
  };

  // One observer for the screen, watching the sentinel; a redraw builds a new one,
  // and the old sentinel is out of the document by then so it can never fire.
  const watchSentinel = () => {
    if (searchObserver || typeof IntersectionObserver !== "function") return;
    searchObserver = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (searchBusy || searchDone) return;
      loadTitles(query, true);
    }, { rootMargin: "600px" });
    searchObserver.observe(moreSentinel);
  };

  const loadTitles = async (text, more = false, { grid = true } = {}) => {
    const trimmed = (text || "").trim();
    if (!more) {
      searchStart = 0;
      searchSeen.clear();
      groups.movie = null;
      groups.show = null;
      searchDone = true;
      titles.replaceChildren();
    }
    // **While you type, the dropdown is the only thing on screen.** The results grid
    // used to be drawn from the same keystroke, so a handful of suggested titles sat
    // on top of a wall of posters for a search that had not been run yet.
    if (!resultQuery() || !grid) {
      searchDone = true;
      if (!grid && trimmed) {
        try {
          const p = new URLSearchParams(resultQuery());
          p.set("q", trimmed);
          const { metas = [] } = await get(`/search.json?${p.toString()}`);
          drawSuggestions(trimmed, metas);
        } catch {
          drawSuggestions(trimmed);
        }
      } else {
        drawSuggestions(trimmed);
      }
      return;
    }
    if (searchBusy) return;
    searchBusy = true;
    if (!more) titles.replaceChildren(el("p", { class: "view-hint", text: "Searching titles…" }));
    try {
      const p = new URLSearchParams(resultQuery());
      if (searchStart > 0) p.set("start", String(searchStart));
      const { metas = [], next = null } = await get(`/search.json?${p.toString()}`);
      if (!more) {
        titles.replaceChildren();
        // **The suggestion list closes when the results arrive.** It stayed open over
        // the grid, so its "Title" labels sat on top of the posters underneath them.
        // **The suggestion list is emptied when the results arrive.** It used to be
        // redrawn here, which put the floating list back on top of the poster grid.
        suggestions.hidden = true;
        suggestions.replaceChildren();
        if (!metas.length) {
          titles.append(el("p", { class: "view-hint", text: "Nothing matched. Try fewer filters, or a different region." }));
          searchDone = true;
          return;
        }
      }
      appendMetas(metas);
      // `next` is the server's own cursor: the page to continue from, or null once
      // it has read past the end of every row type.
      searchStart = typeof next === "number" && next > 0 ? next : 0;
      searchDone = !metas.length || typeof next !== "number";
      if (!searchDone && !moreSentinel.isConnected) titles.append(moreSentinel);
      watchSentinel();
    } catch {
      if (!more) titles.replaceChildren();
      searchDone = true;
    } finally {
      searchBusy = false;
    }
  };

  const refresh = (value) => {
    clearTimeout(timer);
    // Typing clears the results and shows the dropdown again; the grid comes back
    // when you ask for it (Enter, or "More results" in the dropdown).
    titles.replaceChildren();
    suggestions.hidden = false;
    // A shorter beat on the keystroke: the dropdown is the only thing drawn while
    // you type, so waiting a quarter of a second made the suggestions feel behind
    // the keyboard.
    timer = setTimeout(() => loadTitles(value, false, { grid: false }), 150);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      suggestions.hidden = true;
      return;
    }
    if (e.key === "Enter") submitNow(input.value);
  });
  input.addEventListener("input", () => refresh(input.value));

  // Changing a filter keeps the text you have typed and re-reads the row from the
  // server — this is a new URL, so it is also a new request and a new history entry.
  const pick = (name, value) => {
    const p = new URLSearchParams(resultQuery());
    // **Picking a filter does not put the cursor in the search box.** The field is the
    // first focusable thing on the screen, so a redraw handed it the focus and the page
    // jumped to the bar — "clicking All countries falls into search".
    document.getElementById("search-input")?.blur();
    const next = { ...filters, [name]: value };
    for (const key of [...FILTER_KEYS, "sort"]) {
      if (next[key] && next[key] !== "all" && !(key === "sort" && next[key] === "popularity")) p.set(key, next[key]);
      else p.delete(key);
    }
    if (next.type) p.set("type", next.type);
    else p.delete("type");
    // Whatever is in the box right now, not what the URL was rendered from.
    const text = document.getElementById("search-input")?.value ?? query;
    if (text.trim()) p.set("q", text.trim());
    go(`#/search?${p.toString()}`);
  };

  // Categories are per row type — TV has no Romance, Horror or Thriller — so with
  // no type chosen only the categories both rows have are offered, rather than a
  // list that would empty one of the two rows.
  const categoryList = filters.type
    ? vocab.categories?.[filters.type] || []
    : (vocab.categories?.movie || []).filter((c) => (vocab.categories?.series || []).includes(c));

  const panel = el(
    "section",
    { class: "search-filters", id: "search-filters", hidden: !filtersActive(filters) },
    filterRow("Type", vocab.types, filters.type, (v) => pick("type", v)),
    filterRow("Country", vocab.countries, filters.country, (v) => pick("country", v), { clamp: true }),
    categoryList.length
      ? filterRow(
          "Genre",
          [["all", "All Genres"], ...categoryList.map((c) => [c, c])],
          filters.category,
          (v) => pick("category", v),
          { clamp: true },
        )
      : null,
    // Time has every year on its own now, so it gets the same two-row window with
    // the up/down arrows Genre and Country have — 79 chips are not a single line.
    filterRow("Time", vocab.periods, filters.period, (v) => pick("period", v), { clamp: true }),
    filters.lang !== "all"
      ? filterRow(
          "Language",
          [["all", "Any language"], [filters.lang, langName(filters.lang)]],
          filters.lang,
          (v) => pick("lang", v),
        )
      : null,
    filterRow("Sort", vocab.sorts, filters.sort, (v) => pick("sort", v)),
  );

  const filterBtn = el(
    "button",
    {
      class: `search-filter-btn focusable${filtersActive(filters) ? " on" : ""}`,
      type: "button",
      id: "search-filter-btn",
      title: "Filters",
      "aria-label": "Filters",
      "aria-expanded": String(!panel.hidden),
      onclick: () => {
        panel.hidden = !panel.hidden;
        filterBtn.setAttribute("aria-expanded", String(!panel.hidden));
      },
    },
    filterIcon(),
    el("span", { text: "Filters" }),
  );

  if (resultQuery()) queueMicrotask(() => loadTitles(query));

  return [
    el("h1", { class: "view-title", text: "Search" }),
    el(
      "div",
      { class: "search-wrap" },
      // The field is the app's own panel: the magnifier leads it, the text fills it
      // edge to edge, and the filter control closes it — one control, full width.
      el("div", { class: "search-bar" }, input, filterBtn, suggestions),
    ),
    filters.country !== "all" && query.trim()
      ? el("p", {
          class: "view-hint",
          text: "TMDB search results carry no origin country, so Country applies while browsing — clear the text box to browse by it.",
        })
      : null,
    panel,
    titles,
  ].filter(Boolean);
}

/**
 * Whether the filter panel opens by itself.
 *
 * **The Region is the default, not a filter.** `country` starting at the region is
 * what scopes the search, and counting it as "active" would pop the panel open on
 * every search; it counts only when it is something *other* than the region.
 */
const filtersActive = (f) =>
  Boolean(f.type) ||
  ["category", "period", "lang"].some((k) => f[k] !== "all") ||
  (f.country !== "all" && f.country !== state.country) ||
  f.sort !== "popularity";

/* ----------------------------------------------------------------- calendar */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * The Calendar's plan-to-watch pin — and why it is not a watchlist row.
 *
 * The watchlist rows are states you progress through, and they scan whatever is
 * in that state. A calendar pin is different: it is a plan about a *date* — a
 * release you saw on the grid and mean to get to — so it lives in its own row
 * (`calendar-plans`) and the grid lists only the **recent** ones (the last
 * `CAL_RECENT_DAYS`). Putting it in the watchlist's Plan to Watch row was wrong:
 * a plan made on a Tuesday grid is not the same list as everything you plan to
 * watch, and mixing them made "plan to watch" mean two things.
 */
const CAL_RECENT_DAYS = 30;
const CAL_ROW = "calendar-plans";

const keyOfItem = (i) => `${i.type}:${i.id}`;

/** The calendar's own pins, newest first, recent only. */
function calendarPins() {
  const since = Date.now() - CAL_RECENT_DAYS * 864e5;
  return state.customItems
    .filter((i) => i.row === CAL_ROW)
    .filter((i) => !i.addedAt || Date.parse(i.addedAt) >= since)
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

/** Was this title planned *from the calendar*? */
const isCalendarPin = (item) => calendarPins().some((i) => keyOfItem(i) === watchKey(item));

/** Plan the title from the calendar — or take the plan away again. */
async function calendarPlan(item) {
  try {
    const res = await post("/customrows", { row: CAL_ROW, item: pinOf(item) });
    if (res && Array.isArray(res.items)) applyCustomRows(res);
  } catch {
    /* offline — the plan simply does not change */
  }
  render();
}

/**
 * Take a plan back off the calendar.
 *
 * The pin used to be add-only — a plan was a fact about a date and a stray click
 * must not delete it — but add-only with no other way to remove one meant a plan
 * you no longer wanted sat there for good. It is a toggle again, and this is the
 * half that removes.
 */
async function calendarUnplan(item) {
  try {
    const res = await post("/customrows", { row: CAL_ROW, item: pinOf(item), remove: true });
    if (res && Array.isArray(res.items)) applyCustomRows(res);
  } catch {
    /* offline — the plan simply does not change */
  }
  render();
}

/** `2026-10-02` → `Fri, October 2`, put together the way the guide builds its day headings. */
function planDayLabel(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", day: "numeric", month: "long" });
}

function calendarCard(m, opts = {}) {
  const planned = isCalendarPin(m);
  return el(
    "div",
    { class: "cal-item" },
    // **No caption over a calendar poster.** The name, year and rating the poster
    // plate can carry sat on top of the artwork on every day of the grid; the date
    // cell and the poster itself already say what this is.
    posterCard(m, { kind: true, caption: false }),
    // **The plan's own line.** The day list says it by being on that day; the plans list
    // is not on a day, so it says which date the plan was made for.
    opts.date && m.releaseDate ? el("span", { class: "cal-plan-date", text: planDayLabel(m.releaseDate) }) : null,
    // A calendar pin is a plan about a **date**, and it is a toggle: planning says
    // so, and pressing it again takes the plan back. It was briefly add-only, which
    // left a plan you had changed your mind about with no way off the calendar.
    el("button", {
      class: `btn pin cal-pin focusable${planned ? " active" : ""}`,
      type: "button",
      "data-cal-pin": keyOfItem(m),
      "aria-pressed": String(planned),
      title: planned ? "Planned from the calendar — click to remove the plan" : "Plan to watch (calendar pin)",
      text: planned ? "Plan to Watch · planned" : "Plan to Watch",
      onclick: () => (planned ? calendarUnplan(m) : calendarPlan(m)),
    }),
  );
}

/**
 * **The Calendar follows the profile.** The two profiles hold different things:
 * one has *releases* — a title lands on a date — and the other has a *schedule*,
 * where programmes are on at a time. So the screen is not one calendar drawn from
 * two sources; each profile gets the calendar its own content can have.
 */
function renderCalendar() {
  return liveProfile() ? renderLiveCalendar() : renderVodCalendar();
}

function renderVodCalendar() {
  const { month } = state.calendar;
  const [year, mon] = month.split("-").map(Number);
  const grid = el("div", { class: "cal-grid" });
  const detail = el("div", { class: "cal-detail" });
  // **The plans are their own section, not part of a day.** A pin is a plan about a date;
  // which day is *open* is a view of the grid. The plans used to be drawn only inside the
  // selected day, so deselecting it — or turning to another month — took every plan off
  // the screen while the pins sat on the server, which reads as if they were deleted.
  const plans = el("section", { class: "cal-recent" });

  // The month grid is drawn immediately; the titles arrive from the server.
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const today = new Date().toISOString().slice(0, 10);

  const byDate = new Map();

  function drawGrid() {
    grid.replaceChildren(...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => el("div", { class: "cal-dow", text: d })));
    for (let i = 0; i < firstWeekday; i++) grid.append(el("div", { class: "cal-cell blank" }));
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${month}-${String(d).padStart(2, "0")}`;
      const items = byDate.get(iso) || [];
      grid.append(
        el(
          "button",
          {
            class: `cal-cell focusable${iso === today ? " today" : ""}${state.calendar.day === iso ? " selected" : ""}`,
            type: "button",
            // Clicking the selected day again deselects it.
            onclick: () => {
              state.calendar.day = state.calendar.day === iso ? null : iso;
              render();
            },
            "aria-pressed": String(state.calendar.day === iso),
          },
          el("span", { class: "cal-day", text: String(d) }),
          items.length
            ? el("span", { class: "cal-count", text: `${items.length} title${items.length === 1 ? "" : "s"}` })
            : el("span", { class: "cal-count empty" }),
        ),
      );
    }
  }

  function drawDetail() {
    const iso = state.calendar.day;
    // Nothing selected → nothing shown, and no caption over it.
    if (!iso) {
      detail.replaceChildren();
      return;
    }
    const items = byDate.get(iso) || [];
    detail.replaceChildren(
      items.length
        ? el("div", { class: "grid-titles" }, ...items.map((m) => calendarCard(m)))
        : el("p", { class: "empty", text: "Nothing releases on this day." }),
    );
  }

  /**
   * The calendar's own plans, newest first — **whatever day is open, or none.**
   *
   * Drawn empty as well as full: "nothing planned yet" is an answer, and a section that
   * appears only once you have used it is a section you cannot find on the first visit.
   */
  function drawPlans() {
    const items = calendarPins();
    plans.replaceChildren(
      el("h3", { class: "section-title", text: "Your plans" }),
      items.length
        ? el("div", { class: "grid-titles" }, ...items.map((m) => calendarCard(m, { date: true })))
        : el("p", { class: "empty", text: "Nothing planned from the calendar yet — plan a release above." }),
    );
  }

  drawGrid();
  drawDetail();
  drawPlans();

  // A day holds films *and* series, so both rows are read for the month.
  Promise.all(
    ["movie", "series"].map((type) =>
      get(`/calendar/${type}/${month}.json${catalogQuery()}`)
        .then((data) => data.metas || [])
        .catch(() => []),
    ),
  )
    .then((lists) => {
      const seen = new Set();
      for (const m of lists.flat()) {
        const id = `${m.type}:${m.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const list = byDate.get(m.releaseDate) || [];
        list.push(m);
        byDate.set(m.releaseDate, list);
      }
      drawGrid();
      drawDetail();
    })
    .catch((err) => {
      detail.replaceChildren(el("p", { class: "empty", text: `Could not load the calendar — ${err.message}` }));
    });

  return [
    el(
      "header",
      { class: "cal-head" },
      el("div", { class: "cal-title" },
        el("h1", { class: "view-title", text: "Calendar" }),
        el("p", { class: "view-hint", text: `Movies & series releasing this month${state.language ? ` · ${state.language}` : ""}` }),
      ),
      el("div", { class: "cal-nav" },
        el("button", { class: "icon-btn focusable", type: "button", text: "‹", "aria-label": "Previous month", onclick: () => { state.calendar = { month: shiftMonth(month, -1), day: null }; render(); } }),
        el("span", { class: "cal-month", text: `${MONTH_NAMES[mon - 1]} ${year}` }),
        el("button", { class: "icon-btn focusable", type: "button", text: "›", "aria-label": "Next month", onclick: () => { state.calendar = { month: shiftMonth(month, 1), day: null }; render(); } }),
      ),
    ),
    grid,
    detail,
    plans,
  ];
}

/* ------------------------------------------------ calendar (Live TV & Sports) */

/** A local-clock `YYYY-MM-DD` for a moment — the day a programme airs *here*. */
function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A day heading: `Today · Saturday 10 October`, `Tomorrow · …`, else the date. */
function liveDayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const long = new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  if (key === localDayKey(Date.now())) return `Today · ${long}`;
  if (key === localDayKey(Date.now() + 864e5)) return `Tomorrow · ${long}`;
  return long;
}

/** How many programmes one day lists before it says how many are left. */
const LIVE_CAL_PER_DAY = 60;

/**
 * The guide's programmes from now on, grouped by the day they air.
 *
 * **A calendar holds what is *coming*, and the Guide already holds what is *on*.**
 * A chronological list that begins with every channel's mid-run block is a list you
 * have to scroll past (a big lineup put tens of thousands of them ahead of the first
 * programme that had not started yet) — so this keeps the programmes that
 * start from now on, soonest first, and leaves "what is on this minute" to the Guide,
 * where the grid draws it against the clock.
 *
 * **One guide id, one broadcast.** The lineup is a merge — the catalogue, your
 * add-ons, the picked providers — and two entries can point at the same guide feed, so
 * the same programme at the same minute would otherwise be listed twice. Keyed by that
 * guide id and its start time it is listed once; the SD and HD feeds of one channel
 * carry their own ids and stay apart, because they are genuinely two feeds.
 */
function liveCalDays() {
  const guide = state.live.guide;
  const byDay = new Map();
  const seen = new Set();
  if (!guide || !guide.programmes) return byDay;
  const now = Date.now();
  for (const channel of liveChannelsShown()) {
    const epgKey = channel.epgId || channel.id;
    for (const p of guide.programmes[epgKey] || []) {
      if (!p || !p.start || p.start < now) continue;
      // **Only inside the window the screen states.** The read keeps a little more
      // than it promises (an hour either side, so a block straddling the edge is
      // whole), and a day heading drawn from that overhang would contradict the line
      // above it.
      if (guide.end && p.start >= guide.end) continue;
      const id = `${epgKey}|${p.start}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const key = localDayKey(p.start);
      const list = byDay.get(key) || [];
      list.push({ channel, p });
      byDay.set(key, list);
    }
  }
  for (const list of byDay.values()) {
    // Earliest first; two on at once are ordered by channel so the list is stable.
    list.sort((a, b) => a.p.start - b.p.start || String(a.channel.name || "").localeCompare(String(b.channel.name || "")));
  }
  return new Map([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** One programme on the live calendar: when it starts, which channel, and what. */
function liveCalRow(channel, programme) {
  return el(
    "button",
    {
      class: "cal-live-row focusable",
      type: "button",
      title: `Open ${channel.name || "the channel"}`,
      onclick: () => go(`#/channel/${encodeURIComponent(channel.id)}`),
    },
    el("span", { class: "cal-live-time", text: `${clockOf(programme.start)} – ${clockOf(programme.stop)}` }),
    channel.logo
      ? el("img", { class: "cal-live-logo", src: channel.logo, alt: "", loading: "lazy" })
      : el("span", { class: "cal-live-logo fallback", text: (channel.name || "?").slice(0, 1).toUpperCase() }),
    el(
      "span",
      { class: "cal-live-what" },
      el("span", { class: "cal-live-title", text: programme.title }),
      el("span", { class: "cal-live-channel", text: [channel.name, channel.country].filter(Boolean).join(" · ") }),
    ),
  );
}


/** Recording helpers for IPTV/DVR */
const REC_KEY = "nuvio.recordings";

function recordingsGet() {
  try {
    return JSON.parse(localStorage.getItem(REC_KEY) || "[]");
  } catch {
    return [];
  }
}

function recordingsSave(list) {
  try {
    localStorage.setItem(REC_KEY, JSON.stringify(list));
  } catch {}
  state.recordings = list;
}

function isRecording(id) {
  return recordingsGet().some((r) => r.id === id);
}

function toggleRecordProgramme(channel, programme) {
  const list = recordingsGet();
  const id = `${channel.id}|${programme.start}`;
  const idx = list.findIndex((r) => r.id === id);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push({
      id,
      channelId: channel.id,
      channelName: channel.name,
      channelLogo: channel.logo || "",
      title: programme.title,
      start: programme.start,
      stop: programme.stop,
      desc: programme.desc || "",
    });
  }
  recordingsSave(list);
  render();
}

/**
 * The Calendar on the Live TV & Sports profile: what is coming up, and on which
 * channel.
 *
 * A month grid is not something a live playlist can fill — nothing is *released*, it
 * is *scheduled* — so this profile's calendar is the schedule itself: the guide's own
 * programmes, grouped by the day they air, under the profile's two rows (Live TV /
 * Sports), exactly as its Home screen has them.
 *
 * It reads the **same** `/live/guide.json` the Guide reads — same hours, same picked
 * countries — so the two screens can never disagree about what is on, and it states
 * the window that came back rather than implying a month it cannot see. Opening the
 * Calendar first (a link, a reload) reads the lineup and the guide itself instead of
 * landing on an empty page.
 */
function renderLiveCalendar() {
  if (!state.live.loaded && !state.live.loading) loadLive();
  if (state.live.loaded && !state.live.guide && !state.live.guideLoading) loadGuide();

  const guide = state.live.guide;
  const channels = liveChannelsShown();
  const sports = liveRowKey() === "sports";
  const days = liveCalDays();
  const nodes = [
    el(
      "header",
      { class: "cal-head" },
      el(
        "div",
        { class: "cal-title" },
        el("h1", { class: "view-title", text: "Calendar" }),
        el("p", {
          class: "view-hint",
          text: `${sports ? "Sport" : "Live TV"} · ${channels.length ? `${channels.length} channels` : "no channels yet"}`,
        }),
      ),
      liveRowSwitch(),
    ),
  ];

  // **The window is stated, not assumed.** The guide was read for a fixed number of
  // hours, and the list can only hold what that read returned — so the line says the
  // hours the data actually covers rather than a period the app would be guessing at.
  const hours = guide && guide.end > guide.start ? Math.round((guide.end - guide.start) / 3600_000) : 0;
  if (guide && guide.epg && hours) {
    nodes.push(
      el("p", {
        class: "view-hint cal-window",
        text: `The guide reaches ${clockOf(guide.start)} → ${clockOf(guide.end)} (the next ${hours} hours). Later days fill as your guide is refreshed.`,
      }),
    );
  }

  if (!guide) {
    nodes.push(
      ...(state.live.guideLoading
        ? [el("p", { class: "view-hint", text: "Reading the guide…" })]
        : [
            el("p", { class: "empty", text: "The guide has not been read yet — reading it lists what is coming up." }),
            state.live.guideError
              ? el("p", { class: "view-hint", text: `The guide could not be read — ${state.live.guideError}` })
              : null,
            el("div", { class: "cal-actions" },
              el("button", { class: "btn primary focusable", type: "button", text: "Read the guide", onclick: () => loadGuide() }),
            ),
          ]),
    );
    return nodes.filter(Boolean);
  }

  // **No EPG is an answer, not an error.** Without a guide there is no schedule to
  // draw, and the screen says where the guide comes from instead of looking broken.
  if (guide.epg === false) {
    nodes.push(
      el("p", {
        class: "view-hint",
        text: "No guide data — add an XMLTV (EPG) URL under Settings → Source and this lists real programmes.",
      }),
      guide.error ? el("p", { class: "view-hint", text: `The guide could not be read — ${guide.error}` }) : null,
    );
    return nodes.filter(Boolean);
  }

  if (!channels.length) {
    nodes.push(
      el("p", {
        class: "view-hint",
        text: "No channels yet — pick a source and countries under Settings → Source and this lists their schedule.",
      }),
    );
    return nodes.filter(Boolean);
  }

  if (!days.size) {
    nodes.push(el("p", { class: "empty", text: `Nothing else in the guide for the next ${hours || 6} hours.` }));
    return nodes.filter(Boolean);
  }

  for (const [key, list] of days) {
    // **The day counts what it holds**, so a heading says how much of a day the guide
    // can actually see rather than leaving an empty-looking date.
    nodes.push(
      el("h3", { class: "cal-live-day" },
        el("span", { text: liveDayLabel(key) }),
        el("span", { class: "cal-live-count", text: `${list.length} starting` }),
      ),
    );
    nodes.push(el("div", { class: "cal-live" }, ...list.slice(0, LIVE_CAL_PER_DAY).map(({ channel, p }) => liveCalRow(channel, p))));
    if (list.length > LIVE_CAL_PER_DAY) {
      nodes.push(
        el("p", { class: "view-hint", text: `${list.length - LIVE_CAL_PER_DAY} more on this day — the Guide lists every programme.` }),
      );
    }
  }
  return nodes.filter(Boolean);
}

/* ----------------------------------------------------------------- sources */

function sourceProviders(source) {
  if (Array.isArray(source.providers) && source.providers.length) return source.providers;
  return [];
}

/** A manifest resource → the label the Sources screen shows it under. */
const RESOURCE_LABELS = { catalog: "Catalog", meta: "Metadata", stream: "Streams", subtitles: "Subtitles", addon_catalog: "Add-on catalog" };
const resourceLabel = (name) => RESOURCE_LABELS[name] || (name ? name.charAt(0).toUpperCase() + name.slice(1) : "");

/** What one source serves, grouped: resources (add-ons) and scrapers (plugins). */
function sourceGroups(source) {
  const resources = (source.resources || []).map(resourceLabel).filter(Boolean);
  const scrapers = Array.isArray(source.scrapers) ? source.scrapers : [];
  const providers = sourceProviders(source);
  // A repository's "providers" *are* its scrapers.
  if (!scrapers.length && source.kind === "repo") scrapers.push(...providers);
  return { resources, scrapers, providers };
}

/**
 * One source's providers, laid out by what they are.
 *
 * A **Stremio add-on** declares resources (`catalog`, `meta`, `stream`,
 * `subtitles`) and names its catalogs — both are shown. A **Nuvio plugin**
 * publishes scrapers, which are the providers; a repo has no catalogs to list.
 */
function sourceBody(source) {
  const { resources, scrapers, providers } = sourceGroups(source);
  const line = (label, items) =>
    items.length
      ? el("div", { class: "source-line" },
          el("span", { class: "source-line-label", text: label }),
          el("div", { class: "chips" }, ...items.map((p) => el("span", { class: "chip", text: p }))),
        )
      : null;
  // A **Nuvio plugin** answers with *streams*, not catalogs: its scrapers are the
  // sources a title can be played from. A **Stremio add-on** declares everything it
  // serves — catalog, metadata, streams, subtitles — and names its catalogs, so both
  // are listed.
  const isPlugin = scrapers.length > 0 || source.kind === "plugin" || source.kind === "repo";
  // **What it serves is selectable.** Each resource the add-on declares is a toggle:
  // turning *Streams* off takes this add-on out of the play list, and the other
  // resources are remembered the same way. The picked state is stored on the source
  // and travels to the server with it, which is where the stream list is built.
  const off = new Set(Array.isArray(source.disabled) ? source.disabled : []);
  const resourceToggles = (list) =>
    list.map((res) => {
      const label = resourceLabel(res);
      const on = !off.has(res);
      return el("button", {
        class: `filter-chip focusable${on ? " active" : ""}`,
        type: "button",
        "data-resource": res,
        "aria-pressed": String(on),
        title: on ? `Turn ${label} off for this add-on` : `Turn ${label} back on`,
        text: label,
        onclick: () => {
          const next = new Set(off);
          if (next.has(res)) next.delete(res);
          else next.add(res);
          source.disabled = [...next];
          saveSources();
          render();
        },
      });
    });
  // A plugin's scrapers *are* its streams. An add-on declares what it serves, and
  // `stream` among its resources is what makes it playable — so it gets its own
  // **Streams** line, next to the rest of its resources and its catalogs.
  const servesStreams = resources.includes("stream");
  const lines = isPlugin
    ? [line("Streams", scrapers.length ? scrapers : providers)]
    : [
        servesStreams
          ? el("div", { class: "source-line" },
              el("span", { class: "source-line-label", text: "Streams" }),
              el("div", { class: "chips" }, ...resourceToggles(["stream"])),
            )
          : null,
        resources.filter((r) => r !== "stream").length
          ? el("div", { class: "source-line" },
              el("span", { class: "source-line-label", text: "Resources" }),
              el("div", { class: "chips" }, ...resourceToggles(resources.filter((r) => r !== "stream"))),
            )
          : null,
        line("Catalogs", providers),
      ];
  const nodes = lines.filter(Boolean);
  if (nodes.length) return nodes;
  // A source that **has been read** and has nothing to list says that. It used to say
  // "Reading this source's providers…" whether or not the read had finished, so a
  // stream-only add-on — no catalogs, no scrapers, just streams — sat on a line that
  // was not true any more, and there was nothing else on the row to say so.
  if (source.status) {
    return [
      el("p", {
        class: "option-desc",
        text: source.status.ok
          ? "Nothing to list — this add-on publishes no catalogs, and its streams are read when you press Play."
          : source.status.text,
      }),
    ];
  }
  return [el("p", { class: "option-desc", text: "Reading this source's providers…" })];
}

function sourceGraph(meta) {
  const hubs = state.sources.map((s) => ({
    label: s.name || typeLabel(s.type),
    providers: sourceProviders(s),
  }));

  const W = 1040;
  const H = 640;
  const cx = W / 2;
  const cy = H / 2;
  const R1 = 210;
  const R2 = 92;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "graph");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Sources graph");

  const line = (a, b, cls) => {
    const l = document.createElementNS(ns, "line");
    l.setAttribute("x1", a.x); l.setAttribute("y1", a.y);
    l.setAttribute("x2", b.x); l.setAttribute("y2", b.y);
    l.setAttribute("class", cls);
    svg.append(l);
  };
  const node = (p, r, cls, label, dy = 0) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", p.x); c.setAttribute("cy", p.y); c.setAttribute("r", r);
    c.setAttribute("class", cls);
    svg.append(c);
    if (label) {
      const t = document.createElementNS(ns, "text");
      t.setAttribute("x", p.x); t.setAttribute("y", p.y + dy);
      t.setAttribute("class", "graph-label");
      t.setAttribute("text-anchor", "middle");
      t.textContent = label.length > 26 ? `${label.slice(0, 25)}…` : label;
      svg.append(t);
    }
  };

  const center = { x: cx, y: cy };
  const positions = hubs.map((h, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, hubs.length)) * Math.PI * 2;
    return { hub: h, x: cx + Math.cos(a) * R1, y: cy + Math.sin(a) * R1, a };
  });

  for (let i = 0; i < positions.length; i++) {
    line(positions[i], positions[(i + 1) % positions.length], "graph-edge faint");
    line(center, positions[i], "graph-edge");
  }

  const leaves = [];
  for (const pos of positions) {
    const provs = pos.hub.providers;
    const spread = Math.PI * 0.9;
    const start = pos.a - spread / 2;
    provs.forEach((name, j) => {
      const a = provs.length === 1 ? pos.a : start + (j / (provs.length - 1)) * spread;
      const p = { x: pos.x + Math.cos(a) * R2, y: pos.y + Math.sin(a) * R2 };
      line(pos, p, "graph-edge");
      leaves.push({ p, name });
    });
  }

  node(center, 15, "graph-node center", meta?.name || "Title", 34);
  for (const pos of positions) node(pos, 9, "graph-node hub", pos.hub.label, -16);
  for (const l of leaves) node(l.p, 6, "graph-node leaf", l.name, 18);

  return svg;
}

function renderSources(id, name) {
  const meta = { id, name: name || "Title" };
  const nodes = [
    el("div", { class: "sources-head" },
      el("div", {},
        el("p", { class: "hero-kicker", text: "Sources" }),
        el("h2", { class: "view-title", text: meta.name }),
        el("p", { class: "view-hint", text: "Providers connected by the add-on that returns them." }),
      ),
      el("div", { class: "graph-legend" },
        el("span", { class: "dot hub" }), el("span", { text: "add-on" }),
        el("span", { class: "dot leaf" }), el("span", { text: "provider" }),
      ),
    ),
  ];

  // **Add-ons only.** Nuvio plugins were removed (their runner, their source type and
  // their settings pane), so there is nothing else a source can be.
  const ordered = state.sources.filter((s) => ADDON_TYPES.some(([t]) => t === s.type));

  if (!ordered.length) {
    nodes.push(
      el("div", { class: "empty-panel" },
        el("p", { text: "No sources configured yet. Add a Stremio add-on in Settings and its providers appear here, linked to the source that returns them." }),
        el("button", { class: "btn primary focusable", type: "button", text: "Open Settings", onclick: () => go("#/settings") }),
      ),
    );
    return nodes;
  }

  const saved = state.sources;
  state.sources = ordered;
  nodes.push(sourceGraph(meta));
  state.sources = saved;

  // **One group, because there is one kind of source.** The "Plugins & repositories"
  // half went with Nuvio plugins; it read `plugins`, which no longer exists.
  for (const [title, list] of [["Add-ons", ordered]]) {
    if (!list.length) continue;
    nodes.push(el("h3", { class: "result-head", text: title }));
    nodes.push(el("div", { class: "source-provider-list" }, ...list.map((s) =>
      el("div", { class: "source-providers" },
        el("div", { class: "source-providers-head" },
          el("span", { class: "source-type", text: `${typeLabel(s.type)}${s.name ? ` · ${s.name}` : ""}` }),
          el("span", { class: "source-url", text: s.url }),
        ),
        ...sourceBody(s),
      ))));
  }
  return nodes;
}

/* ---------------------------------------------------------- a title, in full */

/**
 * One title's own page.
 *
 * The title used to be a modal over whatever screen you were on — a poster, a
 * description and five buttons. It is a **page** now, because what you want from a
 * title does not fit in a card: who made it, who is in it, what studio and what
 * franchise it belongs to, its rating, its seasons, and what else is like it — and
 * every one of those is a way into its own catalog, not a label.
 */
/* ------------------------------------------------------------ hover previews */

/**
 * **The panel that says what is under the cursor.**
 *
 * Settings → Animation has offered "Titles and cards" and "Catalog tiles" since the
 * pane was written and nothing ever appeared, because the app drew captions on the
 * artwork instead and those captions were removed. The panel is the replacement: the
 * pointer resting on a poster (or on a Home tile) opens a small card beside it with
 * the name on one line and the year, kind and rating on the next — text only, no
 * request, and never inside the player or the trailer overlay.
 *
 * It is drawn **over** the page and takes no clicks (`pointer-events: none`), so the
 * card under it still gets the press, and it is put away by leaving the card, by a
 * scroll, or by any redraw.
 */
const previewBox = el("div", { class: "hover-preview", hidden: true, "aria-hidden": "true" },
  el("p", { class: "hover-preview-title" }),
  el("p", { class: "hover-preview-meta" }),
);

function hidePreview() {
  if (!previewBox.hidden) previewBox.hidden = true;
}

function showPreview(anchor, title, meta) {
  if (!title) return hidePreview();
  previewBox.children[0].textContent = title;
  previewBox.children[1].textContent = meta || "";
  previewBox.hidden = false;
  const a = anchor.getBoundingClientRect();
  const b = previewBox.getBoundingClientRect();
  const left = Math.max(12, Math.min(window.innerWidth - b.width - 12, a.left + a.width / 2 - b.width / 2));
  // Above the card where there is room, below it where there is not.
  const above = a.top - b.height - 10;
  const top = above >= 12 ? above : Math.min(window.innerHeight - b.height - 12, a.bottom + 10);
  previewBox.style.left = `${Math.round(left)}px`;
  previewBox.style.top = `${Math.round(top)}px`;
}

/** Which preview the pointer is on, if any, as its anchor and two lines of text. */
function previewFor(node) {
  if (!node || typeof node.closest !== "function") return null;
  if (node.closest(".player, .trailer-overlay, .modal, .hover-preview")) return null;
  const tile = node.closest("[data-preview]");
  if (tile && state.previews?.catalogs) {
    return { anchor: tile, title: tile.dataset.preview, meta: tile.dataset.previewMeta || "" };
  }
  const card = node.closest(".poster");
  if (card && state.previews?.cards) {
    const d = card.dataset;
    return { anchor: card, title: d.name || "", meta: [d.kind, d.year, d.rating].filter(Boolean).join(" · ") };
  }
  return null;
}

function setupPreviews() {
  document.body.append(previewBox);
  document.addEventListener("pointerover", (e) => {
    const hit = previewFor(e.target);
    if (!hit) return hidePreview();
    showPreview(hit.anchor, hit.title, hit.meta);
  });
  document.addEventListener("pointerout", (e) => {
    const hit = previewFor(e.target);
    // Moving between the pieces of one card is not leaving it.
    if (hit && hit.anchor.contains(e.relatedTarget)) return;
    hidePreview();
  });
  window.addEventListener("scroll", hidePreview, { passive: true });
  window.addEventListener("resize", hidePreview);
}

/* ------------------------------------------------------------------- sound */

/**
 * **Sound is off until it is asked for** (Settings → Sound).
 *
 * Two switches and a volume, and until now none of them did anything. Both are drawn
 * from the Web Audio API rather than from files: a tick is one short decaying note, and
 * the browsing music is a slow four-note pad under a lowpass filter with an LFO on the
 * cutoff — nothing to download, nothing to store, and both stop the instant the switch
 * goes off.
 *
 * The **click** plays on a press (a button, a tile, a tab) and never on a scroll.
 * The **music** plays while the app is browsed and stops the moment a title plays, so
 * it never sits under what you are actually watching. Neither can start before a user
 * gesture, because a browser will not run an AudioContext without one — the first
 * press is what brings it up.
 */
let audioCtx = null;
let music = null;

function audio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => { /* asked again on the next press */ });
  return audioCtx;
}

/** The soft tick a press makes. */
function playClick() {
  if (!state.sound?.clicks) return;
  const ctx = audio();
  if (!ctx) return;
  const at = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(760, at);
  osc.frequency.exponentialRampToValueAtTime(430, at + 0.05);
  // A short, quiet envelope: a tick, not a beep.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.05, at + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.12);
}

/** The music's own ceiling: the volume setting is a percentage of a quiet pad. */
const musicGain = () => (Math.max(0, Math.min(100, Number(state.sound?.musicVolume ?? 35))) / 100) * 0.055;

function startMusic() {
  if (music) {
    // Already running: just follow the volume slider.
    music.master.gain.setTargetAtTime(musicGain(), audioCtx.currentTime, 0.4);
    return;
  }
  const ctx = audio();
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = 0.0001;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 620;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.06;
  lfoGain.gain.value = 190;
  lfo.connect(lfoGain).connect(filter.frequency);
  // A minor-ish stack, so the loop reads as ambience rather than a melody.
  const voices = [110, 164.81, 220, 329.63].map((hz, i) => {
    const osc = ctx.createOscillator();
    osc.type = i % 2 ? "sine" : "triangle";
    osc.frequency.value = hz;
    osc.detune.value = i * 4;
    osc.connect(filter);
    return osc;
  });
  filter.connect(master).connect(ctx.destination);
  const at = ctx.currentTime;
  for (const osc of [...voices, lfo]) osc.start(at);
  master.gain.linearRampToValueAtTime(musicGain(), at + 2.5);
  music = { master, voices, lfo, filter };
}

function stopMusic() {
  if (!music) return;
  const { master, voices, lfo } = music;
  const at = audioCtx.currentTime;
  master.gain.setTargetAtTime(0.0001, at, 0.3);
  // The voices are stopped a beat later, once the fade is done.
  setTimeout(() => {
    for (const osc of [...voices, lfo]) { try { osc.stop(); } catch { /* already stopped */ } }
  }, 1200);
  music = null;
}

/** Music runs while browsing and gives way to the title being played. */
function syncSound() {
  const playing = Boolean(document.querySelector(".player"));
  if (state.sound?.music && !playing) startMusic();
  else stopMusic();
}

function setupSound() {
  // **A press is what turns the audio on.** Browsers keep an AudioContext suspended
  // until a gesture, so the first press is also the first tick, and the music — if it
  // was left on — comes up with it.
  document.addEventListener("pointerdown", () => syncSound(), { once: true });
  // A press anywhere that is a control ticks. A scroll, a hover and the player's own
  // controls are not presses of the app's furniture.
  document.addEventListener("click", (e) => {
    const target = e.target?.closest?.("button, .poster, .icon-box, .settings-tab, .chip, .tab");
    if (!target || target.closest(".player, .trailer-overlay")) return;
    playClick();
  }, true);
  // The player opens and closes without a route change, so the music watches the
  // overlay itself rather than the hash.
  new MutationObserver((records) => {
    const touched = records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) =>
      n.nodeType === 1 && (n.classList?.contains("player") || n.querySelector?.(".player"))));
    if (touched) syncSound();
  }).observe(document.body, { childList: true });
  syncSound();
}

/* ----------------------------------------------------------- notifications */

/**
 * **The app's own notification**, drawn in the corner (Settings → Notifications).
 *
 * The pane names three things worth being told about, and nothing ever told anyone
 * anything. There is no account and nothing leaves the machine, so the only events that
 * exist are the ones the app can see for itself: a **Calendar plan whose date is today**
 * and something **from the Library releasing today**. Both are read once on a boot, and
 * a title is only announced once a day — a message that reappears on every restart is
 * noise, not a notification.
 */
const toastStack = el("div", { class: "toast-stack", role: "status", "aria-live": "polite" });

function notify(title, body) {
  if (!toastStack.isConnected) document.body.append(toastStack);
  const node = el("div", { class: "toast" },
    el("p", { class: "toast-title", text: title }),
    body ? el("p", { class: "toast-body", text: body }) : null,
  );
  const close = () => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 300);
  };
  node.addEventListener("click", close);
  setTimeout(close, 11000);
  toastStack.append(node);
}

async function checkNotifications() {
  const n = state.notifications || {};
  if (!n.calendar && !n.releases) return;
  if (liveProfile()) return;
  const today = new Date().toISOString().slice(0, 10);
  const seenKey = `${KEY.notifications}.seen`;
  const seen = readJSON(seenKey, {});
  if (seen.day === today && seen.profile === state.profile) return;
  let items = [];
  try {
    const lists = await Promise.all(
      ["movie", "series"].map((type) =>
        get(`/calendar/${type}/${today.slice(0, 7)}.json${catalogQuery()}`)
          .then((data) => data.metas || [])
          .catch(() => []),
      ),
    );
    items = lists.flat().filter((m) => m && m.releaseDate === today);
  } catch {
    return;
  }
  writeJSON(seenKey, { day: today, profile: state.profile });
  if (!items.length) return;

  const planned = new Set(calendarPins().map((i) => keyOfItem(i)));
  const library = new Set((state.watchItems || []).map((i) => `${i.type}:${i.id}`));
  let shown = 0;
  for (const m of items) {
    if (shown >= 3) break;
    const key = keyOfItem(m);
    if (n.calendar && planned.has(key)) {
      notify("Out today", `${m.name} — the title you planned for today is out.`);
      shown += 1;
      continue;
    }
    if (n.releases && library.has(key)) {
      notify("From your Library", `${m.name} has something new today.`);
      shown += 1;
    }
  }
}

/**
 * Settings that are not one pane's own: the page-level preferences the server keeps in
 * `user-preferences.json`.
 *
 * Written locally first so the page redraws at once, then posted — the answer is only
 * ever the same value back, so there is nothing to wait for.
 */
function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  writeJSON(KEY.prefs, state.prefs);
  post("/prefs", patch).catch(() => { /* offline — the local copy still applies */ });
  render();
}

/** The resolutions Play may reach for. A number is a ceiling; `auto` is no ceiling. */
const QUALITY_CHOICES = [
  ["auto", "Auto"],
  ["2160", "4K"],
  ["1080", "1080p"],
  ["720", "720p"],
  ["480", "480p"],
];

/** The subtitle languages, as Settings → Subtitles offers them. */
const subtitleChoices = () => [
  ["", `Follow the app (${String(state.language || "en-US").slice(0, 2)})`],
  ...(state.options.subtitleLanguages || []),
];

/**
 * The two choices that belong beside Play.
 *
 * **Subtitle** writes the same language Settings → Subtitles writes, and **Quality**
 * writes the ceiling the source picker reads (see `openSources`), so a title page can
 * answer "which subtitles?" and "how big?" without a trip to Settings first.
 */
function subtitlePick() {
  const pick = dropdown(subtitleChoices(), state.subtitles?.language || "", (value) => {
    state.subtitles = { ...state.subtitles, language: value };
    writeJSON(KEY.subtitles, state.subtitles);
    pushSettings({ subtitles: { language: value } });
    render();
  }, "Subtitle");
  pick.node.classList.add("title-pick");
  return pick.node;
}

function qualityPick() {
  const pick = dropdown(QUALITY_CHOICES, state.prefs?.quality || "auto", (value) => savePrefs({ quality: value }), "Quality");
  pick.node.classList.add("title-pick");
  return pick.node;
}

async function renderTitle(type, id) {
  const media = type === "series" ? "series" : "movie";
  setRow(media);
  let data;
  try {
    data = await get(`/title/${media}/${encodeURIComponent(id)}.json${state.safe ? "" : "?adult=1"}`);
  } catch (err) {
    return [el("div", { class: "empty-panel" }, el("p", { text: `Could not load this title — ${err.message}` }))];
  }
  if (!data?.ok) {
    return [el("div", { class: "empty-panel" }, el("p", { text: data?.error || "This title could not be loaded." }))];
  }

  const meta = { ...data.meta, type: media };
  // The bar names the title you are on (see `renderTabs`) — its id is not its name.
  setChromeLabel(meta.name || "Untitled");
  // **A wide shot wants a wide shot.** The banner used to fall back to the poster, and
  // a 2:3 poster stretched across a 16:9 frame is the picture that came out cropped
  // and half-empty (the reported "banner poster is not fitting"). A title with no
  // backdrop now wears its **poster whole**, over a blurred copy of that same poster —
  // so the frame is full without the artwork being cut in half.
  const backdrop = backdropOf(meta);
  const poster = posterOf(meta);
  // **No line of facts under the name.** `TV-14 · 1 season · 4 episodes · 2026 · ★ 6.9
  // · Ended` repeated what the ratings row and the facts grid already say, in the one
  // place on the page that should be the name and nothing else.
  const kind = media === "series" ? "show" : "movie";
  const node = el(
    "article",
    { class: "title-page" },

    // **The banner is the home screen's banner.** The same two-column card, in the
    // same place at the top of the page: the title's own actions (Play, the pins),
    // its ratings, its overview and its genres down the left, and the wide shot in
    // the frame on the right — one treatment for the same banner.
    el(
      "header",
      { class: "hero title-hero" },
      el(
        "div",
        { class: "hero-body" },
        // **The overview leads the column**, then the actions, then the genres. What
        // the title *is* comes before the buttons that ask you to do something with
        // it. No kicker and no title here — the bar above the page already names it.
        (data.tagline || meta.description)
          ? el("section", { class: "title-row" },
              el("h3", { class: "row-head", text: "Overview" }),
              data.tagline ? el("p", { class: "title-tagline", text: data.tagline }) : null,
              meta.description ? el("p", { class: "title-overview", text: meta.description }) : null,
            )
          : null,
        el(
          "div",
          { class: "title-actions" },
          el("button", {
            class: "btn primary play-btn focusable",
            type: "button",
            id: "title-play",
            text: "▶  Play",
            // Play opens the add-on picker, so its tooltip says so.
            title: "Choose which add-on plays this title",
            // **Full screen here, while the click is still a user gesture.** The player
            // asks for it too, but by then it has awaited a round of add-on calls and
            // browsers refuse a fullscreen request outside the gesture that asked for
            // it — which is why pressing the fullscreen control worked and pressing Play
            // did not. Asking now puts the app in fullscreen *before* the picture exists,
            // where the player's own request is only a second try.
            onclick: () => {
              if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => { /* the overlay still fills the window */ });
              openSources(meta);
            },
          }),
          // **The Assistant sits with Play, not in Settings.** The one question a title
          // page cannot answer from its own metadata is "should I watch this?", so the
          // button that asks it belongs beside the button that plays it.
          el("button", {
            class: "btn focusable",
            type: "button",
            id: "title-assistant",
            text: "Ask Assistant",
            title: "Ask about this title",
            onclick: () => openAssistant({ ...meta, description: meta.description || (data.tagline || "") }),
          }),
          // **Subtitle and Quality sit with Play.** Both answer a question about
          // *this* play — which language the subtitles come in, which resolution to
          // reach for — so they belong beside the button that starts it rather than
          // three screens into Settings.
          subtitlePick(),
          qualityPick(),
          // The pin buttons live on the page now, not in a modal.
          el("div", { class: "title-pins", id: "title-pins" }, ...pinButtons(meta)),
        ),
      ),
      // **The wide shot, in the banner's own frame.** A title with no backdrop keeps
      // its poster, whole, on the frame's plate — never stretched across it.
      el(
        "div",
        { class: "hero-art title-hero-art-frame", "aria-hidden": "true" },
        backdrop
          ? el("img", { class: "title-hero-art", src: backdrop, alt: "", loading: "eager" })
          : poster
            ? el("div", { class: "title-hero-poster" },
                el("img", { src: poster, alt: "", loading: "eager" }),
              )
            : null,
      ),
    ),

    el(
      "div",
      { class: "title-body" },
      // **The ratings sit on the page's own surface, above the trailer.** They were
      // inside the banner, where the plates could not be told apart from the card
      // behind them; here they are the first row the page reads after the banner.
      // **Genres, then the ratings, then the trailer.** Both are short rows that say
      // what the title is before the trailer plays, and taking them out of the banner
      // keeps its left column — the overview and the buttons — as short as the home
      // banner's, so the artwork on the right frames the way that one does.
      data.genres.length
        ? el("div", { class: "title-row" },
            el("h3", { class: "row-head", text: "Genres" }),
            el("div", { class: "chips" }, ...data.genres.map((g) =>
              el("button", {
                class: "chip focusable",
                type: "button",
                text: g.name,
                onclick: () => go(`#/l/genre/${g.id}?type=${media}`),
              })
            )),
          )
        : null,

      ratingsRow(data.ratings, data.ratingsNote),

      trailersRow(data.trailers),

      // **Seasons and the collection sit straight under the trailer.** Both are about
      // this title's own run, so they belong before the credits rather than after the
      // facts grid.
      data.seasons.length
        ? el("section", { class: "title-row" },
            el("h3", { class: "row-head", text: "Seasons" }),
            el("div", { class: "season-grid" }, ...data.seasons.map((s) =>
              el("button", {
                class: "season-card focusable",
                type: "button",
                onclick: () => go(`#/l/season/${encodeURIComponent(id)}/${s.number}?type=${media}`),
              },
                s.poster ? el("img", { src: s.poster, alt: "", loading: "lazy" }) : el("div", { class: "poster-fallback", text: `S${s.number}` }),
                el("span", { class: "season-name", text: s.name }),
                el("span", { class: "season-sub", text: [s.year, s.episodes ? `${s.episodes} episodes` : ""].filter(Boolean).join(" · ") }),
              )
            )),
          )
        : null,

      data.collection
        ? titleStrip("Collection", `The ${data.collection.name}`, null, {
            strip: "collection",
            plainHead: true,
            onclick: () => go(`#/l/collection/${data.collection.tmdbId}?type=movie`),
          })
        : null,

      // **Creator | Director | Writer** — one row, a rule between each. They answer
      // the same question ("who made this?"), and as separate rows they read as three
      // unrelated sections.
      // **One heading — Crew — with no vertical rules.** The names carry their own
      // job, so the three labelled columns were three headings for one question.
      creditRow([["Crew", [...(data.creators || []), ...(data.directors || []), ...(data.writers || [])]]]),
      peopleRow("Cast", data.cast),

      // Production and networks, drawn as the rectangular cards Nuvio uses.
      companyCards("Production", data.companies, "company"),
      companyCards("Networks", data.networks, "network"),

      detailGrid([
        ["Status", data.status],
        // The year is a way into that year's releases rather than a dead label.
        ["Release", meta.releaseInfo, releaseYear(meta.releaseInfo) ? `#/search?period=${releaseYear(meta.releaseInfo)}&type=${media}` : ""],
        [
          kind === "show" ? "Seasons" : "Runtime",
          kind === "show" ? factsSeasons(data) : (data.runtime ? `${data.runtime} min` : ""),
          // A show's seasons open its episode screen, which is the screen they mean.
          kind === "show" && data.seasons.length ? `#/l/season/${encodeURIComponent(id)}/${data.seasons[0].number}?type=series` : "",
        ],
        ["Certification", data.certification],
        ["Origin country", data.originCountry, (data.originCountryCodes || []).length === 1 ? `#/l/country/${data.originCountryCodes[0]}?type=${media}` : ""],
        ["Original language", langName(data.originalLanguage), data.originalLanguage ? `#/search?lang=${encodeURIComponent(data.originalLanguage)}&type=${media}` : ""],
      ]),

      data.more.length ? titleStrip("More like this", null, data.more) : null,
    ),
  );

  // **Whether there is anything to play.** The Play button knows: if no add-on
  // answers with a stream, it says so on the page instead of opening a player that
  // comes up empty.
  // **No "No sources" warning on top of the hero.** It replaced the Play label and
  // printed a line under it before you had asked for anything, when a stream that is
  // slow (not missing) reads exactly like one that is absent. Pressing **Play** is
  // what asks, and it reports the answer itself.

  // The two strips that need their own request are filled once the page is drawn.
  queueMicrotask(() => {
    if (data.collection) fillStripFrom(node.querySelector(`[data-strip="collection"]`), `/list/collection/${data.collection.tmdbId}.json${listQuery("movie")}`, "This franchise has no other titles.");
  });

  return [node];
}

/** One name's own catalog, as a grid — a person's credits, a studio, a genre. */
/** An episode's own title, without the number the server prefixes it with. */
const episodeTitle = (m) => String(m.name || "").replace(/^\d+\.\s*/, "").trim() || `Episode ${m.episode || ""}`.trim();

/**
 * **The episode screen** — one season of a show, listed the way a streaming app
 * lists one.
 *
 * A season used to be drawn as a wall of poster cards with the episode number glued
 * to the front of the name, which is a catalog of stills, not an episode list. This
 * is the other thing: the show's own backdrop across a hero band with a **season
 * picker** in it, then one row per episode — its number, its still, its title, how
 * long it runs and when it aired, its synopsis, and Play.
 */
async function renderSeason(showId, seasonNumber) {
  const adult = state.safe ? "" : "?adult=1";
  let show = null;
  try {
    show = await get(`/title/series/${encodeURIComponent(showId)}.json${adult}`);
  } catch {
    /* the episode list still stands without the show's own page */
  }
  const showName = show?.meta?.name || "This show";
  const seasons = (show?.seasons || [])
    .filter((s) => Number(s.number) > 0)
    .map((s) => [String(s.number), s.name || `Season ${s.number}`]);
  const current = String(seasonNumber || seasons[0]?.[0] || "1");
  let metas = [];
  try {
    ({ metas = [] } = await get(`/list/season/${encodeURIComponent(showId)}/${encodeURIComponent(current)}.json${listQuery("series")}`));
  } catch (err) {
    return [el("div", { class: "empty-panel" }, el("p", { text: `Could not load this season — ${err.message}` }))];
  }

  const showMeta = { id: `tmdb:${showId}`, type: "series", name: showName };
  const playEpisode = (m) =>
    openSources({ ...showMeta, season: Number(current), episode: Number(m.episode || 0) });
  const label = seasons.find(([value]) => value === current)?.[1] || `Season ${current}`;

  return [
    el("article", { class: "season-page" },
      // **No backdrop banner and no way back button here.** The show's own page is one
      // tap away in the nav, and a hero above the episodes pushed the episodes down.
      // What is left is the one line that matters: which season this is, the picker
      // for the other seasons, and how many episodes it holds.
      el("header", { class: "season-head" },
        el("div", { class: "season-head-row" },
          seasons.length > 1
            ? dropdown(seasons, current, (value) => go(`#/l/season/${encodeURIComponent(showId)}/${encodeURIComponent(value)}?type=series`)).node
            : el("h1", { class: "season-title", text: label }),
          el("span", { class: "season-sub", text: `${metas.length} episode${metas.length === 1 ? "" : "s"}` }),
        ),
      ),
      metas.length
        ? el("div", { class: "ep-list" }, ...metas.map((m) =>
            el("article", { class: "ep-row" },
              el("span", { class: "ep-num", text: String(m.episode || "") }),
              // **The still is the play button.** An episode used to carry both a
              // still and a Play button beside it; clicking the picture is what
              // everyone does, so it does that now, and the whole row is one target.
              el("button", {
                class: "ep-still focusable",
                type: "button",
                title: `Play episode ${m.episode}`,
                "aria-label": `Play episode ${m.episode} — ${episodeTitle(m)}`,
                onclick: () => playEpisode(m),
              },
                m.poster
                  ? el("img", { src: m.poster, alt: "", loading: "lazy" })
                  : el("div", { class: "ep-still-empty", text: "No still" }),
                el("span", { class: "ep-play", "aria-hidden": "true", text: "▶" }),
              ),
              el("div", { class: "ep-body" },
                el("div", { class: "ep-head" },
                  el("h3", { class: "ep-title", text: episodeTitle(m) }),
                  el("span", { class: "ep-meta", text: [m.runtime ? `${m.runtime} min` : "", m.airDate || m.releaseInfo].filter(Boolean).join(" · ") }),
                ),
                m.description ? el("p", { class: "ep-overview", text: m.description }) : null,
              ),
            )
          ))
        : el("p", { class: "empty", text: "This season has no episodes listed." }),
    ),
  ];
}

async function renderList(kind, id, type, extra = "") {
  // A season is its own screen: a list of episodes, not a grid of posters.
  if (kind === "season") return renderSeason(id, extra);
  const media = type === "series" ? "series" : "movie";
  const heading = { person: "Credits", company: "From this studio", network: "On this network", genre: "In this genre", keyword: "With this tag", season: "Episodes", collection: "In this franchise" }[kind] || "Titles";

  // **The list keeps going.** These screens used to draw whatever one TMDB discover
  // page held — twenty titles — and stop, which is the "cap" on a network's or a
  // studio's titles. The server pages its discover lists now, so this reads the next
  // page when you reach the end instead of pretending that was the whole list.
  const grid = el("div", { class: "grid-titles" });
  const count = el("h2", { class: "view-title", text: `Loading ${media === "movie" ? "films" : "shows"}…` });
  const more = el("button", { class: "btn subtle focusable", type: "button", text: "Load more", id: "list-more" });
  const foot = el("div", { class: "cat-tools" }, more);
  let page = 1;
  let hasMore = true;
  let busy = false;
  const seen = new Set();
  const path = (n) => `/list/${kind}/${encodeURIComponent(id)}${extra ? `/${encodeURIComponent(extra)}` : ""}.json${listQuery(media)}${n > 1 ? `&page=${n}` : ""}`;

  const load = async () => {
    if (busy || !hasMore) return;
    busy = true;
    try {
      const data = await get(path(page));
      hasMore = Boolean(data.more);
      page += 1;
      for (const m of data.metas || []) {
        const key = `${m.type}:${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        grid.append(posterCard(m, { caption: false }));
      }
      count.textContent = `${seen.size} ${media === "movie" ? "films" : "shows"}`;
      foot.hidden = !hasMore;
      if (!seen.size) grid.append(el("p", { class: "empty", text: "Nothing here for this row." }));
    } catch (err) {
      hasMore = false;
      foot.hidden = true;
      if (!seen.size) grid.append(el("p", { class: "empty", text: `Could not load this list — ${err.message}` }));
    } finally {
      busy = false;
    }
  };
  more.addEventListener("click", load);
  await load();
  // **The list keeps loading as you reach the end.** A *Load more* button at the foot
  // makes the first page look like a ceiling — the reported "20 cap" — so the foot is
  // watched and the next page is read as it comes into view. The button stays as a
  // manual fallback for a page with no `IntersectionObserver`.
  if (typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) load();
    }, { rootMargin: "700px" });
    io.observe(foot);
  }

  return [
    el("div", { class: "sources-head" },
      el("div", {},
        el("p", { class: "hero-kicker", text: heading }),
        count,
      ),
      el("div", { class: "row-switch" },
        ...[['movie', 'Movies'], ['series', 'Shows']].map(([value, label]) =>
          el("button", {
            class: `row-btn focusable${media === value ? " active" : ""}`,
            type: "button",
            text: label,
            onclick: () => go(`#/l/${kind}/${encodeURIComponent(id)}?type=${value}`),
          })
        ),
      ),
    ),
    grid,
    foot,
  ];
}

/** The query every list request carries: the row, and the SFW switch. */
const listQuery = (type) => `?type=${encodeURIComponent(type)}${state.safe ? "" : "&adult=1"}`;

/**
 * **Ask the Assistant about this title.**
 *
 * The Ask box on the search screen does one job: it turns a sentence into a *search*.
 * A title page raises the other question — "what is this about?", "will I like it?" — and
 * that one is answered, not translated. It opens over the page the way the source picker
 * does, so nothing navigates and closing it puts you back where you were.
 */
async function openAssistant(meta) {
  const question = el("input", {
    class: "text-input focusable", type: "text", id: "assistant-question",
    placeholder: `Ask about ${meta.name || "this title"}…`,
  });
  const answer = el("p", { class: "assistant-answer", text: "" });
  const stateLine = el("p", { class: "player-note", text: "" });
  const overlay = el("div", { class: "player assistant-panel" },
    el("div", { class: "player-empty-body" },
      el("h2", { class: "assistant-title", text: `Assistant · ${meta.name || "this title"}` }),
      el("p", { class: "option-desc", text: "Ask what it is about, whether it is worth starting, or who it is for. The answer comes from the AI provider set in Settings → Assistant." }),
      el("div", { class: "source-form" }, question,
        el("button", { class: "btn primary focusable", type: "button", id: "assistant-ask", text: "Ask" }),
      ),
      // **Two questions worth pressing**, so the panel is not an empty box on the first
      // open: the two things a title page cannot tell you from its own metadata.
      el("div", { class: "assistant-suggestions" },
        ...["What is it about?", "Will I like it?"].map((q) =>
          el("button", { class: "chip focusable", type: "button", text: q, onclick: () => { question.value = q; ask(); } }),
        ),
      ),
      stateLine,
      answer,
      el("button", { class: "btn subtle focusable", type: "button", text: "Close", onclick: () => overlay.remove() }),
    ),
  );
  const ask = async () => {
    const q = question.value.trim();
    if (!q) return;
    answer.textContent = "";
    stateLine.textContent = "Asking…";
    try {
      const res = await post("/ai/about", {
        question: q,
        context: {
          name: meta.name || "",
          year: meta.releaseInfo || meta.year || "",
          type: meta.type === "series" ? "series" : "movie",
          overview: meta.description || "",
        },
      });
      if (res?.ok) { answer.textContent = res.text; stateLine.textContent = ""; }
      else stateLine.textContent = res?.text || "No answer came back.";
    } catch (err) {
      stateLine.textContent = `Could not read the answer — ${err.message}`;
    }
  };
  overlay.querySelector("#assistant-ask").addEventListener("click", ask);
  question.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(); });
  document.body.append(overlay);
  question.focus();
}

/** The pin buttons for a title — the same ones the quick-look modal draws. */
function pinButtons(item) {
  const current = state.watchlist[watchKey(item)] || "";
  // **One button per custom row.** The card can hold several rows now, so a title can go
  // into any of them — a single "Add to Custom" could only ever reach the first. Each
  // button toggles its own row, and the ones the title is already in say so.
  const rows = state.customRows?.length ? state.customRows : [{ id: CUSTOM_ROW, name: customLabel() }];
  return [
    ...rows.map((row) => {
      const on = inCustomRow(item, row.id);
      return el("button", {
        class: `btn pin focusable${on ? " active" : ""}`,
        type: "button",
        id: `pin-custom-${row.id}`,
        title: on ? `In ${row.name} — click to remove` : `Add to ${row.name}`,
        "aria-pressed": String(on),
        text: on ? `${row.name} · added` : `Add to ${row.name}`,
        onclick: () => toggleCustomRow(item, row.id),
      });
    }),
    ...PIN_STATES.map(([sid, label]) =>
      el("button", {
        class: `btn pin focusable${current === sid ? " active" : ""}`,
        type: "button",
        id: `pin-${sid}`,
        title: current === sid ? `Pinned as ${label} — click to unpin` : `Pin as ${label}`,
        "aria-pressed": String(current === sid),
        text: current === sid ? `${label} · pinned` : label,
        onclick: () => setWatchState(item, current === sid ? null : sid),
      }),
    ),
  ];
}

/** One person's card — a face, a name and what they did. Opens their credits. */
const personNode = (p) =>
  el("button", {
    class: "person focusable",
    type: "button",
    title: `${p.name} — open their credits`,
    onclick: () => go(`#/l/person/${p.tmdbId}?type=${state.row}`),
  },
    p.poster ? el("img", { class: "person-face", src: p.poster, alt: "", loading: "lazy" }) : el("span", { class: "person-face person-initials", text: initialsOf(p.name).toUpperCase() }),
    el("span", { class: "person-name", text: p.name }),
    p.role ? el("span", { class: "person-role", text: p.role }) : null,
  );

const peopleList = (people) => (people || []).filter((p) => p && p.name && p.tmdbId);

/** A row of people, each opening their own credits. */
function peopleRow(label, people) {
  const list = peopleList(people);
  if (!list.length) return null;
  return el("section", { class: "title-row" },
    el("h3", { class: "row-head", text: label }),
    el("div", { class: "people" }, ...list.map(personNode)),
  );
}

/**
 * Two credit rows in one, split by a vertical rule — Director | Writer.
 *
 * They answer the same question ("who made this?"), and two stacked rows read as
 * two unrelated sections. Both sides scroll like every other people row.
 */
/**
 * The crew: who made this, under **one** heading.
 *
 * It was three labelled sides with a rule between each — Creator | Director |
 * Writer — which read as three unrelated sections for one question. It is one row
 * now, headed **Crew**, and each name still carries its own job (Director, Writer,
 * Creator), so nothing about who did what is lost.
 */
function creditRow(groups) {
  const sides = (groups || [])
    .map(([label, list]) => [label, peopleList(list)])
    .filter(([, list]) => list.length);
  if (!sides.length) return null;
  return el("section", { class: "title-row" },
    el("div", { class: "people-duo" },
      ...sides.map(([label, list]) =>
        el("div", { class: "people-group" },
          el("h3", { class: "row-head", text: label }),
          el("div", { class: "people" }, ...list.map(personNode)),
        ),
      ),
    ),
  );
}

/**
 * Studios and networks as **rectangular cards**, the way Nuvio draws them: the logo
 * on a landscape plate with the name under it, each one opening its own catalog.
 */
function companyCards(label, list, kind) {
  const items = (list || []).filter((c) => c && c.name && c.tmdbId);
  if (!items.length) return null;
  return el("section", { class: "title-row" },
    el("h3", { class: "row-head", text: label }),
    el("div", { class: "company-strip" }, ...items.map((c) =>
      el("button", {
        class: "company-card focusable",
        type: "button",
        title: `${c.name} — open its titles`,
        onclick: () => go(`#/l/${kind}/${c.tmdbId}?type=${state.row}`),
      },
        el("span", { class: "company-logo-wrap" },
          c.logo
            ? el("img", { class: "company-logo", src: c.logo, alt: "", loading: "lazy", onerror: (e) => e.currentTarget.replaceWith(el("span", { class: "company-initials", text: initialsOf(c.name).toUpperCase() })) })
            : el("span", { class: "company-initials", text: initialsOf(c.name).toUpperCase() }),
        ),
        el("span", { class: "company-name", text: c.name }),
      )
    )),
  );
}

/** A titled row of posters — the collection, or "more like this". */
function titleStrip(label, emptyText, metas, opts = {}) {
  const strip = el("div", { class: "strip", "data-strip": opts.strip || "inline" });
  if (metas) for (const m of metas) strip.append(posterCard(m));
  else if (opts.plainHead) strip.append(el("p", { class: "strip-note", text: emptyText || "" }));
  else strip.append(el("p", { class: "empty", text: emptyText && !opts.onclick ? emptyText : "Loading…" }));
  // A heading with somewhere to go is a button, so the whole collection is one
  // click from the row that names it — **unless the row asked for a plain head**:
  // on the title page a heading that wears the accent and grows a `›` reads as a
  // link in the middle of rows that are all labels, so that row is a plain heading
  // and a plain line under it, and the line is the way in.
  const head = opts.onclick && !opts.plainHead
    ? el("button", { class: "row-head row-head-link focusable", type: "button", text: `${label} ›`, onclick: opts.onclick })
    : el("h3", { class: "row-head", text: label });
  if (opts.plainHead && opts.onclick) {
    strip.classList.add("strip-clickable");
    strip.addEventListener("click", opts.onclick);
  }
  return el("section", { class: "title-row" }, head, strip);
}

/** `2 seasons · 24 episodes` — what a show's "runtime" slot carries. */
function factsSeasons(data) {
  const parts = [];
  if (data.seasonsCount) parts.push(`${data.seasonsCount} season${data.seasonsCount === 1 ? "" : "s"}`);
  if (data.episodesCount) parts.push(`${data.episodesCount} episodes`);
  return parts.join(" · ");
}

/** The four-digit year out of a release line (`2019-05-01` or `2019`). */
const releaseYear = (value) => String(value || "").match(/\d{4}/)?.[0] || "";

/** `en` → `English`, so the details row reads as a name and not a code. */
function langName(code) {
  const value = String(code || "").trim();
  if (!value) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(value) || value.toUpperCase();
  } catch {
    return value.toUpperCase();
  }
}

/**
 * The facts a streaming app puts in a row: status, release, runtime, where and in
 * what language.
 *
 * **One fact per line, the label at the left edge and its value at the far right**
 * — it was a two-column list squeezed against the left, which is what "so compact"
 * and "left sided" kept being about, and a value that could be clicked belonged on
 * the right hand edge, not tucked against its label.
 *
 * `href` (optional) makes the value a way into its own list — the year opens that
 * year's releases, the country its own rows, the language every title made in it,
 * the seasons their episode screen — the same way a name on the page is.
 */
/**
 * The facts a streaming app puts in a row: status, release, runtime, where and in
 * what language.
 *
 * **A fact is not a link.** The values were clickable for a while (the year opened
 * that year's releases, the language every title made in it); on this page that read
 * as text you could not trust to be text, so they are plain again — the label at the
 * left edge, the value at the far right, one fact per line.
 */
function detailGrid(items) {
  const rows = items.filter(([, value]) => value);
  if (!rows.length) return null;
  return el("section", { class: "title-row" },
    el("h3", { class: "row-head", text: "Details" }),
    el("dl", { class: "detail-grid" }, ...rows.map(([label, value]) =>
      el("div", { class: "detail-row" },
        el("dt", { class: "detail-label", text: label }),
        el("dd", { class: "detail-value" }, el("span", { class: "detail-plain", text: String(value) })),
      )
    )),
  );
}

/** Trailers, each one opening on YouTube. */
function trailersRow(trailers) {
  const list = (trailers || []).filter((t) => t && t.key);
  if (!list.length) return null;
  return el("section", { class: "title-row" },
    el("h3", { class: "row-head", text: "Trailers" }),
    el("div", { class: "trailer-grid" }, ...list.map((t) =>
      el("button", {
        class: "trailer-card focusable",
        type: "button",
        title: `${t.name} — play in the app`,
        onclick: () => openTrailer(t),
      },
        el("img", { class: "trailer-thumb", src: `https://img.youtube.com/vi/${t.key}/hqdefault.jpg`, alt: "", loading: "lazy" }),
        el("span", { class: "trailer-name", text: t.name }),
        el("span", { class: "trailer-kind", text: t.type }),
      )
    )),
  );
}

/**
 * **The trailer plays in the app.**
 *
 * A trailer card used to hand the clip to a browser tab, which left the app, lost the
 * fullscreen it was in and came back to a page that had scrolled. A floating overlay
 * keeps it here: the same 16:9 frame, one Close button, Escape or a click on the
 * backdrop to leave. The YouTube player is the no-cookie embed, and the clip is only
 * requested when a card is pressed — nothing loads for a page that is merely open.
 */
function openTrailer(t) {
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const overlay = el("div", { class: "trailer-overlay", role: "dialog", "aria-modal": "true", "aria-label": `${t.name} trailer` },
    el("div", { class: "trailer-shell" },
      el("div", { class: "trailer-bar" },
        el("span", { class: "trailer-heading", text: t.name || "Trailer" }),
        el("button", { class: "btn subtle focusable", type: "button", text: "Close", onclick: close }),
      ),
      el("div", { class: "trailer-frame" },
        el("iframe", {
          src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(t.key)}?autoplay=1&rel=0&modestbranding=1`,
          title: t.name || "Trailer",
          allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
          allowfullscreen: true,
        }),
      ),
    ),
  );
  // A press on the backdrop — never on the frame — is the other way out.
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
}

/**
 * Ratings, one plate per service that answered.
 *
 * `note` is the server's explanation when the extra services could not be asked
 * (no key, or the provider's daily limit is spent). It is drawn whether or not any
 * plate is — a row that quietly holds only TMDB is what made "why is it only TMDB?"
 * a fair question rather than something the page answered.
 */
function ratingsRow(ratings, note) {
  const list = (ratings || []).filter((r) => r && r.value);
  if (!list.length && !note) return null;
  return el("section", { class: "title-row" },
    el("h3", { class: "row-head", text: "Ratings" }),
    list.length
      ? el("div", { class: "ratings" }, ...list.map((r) =>
          el("div", { class: "rating" },
            el("span", { class: "rating-value", text: String(r.value) }),
            el("span", { class: "rating-source", text: r.label || r.source }),
          )
        ))
      : null,
    note ? el("p", { class: "title-source-note", text: note }) : null,
  );
}

/** Fill a strip that needed its own request. */
async function fillStripFrom(strip, url, emptyText) {
  if (!strip) return;
  try {
    const { metas = [] } = await get(url);
    strip.replaceChildren();
    if (!metas.length) strip.append(el("p", { class: "empty", text: emptyText }));
    else for (const m of metas) strip.append(posterCard(m));
  } catch (err) {
    strip.replaceChildren(el("p", { class: "empty", text: `Could not load — ${err.message}` }));
  }
}

/* ----------------------------------------------------------------- settings */

function toggleRow(checked, title, desc, onchange) {
  return el("label", { class: "option focusable", tabindex: "0" },
    el("input", { type: "checkbox", checked, onchange }),
    el("span", { class: "option-body" },
      el("span", { class: "option-title", text: title }),
      desc ? el("span", { class: "option-desc", text: desc }) : null,
    ),
  );
}

function radioRow(checked, name, title, desc, onchange) {
  return el("label", { class: "option focusable", tabindex: "0" },
    el("input", { type: "radio", name, checked, onchange }),
    el("span", { class: "option-body" },
      el("span", { class: "option-title", text: title }),
      desc ? el("span", { class: "option-desc", text: desc }) : null,
    ),
  );
}

async function verifyKey(name, store, keyName, path = "/providers/verify") {
  const entry = store[name] || (store[name] = {});
  entry.status = { ok: false, text: "Checking…" };
  writeJSON(keyName, store);
  render();
  try {
    entry.status = (await post(path, { name })) || { ok: false, text: "no response" };
  } catch (err) {
    entry.status = { ok: false, text: `could not reach the server — ${err.message}` };
  }
  writeJSON(keyName, store);
  render();
}

function keyRow(group, name, label, desc, store, keyName, verifyPath = "/providers/verify") {
  const entry = store[name] || (store[name] = {});
  const input = el("input", {
    class: "text-input focusable",
    type: "password",
    placeholder: entry.hasKey ? "•••••••• (set — paste a new key to replace)" : "Paste API key…",
    id: `${group}-${name}-key`,
  });
  const save = el("button", {
    class: "btn primary focusable",
    type: "button",
    text: entry.hasKey ? "Replace key" : "Save key",
    onclick: async () => {
      const key = input.value.trim();
      if (!key) return;
      store[name] = { ...entry, enabled: true, hasKey: true };
      writeJSON(keyName, store);
      await pushSettings({ [group]: { [name]: { enabled: true, key } } });
      input.value = "";
      await verifyKey(name, store, keyName, verifyPath);
    },
  });
  const clear = entry.hasKey
    ? el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Remove key",
        onclick: async () => {
          store[name] = { ...entry, enabled: false, hasKey: false };
          writeJSON(keyName, store);
          await pushSettings({ [group]: { [name]: { enabled: false, key: "" } } });
          render();
        },
      })
    : null;

  return el("div", { class: "provider" },
    el("div", { class: "provider-head" },
      el("div", {},
        el("span", { class: "option-title", text: label }),
        el("span", { class: `badge ${entry.enabled && entry.hasKey ? "on" : "off"}`, text: entry.hasKey ? (entry.enabled ? "enabled" : "key set · off") : "no key" }),
      ),
      el("label", { class: "switch" },
        el("input", {
          type: "checkbox",
          checked: Boolean(entry.enabled),
          onchange: (e) => {
            store[name] = { ...store[name], enabled: e.target.checked };
            writeJSON(keyName, store);
            pushSettings({ [group]: { [name]: { enabled: e.target.checked } } });
            render();
          },
        }),
        el("span", { class: "slider" }),
      ),
    ),
    el("p", { class: "option-desc", text: desc }),
    el("div", { class: "source-form" }, input, save, clear),
    entry.hasKey
      ? el("div", { class: "provider-check" },
          el("button", { class: "btn subtle focusable", type: "button", text: "Check connection", onclick: () => verifyKey(name, store, keyName, verifyPath) }),
          entry.status ? el("span", { class: `source-status ${entry.status.ok ? "ok" : "bad"}`, text: entry.status.text }) : null,
        )
      : null,
  );
}

/**
 * Settings → Debrid.
 *
 * This pane exists because of a failure that had no explanation on screen: a torrent
 * stream whose swarm a browser cannot join just sits at "looking for peers…". The
 * account is the fix, so the pane says what it is for before it asks for a key.
 */
function paneDebrid() {
  const active = debridActive();
  return [
    el("p", { class: "option-desc", text: "A torrent stream has no web address of its own — the add-on publishes an info hash, and the file lives in a swarm. A browser can only reach swarm peers that speak WebRTC, which is why a torrent without a debrid account usually never starts. A debrid service fetches the torrent on its own servers and hands back a direct link, so it plays like any other stream." }),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Services" }),
      el("span", { class: "option-desc", text: active ? `Enabled services are tried in order; the first one that answers serves the stream. Right now: ${active[1]}.` : "Enable one and it takes over the torrent streams automatically. Paste a key, then press Check connection." }),
    ),
    ...DEBRID_SERVICES.map(([name, label, desc]) => keyRow("debrid", name, label, desc, state.debrid, KEY.debrid, "/debrid/verify")),
    el("p", { class: "option-desc", text: "Cached torrents resolve in seconds. A torrent nobody has cached yet has to download on the service first — the player says so, and pressing Play again in a minute usually just works." }),
  ];
}

/**
 * Settings → Subtitles.
 *
 * The player's Audio & subtitles panel lists the tracks a stream **carries**, and a
 * great many streams carry none — or carry one language and not the one you read.
 * This pane is the catalogue those gaps are filled from. OpenSubtitles needs a key to
 * look anything up at all, and its *download* step is the part that wants a signed-in
 * account: a search works with the key alone, a download does not (a signed-out
 * request gets a small daily quota and then stops). Both halves live here, and neither
 * is ever sent back to the page — only whether one is set.
 */
function paneSubtitles() {
  const store = state.subtitles || (state.subtitles = {});
  const os = store.opensubtitles || (store.opensubtitles = { enabled: false, hasKey: false, hasLogin: false });

  const keyInput = el("input", {
    class: "text-input focusable",
    type: "password",
    id: "opensubtitles-key",
    placeholder: os.hasKey ? "•••••••• (set — paste a new key to replace)" : "Paste your OpenSubtitles API key…",
  });
  const userInput = el("input", {
    class: "text-input focusable",
    type: "text",
    id: "opensubtitles-username",
    placeholder: os.hasLogin ? "Username (set)" : "Username",
  });
  const passInput = el("input", {
    class: "text-input focusable",
    type: "password",
    id: "opensubtitles-password",
    placeholder: os.hasLogin ? "•••••••• (set)" : "Password",
  });

  const save = el("button", {
    class: "btn primary focusable",
    type: "button",
    text: os.hasKey ? "Save changes" : "Save key",
    onclick: async () => {
      const patch = {};
      if (keyInput.value.trim()) patch.key = keyInput.value.trim();
      if (userInput.value.trim()) patch.username = userInput.value.trim();
      if (passInput.value.trim()) patch.password = passInput.value.trim();
      if (!Object.keys(patch).length) return;
      // Pasting a key is switching it on, exactly as it is for every other provider.
      patch.enabled = true;
      await pushSettings({ subtitles: { opensubtitles: patch } });
      keyInput.value = "";
      userInput.value = "";
      passInput.value = "";
      await checkSubtitles();
    },
  });
  const clear = os.hasKey
    ? el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Remove key",
        onclick: async () => {
          os.enabled = false;
          os.hasKey = false;
          os.hasLogin = false;
          os.status = null;
          writeJSON(KEY.subtitles, store);
          await pushSettings({ subtitles: { opensubtitles: { enabled: false, key: "", username: "", password: "" } } });
          render();
        },
      })
    : null;

  const languages = [["", `Follow the app's language (${String(state.language || "en-US").slice(0, 2)})`], ...(state.options.subtitleLanguages || [])];
  const picker = dropdown(languages, store.language || "", (value) => {
    store.language = value;
    writeJSON(KEY.subtitles, store);
    pushSettings({ subtitles: { language: value } });
    render();
  });

  const active = subtitleActive();

  return [
    el("p", {
      class: "option-desc",
      text: "A stream's own subtitle tracks are listed in the player. When it carries none — or carries one language and not yours — the player searches the services enabled below and plays the one you pick like any other subtitle. Each needs its own free key; the more you enable, the more titles are covered.",
    }),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Services" }),
      el("span", {
        class: "option-desc",
        text: active.length
          ? `Searched together, in the order below. Right now: ${active.join(", ")}.`
          : "Enable one and paste its key — the player has nothing to offer until then but what the stream already carries.",
      }),
    ),
    el("div", { class: "provider" },
      el("div", { class: "provider-head" },
        el("div", {},
          el("span", { class: "option-title", text: "OpenSubtitles" }),
          el("span", {
            class: `badge ${os.enabled && os.hasKey ? "on" : "off"}`,
            text: !os.hasKey ? "no key" : !os.enabled ? "key set · off" : os.hasLogin ? "enabled · signed in" : "enabled · search only",
          }),
        ),
        el("label", { class: "switch" },
          el("input", {
            type: "checkbox",
            checked: Boolean(os.enabled),
            onchange: (e) => {
              os.enabled = e.target.checked;
              writeJSON(KEY.subtitles, store);
              pushSettings({ subtitles: { opensubtitles: { enabled: e.target.checked } } });
              render();
            },
          }),
          el("span", { class: "slider" }),
        ),
      ),
      el("p", {
        class: "option-desc",
        text: "The widest catalogue of the four, and the only one whose downloads want a signed-in account. The API key is free and is what searches it.",
      }),
      el("div", { class: "source-form" }, keyInput, save, clear),
      el("p", {
        class: "option-desc",
        text: "A signed-in account is what downloads them. Without one OpenSubtitles allows a small daily quota of anonymous downloads per IP and then stops; with one the quota is your account's own, which is the limit a player runs into second. Searching works without it.",
      }),
      el("div", { class: "source-form" }, userInput, passInput),
      os.hasKey
        ? el("div", { class: "provider-check" },
            el("button", { class: "btn subtle focusable", type: "button", text: "Check connection", onclick: () => checkSubtitles() }),
            os.status ? el("span", { class: `source-status ${os.status.ok ? "ok" : "bad"}`, text: os.status.text }) : null,
          )
        : null,
    ),
    // The rest are key-only, so the shared provider row draws them.
    ...SUBTITLE_SERVICES.map(([name, label, desc]) => keyRow("subtitles", name, label, desc, store, KEY.subtitles, "/subtitles/verify")),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Language" }),
      el("span", { class: "option-desc", text: "Which language the player asks for. It follows what the app is browsed in until you pick one here." }),
    ),
    el("div", { class: "source-form" }, picker.node),
  ];
}

/**
 * Settings → DNS.
 *
 * One switch, one resolver, and it applies to the whole app: every request the server
 * makes goes through `addon/net.mjs`, which reads this setting on each call. The pane says
 * what that means rather than assuming it is obvious, and the Test button resolves the
 * same name both ways so the answer is a pair of addresses rather than a claim.
 */
function paneDns() {
  const dns = state.dns || (state.dns = {});
  const presets = dns.presets?.length
    ? dns.presets
    : [
        { name: "None", servers: [] },
        { name: "Google", servers: ["8.8.8.8", "8.8.4.4"] },
        { name: "Cloudflare", servers: ["1.1.1.1", "1.0.0.1"] },
        { name: "AdGuard", servers: ["94.140.14.14", "94.140.15.15"] },
        { name: "Quad9", servers: ["9.9.9.9", "149.112.112.112"] },
        { name: "OpenDNS", servers: ["208.67.222.222", "208.67.220.220"] },
        { name: "Custom", servers: [] },
      ];

  const primaryInput = el("input", { class: "text-input focusable", type: "text", id: "dns-primary", placeholder: "8.8.8.8", value: dns.primary || "" });
  const secondaryInput = el("input", { class: "text-input focusable", type: "text", id: "dns-secondary", placeholder: "8.8.4.4", value: dns.secondary || "" });
  const status = el("span", { class: `source-status ${dns.status?.ok ? "ok" : dns.status ? "bad" : ""}`, text: dns.status?.text || "" });

  const enabledSwitch = el("input", {
    type: "checkbox",
    id: "dns-enabled",
    checked: Boolean(dns.enabled),
    onchange: (e) => {
      dns.enabled = e.target.checked;
      saveDns({ enabled: e.target.checked });
    },
  });

  const picker = dropdown(
    presets.map((p) => [p.name, p.name]),
    dns.provider || "Cloudflare",
    (value) => {
      const preset = presets.find((p) => p.name === value);
      dns.provider = value;
      if (preset?.servers.length) {
        dns.primary = preset.servers[0];
        dns.secondary = preset.servers[1] || "";
        primaryInput.value = dns.primary;
        secondaryInput.value = dns.secondary;
      } else if (value === "None") {
        // **None means the machine's own resolver**, so the override goes off with it —
        // otherwise the switch stayed on with the last pair of addresses still in the
        // boxes, and the app kept asking a resolver the user had just said no to.
        dns.primary = "";
        dns.secondary = "";
        primaryInput.value = "";
        secondaryInput.value = "";
        dns.enabled = false;
        enabledSwitch.checked = false;
      }
      saveDns({ provider: value, primary: dns.primary, secondary: dns.secondary, enabled: dns.enabled });
    },
  );

  return [
    el("p", {
      class: "option-desc",
      text: "Which resolver every request in this app asks. It changes how a domain turns into an address — nothing else. It is not a VPN and it does not hide anything.",
    }),
    el("div", { class: "provider" },
      el("div", { class: "provider-head" },
        el("div", {},
          el("span", { class: "option-title", text: "Override System DNS" }),
          el("span", { class: `badge ${dns.enabled ? "on" : "off"}`, text: dns.enabled ? `on · ${(dns.servers || []).join(", ") || "no servers"}` : "off" }),
        ),
        el("label", { class: "switch" }, enabledSwitch, el("span", { class: "slider" })),
      ),
      el("p", { class: "option-desc", text: "Off is the machine's own resolver. On, the app asks the resolver below and only this app is affected." }),
    ),
    el("div", { class: "group-head" }, el("span", { class: "option-title", text: "Resolver" })),
    el("div", { class: "source-form" }, picker.node),
    el("div", { class: "source-form" }, primaryInput, secondaryInput),
    el("p", { class: "option-desc", text: "The two addresses are IPv4 or IPv6. A preset fills them in; Custom uses what you type." }),
    el("div", { class: "source-form" },
      el("button", { class: "btn primary focusable", type: "button", text: "Save", onclick: () => saveDns({ primary: primaryInput.value.trim(), secondary: secondaryInput.value.trim() }) }),
      el("button", { class: "btn subtle focusable", type: "button", id: "dns-test", text: "Test DNS", onclick: () => testDnsNow(status) }),
      status,
    ),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "What it applies to" }),
      el("span", { class: "option-desc", text: "Everything the server requests, because they all fetch through the same door." }),
    ),
    el("p", {
      class: "option-desc",
      text: "Metadata (TMDB, TVDB, MDBList, the trackers, posters), the AI providers, Stremio add-ons, subtitles, debrid APIs, Custom Websites, every scraper tier, the stream proxy, and catalog and stream fetches. The embedded player is a separate process and keeps the system resolver.",
    }),
    el("p", { class: "option-desc", text: "DNS changes how domains resolve." }),
  ];
}

async function saveDns(patch) {
  const dns = state.dns || (state.dns = {});
  dns.status = { ok: false, text: "Saving…" };
  render();
  try {
    const res = await post("/dns", { ...patch, enabled: dns.enabled });
    if (res?.dns) state.dns = { ...state.dns, ...res.dns };
    state.dns.status = { ok: true, text: res?.message || "Saved." };
  } catch (err) {
    state.dns.status = { ok: false, text: `Could not save — ${err.message}` };
  }
  writeJSON(KEY.dns, state.dns);
  render();
}

async function testDnsNow(target) {
  target.className = "source-status";
  target.textContent = "Resolving…";
  try {
    const res = await post("/dns/test", { host: "google.com" });
    target.className = `source-status ${res?.ok ? "ok" : "bad"}`;
    target.textContent = res?.message || "no answer";
  } catch (err) {
    target.className = "source-status bad";
    target.textContent = `Could not test — ${err.message}`;
  }
}

/**
 * Settings → Custom Websites.
 *
 * The sites you watch that no add-on covers: added once, searched automatically when Play
 * is pressed. What is stored is the site, its search pattern and its category — never the
 * streams, which are re-extracted every time because a stream URL expires.
 */
function paneCustomSites() {
  const store = state.customSites || (state.customSites = { categories: [], repositories: [] });
  // **One list of sites, not a box per kind of title.** The pane used to draw six boxes —
  // Movies, Series, Anime, … — each with its own add field, so adding a site meant choosing
  // its kind before you had pasted it, and "which sites do I have?" was answered by six
  // lists. There is one URL box now, and a site wears its tags on its own row.
  const sites = store.sites?.length ? store.sites : flatSites(store.categories);
  const tags = store.tags?.length ? store.tags : CATEGORY_LABELS.map(([key, label]) => ({ key, label }));

  const addInput = el("input", {
    class: "text-input focusable", type: "text", id: "site-url",
    placeholder: "https://site.example/",
  });
  const addBtn = el("button", {
    class: "btn primary focusable", type: "button", id: "site-add", text: "Add site",
    onclick: () => addCustomSite(addInput),
  });
  addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
  const note = el("p", {
    class: `option-desc${store.websiteNote ? (store.websiteNote.ok ? " ok" : " bad") : ""}`,
    id: "site-note",
    text: store.websiteNote?.text || "",
  });

  const repoInput = el("input", { class: "text-input focusable", type: "text", id: "repo-url", placeholder: "https://…/repository.json" });
  const savedRepo = store.repoNote;
  const repoNote = el("p", {
    class: `option-desc${savedRepo ? (savedRepo.ok ? " ok" : savedRepo.text ? " bad" : "") : ""}`,
    id: "repo-note",
    text: savedRepo?.text || "",
  });
  const repoList = (store.repositories || []).map((r) =>
    el("div", { class: "site-row" },
      el("div", { class: "site-body" },
        el("span", { class: "site-domain", text: r.name || r.url }),
        el("span", { class: "site-pattern", text: `${r.count || 0} sites · ${r.url}` }),
      ),
      el("button", { class: "btn subtle focusable", type: "button", text: "Remove", onclick: () => removeRepository(r.url) }),
    ),
  );

  return [
    el("p", {
      class: "option-desc",
      text: "Sites the add-ons do not cover. Paste one URL and it is searched every time you press Play — the best-matching result page is read and what it holds is added to the Sources list, tagged with the site's own domain. Only the site, its search pattern and its tags are kept; the streams themselves are never stored, because a stream URL expires and would only be a dead link tomorrow. Tag a site so a film site is not searched for a series.",
    }),
    el("div", { class: "source-form" }, addInput, addBtn),
    note,
    sites.length
      ? el("div", { class: "site-list" }, ...sites.map((site) => siteRow(site, tags)))
      : el("p", { class: "option-desc", text: "No sites added yet." }),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Repositories" }),
      el("span", { class: "option-desc", text: "A repository is a JSON list of sites: { name, websites: [{ url, category }] }." }),
    ),
    ...(repoList.length ? repoList : [el("p", { class: "option-desc", text: "No repositories added." })]),
    el("div", { class: "source-form" }, repoInput,
      el("button", { class: "btn primary focusable", type: "button", id: "repo-add", text: "Add Repository", onclick: () => addRepo(repoInput) }),
    ),
    repoNote,
  ];
}

/** The flat list the pane draws, from either the server's answer or an older cached one. */
function flatSites(categories = []) {
  const out = [];
  const seen = new Set();
  for (const cat of categories) {
    for (const site of cat.sites || []) {
      if (seen.has(site.url)) continue;
      seen.add(site.url);
      out.push({ ...site, categories: site.categories?.length ? site.categories : [cat.key] });
    }
  }
  return out;
}

/** The tag a site wears, and the word for a site that wears none. */
const tagLabel = (key) => (CATEGORY_LABELS.find(([k]) => k === key) || [key, key])[1];

/**
 * One added site: its domain, its search pattern, **its tags**, and edit/delete.
 *
 * The tags are the row's own control: pressing one adds or removes it, and the site is
 * saved with what is left. `Other` is how a site says "search me for anything" — that is
 * what a site has until it is tagged, so a URL pasted into the box above works on the very
 * next Play.
 */
function siteRow(site, tags) {
  const domain = el("span", { class: "site-domain", text: site.domain });
  const pattern = el("span", { class: "site-pattern", text: site.searchPattern ? `${site.searchPattern.action} · ${site.searchPattern.input}` : "no search pattern" });
  const worn = site.categories?.length ? site.categories : ["other"];
  const tagRow = el("div", { class: "site-tags" },
    ...tags.map((tag) => el("button", {
      class: `tag focusable${worn.includes(tag.key) ? " on" : ""}`,
      type: "button",
      title: worn.includes(tag.key) ? `${tag.label} — press to remove this tag` : `Also search this site for ${tag.label}`,
      text: tag.label,
      onclick: () => setSiteTags(site, worn.includes(tag.key) ? worn.filter((k) => k !== tag.key) : [...worn, tag.key]),
    })),
  );
  const body = el("div", { class: "site-body" }, domain, pattern, tagRow);

  // **Editing replaces the row's actions, it does not join them.** Pressing Edit used to
  // open the editor *over the details* while Edit and Delete stayed on the row beside the
  // new Save and Cancel — four buttons for one row, two of them the action you had just
  // taken. The row now hands its action slot over: Edit/Delete go, Save/Cancel arrive, and
  // Cancel puts them back.
  const actions = el("div", { class: "site-actions" });
  const restore = () => {
    actions.replaceChildren(
      el("button", { class: "btn subtle focusable", type: "button", text: "Edit", onclick: startEdit }),
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Delete",
        onclick: async () => {
          const res = await post("/custom-sites/remove", { url: site.url });
          if (res?.sites) refreshCustomSites(res.sites);
          render();
        },
      }),
    );
  };
  const startEdit = () => {
    const urlInput = el("input", { class: "text-input focusable", type: "text", value: site.url });
    const sampleInput = el("input", { class: "text-input focusable", type: "text", placeholder: "a sample search URL (…/search?q=title)" });
    const msg = el("p", { class: "option-desc", text: "" });
    const save = async () => {
      const patch = { url: urlInput.value.trim() };
      if (sampleInput.value.trim()) {
        const res = await post("/custom-sites/pattern", { sample: sampleInput.value.trim(), title: domain.textContent, url: patch.url, category: worn[0] });
        if (res?.pattern) patch.searchPattern = res.pattern;
        else msg.textContent = res?.message || "That sample URL had no query to copy.";
      }
      const res = await post("/custom-sites/update", { url: site.url, category: worn[0], patch });
      if (res?.sites) refreshCustomSites(res.sites);
      render();
    };
    body.replaceChildren(
      el("div", { class: "site-edit" }, urlInput, sampleInput, msg),
    );
    actions.replaceChildren(
      el("button", { class: "btn primary focusable", type: "button", text: "Save", onclick: save }),
      el("button", { class: "btn subtle focusable", type: "button", text: "Cancel", onclick: () => render() }),
    );
    urlInput.focus();
  };
  restore();
  return el("div", { class: "site-row" }, body, actions);
}

/** Retag one site: the server owns the store, the answer is the whole list. */
async function setSiteTags(site, categories) {
  const res = await post("/custom-sites/update", { url: site.url, category: categories[0] || "other", patch: { categories } });
  if (res?.sites) refreshCustomSites(res.sites);
  render();
}

// **The tags a site can wear.** `Live TV` is what the anime tag used to be: a site that
// carries channels rather than a catalogue is the thing people actually add, and `other`
// is still the tag every search includes.
const CATEGORY_LABELS = [["movies", "Movies"], ["series", "Series"], ["documentary", "Documentary"], ["sports", "Sports"], ["livetv", "Live TV"], ["other", "Other"]];

/** The server's per-category map into the pane's list shape. */
const categoriesToState = (sites) =>
  CATEGORY_LABELS.map(([key, label]) => ({ key, label, sites: sites[key] || [] }));

/** The add box's own message, on the state for the same reason the repo note is. */
function setWebsiteNote(text, ok = false) {
  const store = state.customSites || (state.customSites = { categories: [], repositories: [] });
  store.websiteNote = { text, ok };
  writeJSON(KEY.customSites, store);
  const node = document.querySelector("#site-note");
  if (node) {
    node.className = `option-desc${ok ? " ok" : text ? " bad" : ""}`;
    node.textContent = text;
  }
}

/**
 * Add the site in the box.
 *
 * **No tag is asked for here.** The site is added as `Other`, which every search includes,
 * so pressing Play after pasting one works immediately — and the row it lands on is where
 * it gets tagged (Movies, Anime, …).
 */
async function addCustomSite(input) {
  const url = input.value.trim();
  if (!url) {
    setWebsiteNote("Paste a site URL first.");
    return;
  }
  setWebsiteNote("Reading the site's search form…");
  const res = await post("/custom-sites/add", { url });
  if (res?.sites) refreshCustomSites(res.sites);
  if (!res?.ok && res?.needPattern) {
    // **No search box in the markup.** Inventing one returns nothing, so the user is asked
    // for a real search URL instead — from which the pattern is copied exactly.
    setWebsiteNote(`${res.message || "The search form could not be read."} Open the site, search for anything, and paste that URL in the field below.`);
    const note = document.querySelector("#site-note");
    const sample = el("input", { class: "text-input focusable", type: "text", placeholder: "https://site.example/search?q=anything" });
    const done = el("button", {
      class: "btn primary focusable",
      type: "button",
      text: "Use this URL",
      onclick: async () => {
        const got = await post("/custom-sites/pattern", { sample: sample.value.trim(), title: "", url });
        if (got?.sites) refreshCustomSites(got.sites);
        setWebsiteNote(got?.ok ? got?.message || "The search pattern was saved." : got?.message || "That URL has no query parameters.", got?.ok === true);
        render();
      },
    });
    note?.after(el("div", { class: "source-form" }, sample, done));
    return;
  }
  setWebsiteNote(res?.message || (res?.ok ? "Added." : "Could not add that site."), res?.ok === true);
  if (res?.ok) input.value = "";
  render();
}

function refreshCustomSites(sites) {
  // The stored notes and the repository list are kept: they are not part of the site
  // list the server just answered with.
  const categories = categoriesToState(sites);
  state.customSites = {
    ...state.customSites,
    categories,
    // **The flat list the pane draws**, built from the same answer, so a tag pressed on a
    // row is on screen the moment the server has stored it.
    sites: flatSites(categories),
    repositories: state.customSites.repositories || [],
  };
  writeJSON(KEY.customSites, state.customSites);
}

/** The repository row's message, kept on the state for the same reason as a site's. */
function setRepoNote(text, ok = false) {
  const store = state.customSites || (state.customSites = { categories: [], repositories: [] });
  store.repoNote = { text, ok };
  writeJSON(KEY.customSites, store);
  const node = document.querySelector("#repo-note");
  if (node) {
    node.className = `option-desc${ok ? " ok" : text ? " bad" : ""}`;
    node.textContent = text;
  }
}

async function addRepo(input) {
  const url = input.value.trim();
  if (!url) {
    setRepoNote("Paste the repository's JSON URL first.");
    return;
  }
  setRepoNote("Reading the repository…");
  const res = await post("/custom-sites/repositories", { url });
  if (res?.sites) refreshCustomSites(res.sites);
  if (res?.repositories) {
    state.customSites.repositories = res.repositories;
    writeJSON(KEY.customSites, state.customSites);
  }
  setRepoNote(res?.message || (res?.ok ? "Added." : "Could not read that repository."), res?.ok === true);
  render();
}

async function removeRepository(url) {
  const res = await post("/custom-sites/repositories/remove", { url });
  if (res?.sites) refreshCustomSites(res.sites);
  if (res?.repositories) {
    state.customSites.repositories = res.repositories;
    writeJSON(KEY.customSites, state.customSites);
  }
  setRepoNote(res?.message || "The repository was removed.", res?.ok === true);
  render();
}

/**
 * Ask the server whether the OpenSubtitles setup actually works.
 *
 * The check is a **real search**, not a ping: a key that answers a ping and fails the
 * search it exists for has told the user nothing.
 */
async function checkSubtitles() {
  const os = state.subtitles?.opensubtitles;
  if (!os) return;
  os.status = { ok: false, text: "Checking…" };
  writeJSON(KEY.subtitles, state.subtitles);
  render();
  try {
    os.status = (await post("/subtitles/verify", { name: "opensubtitles" })) || { ok: false, text: "no response" };
  } catch (err) {
    os.status = { ok: false, text: `could not reach the server — ${err.message}` };
  }
  writeJSON(KEY.subtitles, state.subtitles);
  render();
}

function aiAskRow() {
  const input = el("input", { class: "text-input focusable", type: "text", placeholder: "Tell me what to watch…", id: "ai-ask" });
  const mic = el("button", { class: "btn focusable", type: "button", text: "🎙 Voice", onclick: () => startVoice(input) });
  const send = el("button", {
    class: "btn primary focusable",
    type: "button",
    text: "Ask",
    onclick: () => {
      const q = input.value.trim();
      if (q) aiIntent(q);
    },
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send.click();
  });
  // The box says whether an AI is actually behind it, so "Ask did nothing" has an
  // answer on screen instead of being something you have to guess from the result.
  const aiReady = Boolean(state.ai?.enabled !== false && (state.ai?.ready || state.ai?.provider));
  return el("div", { class: "ai-ask" },
    el("p", {
      class: "option-desc",
      text: aiReady
        ? "The assistant turns your words into a search."
        : "No AI provider is connected yet, so these words are searched as they are. Paste a key above to let the assistant read them.",
    }),
    el("div", { class: "ai-ask-form" }, input, mic, send),
  );
}

function startVoice(input) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    input.placeholder = "Voice isn't available in this build — type instead.";
    return;
  }
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.onresult = (e) => {
    const said = e.results?.[0]?.[0]?.transcript ?? "";
    if (said) {
      input.value = said;
      aiIntent(said);
    }
  };
  rec.onerror = () => {
    input.placeholder = "Couldn't hear that — type instead.";
  };
  try {
    rec.start();
  } catch {
    const text = prompt("What do you want to watch?");
    if (text) aiIntent(text);
  }
}

/**
 * The Ask box. With a provider and a key it asks the model to turn the sentence
 * into a search query; without one — or if the provider is unreachable — the
 * typed words are searched as-is, so the box still works with no AI configured.
 */
async function aiIntent(text, picked) {
  const q = String(text || "").trim();
  if (!q) return;
  // "Pick for me" narrows the search to one row: the assistant is asked for a
  // film, and the answer must not come back as a series (or the reverse).
  const side = picked ?? (state.ai?.pickRow === "movie" || state.ai?.pickRow === "series" ? state.ai.pickRow : "");
  const to = (query) => {
    const p = new URLSearchParams({ q: query });
    if (side) p.set("type", side);
    go(`#/search?${p.toString()}`);
  };
  // Whether a key is set is the **server's** answer, not this page's: a key can
  // live in the environment, and the page only ever sees "set / not set" from
  // `/ai.json`. Gating on the local copy is what made Ask silently fall back to a
  // literal search on a server that had a working key.
  const provider = state.ai?.provider || "";
  // **`ready` is the server's answer**, not this page's guess: the server uses the
  // first provider that actually has a key, so a key pasted for a provider that was
  // not explicitly picked still answers here. Gating on the local `provider` alone
  // sent every Ask straight to a literal search, which read as the box doing
  // nothing.
  const ready = Boolean(state.ai?.enabled !== false && (state.ai?.ready || provider));
  if (ready) {
    try {
      const res = await post("/ai/ask", { prompt: q });
      if (res?.ok && res.query) return to(res.query);
    } catch {
      /* fall through to the literal text */
    }
  }
  to(q);
}

/* ---- settings panes ------------------------------------------------------- */

/**
 * Profile — shows which profile is active and lets you switch in place, so the
 * pane is informative even when you never touch it.
 */
/**
 * One switch in the profile editor: a media row, a card, or a catalog inside a card.
 *
 * `level` decides where the pick is stored, so one drawing serves all three and a
 * pick is remembered per profile (`nuvio.visibility`).
 */
function visRow(checked, level, id, title, desc, depth = 0) {
  const input = el("input", {
    type: "checkbox",
    name: `${level}:${id}`,
    "data-vis-level": level,
    "data-vis-id": id,
    ...(checked ? { checked: "checked" } : {}),
    onchange: (e) => {
      const v = visFor();
      if (level === "row") v.rows[id] = e.target.checked;
      else if (level === "card") v.cards[id] = e.target.checked;
      else v.catalogs[id] = e.target.checked;
      saveVisibility();
      render();
    },
  });
  return el(
    "label",
    {
      class: `option vis-option focusable${depth ? " vis-sub" : ""}`,
      tabindex: "0",
      style: depth ? `padding-left: ${depth * 16}px` : "",
    },
    input,
    el("span", { class: "option-body" },
      el("span", { class: "option-title", text: title }),
      desc ? el("span", { class: "option-desc", text: desc }) : null,
    ),
  );
}

/**
 * Settings → Profile: the profile you are on, and what it shows.
 *
 * This is the "pick the cards for you" editor: one switch for each of Movies and
 * Shows, one per card, and one per catalog row inside a card — so a profile can be
 * exactly Netflix-and-anime, or films only, without a second app.
 */
function paneProfile() {
  // Only the profile in use — switching happens on the switch-profile screen.
  const v = visFor();
  const editing = state.pickCards === true;
  // **Edit** is the way in. The editor used to be a bare toggle sitting in the pane
  // with a paragraph of explanation, so "there is a profile editor at all" was
  // something you had to notice; an Edit button on the profile itself is where you
  // look for it — and it reads as edit-then-done, which is what it is.
  const setEditing = (on) => {
    state.pickCards = on;
    writeJSON(KEY.pickCards, on);
    render();
  };
  return [
    el(
      "div",
      { class: "current-profile" },
      el("span", { class: "avatar", "aria-hidden": "true" }, avatarNode(state.profile)),
      el(
        "div",
        { class: "current-profile-body" },
        el("span", { class: "current-profile-name", text: state.profile }),
        el("span", { class: "current-profile-note", text: editing ? "Editing this profile" : "Current profile" }),
      ),
      el("button", {
        class: `btn focusable${editing ? " subtle" : " primary"}`,
        type: "button",
        id: "profile-edit",
        text: editing ? "Done" : "Edit",
        "aria-pressed": String(editing),
        title: editing ? "Close the profile editor" : "Pick the rows, cards and catalogs this profile shows",
        onclick: () => setEditing(!editing),
      }),
    ),
    el("p", {
      class: "option-desc",
      text: editing
        ? "Switch off anything this profile should not show, then press Done. Off by default: with the editor closed, everything shows and nothing is hidden."
        : "This is the profile the app is using. Open the profile icon in the top bar to switch; press Edit to choose which rows, cards and catalogs this profile shows.",
    }),
    // **The mode, then the account.** Settings → Profile is where a person looks for
    // "who am I signed in as", so the sign-in card sits directly under the mode it belongs
    // to, inside the same grid as everything else on this pane.
    signInCard(),

    editing ? el("div", { class: "vis-editor" },
      el("section", { class: "vis-section" },
        el("div", { class: "group-head" },
          el("span", { class: "option-title", text: "Media rows" }),
          el("span", { class: "option-desc", text: "The Movies and Shows rows under the hero banner." }),
        ),
        visRow(v.rows.movie !== false, "row", "movie", "Movies", "The Movies row and its cards."),
        visRow(v.rows.series !== false, "row", "series", "Shows", "The Shows row and its cards."),
      ),

      el("section", { class: "vis-section" },
        el("div", { class: "group-head" },
          el("span", { class: "option-title", text: "Cards" }),
          el("span", { class: "option-desc", text: `${state.collections.filter(cardVisible).length} of ${state.collections.length} cards show on Home, in the published order. Each card's catalog rows are listed inside it.` }),
        ),
        ...state.collections.map((card) => visCard(card, v)),
      ),
    ) : null,
  ].filter(Boolean);
}

/**
 * One card in the visibility editor: the card's own switch, then its catalog rows.
 *
 * Cards are separate blocks rather than one long list, so "which rows belong to
 * this card?" is answered by the box they sit in — and the card's header reports
 * how many of its rows are on, which is the number you actually want while picking.
 */
function visCard(card, v) {
  const rows = rowOf(card).catalogs;
  const shownRows = rows.filter((cat) => v.catalogs[cat.id] !== false).length;
  const shown = v.cards[card.key] !== false;
  return el("div", { class: `vis-card${shown ? "" : " off"}` },
    visRow(shown, "card", card.key, titleOf(card), rows.length ? `${shownRows} of ${rows.length} catalog rows on` : "No catalog rows yet"),
    rows.length
      ? el("div", { class: "vis-card-rows" },
          ...rows.map((cat) => visRow(v.catalogs[cat.id] !== false, "catalog", cat.id, cat.name, "", 1)),
        )
      : null,
  );
}

/**
 * Settings → Posters: the switch, the service, and its own URL.
 *
 * **The service is a choice with a None.** Off is the default: the providers already
 * send 2:3 artwork with the year on it, and a poster service is for replacing that with
 * artwork carrying the ratings. RPDB keeps its key *inside the URL*, which is why the
 * key box writes into the pattern rather than being sent anywhere else — and why a
 * service this app has never heard of works too: put its URL in the pattern.
 */
function panePosters() {
  const stored = state.posters || {};
  const host = (url) => String(url || "").match(/^https?:\/\/([^/]+)/i)?.[1]?.toLowerCase() || "";
  const hostname = host(stored.pattern);
  // Which service the saved pattern belongs to, matched on the host — an RPDB URL
  // carries the user's own key, so it never equals the template.
  // **The stored source wins when it is one this pane offers.** Deriving the choice
  // from the pattern alone put "Something else" with an empty pattern back on None the
  // moment it was picked, so the radio jumped away from the one that had just been
  // chosen — and the pattern box it should have revealed never appeared.
  const known = POSTER_SERVICES.some(([id]) => id === stored.source);
  const current = known
    ? stored.source
    : hostname.includes("ratingposterdb.com")
      ? "rpdb"
      : stored.pattern
        ? "custom"
        : "none";

  const pattern = el("input", {
    class: "text-input focusable",
    type: "text",
    id: "poster-pattern",
    value: stored.pattern || "",
    placeholder: "https://…/{imdb_id}.jpg",
  });
  // The key RPDB wants. It is written into the pattern as `{rpdb_key}` server-side, so
  // it never sits in the page's own copy of the URL.
  const keyInput = el("input", {
    class: "text-input focusable",
    type: "password",
    id: "poster-key",
    value: "",
    placeholder: stored.hasKey ? "a key is saved — paste a new one to replace it" : "your RPDB key",
  });
  const status = el("span", { class: "source-status", text: "" });

  const savePosters = async (patch) => {
    state.posters = { ...state.posters, ...patch };
    writeJSON(KEY.posters, state.posters);
    await pushSettings({ posters: patch });
    render();
  };

  return [
    toggleRow(stored.enabled === true, "Upgrade posters everywhere", "Replace the artwork with the poster service's version for every title; titles it cannot cover keep theirs.", (e) => savePosters({ enabled: e.target.checked })),
    // **One box per service, the same shape Content uses.** These were stacked rows
    // inside one "Poster service" panel, which read as a list inside a list; as boxes
    // they sit in the pane's own board, two to a row, and the chosen one wears the
    // accent like every other choice in Settings.
    el("p", { class: "option-title", text: "Poster service" }),
    el("p", { class: "option-desc", text: "Which service supplies the artwork. Its pattern is filled in below; edit the pattern to use anything else — {imdb_id}, {tmdb_id}, {type} and {rpdb_key} are filled in per title." }),
    ...POSTER_SERVICES.map(([id, label, url, desc]) =>
      radioRow(current === id, "posterservice", label, desc, () => savePosters({ source: id, pattern: url, enabled: id !== "none" })),
    ),
    current === "custom" || current === "rpdb"
      ? el("div", { class: "provider" },
          el("span", { class: "option-title", text: current === "rpdb" ? "RPDB key" : "URL pattern" }),
          current === "rpdb"
            ? el("p", { class: "option-desc", text: "RPDB takes its key in the URL itself. It is stored on the server and substituted for {rpdb_key}; the page never holds the finished URL." })
            : null,
          el("div", { class: "source-form" },
            current === "rpdb"
              ? keyInput
              : pattern,
            el("button", {
              class: "btn primary focusable", type: "button", id: "poster-save", text: current === "rpdb" ? "Save key" : "Save pattern",
              onclick: async () => {
                if (current === "rpdb") {
                  const value = keyInput.value.trim();
                  if (!value) return;
                  await savePosters({ apiKey: value });
                  keyInput.value = "";
                  return;
                }
                const value = pattern.value.trim();
                if (!value) return;
                await savePosters({ pattern: value });
              },
            }),
            el("button", {
              class: "btn subtle focusable", type: "button", id: "poster-check", text: "Check service",
              onclick: async () => {
                status.className = "source-status";
                status.textContent = "Checking…";
                try {
                  const res = await get("/posters/check");
                  status.className = `source-status ${res.ok ? "ok" : "bad"}`;
                  status.textContent = res.text;
                } catch (err) {
                  status.className = "source-status bad";
                  status.textContent = `could not check — ${err.message}`;
                }
              },
            }),
          ),
          el("div", { class: "provider-check" }, status),
        )
      : null,
  ];
}

const providerRow = (name) => {
  const [n, label, desc] = PROVIDERS.find(([p]) => p === name) || [];
  return n ? keyRow("providers", n, label, desc, state.providers, KEY.providers) : null;
};

function paneProviders() {
  // **No content-source picker.** TMDB and TVDB are not alternatives any more:
  // TMDB builds every row (it is the only provider with a discover engine) and TVDB
  // fills the fields TMDB left empty. A switch that said one *replaced* the other
  // was the wrong shape for how they actually work, so it is gone and the two
  // halves of the enrichment are what you turn on or off.
  const setEnrich = (key, value) => {
    state.enrich = { ...state.enrich, [key]: value };
    writeJSON(KEY.enrich, state.enrich);
    pushSettings({ enrich: { [key]: value } });
    render();
  };
  return [
    el("p", { class: "option-desc", text: "Paste a key and enable a provider. Catalogs keep the same names; the provider changes what is behind them." }),
    providerRow("tmdb"),
    providerRow("tvdb"),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Enrichment" }),
      el("span", { class: "option-desc", text: "TMDB builds every row; TVDB adds what TMDB left out. Both work together — neither replaces the other." }),
    ),
    toggleRow(state.enrich.tmdb !== false, "TMDB artwork & ratings", "Switches the tagged posters and the extra ratings on or off for every row — off, a title keeps the artwork and rating TMDB served it.", (e) => setEnrich("tmdb", e.target.checked)),
    toggleRow(state.enrich.tvdb !== false, "Fill TMDB's gaps with TVDB", "For each title TVDB knows (by IMDb id), supplies the fields TMDB left empty — name, year, overview and artwork. Never overwrites a field TMDB already answered. Needs the TVDB key above.", (e) => setEnrich("tvdb", e.target.checked)),
  ];
}

/**
 * Rating services, as this pane offers them.
 *
 * **`free` is the interesting one**: IMDb, Rotten Tomatoes and Metacritic each publish
 * a score on their own page, so this needs no account and no key — which is why the
 * ratings row on a title page is real out of the box. MDBList is the aggregate: one key
 * that answers for every source it knows at once, films, series and anime alike.
 */
const RATING_SERVICES = [
  ["none", "None", "No extra ratings — the title page keeps TMDB's own score and nothing else."],
  ["free", "Public pages (no key)", "IMDb, Rotten Tomatoes and Metacritic read from their own pages. Nothing to sign up for; each title is looked up once and cached."],
  ["mdblist", "MDBList (one key)", "MDBList merges IMDb, Rotten Tomatoes, Metacritic, Trakt, Letterboxd and more into scores for every title type. Needs the key below."],
];

/** Settings → Ratings: which services the title page reads, and MDBList's key. */
function paneRatings() {
  const source = state.ratings?.source || "free";
  return [
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "Ratings service" }),
      el("p", { class: "option-desc", text: "What the ratings row on a title page is built from. TMDB's own score is always shown — it arrives with the title." }),
      ...RATING_SERVICES.map(([id, label, desc]) =>
        radioRow(source === id, "ratingservice", label, desc, () => {
          state.ratings = { ...state.ratings, source: id };
          writeJSON(KEY.ratings, state.ratings);
          pushSettings({ ratings: { source: id } });
          render();
        }),
      ),
    ),
    source === "mdblist"
      ? el("div", { class: "group-head" },
          el("span", { class: "option-title", text: "MDBList" }),
          el("span", { class: "option-desc", text: "The key is stored on the server; the page only ever learns whether one is set." }),
        )
      : null,
    source === "mdblist" ? providerRow("mdblist") : null,
  ];
}

function paneTracking() {
  return [
    el("p", { class: "option-desc", text: "Connect a service to track what you watch. Each key is stored on the server — the page only ever learns whether one is set." }),
    // **Outbound, and said so.** The direction matters: this app's own watch state is
    // the one the Library is drawn from, so a tracker is told what you watched and is
    // never asked what it thinks — which is why connecting one cannot rewrite a row.
    el("p", { class: "option-desc", text: "Sync runs one way. Watched state goes out to the service you connect; nothing is read back, so a list kept elsewhere can never overwrite what your Library shows." }),
    ...TRACKER_GROUPS.flatMap((group) => [
      // The divider belongs *before* the group it separates, the way the rule on a
      // collection page sits above the row it introduces.
      group.divider ? el("div", { class: "h-divider tracking-divider", "aria-hidden": "true" }) : null,
      el("div", { class: "group-head" },
        el("span", { class: "option-title", text: group.title }),
        el("span", { class: "option-desc", text: group.hint }),
      ),
      ...group.services.map(([name, label, desc]) => keyRow("tracking", name, label, desc, state.tracking, KEY.tracking)),
    ].filter(Boolean)),
  ];
}

/**
 * One free AI provider: pick it with the switch, paste its key, check it.
 * The key goes to the server (as every other key does) — the page only ever
 * learns whether one is set.
 */
function aiProviderRow(slug, label, signup, note) {
  const hasKey = Boolean(state.ai.hasKey?.[slug]);
  const active = state.ai.provider === slug;
  // The models the provider reported, filled in by Test connection / Load models.
  const modelList = el("div", { class: "model-list", id: `ai-${slug}-models` });
  /**
   * Show the models as pickable chips.
   *
   * Clicking one sets it as the model in use — the model box below stops being a
   * name you have to know and becomes a name you picked from what the provider
   * actually serves today.
   */
  const drawModels = (models, recommended = "") => {
    modelList.replaceChildren(
      ...models.map((id) =>
        el("button", {
          class: `model-chip focusable${id === state.ai.model || id === recommended ? " suggested" : ""}`,
          type: "button",
          text: id,
          title: `Use ${id}`,
          onclick: async () => {
            state.ai.model = id;
            writeJSON(KEY.ai, state.ai);
            await pushSettings({ ai: { model: id } });
            render();
          },
        }),
      ),
    );
  };
  const input = el("input", {
    class: "text-input focusable",
    type: "password",
    id: `ai-${slug}-key`,
    placeholder: hasKey ? "•••••••• (set — paste a new key to replace)" : "Paste API key…",
  });
  const status = el("span", { class: "source-status", text: "" });

  return el("div", { class: `provider ai-provider${active ? " active" : ""}` },
    el("div", { class: "provider-head" },
      el("div", { class: "ai-provider-name" },
        el("span", { class: "option-title", text: label }),
        el("span", { class: `badge ${hasKey ? "on" : "off"}`, text: hasKey ? "key set" : "no key" }),
        el("span", { class: "badge free", text: "free tier" }),
      ),
      el("label", { class: "switch", title: `Use ${label}` },
        el("input", {
          type: "radio",
          name: "ai-provider",
          value: slug,
          checked: active,
          onchange: () => {
            state.ai.provider = slug;
            writeJSON(KEY.ai, state.ai);
            pushSettings({ ai: { provider: slug } });
            render();
          },
        }),
        el("span", { class: "slider" }),
      ),
    ),
    el("p", { class: "option-desc", text: note }),
    el("div", { class: "source-form" }, input,
      el("button", {
        class: "btn primary focusable",
        type: "button",
        text: hasKey ? "Replace key" : "Save key",
        onclick: async () => {
          const value = input.value.trim();
          if (!value) return;
          state.ai.hasKey = { ...(state.ai.hasKey || {}), [slug]: true };
          // The first key pasted becomes the provider in use.
          if (!state.ai.provider) state.ai.provider = slug;
          writeJSON(KEY.ai, state.ai);
          await pushSettings({ ai: { keys: { [slug]: value }, provider: state.ai.provider } });
          input.value = "";
          render();
        },
      }),
      hasKey
        ? el("button", {
            class: "btn subtle focusable",
            type: "button",
            text: "Remove key",
            onclick: async () => {
              state.ai.hasKey = { ...(state.ai.hasKey || {}), [slug]: false };
              writeJSON(KEY.ai, state.ai);
              await pushSettings({ ai: { keys: { [slug]: "" } } });
              render();
            },
          })
        : null,
    ),
    el("div", { class: "provider-check" },
      // Test connection, and load the models in the same call: a model list only
      // comes back from a key that works, so one button answers both questions.
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Test connection",
        onclick: async () => {
          status.className = "source-status";
          status.textContent = "Testing…";
          modelList.replaceChildren();
          try {
            const res = await post("/ai/verify", { provider: slug });
            status.className = `source-status ${res?.ok ? "ok" : "bad"}`;
            status.textContent = res?.text || (res?.ok ? "connected" : "not connected");
            drawModels(res?.chat || []);
          } catch (err) {
            status.className = "source-status bad";
            status.textContent = `could not check — ${err.message}`;
          }
        },
      }),
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Load models",
        onclick: async () => {
          status.className = "source-status";
          status.textContent = "Loading models…";
          modelList.replaceChildren();
          try {
            const res = await post("/ai/models", { provider: slug });
            status.className = `source-status ${res?.ok ? "ok" : "bad"}`;
            status.textContent = res?.text || "no models";
            drawModels(res?.chat || [], res?.recommended);
          } catch (err) {
            status.className = "source-status bad";
            status.textContent = `could not list models — ${err.message}`;
          }
        },
      }),
      el("a", { class: "ai-signup", href: signup, target: "_blank", rel: "noreferrer", text: "Get a free key" }),
      status,
    ),
    modelList,
  );
}

function paneAi() {
  return [
    toggleRow(state.ai.enabled, "Enable AI", "Turns on the assistant and its options.", (e) => {
      state.ai.enabled = e.target.checked;
      writeJSON(KEY.ai, state.ai);
      pushSettings({ ai: { enabled: state.ai.enabled } });
      render();
    }),
    state.ai.enabled ? [
      toggleRow(state.ai.enhanceArtwork, "Classic posters & banners → high quality", "Requests the next-bigger artwork size so older posters and banners look modern.", (e) => {
        state.ai.enhanceArtwork = e.target.checked;
        writeJSON(KEY.ai, state.ai);
        pushSettings({ ai: { enhanceArtwork: state.ai.enhanceArtwork } });
        render();
      }),
      toggleRow(state.ai.enhanceMissing !== false, "Give the same treatment to posters without a better poster", "Titles the poster service could not cover (no IMDb id) still get the high-quality artwork treatment.", (e) => {
        state.ai.enhanceMissing = e.target.checked;
        writeJSON(KEY.ai, state.ai);
        pushSettings({ ai: { enhanceMissing: state.ai.enhanceMissing } });
        render();
      }),
      // **No "Pick the cards for you" here.** The card editor belongs to the Profile
      // pane, and this is the AI pane: one switch about someone else's cards in the
      // middle of the provider keys was a setting in the wrong room.
      el("p", { class: "option-desc", text: "Pick a free provider and paste its API key. The key is stored on the server, never in the page, and the Ask box falls back to a plain search when no key is set." }),
      ...AI_PROVIDERS.map(([slug, label, signup, note]) => aiProviderRow(slug, label, signup, note)),
      el("div", { class: "provider" },
        el("span", { class: "option-title", text: "Model" }),
        el("p", { class: "option-desc", text: "Optional. Providers rename models faster than this ships — leave it empty to use the provider's default." }),
        el("div", { class: "source-form" },
          el("input", {
            class: "text-input focusable",
            type: "text",
            id: "ai-model",
            value: state.ai.model || "",
            placeholder: "Model (optional)",
          }),
          el("button", {
            class: "btn primary focusable",
            type: "button",
            text: "Save model",
            onclick: async (e) => {
              const value = e.target.closest(".provider").querySelector("#ai-model").value.trim();
              state.ai.model = value;
              writeJSON(KEY.ai, state.ai);
              await pushSettings({ ai: { model: value } });
              render();
            },
          }),
        ),
      ),
    ] : null,
  ];
}


// Used only when the server predates the options payload, so the selects are
// never empty.
const FALLBACK_LANGUAGES = [["en-US", "English (US)"], ["hi-IN", "Hindi"], ["es-ES", "Spanish"]];
const FALLBACK_COUNTRIES = [["US", "United States"], ["IN", "India"], ["GB", "United Kingdom"]];

/**
 * Content — where you are, and what language you read it in.
 *
 * The country drives the Regional OTT cards (that country's own services,
 * not every region's), and the language is the language every row is served in —
 * which is also the primary subtitle language.
 */
/**
 * Content: what the rows contain.
 *
 * The country picker is gone as well as the language one. Both belonged to the
 * regional OTT cards' *names* rather than to what a row holds, and the country is
 * published by the server (`/settings` → `country`) — so the two settings that
 * only ever confused the question "what am I looking at?" are not here. What is
 * left is the one switch that really does change a row's contents.
 */
function paneContent() {
  // **Where the app is comes first.** The Region is what the Regional OTT cards are
  // made of and what a search starts on, so it belongs at the top of Content rather
  // than in Appearance, where it would read as a colour.
  return [
    el("p", { class: "option-title", text: "Region" }),
    el("p", { class: "option-desc", text: "Where the app is. The Regional OTT cards are this region's own services, and the search screen starts on it — the Country chips can still be changed per search." }),
    paneRegion(),
    radioRow(state.safe, "safe", "SFW", "Safe for work — adult titles excluded (TMDB default).", () => {
      state.safe = true; writeJSON(KEY.safe, true); pushSettings({ safe: true }); render();
    }),
    radioRow(!state.safe, "safe", "NSFW", "Include adult titles where TMDB supports it.", () => {
      state.safe = false; writeJSON(KEY.safe, false); pushSettings({ safe: false }); render();
    }),
    el("p", { class: "option-title", text: "Refresh catalogs & metadata" }),
    el("p", { class: "option-desc", text: "How often the addon re-reads TMDB and the screen re-reads itself. The addon's cache follows the same interval, so a row can actually come back different." }),
    ...REFRESH_CHOICES.map(([minutes, label]) =>
      radioRow(Number(state.refresh) === minutes, "refresh", label, minutes === 0 ? "Nothing is re-read until you press Refresh now." : `Catalogs and metadata are re-read every ${minutes} minutes.`, () => {
        state.refresh = minutes;
        writeJSON(KEY.refresh, minutes);
        pushSettings({ refresh: { minutes } });
        render();
      }),
    ),
    el("div", { class: "provider" },
      el("button", { class: "btn primary focusable", type: "button", text: "Refresh now", onclick: () => refreshNow() }),
    ),
  ];
}

/**
 * Paint the accent and the motion setting onto the document.
 *
 * Both are applied as CSS custom properties / one root class, so every rule in
 * the stylesheet follows them and nothing has to be re-rendered to re-tint.
 */
function applyTheme() {
  const [, , rgb, base, deep] = accentOf(state.accent);
  const root = document.documentElement;
  // **The typeface is one custom property.** Written here with the accent, and written
  // into the boot record below, so the first paint is already in the chosen face.
  root.style.setProperty("--font", FONT_STACK);
  root.style.setProperty("--accent", base);
  root.style.setProperty("--accent-rgb", rgb);
  root.style.setProperty("--accent-deep", deep);
  root.classList.toggle("motion-off", state.motion === "off");
  root.classList.toggle("motion-full", state.motion === "full");
  // Written out for the boot script in `index.html`, which applies them **before
  // the first paint**. Without it the app painted its default gold and then
  // re-tinted a frame later — the "golden accent on boot" flash.
  try {
    localStorage.setItem(KEY.theme, JSON.stringify({ base, rgb, deep, motion: state.motion }));
  } catch {
    /* private mode — the app still tints, it just flashes on the next boot */
  }
}

/**
 * **The Region.**
 *
 * One place where the app is, instead of two half-answers: the server keeps `country`
 * and every read that depends on it follows — the Regional OTT cards are that region's
 * own services (the region rides in the row id, so two regions never collide), and the
 * search screen starts on it. Changing it re-reads the cards, because the rows the old
 * region published are not the rows the new one publishes.
 */
async function setRegion(code) {
  const value = String(code || "").toUpperCase();
  if (!value || value === state.country) return;
  state.country = value;
  localStorage.setItem(KEY.country, value);
  pushSettings({ country: value });
  await refreshCollections();
  render();
}

function paneRegion() {
  // **The server's own country list**, which is objects (`{code, name, services}`), not
  // the pairs a dropdown reads — so it is mapped, and the service count rides along:
  // it is how many Regional OTT rows that region is going to have.
  const list = (state.options.countries || [])
    .filter((c) => c && c.code)
    .map((c) => [String(c.code).toUpperCase(), c.services ? `${c.name} · ${c.services} rows` : c.name]);
  // A country the server no longer offers is still the one stored here, so it is put
  // back at the top rather than letting the picker show some other region's name.
  if (state.country && !list.some(([code]) => code === state.country)) list.unshift([state.country, state.country]);
  const pick = dropdown(list.length ? list : FALLBACK_COUNTRIES, state.country, setRegion, "Region");
  pick.node.id = "region-pick";
  return pick.node;
}

/** Settings → Appearance: the accent colour, and how much the app moves. */
function paneAppearance() {
  return [
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "Accent colour" }),
      el("p", { class: "option-desc", text: "The colour the app is painted in — buttons, chips, highlights, borders. Gold is the default; pick another and the whole app follows." }),
      el("div", { class: "accent-row" },
        ...ACCENTS.map(([id, label, , base]) =>
          el("button", {
            class: `accent-swatch focusable${state.accent === id ? " active" : ""}`,
            type: "button",
            id: `accent-${id}`,
            title: label,
            "aria-label": label,
            "aria-pressed": String(state.accent === id),
            style: `--swatch: ${base}`,
            onclick: () => {
              state.accent = id;
              localStorage.setItem(KEY.accent, id);
              applyTheme();
              render();
            },
          }),
        ),
      ),
      el("div", { class: "provider-check" }, el("span", { class: "source-status", text: `Accent: ${accentOf(state.accent)[1]}` })),
    ),
    // **There is no typeface setting.** The app is set in one face — the stack in
    // `--font`, which is local families and the system UI face, so nothing is downloaded
    // and the app reads the same offline.
    el("p", {
      class: "option-desc",
      text: "The app is set in Inter, condensed to fit the rows — one face for the wordmark, the titles and the controls. There is no other typeface to choose.",
    }),
  ];
}

function paneLayout() {
  return LAYOUTS.map(([value, title, desc]) =>
    radioRow(state.layout === value, "layout", title, desc, () => {
      state.layout = value;
      localStorage.setItem(KEY.layout, value);
      render();
    }),
  );
}

/**
 * Settings → Animation: how much the app moves, and what moves.
 *
 * **Its own section.** It used to be half of "Appearance & layout", under the accent
 * swatches — the one setting on that pane nobody was looking for there. The switches below
 * it are the *what*: the preview panel a card opens on hover, a catalog tile, a button.
 */
function paneAnimation() {
  return [
    el("p", { class: "option-desc", text: "How the app moves: screen changes, hover lifts, the row highlight." }),
    ...MOTIONS.map(([value, title, desc]) =>
      radioRow(state.motion === value, "motion", title, desc, () => {
        state.motion = value;
        localStorage.setItem(KEY.motion, value);
        applyTheme();
        render();
      }),
    ),
    el("div", { class: "h-divider", "aria-hidden": "true" }),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Hover previews" }),
      el("span", { class: "option-desc", text: "The little panel that opens when the pointer rests on something — its name, its year, what it is. It is a picture of the thing under the cursor, drawn over the page; nothing is opened and nothing navigates." }),
    ),
    toggleRow(state.previews.cards, "Titles and cards", "A poster shows its title, year and rating in a small panel.", (e) => {
      state.previews = { ...state.previews, cards: e.target.checked };
      writeJSON(KEY.previews, state.previews);
      render();
    }),
    toggleRow(state.previews.catalogs, "Catalog tiles and buttons", "Rows, genres and buttons say what they hold before you open them.", (e) => {
      state.previews = { ...state.previews, catalogs: e.target.checked };
      writeJSON(KEY.previews, state.previews);
      render();
    }),
  ];
}

/**
 * Settings → Sound: what the app plays, and only when you ask for it.
 *
 * Off by default. A media app that beeps at you on every press is the reason people turn
 * their machines down, so both switches start off and the music never starts on its own.
 */
function paneSound() {
  const sound = state.sound;
  const set = (patch) => {
    state.sound = { ...state.sound, ...patch };
    writeJSON(KEY.sound, state.sound);
    pushSettings({ sound: state.sound });
    render();
  };
  const volumeInput = el("input", {
    class: "text-input focusable", type: "range", min: "0", max: "100",
    id: "sound-volume", value: String(sound.musicVolume ?? 35), style: "width: 100%",
    oninput: (e) => { sound.musicVolume = Number(e.target.value); },
    onchange: () => set({}),
  });
  return [
    el("p", { class: "option-desc", text: "Nothing here is on until you turn it on, and nothing plays over a title once it is playing." }),
    toggleRow(sound.clicks, "A click when you press something", "A short, soft tick on a button, a tile and a card — never on a scroll, and never on a screen you did not press.", (e) => set({ clicks: e.target.checked })),
    toggleRow(sound.music, "Music while you browse", "A quiet loop under the app until you press Play. It stops the moment a title starts, and never plays in the player.", (e) => set({ music: e.target.checked })),
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "Music volume" }),
      el("p", { class: "option-desc", text: "How loud the browsing music is, against the title you are about to play." }),
      volumeInput,
      el("div", { class: "provider-check" }, el("span", { class: "source-status", text: `${sound.musicVolume ?? 35}%` })),
    ),
  ];
}

/**
 * Settings → Notifications: what the app is allowed to tell you about.
 *
 * The Calendar holds a title's release date and the pins you set on it, and a pinned
 * episode airing is the one thing in this app that is *late* — so it is the one thing worth
 * a notification. Everything else is off unless asked for.
 */
function paneNotifications() {
  const n = state.notifications;
  const set = (patch) => {
    state.notifications = { ...state.notifications, ...patch };
    writeJSON(KEY.notifications, state.notifications);
    pushSettings({ notifications: state.notifications });
    render();
  };
  return [
    el("p", { class: "option-desc", text: `Notifications for this profile (${state.profile}). A notification is drawn in the app; nothing leaves the machine and no account is needed.` }),
    toggleRow(n.calendar, "Pinned titles in the Calendar", "Tell me when a title I pinned to watch comes out, and when a pinned episode airs.", (e) => set({ calendar: e.target.checked })),
    toggleRow(n.releases, "New releases in my Library", "Tell me when something in the Library gets a new season or a new episode.", (e) => set({ releases: e.target.checked })),
    toggleRow(n.live, "Live TV and sports", "Tell me before a pinned fixture starts, on the Live TV & Sports profile.", (e) => set({ live: e.target.checked })),
  ];
}

/**
 * A dropdown the app draws itself.
 *
 * A native `<select>` is the one control the **platform** paints: its popup list
 * cannot be themed at all, and its closed box never quite matched the fields beside
 * it however the stylesheet was written. This is a button plus a list in the app's
 * own markup, so there is nothing left for the OS to draw — no appearance override,
 * no drawn chevron hack, no cached sheet that can lose the race.
 */
function dropdown(options, initial, onPick, caption = "") {
  let value = options.some(([v]) => v === initial) ? initial : (options[0] || ["", ""])[0];
  const shown = options.find(([v]) => v === value) || ["", ""];
  const label = el("span", { class: "dropdown-value", text: shown[1] });
  const menu = el("div", { class: "dropdown-menu", hidden: true });
  const root = el("div", { class: "dropdown" });
  const close = () => { menu.hidden = true; root.classList.remove("open"); };
  for (const [v, text] of options) {
    menu.append(el("button", {
      class: "dropdown-item focusable",
      type: "button",
      text,
      onclick: () => {
        value = v;
        label.textContent = text;
        close();
        // A picker that opens something (a season) says so; a picker that only
        // records a value (the add-on type) has nothing to do here.
        if (onPick) onPick(v);
      },
    }));
  }
  root.append(
    el("button", {
      class: `dropdown-btn focusable${caption ? " with-label" : ""}`,
      type: "button",
      "aria-haspopup": "listbox",
      onclick: (e) => {
        e.stopPropagation();
        const opening = menu.hidden;
        close();
        if (opening) { menu.hidden = false; root.classList.add("open"); }
      },
    },
      // **The caption names the choice, not just the chosen value.** A picker on a
      // title page says "Subtitle · English" rather than "English", which could be
      // the language, the audio or the country.
      caption ? el("span", { class: "dropdown-label", text: caption }) : null,
      label,
      el("span", { class: "dropdown-caret", "aria-hidden": "true" }),
    ),
    menu,
  );
  // A press anywhere else closes it, the way a menu should behave. This listens in
  // the **capture** phase and ignores presses inside the menu, because a press on a
  // card (or any control that stops propagation) never reached a bubble-phase
  // listener — which is what made the open list look like it would not close.
  document.addEventListener("pointerdown", (e) => {
    if (root.contains(e.target)) return;
    close();
  }, true);
  return { node: root, value: () => value };
}

/** One source section (Add-ons or Plugins), with server-side inspection. */
function sourceSection(title, hint, types, list) {
  const picker = dropdown(types, types[0][0]);
  const urlInput = el("input", { class: "text-input focusable", type: "text", placeholder: "https://…" });
  const add = el("button", {
    class: "btn primary focusable",
    type: "button",
    text: "Add",
    onclick: async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      // **The row says what it is doing from the first frame**, and it is read right
      // away: a source added here used to sit on "Reading this source's providers…"
      // until something happened to read it, which is the row that never moved.
      state.sources.push({ type: picker.value(), url, status: { ok: false, text: "Reading the manifest…" } });
      urlInput.value = "";
      saveSources();
      render();
      await inspectSource(state.sources.length - 1, { quiet: true });
      render();
    },
  });
  return [
    el("p", { class: "option-desc", text: hint }),
    el("div", { class: "source-form" }, picker.node, urlInput, add),
    list.length
      ? el("div", { class: "sources" }, ...list.map((s, pos) => sourceRow(s, state.sources.indexOf(s), list, pos)))
      : el("p", { class: "option-desc", text: "None added yet." }),
  ];
}

/**
 * Keep the sources on the server as well as in this page.
 *
 * They have to live server-side because **reading a stream happens there** (a
 * browser cannot call another host's `/stream/…`), and because the addon publishes
 * what it can play to Nuvio itself. The page keeps its own copy so Settings draws
 * instantly and works offline.
 */
function saveSources() {
  writeJSON(KEY.sources, state.sources);
  pushSettings({ sources: state.sources });
}

/**
 * Inspect a source **through our server** (`/api/source`). Doing it here instead
 * of in the page is what makes third-party sources work: a browser is blocked by
 * CORS from reading another host's manifest.json.
 */
async function inspectSource(index, { quiet = false } = {}) {
  const source = state.sources[index];
  if (!source) return;
  if (!quiet) {
    source.status = { ok: false, text: "Checking…" };
    render();
  }
  try {
    // A source that never answers must not leave the row saying "Checking…" for
    // ever — the request is given a deadline and reports the timeout like any other
    // failure.
    const res = await Promise.race([
      post("/api/source", { type: source.type, url: source.url }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("that source did not answer in time")), 20000)),
    ]);
    if (res?.unreachable) {
      // The app's own server did not answer. That is not the add-on's answer, and saying
      // it was is what put "HTTP 503" on every source in the list at once.
      source.status = { ok: false, text: `not read — the app's own server did not answer (${res.message})` };
      saveSources();
      if (!quiet) render();
      return;
    }
    source.providers = res.providers || [];
    // The same list, kept for the **Providers** button: a plugin's providers are its
    // scrapers, and an add-on's are its catalogs.
    source.allProviders = res.providers?.length ? res.providers : res.scrapers || [];
    source.resources = res.resources || [];
    source.scrapers = res.scrapers || [];
    source.kind = res.kind || "";
    source.name = res.name || source.name;
    source.status = { ok: Boolean(res.ok), text: res.ok ? `${res.name || typeLabel(source.type)} · ${res.message}` : res.message };
  } catch (err) {
    source.status = { ok: false, text: `could not check — ${err.message}` };
  }
  saveSources();
  if (!quiet) render();
}

/** Sources being read right now, so one source is never read twice at the same time. */
const inspecting = new Set();

/**
 * Read every source the app has not read yet — quietly, and only once.
 *
 * A source restored from an older build (or added on another device) is stored
 * without its providers, and its row then shows nothing under it. Reading them here
 * is what makes the providers appear on their own instead of waiting for a click
 * that nothing on screen tells you to make. A source that answered badly keeps its
 * status, so this never runs twice for the same source — and a read **already in
 * flight** is not started again, which is what could redraw this screen in a loop
 * while a slow source was being read.
 */
async function hydrateSources() {
  const pending = state.sources.filter((s) => s && !s.status && !inspecting.has(s));
  if (!pending.length) return;
  for (const source of pending) inspecting.add(source);
  for (const source of pending) {
    try {
      await inspectSource(state.sources.indexOf(source), { quiet: true });
    } finally {
      inspecting.delete(source);
    }
  }
  render();
}

/**
 * What a source's status line says, **read from the source itself**.
 *
 * The line used to be the string the last inspection stored, which went stale the
 * moment the wording changed: a row read before the resources were counted kept
 * saying "0 catalogs" while the chips under it already listed Streams, Metadata and
 * Subtitles. It is composed here from the stored providers and resources, so it is
 * always true of the row it is on.
 */
function sourceStatusText(source) {
  const providers = Array.isArray(source.providers) ? source.providers : [];
  const resources = Array.isArray(source.resources) ? source.resources : [];
  const scrapers = Array.isArray(source.scrapers) ? source.scrapers : [];
  if (source.kind === "plugin" || source.kind === "repo" || (scrapers.length && !providers.length)) {
    return `${scrapers.length} scraper${scrapers.length === 1 ? "" : "s"}`;
  }
  if (!providers.length && !resources.length) return source.status?.text || "";
  const serves = [
    resources.includes("stream") ? "streams" : "",
    resources.includes("meta") ? "metadata" : "",
    resources.includes("subtitles") ? "subtitles" : "",
  ].filter(Boolean);
  return `${providers.length} catalog${providers.length === 1 ? "" : "s"}${serves.length ? ` · ${serves.join(", ")}` : ""}`;
}

/**
 * Move an add-on **up or down its own list**.
 *
 * This is not decoration: the order is the order the add-ons are **asked in** when you
 * press Play, and what they answer is appended in that order, so the top row's streams
 * are the first ones in the player's Sources drawer. The move is stored with the rest of
 * the sources, on the server as well as in the page, so it is the order this device
 * plays in.
 */
function moveSource(order, pos, delta) {
  const to = pos + delta;
  if (to < 0 || to >= order.length) return;
  const moving = order[pos];
  const target = order[to];
  if (!moving || !target) return;
  // **Found by what they are, not by which object they are.** Writing the order is a
  // round trip, and the server's copy of the sources **replaces** this page's copy when
  // the write comes back — so the rows on screen can hold older objects than the ones in
  // `state.sources`, and an identity lookup then matches nothing and the arrow does
  // nothing at all.
  const key = (s) => `${s?.type || ""}|${s?.url || ""}`;
  const i = state.sources.findIndex((s) => key(s) === key(moving));
  const j = state.sources.findIndex((s) => key(s) === key(target));
  if (i < 0 || j < 0 || i === j) return;
  // Move the *stored* pair, so the copy that is written back is the one that is kept.
  const held = state.sources[i];
  state.sources[i] = state.sources[j];
  state.sources[j] = held;
  saveSources();
  render();
}

/** The two arrows that set an add-on's position: first row cannot go up, last cannot go down. */
function sourceMoveButtons(order, pos) {
  const arrow = (delta, text, title) =>
    el("button", {
      class: "btn subtle focusable source-move",
      type: "button",
      text,
      disabled: delta < 0 ? pos <= 0 : pos >= order.length - 1,
      title,
      "aria-label": title,
      onclick: () => moveSource(order, pos, delta),
    });
  return [
    arrow(-1, "\u2191", pos <= 0 ? "Already first in the order" : "Move up \u2014 ask this add-on earlier"),
    arrow(1, "\u2193", pos >= order.length - 1 ? "Already last in the order" : "Move down \u2014 ask this add-on later"),
  ];
}

function sourceRow(source, index, order = [], pos = 0) {
  const list = Array.isArray(source.allProviders) && source.allProviders.length ? source.allProviders : null;
  return el("div", { class: "source" },
    el("div", { class: "source-main" },
      el("span", { class: "source-type", text: `${typeLabel(source.type)}${source.name ? ` · ${source.name}` : ""}` }),
      el("span", { class: "source-url", text: source.url }),
      source.status ? el("span", { class: `source-status ${source.status.ok ? "ok" : "bad"}`, text: sourceStatusText(source) }) : null,
      ...sourceBody(source),
      // **Pressing Providers shows the providers.** The button re-read the source
      // and redrew the same summary line, so it looked like it did nothing; this is
      // the full list it read, opened under the row.
      source.showProviders && list
        ? el("div", { class: "source-providers" },
            el("span", { class: "source-line-label", text: `Providers (${list.length})` }),
            el("div", { class: "chips" }, ...list.map((p) => el("span", { class: "chip", text: p }))),
          )
        : null,
      source.showProviders && !list && source.status?.ok
        ? el("p", { class: "option-desc", text: "This source names no providers of its own." })
        : null,
    ),
    el("div", { class: "source-actions" },
      // **Position.** Two arrows instead of removing an add-on and adding it again to
      // put it where you want it in the play order.
      ...sourceMoveButtons(order, pos),
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Providers",
        "aria-expanded": String(Boolean(source.showProviders)),
        title: "Read and list this source's providers",
        onclick: async () => {
          source.showProviders = !source.showProviders;
          if (!source.providers?.length) await inspectSource(index, { quiet: true });
          render();
        },
      }),
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Remove",
        onclick: () => {
          state.sources.splice(index, 1);
          saveSources();
          render();
        },
      }),
    ),
  );
}

/**
 * Settings → Add-ons & plugins, one pane: both kinds of source, each with its own
 * form, so "where do I add a source?" has one answer.
 */
function paneAddonsPlugins() {
  const addons = state.sources.filter((s) => ADDON_TYPES.some(([t]) => t === s.type));
  // **Add-ons only.** The Nuvio plugin half of this pane is gone: a plugin is code
  // the Nuvio app runs itself, and the server-side runner for it was removed with it.
  return [
    ...sourceSection("Stremio add-ons", "A Stremio add-on URL is read on the server (manifest.json), so it works even when the host sends no CORS headers — its catalogs, metadata, streams and subtitles are listed as providers. A stream the add-on publishes as a torrent is played through your debrid account when one is set up in Settings → Debrid — a browser cannot join a public swarm on its own, so that account is what makes those streams play.", ADDON_TYPES, addons),
  ];
}

/* --------------------------------------------------------------- Custom Rows */

/** When the row list was last read, so the pane's own redraw cannot loop. */
let customRowsFetchedAt = 0;

/**
 * Settings → Custom Rows: the card's rows, and only its rows.
 *
 * **What this pane is, and what it deliberately is not.** It manages the *rows*: add one,
 * rename it, delete it, move it up or down. It does not list what is inside a row — the
 * card goes into a row from a title page, and a settings screen that also listed every
 * title would be a second, worse home screen. The calendar's own row is not here either:
 * it is filled by the calendar, not by hand, so it is not one of "your" rows.
 *
 * The read is fresh when the pane opens (with a floor, so a redraw cannot loop), which is
 * what makes it agree with the pin buttons on a title page.
 */
function paneCustomRows() {
  if (Date.now() - customRowsFetchedAt > 1500) {
    customRowsFetchedAt = Date.now();
    get("/custom-rows.json")
      .then((res) => {
        if (Array.isArray(res?.rows)) state.customRows = res.rows;
        if (state.settingsSection === "customrows") render();
      })
      .catch(() => { /* offline: the pane shows the rows the app already knows */ });
  }

  const rows = state.customRows || [];
  const max = 6;
  const newName = el("input", { class: "text-input focusable", type: "text", id: "custom-row-name", maxlength: "40", placeholder: "New row name" });
  const addNote = el("span", { class: `source-status${state.customRowNote ? (state.customRowNote.ok ? " ok" : " bad") : ""}`, text: state.customRowNote?.text || "" });
  const setNote = (text, ok = false) => {
    state.customRowNote = text ? { text, ok } : null;
    addNote.className = `source-status${ok ? " ok" : text ? " bad" : ""}`;
    addNote.textContent = text || "";
  };
  newName.addEventListener("input", () => setNote(""));

  const rowEditor = (row, index) => {
    const input = el("input", { class: "text-input focusable", type: "text", id: `custom-row-name-${row.id}`, maxlength: "40", value: row.name });
    // **No "2 cards" label.** It counted the cards in the row, which is the one thing this
    // pane is not about: the rows are named and ordered here, and what is in them is said
    // on the card itself. A number that changes as you add titles was a counter to keep
    // reading, not information.
    return el("div", { class: "site-row", id: `customrow-${row.id}` },
      el("div", { class: "site-body" },
        el("div", { class: "source-form" },
          input,
        ),
      ),
      el("div", { class: "source-actions" },
        // **The order is the card's order.** The arrows move a row one place; the first
        // and last are disabled rather than wrapping around.
        el("button", {
          class: "btn subtle focusable source-move", type: "button", id: `custom-row-up-${row.id}`,
          text: "↑", title: index ? "Move this row up" : "It is already first",
          disabled: index === 0,
          onclick: () => moveCustomRow(row.id, -1),
        }),
        el("button", {
          class: "btn subtle focusable source-move", type: "button", id: `custom-row-down-${row.id}`,
          text: "↓", title: index < rows.length - 1 ? "Move this row down" : "It is already last",
          disabled: index >= rows.length - 1,
          onclick: () => moveCustomRow(row.id, 1),
        }),
        el("button", {
          class: "btn subtle focusable",
          type: "button",
          id: `custom-row-delete-${row.id}`,
          text: "Delete",
          disabled: rows.length <= 1,
          title: rows.length <= 1 ? "The card needs at least one row" : "Delete this row and the cards in it",
          onclick: async () => {
            const res = await post("/custom-rows/delete", { id: row.id }).catch(() => null);
            setNote(res?.message || "Deleted.", res?.ok === true);
            await loadCustomRows();
            render();
          },
        }),
        // **Edit, and it sits after the arrows.** It was called "Rename" and lived in the
        // name field, before the order controls — so the buttons read Edit, ↑, ↓, Delete in
        // no order at all. It is the same action the Website rows offer, under the same
        // word, in the same place: last but one, after the two that move the row.
        el("button", {
          class: "btn primary focusable",
          type: "button",
          id: `custom-row-edit-${row.id}`,
          text: "Edit",
          onclick: async () => {
            const res = await post("/custom-rows/rename", { id: row.id, name: input.value.trim() }).catch(() => null);
            setNote(res?.message || "Saved.", res?.ok === true);
            await loadCustomRows();
            render();
          },
        }),
      ),
    );
  };

  return [
    el("p", {
      class: "option-desc",
      text: `The rows your own card is made of. A title goes into one of them from a title page — the “Add to …” buttons beside the watch states — and this is where the rows themselves are named and ordered. Each row is published as its own row on the ${customLabel()} card, in this order.`,
    }),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Add a row" }),
      el("span", { class: "option-desc", text: `The card holds up to ${max} rows.` }),
    ),
    el("div", { class: "source-form" },
      newName,
      el("button", {
        class: "btn primary focusable",
        type: "button",
        id: "custom-row-add",
        text: "Add row",
        disabled: rows.length >= max,
        onclick: async () => {
          const res = await post("/custom-rows/add", { name: newName.value.trim() }).catch(() => null);
          setNote(res?.message || (res?.ok ? "Added." : "Could not add that row."), res?.ok === true);
          newName.value = "";
          await loadCustomRows();
          render();
        },
      }),
      addNote,
    ),
    el("div", { class: "group-head" },
      el("span", { class: "option-title", text: "Rows" }),
      el("span", { class: "option-desc", text: "Rename in place, reorder with the arrows, or delete a row with everything in it." }),
    ),
    ...(rows.length ? rows.map(rowEditor) : [el("p", { class: "option-desc", text: "No rows yet." })]),
  ];
}

/** Read the rows back, so the pane and the pin buttons agree. */
async function loadCustomRows() {
  const res = await get("/custom-rows.json").catch(() => null);
  if (Array.isArray(res?.rows)) state.customRows = res.rows;
  return res;
}

async function moveCustomRow(id, delta) {
  const res = await post("/custom-rows/move", { id, delta }).catch(() => null);
  if (Array.isArray(res?.rows)) state.customRows = res.rows;
  render();
}

function renderRecordings() {
  const list = recordingsGet();
  const now = Date.now();
  const upcoming = list.filter((r) => r.stop > now).sort((a, b) => a.start - b.start);
  const past = list.filter((r) => r.stop <= now).sort((a, b) => b.stop - a.stop);
  const mkRow = (r) => el("button", {
    class: "cal-live-row focusable",
    type: "button",
    title: "Remove recording",
    onclick: () => { toggleRecordProgramme({ id: r.channelId, name: r.channelName, logo: r.channelLogo }, { start: r.start, stop: r.stop, title: r.title }); },
  }, el("span", { class: "cal-live-time", text: `${clockOf(r.start)} – ${clockOf(r.stop)}` }), r.channelLogo ? el("img", { class: "cal-live-logo", src: r.channelLogo, alt: "" }) : el("span", { class: "cal-live-logo fallback", text: (r.channelName || "?").slice(0,1).toUpperCase() }), el("span", { class: "cal-live-what" }, el("span", { class: "cal-live-title", text: r.title }), el("span", { class: "cal-live-channel", text: r.channelName })));
  return [
    el("h1", { class: "view-title", text: "Recordings" }),
    el("p", { class: "view-hint", text: `${list.length} recordings · ${upcoming.length} upcoming` }),
    el("h2", { class: "view-title", style: "font-size:1.2rem;margin-top:1rem", text: "Upcoming" }),
    upcoming.length ? el("div", { class: "cal-list" }, ...upcoming.map(mkRow)) : el("p", { class: "empty", text: "No upcoming recordings" }),
    el("h2", { class: "view-title", style: "font-size:1.2rem;margin-top:1.5rem", text: "Past" }),
    past.length ? el("div", { class: "cal-list" }, ...past.map(mkRow)) : el("p", { class: "empty", text: "No past recordings" }),
  ];
}

function renderSettings() {
  const section = state.settingsSection;

  const panes = {
    // **The EPG is where the channels come from**, not a section beside it: a guide URL is
    // one more thing the source needs, so it is asked for in the Source pane.
    livesource: () => [...paneLiveSource(), el("div", { class: "h-divider", "aria-hidden": "true" }), ...paneLiveGuide()],
    livecountries: paneLiveCountries,
    liverefresh: paneLiveRefresh,
    profile: paneProfile,
    posters: panePosters,
    // Trackers and providers are their own panes now — the two halves of the old
    // "Trackers & providers" tab, each under its own name.
    tracking: paneTracking,
    providers: paneProviders,
    debrid: paneDebrid,
    subtitles: paneSubtitles,
    dns: paneDns,
    customsites: paneCustomSites,
    customrows: paneCustomRows,
    ratings: paneRatings,
    ai: paneAi,
    content: paneContent,
    addons: paneAddonsPlugins,
    plugins: paneAddonsPlugins,
    layout: paneLayout,
    appearance: paneAppearance,
    animation: paneAnimation,
    sound: paneSound,
    notifications: paneNotifications,
    livelayout: paneLayout,
  };

  // A stored section that does not exist for this profile (the Live TV profile has
  // its own set) falls back to that profile's first section.
  const sections = settingsSections();
  const active = sections.find(([id]) => id === section) || sections[0];

  // **The sections are a grid of tiles, not a column of links.** Each group is a small
  // panel holding its own two-column grid, and a tile is the door to that section. It
  // reads as a settings *board*: the whole of what there is to change is visible at once,
  // instead of a list that has to be read top to bottom to find one item.
  // **One board, every door.** Each section is its own tile in one grid — no group box
  // around a handful of them, and no heading to read first. `settingsGroups()` still
  // returns groups (a profile can add more), but a group with no name draws no box: its
  // tiles join the same grid as everyone else's.
  const nav = el("nav", { class: "settings-nav", "aria-label": "Settings sections" },
    ...settingsGroups().map((group) =>
      el("div", { class: `settings-tiles${group.group ? "" : " flat"}` },
        ...group.sections.map(([id, label]) =>
          el("button", {
            class: `settings-tab focusable${id === active[0] ? " active" : ""}`,
            type: "button",
            "aria-current": id === active[0] ? "true" : false,
            text: label,
            onclick: () => {
              state.settingsSection = id;
              localStorage.setItem(KEY.section, id);
              render();
            },
          }),
        ),
      ),
    ),
  );

  // **And the options are a grid too.** A pane's own output is wrapped in one grid, so
  // its switches sit two to a row and its panels stay full width — the same board idea one
  // level down. Nothing about a pane's own internals is restated here; this only decides
  // how the pieces it hands back are laid out.
  const body = el("section", { class: "setting" },
    el("h3", { text: active[1] }),
    el("div", { class: "setting-grid" }, ...(panes[active[0]] || paneProfile)()),
  );

  return [
    el("h1", { class: "view-title", text: "Settings" }),
    // **No "Profile: VOD" line.** The tile you are on already says what you are changing,
    // and the top bar already says which profile you are in.
    el("div", { class: "settings" }, nav, el("div", { class: "settings-pane" }, body)),
  ];
}

/* ------------------------------------------------------------------- chrome */

/**
 * The name the top bar shows for a screen whose name is not in its route.
 *
 * Only a title page needs it — `#/t/movie/27205` is an id, not a name. The page sets
 * this once its own data has arrived and asks the bar to draw again, so the label
 * arrives with the page rather than on the next render.
 */
let chromeLabel = "";

/**
 * Name the screen being drawn in the top bar.
 *
 * A late answer from a screen you have already left is dropped: the name only lands
 * while the route is still the one that asked for it.
 */
function setChromeLabel(text) {
  const now = parseHash();
  if (now.view !== "title") return;
  chromeLabel = text || "";
  renderTabs();
}

/** The profile button is an icon — the profile it stands for lives in its title. */
function renderProfile() {
  const btn = document.getElementById("profile");
  const label = `${currentPerson().name} · ${state.profile} — switch profile`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function renderTabs() {
  const tabs = document.getElementById("tabs");
  const parsed = parseHash();
  const card = cardByKey(parsed.key);
  // **The bar names the screen you are on.** A card wears its name, an **Explore page
  // the catalog you are inside** — the genre or runtime you picked (`Runtimes › 30–44
  // mins` names the row, so the chip you are reading it by is what goes up here) — and
  // a **title page the title itself**. Only Home keeps the clickable tab; settings,
  // search, the calendar, the guide and the live screens wear the arrow alone.
  let label = "";
  if (parsed.view === "card" && card) {
    label = titleOf(card);
  } else if (parsed.view === "explore" && card) {
    const cat = rowOf(card).catalogs.find((c) => c.id === parsed.id);
    label = cat ? cat.name : "";
  } else if (parsed.view === "title") {
    // A title's route carries a TMDB id, not a name, so the page hands it in once its
    // own data has arrived (see `setChromeLabel`).
    label = chromeLabel;
  }
  // Built as a list and filtered rather than handed to `replaceChildren` directly:
  // that call stringifies a non-node, so a bare `null` in the arguments lands on the
  // page as the word "null" instead of being dropped (`el` drops it — this is not `el`).
  const children = [];
  if (label) {
    // The same rule the Home group wears, drawn for the name: the left-hand group is
    // gone on these screens, so it would otherwise sit against nothing.
    children.push(el("span", { class: "top-divider", "aria-hidden": "true" }));
    // **The name is a label, not a door.** It used to be a Home button, so pressing
    // the name of the card you were reading threw you out of it. Leaving is the
    // arrow's job (`#back`), which sits right beside this — so the name is drawn as
    // plain text: no click, no focus stop, nothing to press.
    children.push(el("span", { class: "tab tab-title", text: label }));
  } else if (parsed.view === "home") {
    children.push(
      el("button", {
        class: "tab focusable",
        type: "button",
        role: "tab",
        "aria-selected": "true",
        // **An arrow, not a hand.** Home is a place you are, not a link out of the app —
        // and the pointer over four words of a tab bar read as a door to somewhere else.
        style: "cursor: default",
        text: "Home",
        onclick: () => go("#/"),
      }),
    );
  }
  tabs.replaceChildren(...children);
  // Nothing to draw (an Explore page, a title, settings) → the slot goes with the
  // label, so no margin or gap is left sitting beside the arrow on its own.
  tabs.hidden = !children.length;
}

/**
 * Take the boot screen away once the first screen is on the page.
 *
 * The fade is CSS; this only flips the class after that first paint, so what
 * appears behind the splash is a finished screen rather than an empty shell. The
 * node is hidden once the fade is over so it cannot swallow a click.
 */
/** When the splash went up, so the opening sequence is always seen once. */
const bootShownAt = Date.now();
/**
 * **The sequence is not cut off by a warm server.** The splash comes down when the first
 * screen is drawn, which on a warm catalog is a few hundred milliseconds — the line would
 * barely start to fill and the wordmark would never finish. So it is held for the length
 * of the opening (the fill, then the last two letters), and no longer.
 */
// The opening is three beats — the line fills, the cat resolves into the C, and the last
// two letters arrive at 2.25s and 2.6s — so this is a little past its end, and a warm
// catalog cannot cut it short.
const BOOT_MIN_MS = 3200;

/** A screen the page was linked to, to be taken once a mode has been chosen. */
let pendingDeepLink = "";

function endBoot() {
  const bootScreen = document.getElementById("boot");
  if (!bootScreen || bootScreen.classList.contains("done")) return;
  const left = BOOT_MIN_MS - (Date.now() - bootShownAt);
  // Still inside the opening: come back when it is over, rather than shortening it.
  if (left > 0) {
    if (!endBoot.pending) {
      endBoot.pending = true;
      setTimeout(() => { endBoot.pending = false; endBoot(); }, left);
    }
    return;
  }
  bootScreen.classList.add("done");
  setTimeout(() => { bootScreen.hidden = true; }, 700);
}

/** Which screen a route points at, for remembering where it was scrolled. */
const routeOf = (r) => [r.view, r.key || "", r.id || "", r.name || "", r.group || ""].join("|");

/** Where each screen was last left, so going back does not land at the top. */
const scrollMemory = new Map();
let lastRoute = "";

/** Which render is the newest, so a watchdog cannot report on a screen already left. */
let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  // Armed before the first await: the screen's own request is what can hang.
  watchRender(seq);
  const parsed = parseHash();
  const { view, key, id, name, group, type, kind, extra } = parsed;
  const browsing = ["home", "card", "explore"].includes(view);
  // A name handed in by the screen being drawn (a title page) belongs to that screen
  // only, so the next one never inherits the last title's name.
  chromeLabel = "";

  // A screen you are **returning to** is put back where you left it, and a screen
  // you are **already on** does not move at all — a pin, a filter or a settings
  // toggle re-renders the same route and must not throw the page back to the top,
  // which is what a bare `scrollTo(0)` here used to do on every click.
  const route = routeOf(parsed);
  // A redraw of the screen you are **already on** (a toggle, a source being read, the
  // banner's own move) must not replay the entry animation — that restart, on every
  // redraw, is the blink the Add-ons screen was doing.
  // A screen that redraws is a screen the preview no longer belongs to.
  hidePreview();
  const sameScreen = route === lastRoute;
  const wasAt = window.scrollY;
  if (lastRoute && lastRoute !== route) scrollMemory.set(lastRoute, wasAt);
  const restore = route === lastRoute ? wasAt : scrollMemory.get(route) ?? 0;
  lastRoute = route;

  // **The four app-level controls live on Home.** The profile switch, the calendar,
  // search and settings are all ways *into* something; drawn on a card, a channel or a
  // settings pane they sat over the content as a second, unrelated set of doors. They
  // are Home's now — the back arrow and the bar's own label are how you leave a card.
  const onHome = view === "home";
  document.getElementById("tabs").hidden = !browsing;
  document.getElementById("back").hidden = ["home", "profiles", "modes"].includes(view);
  // **The arrow's own rule.** Only the screens reached *from* a title page wear it —
  // the lists a name on a title opens (a credit, a studio, a network, a genre) and the
  // season screen — so the back arrow reads as the head of that page rather than one
  // control floating in the bar. Home and the rest keep the bare arrow.
  document.getElementById("back-divider").hidden = !(
    view === "list" && ["person", "company", "network", "genre", "season", "country", "keyword", "collection"].includes(parseHash().kind)
  );
  document.getElementById("settings").hidden = !onHome;
  document.getElementById("search").hidden = !onHome;
  document.getElementById("calendar").hidden = !onHome;
  document.getElementById("profile").hidden = !onHome;
  // The dividers and the profile/calendar pair are one group, so the rule between them
  // and the tabs goes with them rather than staying as a stroke with nothing beside it.
  document.getElementById("top-left").hidden = !onHome;
  // Only the OTT cards' rows are read in one of the five orders; every other screen
  // asks for its rows the way it always did.
  // The order rides on the request only where the dropdown is offered — the ◆ Top 10
  // OTT cards' Explore page — so no other row can be served in an order it never asked
  // for (and two orders cannot share a pool that was built for one of them).
  activeOttSort = view === "explore" && isOttTop10Card(cardByKey(key)) ? state.ottSort : "";
  renderProfile();

  let nodes;
  // **A screen that throws is a screen with something to say.** Every branch below can
  // ask the server for something, and any of them can fail or answer with nothing —
  // which used to leave `#main` empty: a black page under a working top bar, with the
  // watchdog as the only thing that would ever explain it. The failure is drawn now.
  try {
  if (view === "guide") nodes = renderGuide();
  else if (view === "recordings") nodes = renderRecordings();
  else if (view === "categories") nodes = renderLiveCategories();
  else if (view === "category") nodes = renderLiveCategory(group);
  else if (view === "channel") nodes = renderChannel(id);
  else if (view === "title") nodes = await renderTitle(type, id);
  else if (view === "list") nodes = await renderList(kind, id, type, extra);
  else if (view === "profiles") nodes = renderPeople();
  else if (view === "modes") nodes = renderModes();
  else if (view === "card") nodes = await renderCard(key);
  else if (view === "explore") nodes = renderExplore(key, id);
  else if (view === "sources") nodes = renderSources(id, name);
  else if (view === "settings") nodes = renderSettings();
  else if (view === "search") nodes = liveProfile() ? renderLiveSearch() : renderSearch();
  else if (view === "calendar") nodes = renderCalendar();
  // The second profile has its own Home — the channels, not the cards.
  else nodes = liveProfile() ? renderLiveHome() : renderHome();
  } catch (err) {
    nodes = [screenError(err, view)];
  }

  const main = document.getElementById("main");
  // An empty answer is a failure too, so it gets the same panel rather than a blank page.
  main.replaceChildren(...(Array.isArray(nodes) && nodes.length ? nodes : [screenError(null, view)]));
  // Now that the frames are in the document, lay the cards' own pictures into
  // them — in place of the generated vector scene.
  hydrateContent();
  // One class, animation defined in the stylesheet: a new screen arrives instead of
  // appearing, and "no animation" removes it entirely. The screen you are already on
  // keeps its class, so a redraw does not restart the fade.
  if (!sameScreen) {
    main.classList.remove("view-in");
    void main.offsetWidth;
    main.classList.add("view-in");
  }
  renderTabs();
  syncProfileMark();
  window.scrollTo({ top: restore });
  // The screen is drawn: nothing to warn about.
  clearTimeout(renderWatchdog);

  // Only Home has a banner: the ten-second rotation runs there, and any other screen
  // stops it rather than leaving a timer redrawing a banner that is not on screen.
  // The Live TV profile has no banner to rotate — its first card is the Guide.
  if (view === "home" && !liveProfile()) startHeroRotation();
  else {
    stopHeroRotation();
    // The Upcoming card's still lives on Home too, so leaving Home stops its clock
    // rather than leaving a timer redrawing a card that is not on the page.
    stopSpotlight();
  }
  // The catalog refresh runs on every browsing view, not just Home.
  startAutoRefresh();
  // A source stored without its providers is read once, so its providers appear
  // without anyone having to press anything.
  queueMicrotask(hydrateSources);
}

/* ------------------------------------------------------------ keyboard nav */

/**
 * Wheel over the titles scrolls the titles — and only the titles.
 *
 * Pointing at a row and scrolling is how you browse cards, so the wheel moves
 * the row under the cursor *instead of* the page. That stays true at either end
 * of the row as well: the page must not start scrolling because the row ran out,
 * which used to drag the whole screen away the moment a row ended. The page
 * scrolls normally anywhere the cursor is not over a row of titles.
 *
 * Shift+wheel and trackpad horizontal gestures keep their normal meaning.
 */
const ROW_SELECTOR = ".strip, .icons.rows, .people, .company-strip, .ratings";

/** Is the app asked not to animate? "Always" overrides the system preference. */
const reducedMotion = () => {
  const root = document.documentElement;
  if (root.classList.contains("motion-full")) return false;
  if (root.classList.contains("motion-off")) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
};

/**
 * Scroll a row smoothly instead of jumping one wheel-notch at a time.
 *
 * A raw `scrollLeft += delta` per wheel event is what made the rows feel rough:
 * the browser fires a burst of wheel events with uneven deltas, and every one of
 * them snapped the row to a new position. Here the wheel only moves a *target*,
 * and a frame loop eases the row toward it, so a flick glides and a slow scroll
 * creeps. With motion switched off it goes straight to the target.
 */
const glides = new WeakMap();

function glide(row, target) {
  if (reducedMotion()) {
    row.scrollLeft = target;
    return;
  }
  const anim = glides.get(row) || { target: row.scrollLeft, raf: 0 };
  anim.target = target;
  glides.set(row, anim);
  if (anim.raf) return;
  const step = () => {
    const delta = anim.target - row.scrollLeft;
    if (Math.abs(delta) < 0.6) {
      row.scrollLeft = anim.target;
      anim.raf = 0;
      return;
    }
    row.scrollLeft += delta * 0.24;
    anim.raf = requestAnimationFrame(step);
  };
  anim.raf = requestAnimationFrame(step);
}

function horizontalWheel() {
  document.addEventListener(
    "wheel",
    (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      // A menu, the modal or a dropdown keeps its own scrolling.
      if (e.target?.closest?.(".cat-menu, .modal-card, .settings-nav, .search-suggest")) return;
      const row = e.target?.closest?.(ROW_SELECTOR);
      // A row that has nothing clipped scrolls nowhere — leave that to the page.
      if (!row || row.scrollWidth - row.clientWidth <= 1) return;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      // The page never moves while the cursor is on the titles: the row takes the
      // wheel to its end and then simply stops.
      e.preventDefault();
      glide(row, Math.max(0, Math.min(row.scrollWidth - row.clientWidth, row.scrollLeft + delta)));
    },
    { passive: false },
  );
}

function setupInput() {
  // **Back goes back**, the way a browser's Back does — to the screen you were on,
  // not to Home. It used to jump straight to `#/` from anywhere, which is why
  // leaving a title page landed you on Home even when you had come from a row.
  document.getElementById("back").addEventListener("click", () => {
    const { view, key } = parseHash();
    if (history.length > 1) {
      history.back();
      return;
    }
    if (view === "explore") go(`#/c/${encodeURIComponent(key)}`);
    else go("#/");
  });
  document.getElementById("settings").addEventListener("click", () => go("#/settings"));
  document.getElementById("search").addEventListener("click", () => go("#/search"));
  document.getElementById("calendar").addEventListener("click", () => go("#/calendar"));

  // The profile icon opens the switch-profile screen (it no longer drops a menu).
  document.getElementById("profile").addEventListener("click", () => {
    if (parseHash().view === "profiles") return;
    go("#/profiles");
  });

  document.getElementById("modal-sources").addEventListener("click", () => {
    if (!modalItem) return;
    go(`#/s/${encodeURIComponent(modalItem.id)}/${encodeURIComponent(modalItem.name || "Title")}`);
    modal.close();
  });

  for (const node of document.querySelectorAll("[data-close]")) node.addEventListener("click", () => modal.close());
  window.addEventListener("hashchange", render);
  horizontalWheel();

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (typing) return;
    // A **disabled** control is not somewhere the D-pad can land: focusing it does
    // nothing, so the cursor would appear stuck on it.
    const list = [...document.querySelectorAll(".focusable")].filter((n) => n.offsetParent !== null && !n.disabled);
    const cur = document.activeElement;
    let i = list.indexOf(cur);

    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (!list.length) return;
      e.preventDefault();
      i = i === -1 ? 0 : i + (e.key === "ArrowRight" ? 1 : -1);
      list[Math.max(0, Math.min(list.length - 1, i))].focus();
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!list.length) return;
      e.preventDefault();
      if (i === -1) return list[0].focus();
      const from = cur.getBoundingClientRect();
      let best = null;
      let bestScore = Infinity;
      for (const node of list) {
        if (node === cur) continue;
        const r = node.getBoundingClientRect();
        const dy = r.top - from.top;
        if (e.key === "ArrowDown" && dy < 12) continue;
        if (e.key === "ArrowUp" && dy > -12) continue;
        const score = Math.abs(dy) * 3 + Math.abs(r.left - from.left);
        if (score < bestScore) {
          bestScore = score;
          best = node;
        }
      }
      if (best) best.focus();
      return;
    }

    if (e.key === "Escape" || e.key === "Backspace") {
      if (!modal.root.hidden) return modal.close();
      if (parseHash().view !== "home") { e.preventDefault(); go("#/"); }
    }
  });
}

/* ---------------------------------------------------------- Live TV & Sports */

/**
 * The second profile is a different app.
 *
 * It has its own two buttons (Live TV / Sports, where Movies & Shows has
 * Movies / Shows), its own cards — the channels, grouped by the playlist's own
 * categories, with the Guide as the first card — its own screens (the TiviMate-
 * style Guide and a channel page) and its own settings, which replace the
 * Movies & Shows ones entirely rather than sitting beside them.
 */
const LIVE_ROWS = [["livetv", "Live TV"], ["sports", "Sports"]];
const liveProfile = () => state.profile === LIVE_PROFILE;

const liveRowKey = () => state.liveRow;
const setLiveRow = (value) => {
  state.liveRow = value;
  localStorage.setItem(KEY.liveRow, value);
};

/** The Live TV / Sports switch — the profile's own two buttons. */
function liveRowSwitch() {
  return el(
    "div",
    { class: "row-switch", role: "tablist", "aria-label": "Live TV or Sports" },
    ...LIVE_ROWS.map(([value, label]) =>
      el("button", {
        class: `row-btn focusable${liveRowKey() === value ? " active" : ""}`,
        type: "button",
        role: "tab",
        id: `live-row-${value}`,
        "aria-selected": String(liveRowKey() === value),
        text: label,
        onclick: () => {
          setLiveRow(value);
          render();
        },
      }),
    ),
  );
}

/** The live source, as the app keeps it (the server keeps its own masked copy). */
function liveSource() {
  const live = {
    // `dth` is the premium/DTH/operator catalogue — the profile's own source. `m3u`
    // and `xtream` are your own box's export.
    mode: "dth",
    m3u: "",
    host: "",
    username: "",
    password: "",
    epg: "",
    refreshMinutes: 0,
    // Which of the catalogue's providers this profile is drawn from. Empty means
    // "not picked yet", and the app says so rather than showing an empty profile.
    providers: [],
    // Which countries of the catalogue this profile is scoped to. `allCountries`
    // means every country the catalogue covers; a picked list means just those.
    countries: [],
    allCountries: false,
    ...state.liveSource,
  };
  // A stored mode from before the catalogue replaced the public directory says
  // "demo", which is not a source any more — land on the catalogue rather than on a
  // pane with nothing selected.
  if (!["dth", "m3u", "xtream"].includes(live.mode)) live.mode = "dth";
  if (!Array.isArray(live.providers)) live.providers = [];
  return live;
}

/**
 * The countries Live TV is scoped to, as the `countries=` parameter.
 *
 * Empty means "no filter": either every country is enabled or none is picked, and
 * the whole directory is in play either way. This one string is what the Guide, the
 * Categories card and the channel rows all read, so one setting moves them together.
 */
const liveCountriesPicked = () => {
  const live = liveSource();
  if (live.allCountries) return "";
  return (Array.isArray(live.countries) ? live.countries : []).map((c) => String(c).toUpperCase()).join(",");
};

/**
 * Read the lineup.
 *
 * **Picking countries does not cut the lineup down to them.** It scopes which
 * guides and which DTH providers are read (and therefore whose programme data the
 * guide holds); the channel card is the whole playlist you are subscribed to, which
 * is what it was drawn from before the setting existed. Passing the picked list as
 * the channels' own filter is what made selecting a country shrink the card to that
 * country's categories.
 */
const liveFetch = (params = {}, force = false) => {
  const p = new URLSearchParams({ limit: "400", ...params });
  if (force) p.set("force", "1");
  return get(`/live/channels.json?${p.toString()}`);
};

/**
 * Read the channels: the full list once, then one row per category.
 *
 * Rows are per category because that is what the request asked for — cards like
 * the Movies & Shows ones — and because one request per row keeps each row's
 * payload small however large the playlist is.
 */
async function loadLive({ force = false } = {}) {
  if (state.live.loading) return;
  state.live = { ...state.live, loading: true };
  render();
  try {
    // **One read, not one per group.** Live TV used to fetch the lineup and then a
    // second request per category to draw a channel row for each one — a dozen calls
    // to paint rows nobody asked for. The profile is two cards and the channels are
    // inside them, so the lineup is read once and the categories come from the
    // server's own group list.
    const first = await liveFetch({ limit: String(LIVE_CHANNEL_LIMIT) }, force);
    state.live = {
      loading: false,
      loaded: true,
      all: first.channels || [],
      total: first.total || 0,
      groups: (first.groups || []).map((g) => g.name).filter((name) => name && name !== "General"),
      // The server's own group list — name *and* channel count — which is what the
      // Channels screen draws its tiles from.
      groupList: first.groups || [],
      updated: first.updated || 0,
      error: first.error || "",
      guide: state.live.guide,
      guideLoading: false,
      guideError: state.live.guideError,
    };
  } catch (err) {
    state.live = { ...state.live, loading: false, loaded: true, error: String((err && err.message) || err) };
  }
  render();
}

/**
 * Every channel currently on screen, for the Guide, the cards and lookups.
 *
 * The **Sports** tab is the Live TV lineup filtered to sport — by the channel's own
 * name and its groups — rather than a second list built from category rows. A
 * lineup with nothing sport-shaped in it falls back to the whole list, so the tab
 * is never an empty screen on a playlist that simply does not carry any.
 */
function liveChannelsShown() {
  const all = state.live.all || [];
  // **The country you picked scopes the lineup — all of it.** The setting used to
  // only decide whose guide was read, so the card and the guide showed the whole
  // world's playlist under a country heading, and the channels that country declares
  // were a slice of a mixed list. Picking India or the US now leaves *that* country's
  // channels and nothing else — every one of them, not the first pageful.
  const codes = liveCountriesPicked().split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  // **A channel with no country is never filtered out.** Your add-ons' own channels carry
  // no country of this catalogue's — dropping them the moment a country was picked is how
  // "pick India" would have made every add-on channel disappear.
  const inCountry = codes.length
    ? all.filter((c) => !c.country || codes.includes(String(c.country).toUpperCase()))
    : all;
  const list = inCountry.length ? inCountry : all;
  if (liveRowKey() !== "sports") return list;
  const sport = list.filter((c) => /sport/i.test(`${c.name || ""} ${(c.groups || []).join(" ")}`));
  return sport.length ? sport : list;
}

const findChannel = (id) => liveChannelsShown().find((c) => c.id === id) || (state.live.all || []).find((c) => c.id === id) || null;

/**
 * **The same channel, published as another feed.**
 *
 * A DTH catalogue lists one channel several times: the SD and the HD feed are
 * separate entries with separate ids and separate `tvg-id`s, and often only some of
 * them carry a stream URL, because the free-to-air lists publish the HD feed while
 * the operator's own listing is the SD one. Tapping `Sony Max SD` therefore ended at
 * "no stream" with `Sony Max HD` one row away, playing. The names are compared with
 * the quality markers dropped, so the feeds of one channel meet each other; a
 * genuinely different channel does not, because what is left is not the same name at
 * all (`Sony Max 2` does not meet `Sony Max`, `Sony Ten 1` does not meet `Sony Ten 2`).
 * A country is never crossed when both declare one, and a channel one of your add-ons
 * published is left to that add-on — its own stream is the right one to ask for.
 */
function siblingChannelWithUrl(channel) {
  if (!channel) return null;
  const keyOf = (c) =>
    String(c.name || "")
      .toLowerCase()
      .replace(/\b(sd|hd|fhd|uhd|4k|8k|1080p|720p|576p|480p|hevc|h\.?26[45])\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const want = keyOf(channel);
  if (!want) return null;
  const country = String(channel.country || "").toUpperCase();
  const matches = (state.live.all || []).filter(
    (c) =>
      c &&
      c.id !== channel.id &&
      c.url &&
      keyOf(c) === want &&
      (!country || !c.country || String(c.country).toUpperCase() === country),
  );
  if (!matches.length) return null;
  // The closest name wins — the sibling with the fewest extra words.
  return matches.sort((a, b) => String(a.name || "").length - String(b.name || "").length)[0];
}

/* ------------------------------------------------------------------- guide */

/** Read the guide: programme blocks per channel id, when an EPG URL is set. */
async function loadGuide({ force = false } = {}) {
  if (state.live.guideLoading) return;
  state.live = { ...state.live, guideLoading: true };
  render();
  try {
    const picked = liveCountriesPicked();
    const guide = await get(
      `/live/guide.json?hours=6${force ? "&force=1" : ""}${picked ? `&countries=${encodeURIComponent(picked)}` : ""}`,
    );
    state.live = { ...state.live, guideLoading: false, guide, guideError: guide.error || "" };
  } catch (err) {
    state.live = { ...state.live, guideLoading: false, guideError: String((err && err.message) || err) };
  }
  render();
}

const minutesLeft = (ms) => Math.max(0, Math.round(ms / 60_000));
const clockOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The programme on now, and the one after, for one channel. */
function nowNext(channel, guide) {
  const key = channel.epgId || channel.id;
  const list = guide?.programmes?.[key] || [];
  const now = Date.now();
  const index = list.findIndex((p) => p.start <= now && p.stop > now);
  if (index === -1) return { now: null, next: list.find((p) => p.start > now) || null };
  return { now: list[index], next: list[index + 1] || null };
}

/**
 * The Guide — the TiviMate-shaped grid: a time ruler across the top, a channel
 * column down the left, and one block per programme.
 *
 * The blocks are real programmes when an XMLTV URL is set. Without one the grid
 * still draws the lineup and says so once at the top, rather than inventing a
 * schedule or hiding the screen.
 */
function renderGuide() {
  if (!state.live.loaded && !state.live.loading) queueMicrotask(() => loadLive());
  if (!state.live.guide && !state.live.guideLoading) queueMicrotask(() => loadGuide());

  let channels = liveChannelsShown().slice(0, LIVE_GUIDE_CHANNELS);
  const { guideCountry, guideCategory, guideSportsOnly } = state.live || {};
  if (guideCountry) {
    channels = channels.filter((c) => (c.country || "").toUpperCase() === guideCountry.toUpperCase());
  }
  if (guideCategory) {
    channels = channels.filter((c) => (c.groups || []).some((g) => g === guideCategory));
  }
  if (guideSportsOnly) {
    channels = channels.filter((c) => (c.groups || []).some((g) => /sport/i.test(g)) || /sport/i.test(c.name || ""));
  }
  const guide = state.live.guide;
  const hasEpg = Boolean(guide && guide.epg);
  const start = Date.now();
  const span = LIVE_GUIDE_HOURS * 3600_000;
  const hours = Array.from({ length: LIVE_GUIDE_HOURS }, (_, i) => start + i * 3600_000);

  const rows = channels.map((channel, i) => {
    const programs = hasEpg ? (guide.programmes[channel.epgId || channel.id] || []) : [];
    const blocks = programs
      .filter((p) => p.stop > start && p.start < start + span)
      .map((p) => {
        const from = Math.max(p.start, start);
        const to = Math.min(p.stop, start + span);
        const left = ((from - start) / span) * 100;
        const width = Math.max(((to - from) / span) * 100, 2);
        return el(
          "div",
          { class: "guide-block", style: `left:${left}%;width:${width}%` },
          el("span", { class: "guide-block-title", text: p.title }),
          el("span", { class: "guide-block-time", text: `${clockOf(p.start)} – ${clockOf(p.stop)}` }),
        );
      });
    return el(
      "div",
      { class: "guide-row" },
      el(
        "button",
        {
          class: "guide-channel focusable",
          type: "button",
          title: `Open ${channel.name}`,
          onclick: () => go(`#/channel/${encodeURIComponent(channel.id)}`),
        },
        el("span", { class: "guide-num", text: String(i + 1) }),
        channel.logo
          ? el("img", { class: "guide-logo", src: channel.logo, alt: "", loading: "lazy" })
          : el("span", { class: "guide-logo fallback", text: (channel.name || "?").slice(0, 1).toUpperCase() }),
        el("span", { class: "guide-name", text: channel.name }, (() => {
          const res = channelResolution(channel.name);
          return res ? el("span", { class: "guide-res", text: res }) : null;
        })()),
      ),
      el(
        "div",
        { class: `guide-track${hasEpg ? "" : " bare"}` },
        hasEpg ? blocks : el("span", { class: "guide-nodata", text: "No programme data" }),
      ),
    );
  });

  const marker = ((Math.max(Date.now(), start) - start) / span) * 100;

  return [
    el("h1", { class: "view-title", text: "Guide" }),
    el("p", { class: "view-hint", text: `${channels.length} channels · the next ${LIVE_GUIDE_HOURS} hours` }),
    liveRowSwitch(),
    // Country and category filter strips for immersive guide
    (() => {
      const all = state.live.all || [];
      const countries = [...new Set(all.map((c) => (c.country || "").trim()).filter(Boolean))].sort();
      const groups = [...new Set(all.flatMap((c) => c.groups || []).filter(Boolean))].sort((a,b) => a.localeCompare(b));
      const chips = [];
      chips.push(el("button", {
        class: `chip focusable${!state.live.guideCountry && !state.live.guideCategory && !state.live.guideSportsOnly ? " active" : ""}`,
        type: "button",
        text: "All",
        onclick: () => { state.live.guideCountry = ""; state.live.guideCategory = ""; state.live.guideSportsOnly = false; render(); }
      }));
      countries.slice(0, 12).forEach((cc) => chips.push(el("button", {
        class: `chip focusable${state.live.guideCountry === cc ? " active" : ""}`,
        type: "button",
        text: cc,
        onclick: () => { state.live.guideCountry = state.live.guideCountry === cc ? "" : cc; render(); }
      })));
      groups.slice(0, 20).forEach((g) => chips.push(el("button", {
        class: `chip focusable${state.live.guideCategory === g ? " active" : ""}`,
        type: "button",
        text: g,
        onclick: () => { state.live.guideCategory = state.live.guideCategory === g ? "" : g; render(); }
      })));
      chips.push(el("button", {
        class: `chip focusable${state.live.guideSportsOnly ? " active" : ""}`,
        type: "button",
        text: "Sports",
        onclick: () => { state.live.guideSportsOnly = !state.live.guideSportsOnly; render(); }
      }));
      return el("div", { class: "cat-strip" }, chips);
    })(),
    hasEpg
      ? null
      : el("p", {
          class: "view-hint",
          text: "No guide data — add an XMLTV (EPG) URL under Settings → Source and these rows fill with real programmes.",
        }),
    el(
      "div",
      { class: "guide" },
      el(
        "div",
        { class: "guide-head" },
        el("span", { class: "guide-corner", text: "Channel" }),
        el(
          "div",
          { class: "guide-times" },
          ...hours.map((h) => el("span", { class: "guide-time", text: clockOf(h) })),
          // Where "now" is, so the grid reads like a live TV app's.
          el("span", { class: "guide-now", style: `left:${marker}%`, "aria-hidden": "true" }),
        ),
      ),
      el("div", { class: "guide-body" }, ...rows),
    ),
  ].filter(Boolean);
}

/* ----------------------------------------------------------------- channels */

/** One channel tile: logo, name, and the group/country it came with. */
function channelCard(channel) {
  return el(
    "button",
    {
      class: "channel-card focusable",
      type: "button",
      title: `${channel.name}${channel.groups?.length ? ` — ${channel.groups.join(", ")}` : ""}`,
      onclick: () => go(`#/channel/${encodeURIComponent(channel.id)}`),
    },
    el(
      "span",
      { class: "channel-art" },
      channel.logo
        ? el("img", { src: channel.logo, alt: "", loading: "lazy" })
        : el("span", { class: "channel-fallback", text: (channel.name || "?").slice(0, 1).toUpperCase() }),
    ),
    el("span", { class: "channel-name", text: channel.name }, (() => {
      const res = channelResolution(channel.name);
      return res ? el("span", { class: "channel-res", text: res }) : null;
    })()),
    el("span", { class: "channel-sub", text: [channel.groups?.[0], channel.country, channelResolution(channel.name) || ""].filter(Boolean).join(" · ") }),
  );
}

function channelRow(name, channels) {
  return el(
    "section",
    { class: "cat-row live-row", "data-group": name },
    el(
      "header",
      { class: "cat-head" },
      el("h2", { class: "cat-name", text: name }),
      el("span", { class: "cat-count", text: `${channels.length} channels` }),
    ),
    el("div", { class: "channel-strip" }, ...channels.map(channelCard)),
  );
}

/**
 * One Live TV card — the same box a Movies card wears.
 *
 * The profile's two cards used to be `hero` **banners**: a full-width panel with a
 * big title and two buttons, twice, one under the other. They are **cards** now,
 * exactly like Genres and Decades are on the Movies home: a 16:9 frame carrying the
 * first few rows of what is inside it, then the name and a line of description under
 * it — and the frame is the button, the way a cover is.
 */
function liveCard({ id, title, sub, rows, action, posters = [], grid = null }) {
  // **The frame holds six channel logos**, the way a Movies card holds its own
  // posters: a wall of `.content-tile`s in the same `.icon-wrap`. Only when there
  // is nothing to draw (no lineup read yet) does it fall back to the guide rows.
  // A card that carries a whole `grid` (the Guide card's TiviMate table) draws that
  // instead — the table has its own clickable rows, so it is never nested in a button.
  // **Six logos or a rectangle, never a gap.** The wall is a 3×2 grid, so a lineup that
  // yielded four channels drew four tiles and two empty slots — the gap on the card.
  // The wall now takes the largest count that fills a whole rectangle (6, 3, 2 or 1).
  const available = posters.filter((p) => p && (p.logo || p.name));
  const wallCount = available.length >= 6 ? 6 : available.length >= 3 ? 3 : available.length >= 2 ? 2 : available.length;
  const wall = available.slice(0, wallCount);
  const wallCols = wallCount === 1 ? 1 : wallCount === 2 ? 2 : 3;
  const filled = Boolean(grid) || wall.length > 0;
  return el(
    "div",
    { class: "icon-box live-card" },
    el(
      "div",
      { class: `icon-wrap${filled ? " art-filled" : ""}` },
      grid
        ? grid
        : el(
            "button",
            { class: "icon-art focusable", type: "button", id, title, "aria-label": title, onclick: action },
            wall.length ? null : el("div", { class: "guide-mini" }, ...rows),
          ),
      grid || !wall.length
        ? null
        : el("div", { class: "content-strip logo-wall", style: `grid-template-columns: repeat(${wallCols}, 1fr); grid-template-rows: repeat(${wallCount / wallCols}, 1fr)` }, ...wall.map((c) =>
            c.logo
              ? el("img", { class: "content-tile logo", src: c.logo, alt: "", loading: "lazy" })
              : el("div", { class: "content-tile blank logo-text", text: initialsOf(c.name).toUpperCase() }),
          )),
    ),
    el(
      "span",
      { class: "icon-meta" },
      // **A card whose frame is its own content still needs its way in.** With the
      // guide table in the frame the title is the button that opens the full guide;
      // the table's own rows open their channel.
      grid
        ? el("button", { class: "icon-name icon-name-link focusable", type: "button", text: title, onclick: action })
        : el("span", { class: "icon-name", text: title }),
      el("span", { class: "icon-sub", text: sub }),
    ),
  );
}

/**
 * **The real guide, not a preview of one.**
 *
 * The TiviMate-shaped grid the Guide screen draws — a time ruler with a now-marker,
 * a channel column with logos, and a programme block per slot on the track — built
 * once here and used in two places: the Guide card's own frame, and the full screen.
 * A card that drew four "now playing" lines and then made you open another screen to
 * see a guide was a preview of the thing you asked for.
 */
function guideGrid(channels, { hours = 3 } = {}) {
  const guide = state.live.guide;
  const hasEpg = Boolean(guide && guide.epg);
  const start = Date.now();
  const span = hours * 3600_000;
  const ticks = Array.from({ length: hours }, (_, i) => start + i * 3600_000);
  const rows = channels.map((channel, i) => {
    const programs = hasEpg ? (guide.programmes[channel.epgId || channel.id] || []) : [];
    const blocks = programs
      .filter((p) => p.stop > start && p.start < start + span)
      .map((p) => {
        const from = Math.max(p.start, start);
        const to = Math.min(p.stop, start + span);
        return el(
          "div",
          { class: "guide-block", style: `left:${((from - start) / span) * 100}%;width:${Math.max(((to - from) / span) * 100, 2)}%` },
          el("span", { class: "guide-block-title", text: p.title }),
          el("span", { class: "guide-block-time", text: `${clockOf(p.start)} – ${clockOf(p.stop)}` }),
        );
      });
    return el(
      "div",
      { class: "guide-row" },
      el(
        "button",
        { class: "guide-channel focusable", type: "button", title: `Play ${channel.name}`, onclick: () => openChannelPlayer(channel.id) },
        el("span", { class: "guide-num", text: String(i + 1) }),
        channel.logo
          ? el("img", { class: "guide-logo", src: channel.logo, alt: "", loading: "lazy" })
          : el("span", { class: "guide-logo fallback", text: (channel.name || "?").slice(0, 1).toUpperCase() }),
        el("span", { class: "guide-name", text: channel.name }, (() => {
          const res = channelResolution(channel.name);
          return res ? el("span", { class: "guide-res", text: res }) : null;
        })()),
      ),
      el(
        "div",
        { class: `guide-track${hasEpg ? "" : " bare"}` },
        hasEpg ? blocks : el("span", { class: "guide-nodata", text: "No programme data" }),
      ),
    );
  });
  const marker = ((Date.now() - start) / span) * 100;
  return el(
    "div",
    { class: `guide${hours <= 3 ? " guide-in-card" : ""}` },
    el(
      "div",
      { class: "guide-head" },
      el("span", { class: "guide-corner", text: "Channel" }),
      el(
        "div",
        { class: "guide-times" },
        ...ticks.map((h) => el("span", { class: "guide-time", text: clockOf(h) })),
        el("span", { class: "guide-now", style: `left:${marker}%`, "aria-hidden": "true" }),
      ),
    ),
    el("div", { class: "guide-body" }, ...(rows.length ? rows : [el("p", { class: "empty", text: state.live.loading ? "reading the lineup…" : "No channels in this country yet." })])),
  );
}

/** The Guide card — the first card of the profile, and its way into the grid. */
function guideCard() {
  // **The card's frame is the guide itself** — the same TiviMate table the Guide
  // screen draws, six channels across three hours, with the now-marker and each
  // channel's own programme blocks. It used to be four "now playing" lines, which
  // made the card a preview of a guide you had to open somewhere else.
  // **The card reads the guide itself.** Only the Guide *screen* used to ask for the
  // programme data, so a table drawn on the card had no schedule to draw — every row
  // said "No programme data" until you opened the screen that fetched it.
  if (!state.live.guide && !state.live.guideLoading) queueMicrotask(() => loadGuide());
  const channels = liveChannelsShown().slice(0, 6);
  const updated = state.live.updated ? new Date(state.live.updated).toLocaleTimeString() : "";
  return liveCard({
    id: "open-guide",
    title: "Guide",
    sub: [
      `${state.live.total || state.live.all.length} channels`,
      state.live.groups.length ? `${state.live.groups.length} categories` : "",
      updated ? `updated ${updated}` : "",
      state.live.guide && state.live.guide.epg === false ? "no EPG yet" : "",
    ].filter(Boolean).join(" · "),
    grid: guideGrid(channels, { hours: 3 }),
    action: () => go("#/guide"),
  });
}

/**
 * The Channels card — the profile's second card.
 *
 * It was a **Categories** card that listed category names and nothing else, which
 * is a table of contents for a list you have not seen. This one is the channels
 * themselves: the first few in the lineup, and the count, with the frame opening the
 * full list. No category rows sit under it either — the wall of one row per category
 * is gone, so the profile is the switch, two cards, and the screens they open.
 */
function channelsCard() {
  const channels = liveChannelsShown();
  const rows = channels.slice(0, 4).map((channel) =>
    el(
      "div",
      { class: "guide-mini-row" },
      el("span", { class: "guide-mini-name", text: channel.name }),
      el("span", { class: "guide-mini-block", text: channel.groups?.[0] || "—" }),
    ),
  );
  if (!rows.length) {
    rows.push(
      el("div", { class: "guide-mini-row" },
        el("span", { class: "guide-mini-name", text: "Channels" }),
        el("span", { class: "guide-mini-block bare", text: state.live.loading ? "reading…" : "—" })),
    );
  }
  return liveCard({
    id: "open-channels",
    title: liveRowKey() === "sports" ? "Sports channels" : "Channels",
    sub: channels.length
      ? `${channels.length} channels${state.live.groups.length ? ` · ${state.live.groups.length} groups` : ""}`
      : "Reading the channel list…",
    rows,
    posters: channels.slice(0, 6),
    action: () => go("#/categories"),
  });
}

function recordingsCard() {
  const list = recordingsGet();
  const upcoming = list.filter((r) => r.stop > Date.now()).slice(0, 6);
  const rows = upcoming.length
    ? upcoming.map((r) => el("div", { class: "guide-mini-row" },
        el("span", { class: "guide-mini-name", text: r.title }),
        el("span", { class: "guide-mini-block", text: clockOf(r.start) })
      ))
    : [el("div", { class: "guide-mini-row" },
        el("span", { class: "guide-mini-name", text: "No upcoming recordings" }),
        el("span", { class: "guide-mini-block bare", text: "Schedule from guide" })
      )];
  return liveCard({
    id: "open-recordings",
    title: "Recordings",
    sub: `${list.length} total · ${upcoming.length} upcoming`,
    rows,
    action: () => go("#/recordings"),
  });
}
/**
 * The Live TV banner — this profile's own Spotlight.
 *
 * The Movies home opens on a banner, and the Live TV profile had none: it began
 * at the switch. This is the same box: a kicker that says which tab you are on, the
 * channel's name where a card's title sits, what is on it now (or its group when
 * there is no guide yet), its own groups as chips, and its picture on the right —
 * a channel's picture is its **logo**, so that is what the frame holds, centred on
 * the app's flat panel. There is nothing to rotate here the way the Movies banner
 * refreshes a backdrop: a logo and a name are already stable, so the banner picks
 * one channel per launch the way every card picks its own slice.
 */
function liveHeroBlock() {
  const channels = liveChannelsShown().filter((c) => c.name);
  if (!channels.length) return null;
  const channel = channels[LAUNCH_SEED % channels.length];
  const { now } = nowNext(channel, state.live.guide);
  const sports = liveRowKey() === "sports";
  const groups = channel.groups || [];
  return el(
    "section",
    { class: "hero live-hero" },
    el(
      "div",
      { class: "hero-body" },
      el("p", { class: "hero-kicker", text: sports ? "Sports" : "Live TV" }),
      el("h2", { class: "hero-title", text: channel.name }),
      el("p", {
        class: "hero-line",
        text: now
          ? `Now playing · ${now.title}`
          : [groups[0], channel.country].filter(Boolean).join(" · ") || "Live channel",
      }),
      chipLine(
        groups.map((group) =>
          el("button", {
            class: "chip focusable",
            type: "button",
            text: group,
            onclick: () => go(`#/categories/${encodeURIComponent(group)}`),
          }),
        ),
        { className: "hero-cats" },
      ),
    ),
    el(
      "button",
      {
        class: "hero-art focusable live-hero-art",
        type: "button",
        title: `Open ${channel.name}`,
        "aria-label": `Open ${channel.name}`,
        onclick: () => go(`#/channel/${encodeURIComponent(channel.id)}`),
      },
      channel.logo
        ? el("img", { class: "live-hero-logo", src: channel.logo, alt: "", loading: "lazy" })
        : el("span", { class: "live-hero-initials", text: initialsOf(channel.name) }),
    ),
  );
}

/**
 * Live TV & Sports Home.
 *
 * **The banner comes first, then the Live TV / Sports switch, then the two cards** —
 * the same reading as the Movies home, where the banner is above the Movies/Shows
 * buttons and the cards are under them. They were the other way round once, so the
 * cards floated over the tabs that decide what they show. Under the cards there is
 * **nothing**: the wall of one channel row per category is gone.
 */
function renderLiveHome() {
  if (!state.live.loaded && !state.live.loading) queueMicrotask(() => loadLive());
  const nodes = [
    liveHeroBlock(),
    liveRowSwitch(),
    el("div", { class: "icons grid live-cards" }, guideCard(), channelsCard(), recordingsCard()),
  ].filter(Boolean);
  if (state.live.loading && !state.live.loaded) {
    nodes.push(el("p", { class: "empty", text: "Reading the channel list…" }));
  } else if (state.live.error && !state.live.all.length) {
    nodes.push(el("p", { class: "empty", text: `The channel source could not be read — ${state.live.error}` }));
  } else if (state.live.error) {
    nodes.push(el("p", { class: "view-hint", text: `Last read failed (${state.live.error}) — showing the lineup from the last good read.` }));
  }
  return nodes;
}

/**
 * The Categories screen — every category in this playlist, with its channel count.
 *
 * Picking one opens that category's channels. The list is the playlist's own
 * vocabulary, not a fixed set, so a directory read by country and a personal M3U
 * both answer with their real categories.
 */
function renderLiveCategories() {
  if (!state.live.loaded && !state.live.loading) queueMicrotask(() => loadLive());
  const groups = state.live.groupList || [];
  return [
    el("h1", { class: "view-title", text: "Channels" }),
    el("p", {
      class: "view-hint",
      text: groups.length
        ? `${liveChannelsShown().length} channels in ${groups.length} groups — pick a group to see its channels.`
        : "Reading the channel list…",
    }),
    el(
      "div",
      { class: "cat-tiles" },
      ...groups.map((group) =>
        el(
          "button",
          {
            class: "cat-tile focusable",
            type: "button",
            "data-group": group.name,
            onclick: () => go(`#/categories/${encodeURIComponent(group.name)}`),
          },
          el("span", { class: "cat-tile-name", text: group.name }),
          el("span", { class: "cat-tile-count", text: `${group.count} channel${group.count === 1 ? "" : "s"}` }),
        ),
      ),
    ),
  ];
}

/** One category's channels. */
function renderLiveCategory(group) {
  if (!state.live.loaded && !state.live.loading) queueMicrotask(() => loadLive());
  if (state.live.categoryGroup !== group && !state.live.categoryLoading) loadLiveGroup(group);
  const channels = state.live.categoryGroup === group ? state.live.categoryChannels || [] : [];
  return [
    el("h1", { class: "view-title", text: group }),
    el("p", {
      class: "view-hint",
      text: channels.length ? `${channels.length} channels in ${group}.` : "Reading this category…",
    }),
    channels.length
      ? el("div", { class: "channel-strip search-channels" }, ...channels.map(channelCard))
      : el("p", { class: "empty", text: "No channels in this category." }),
  ];
}

/** Read one category's channels — one request, only when it is opened. */
async function loadLiveGroup(group) {
  state.live = { ...state.live, categoryGroup: group, categoryChannels: [], categoryLoading: true };
  render();
  try {
    const res = await liveFetch({ group, limit: "300" });
    state.live = { ...state.live, categoryGroup: group, categoryChannels: res.channels || [], categoryLoading: false };
  } catch {
    state.live = { ...state.live, categoryGroup: group, categoryChannels: [], categoryLoading: false };
  }
  render();
}

/** A channel's id whose player is already opening, so a redraw cannot open it twice. */
let openingChannel = "";

/**
 * A channel **is its player** — there is no channel page.
 *
 * The screen that used to sit here showed a logo, the stream URL in a readonly box,
 * a *Play (HLS)* button and *Copy link*: a page you had to press a button on to
 * watch the thing you just picked. Landing on a channel opens the player on its own
 * stream now, the same way every other player in the app works.
 */
/**
 * **A channel that cannot play has to say so.**
 *
 * The player panel, not a silent nothing: which channel it was, why it has no stream,
 * and the one setting that fixes it. Closable by its button or Escape.
 */
function openChannelNotice({ title, message }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const overlay = el(
    "div",
    { class: "player empty-player" },
    el(
      "div",
      { class: "player-empty-body" },
      el("p", { class: "player-loading-title", text: title }),
      el("p", { class: "player-note", text: message }),
      el(
        "div",
        { class: "player-empty-actions" },
        el("button", {
          class: "btn primary focusable",
          type: "button",
          text: "Open Source settings",
          onclick: () => {
            close();
            state.settingsSection = "livesource";
            localStorage.setItem(KEY.section, "livesource");
            go("#/settings");
          },
        }),
        el("button", { class: "btn subtle focusable", type: "button", text: "Close", onclick: close }),
      ),
    ),
  );
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
}

async function openChannelPlayer(id) {
  if (openingChannel === id) return;
  openingChannel = id;
  try {
    if (!state.live.loaded && !state.live.loading) loadLive();
    // Wait for the lineup to arrive: a channel opened from a link can land here
    // before the list is in memory.
    for (let i = 0; i < 80 && !state.live.loaded; i++) await new Promise((r) => setTimeout(r, 250));
    const channel = findChannel(id);
    // **The add-ons are asked for the channel too.** A live channel has no IMDb id, so
    // this is the Stremio *channel* request (`/stream/channel/<id>.json`) — that is what
    // "find the stream from my Stremio add-ons" means for Live TV, and it is the only
    // source for a channel the lineup has no URL for.
    const askAddons = async () => {
      if (!channel) return null;
      const p = new URLSearchParams({ name: channel.name || "", epgId: channel.epgId || "" });
      // **A channel that came from an add-on is asked for itself**: the add-on and the
      // id its own catalogue gave it travel with the channel (see `liveAddonChannels`).
      const own = channel.addonStream;
      if (own) {
        p.set("source", own.source || "");
        p.set("type", own.type || "tv");
        p.set("mediaId", own.mediaId || "");
      }
      return get(`/streams/channel/${encodeURIComponent(channel.id)}.json?${p.toString()}`).catch(() => null);
    };
    if (channel?.url) {
      if (!state.live.guide && !state.live.guideLoading) loadGuide();
      await openPlayer(channel.url, channel.name, { channel: true, loadStreams: askAddons });
      return;
    }
    // **Before giving up, the same channel's other feed.** This channel has no URL of
    // its own, but the lineup may list the same channel under another id with one —
    // that is exactly the `Sony Max SD` / `Sony Max HD` case, and the tap plays the
    // feed that exists instead of a page about the feed that does not. A channel one
    // of your add-ons published is left to that add-on, whose own stream is the
    // right one to ask for.
    const sibling = channel && !channel.addonStream ? siblingChannelWithUrl(channel) : null;
    if (sibling) {
      if (!state.live.guide && !state.live.guideLoading) loadGuide();
      await openPlayer(sibling.url, channel.name, { channel: true, loadStreams: askAddons });
      return;
    }
    // No URL in the lineup: the add-ons are the only thing left to try, and one of
    // their streams plays exactly like the lineup's own.
    const payload = await askAddons();
    const found = (payload?.streams || []).filter((s) => !isExternalStream(s));
    if (found.length) {
      if (!state.live.guide && !state.live.guideLoading) loadGuide();
      const best = found.find((s) => !/cam|trailer|sample/i.test(`${s.name} ${s.title}`)) || found[0];
      await openPlayer(best.url, channel.name, {
        channel: true,
        streams: payload.streams,
        addonStatus: payload.sources || [],
      });
      return;
    }
    // **Nothing played this channel, and it now says what was tried.** The lineup had
    // no URL, and the add-ons you added were asked for it as a live channel and answered
    // none. This used to fall straight through and do *nothing at all*, which is exactly
    // "the player does not open in the Live TV & Sports profile".
    const asked = payload?.sources || [];
    openChannelNotice({
      title: channel ? channel.name : "Channel unavailable",
      message: channel
        ? `No stream for this channel. Your add-ons were asked for it as a live channel and answered none${asked.length ? ` (${asked.map((s) => `${s.name}: ${s.ok ? s.message : "failed"}`).join(", ")})` : ""}; channels that publish a free-to-air stream play directly. A subscription channel needs your own playlist — add an M3U URL or an Xtream login under Settings → Source.`
        : state.live.error
          ? `The lineup could not be read — ${state.live.error}`
          : "That channel is not in this playlist. Check the countries and providers picked under Settings → Source.",
    });
  } finally {
    openingChannel = "";
  }
}

function renderChannel(id) {
  const channel = findChannel(id);
  queueMicrotask(() => openChannelPlayer(id));
  // The same fallback the player uses, so the line under it does not say "has no
  // stream URL" for a channel that is about to play on its other feed.
  const sibling = channel && !channel.url && !channel.addonStream ? siblingChannelWithUrl(channel) : null;
  return [
    el("p", {
      class: "view-hint",
      text: channel
        ? channel.url
          ? `Opening ${channel.name}…`
          : sibling
            ? `Opening ${channel.name} on its ${sibling.name} feed…`
            : `${channel.name} has no stream URL in the lineup. Add your playlist under Settings → Source.`
        : // **Not "not found" until the lineup is actually in hand.** This line said
          // "Channel not found in this playlist" for the whole time the list was
          // still being read, which is what made a perfectly good channel look lost.
          state.live.loading || !state.live.loaded
          ? "Reading the channel list…"
          : "Channel not found in this playlist.",
    }),
  ];
}

/**
 * Search in the Live TV profile searches *channels*, not titles.
 *
 * The Movies & Shows search asks TMDB about films; a live playlist has nothing to
 * do with that, and its channel list is already in memory — so this filters it as
 * you type, with the same suggestion behaviour (matching names under the box) the
 * other profile's search has.
 */
function renderLiveSearch() {
  if (!state.live.loaded && !state.live.loading) queueMicrotask(() => loadLive());
  const input = el("input", {
    class: "search-input focusable",
    type: "search",
    id: "search-input",
    placeholder: "Search channels…",
    autocomplete: "off",
  });
  const suggestions = el("div", { class: "search-suggest", id: "search-suggest", hidden: true });
  const results = el("div", { class: "channel-strip search-channels", id: "live-results" });

  const pool = () => state.live.all;
  const matches = (needle) => {
    const text = needle.trim().toLowerCase();
    if (!text) return [];
    const seen = new Set();
    const out = [];
    for (const channel of pool()) {
      if (seen.has(channel.id)) continue;
      if (!channel.name.toLowerCase().includes(text)) continue;
      seen.add(channel.id);
      out.push(channel);
      if (out.length >= 60) break;
    }
    return out;
  };

  const draw = () => {
    const hits = matches(input.value);
    suggestions.replaceChildren(
      ...hits.map((channel) =>
        el(
          "button",
          {
            class: "suggest-item focusable",
            type: "button",
            onclick: () => go(`#/channel/${encodeURIComponent(channel.id)}`),
          },
          el("span", { class: "suggest-kind", text: "Channel" }),
          el("span", { class: "suggest-text", text: `${channel.name}${channel.groups?.length ? ` — ${channel.groups[0]}` : ""}` }),
        ),
      ),
    );
    suggestions.hidden = !hits.length;
    results.replaceChildren(
      ...(input.value.trim() ? hits.map(channelCard) : []),
    );
  };
  input.addEventListener("input", draw);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") suggestions.hidden = true;
  });

  return [
    el("h1", { class: "view-title", text: "Search channels" }),
    el("div", { class: "search-wrap" }, el("div", { class: "search-bar" }, input, suggestions)),
    el("p", { class: "view-hint", text: `${state.live.total || state.live.all.length} channels in this playlist — type to filter them.` }),
    results,
  ];
}

/* -------------------------------------------------- live settings panes */

/** Settings → Source: which playlist the channels come from. */
/** The provider catalogue, read once and kept for the session. */
let liveProviderList = null;

async function loadProviderList() {
  if (liveProviderList) return liveProviderList;
  try {
    const data = await get("/live/countries.json");
    liveProviderList = Array.isArray(data.providers) ? data.providers : [];
  } catch {
    liveProviderList = [];
  }
  return liveProviderList;
}

/**
 * The provider picker — the premium/DTH catalogue, one chip per provider.
 *
 * Live TV's lineup is a *subscriber's* lineup, so the first question is which
 * provider you are a subscriber of. Picking one is what makes the profile show
 * anything: its own feed names the channels and schedules them, and each chip says
 * whether that provider's guide is attached.
 */
function providerPicker(picked, save) {
  const search = el("input", {
    class: "text-input focusable",
    type: "text",
    id: "live-provider-filter",
    placeholder: "Filter providers or countries…",
  });
  const rows = el("div", { class: "country-picker provider-groups", id: "live-providers" });
  // The providers are laid out **by country**, the way the Movies & Shows profile
  // groups its settings: a country heading, then that country's operators under it.
  // One flat alphabetical run of a hundred operators answered "which of these is
  // mine?" with a wall of names.
  const countryName = (code) =>
    (liveCountryList || []).find((c) => String(c.code).toUpperCase() === String(code).toUpperCase())?.name || String(code).toUpperCase();
  const paint = () => {
    if (!liveProviderList) {
      rows.replaceChildren(el("p", { class: "empty", text: "Reading the provider catalogue…" }));
      return;
    }
    const needle = search.value.trim().toLowerCase();
    const matching = liveProviderList.filter(
      (p) =>
        !needle ||
        p.name.toLowerCase().includes(needle) ||
        String(p.country).toLowerCase() === needle ||
        countryName(p.country).toLowerCase().includes(needle),
    );
    // What is already picked always stays on screen, so a choice cannot be hidden
    // by whatever is typed in the filter.
    const list = [
      ...liveProviderList.filter((p) => picked.has(p.id)),
      ...matching.filter((p) => !picked.has(p.id)),
    ];
    if (!list.length) {
      rows.replaceChildren(el("p", { class: "empty", text: "No provider matches that." }));
      return;
    }
    // Grouped by country, and inside a country the operators of that country come
    // first, so a picked chip is never buried under an unrelated alphabet.
    const byCountry = new Map();
    for (const p of list) {
      const code = String(p.country || "").toUpperCase();
      if (!byCountry.has(code)) byCountry.set(code, []);
      byCountry.get(code).push(p);
    }
    rows.replaceChildren(
      ...[...byCountry.entries()].map(([code, items]) =>
        el("div", { class: "provider-country-block" },
          el("span", { class: "provider-country", text: `${countryName(code)} · ${code}` }),
          el("div", { class: "filter-options" },
            ...items.map((p) =>
              el("button", {
                class: `filter-chip focusable${picked.has(p.id) ? " active" : ""}`,
                type: "button",
                "data-provider": p.id,
                "aria-pressed": String(picked.has(p.id)),
                title: `${p.name} — ${code}${p.epg ? " · ships a public guide" : " · supply an EPG URL for its guide"}`,
                text: p.name,
                onclick: () => {
                  const next = new Set(picked);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  save({ providers: [...next] });
                },
              }),
            ),
          ),
        ),
      ),
    );
  };
  search.addEventListener("input", paint);
  if (!liveProviderList || !liveCountryList) {
    queueMicrotask(() => Promise.all([loadProviderList(), loadCountryList()]).then(paint));
  }
  paint();
  return el(
    "div",
    null,
    el("div", { class: "source-form" }, search),
    rows,
    el("p", {
      class: "option-desc",
      text: "Picking a provider adds its lineup to Live TV and to the Guide. Providers that publish a public XMLTV feed bring their own schedule with them; the rest are scheduled from the EPG URL under Guide & EPG.",
    }),
  );
}

function paneLiveSource() {
  const live = liveSource();
  const pickedProviders = new Set((Array.isArray(live.providers) ? live.providers : []).map(String));
  const field = (id, label, value, placeholder, type = "text") => {
    const input = el("input", { class: "text-input focusable", type, id, value, placeholder });
    input.addEventListener("change", () => save({ [label]: input.value.trim() }));
    return input;
  };
  const save = (patch) => {
    state.liveSource = { ...liveSource(), ...patch };
    writeJSON(KEY.liveSource, state.liveSource);
    pushSettings({ live: state.liveSource });
    state.live = { ...state.live, loaded: false, rows: [] };
    loadLive({ force: true });
    // Re-draw the pane, so a picked provider's chip lights up where it stands.
    render();
  };

  return [
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "Where the lineup comes from" }),
      el("p", {
        class: "option-desc",
        text: "The catalogue is the premium, DTH and operator providers themselves — pick the ones you subscribe to and Live TV draws their lineup and their guide. Streams are never shipped: a premium stream belongs to a subscriber's box, so export your own playlist (or log in to your Xtream panel) and it meets the catalogue on the channel's `tvg-id`. The playlist URL and the password stay on the server, never in the page.",
      }),
      el("div", { class: "options" },
        ...[["dth", "Premium & DTH catalogue", "Sky, DIRECTV, Tata Play, Airtel, DStv, Astro, Foxtel and the rest — the operator's own lineup and guide, per country."],
          ["m3u", "My M3U playlist", "An M3U/M3U8 URL (or a path on the server) with your own channels, exported from your box."],
          ["xtream", "Xtream Codes login", "Host, username and password — the live streams and their categories are read from the panel."]].map(([mode, title, desc]) =>
          radioRow(live.mode === mode, "live-mode", title, desc, () => save({ mode })),
        ),
      ),
      live.mode === "dth" ? providerPicker(pickedProviders, save) : null,
      live.mode === "m3u"
        ? el("div", { class: "source-form" }, field("live-m3u", "m3u", live.m3u, "https://…/playlist.m3u"))
        : null,
      live.mode === "xtream"
        ? el("div", { class: "source-form" },
            field("live-host", "host", live.host, "http://host:8080"),
            field("live-user", "username", live.username, "username"),
            field("live-pass", "password", live.password, "password", "password"),
          )
        : null,
      el("div", { class: "provider-check" },
        el("span", {
          class: `source-status${state.live.error ? " bad" : state.live.loaded ? " ok" : ""}`,
          text: state.live.loaded
            ? `${state.live.total || state.live.all.length} channels loaded${state.live.groups.length ? ` in ${state.live.groups.length} categories` : ""}${state.live.error ? ` — last read failed (${state.live.error})` : ""}`
            : "Reading…",
        }),
      ),
      el("div", { class: "source-form" },
        el("button", { class: "btn primary focusable", type: "button", text: "Reload channels", onclick: () => loadLive({ force: true }) }),
      ),
    ),
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "Metadata" }),
      el("p", { class: "option-desc", text: "Each channel keeps the logo, its categories and its country from the playlist, and its stream URL is kept server-side. Reload re-reads all of it — on the refresh clock below, and whenever you press Refresh now." }),
    ),
  ];
}

/** The directory's country table, read once and kept for the session. */
let liveCountryList = null;

async function loadCountryList() {
  if (liveCountryList) return liveCountryList;
  try {
    const data = await get("/live/countries.json");
    liveCountryList = Array.isArray(data.countries) ? data.countries : [];
  } catch {
    liveCountryList = [];
  }
  return liveCountryList;
}

/**
 * Settings → Countries: which of the directory's countries this profile reads.
 *
 * The public directory is published one file per country, so this is the switch
 * that decides what the **Guide** and the **Categories** card are drawn from.
 * Nothing here is a second source: it is the same directory, sliced by country.
 */
function paneLiveCountries() {
  const live = liveSource();
  const picked = new Set((Array.isArray(live.countries) ? live.countries : []).map((c) => String(c).toUpperCase()));
  const save = (patch) => {
    state.liveSource = { ...liveSource(), ...patch };
    writeJSON(KEY.liveSource, state.liveSource);
    pushSettings({ live: state.liveSource });
    // A different slice of the directory is a different lineup, so the channels and
    // the guide are re-read rather than filtered on screen.
    state.live = { ...state.live, loaded: false, rows: [], guide: null, categoryChannels: [] };
    loadLive({ force: true });
    loadGuide({ force: true });
    render();
  };
  const toggle = (code) => {
    const next = new Set(picked);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    save({ countries: [...next], allCountries: false });
  };

  const search = el("input", {
    class: "text-input focusable",
    type: "text",
    id: "live-country-filter",
    placeholder: "Filter countries…",
  });
  const rows = el("div", { class: "filter-options country-picker" });
  const paint = () => {
    if (!liveCountryList) {
      rows.replaceChildren(el("p", { class: "empty", text: "Reading the country list…" }));
      return;
    }
    const needle = search.value.trim().toLowerCase();
    const matching = liveCountryList.filter(
      (c) => !needle || c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle,
    );
    // What is already picked always stays on screen, so a choice cannot be hidden
    // by whatever is typed in the filter.
    // **Every country, not the first sixty.** The list was cut at 60 — which, at
    // an alphabetical start, meant it stopped around Denmark and countries after
    // it could not be picked at all. The picker is its own scrolling window
    // (`.country-picker`), so the whole list lives in it and nothing is hidden.
    const list = [
      ...liveCountryList.filter((c) => picked.has(c.code)),
      ...matching.filter((c) => !picked.has(c.code)),
    ];
    rows.replaceChildren(
      ...(list.length
        ? list.map((c) =>
            el("button", {
              class: `filter-chip focusable${picked.has(c.code) ? " active" : ""}`,
              type: "button",
              "aria-pressed": String(picked.has(c.code)),
              title: `${c.name} (${c.code})`,
              text: `${c.flag ? `${c.flag} ` : ""}${c.name}`,
              onclick: () => toggle(c.code),
            }),
          )
        : [el("p", { class: "empty", text: "No country matches that." })]),
    );
  };
  search.addEventListener("input", paint);
  if (!liveCountryList) queueMicrotask(() => loadCountryList().then(paint));
  paint();    const pickedNote = live.allCountries
    ? "Reading every country the catalogue covers."
    : picked.size
      ? `${picked.size} countr${picked.size === 1 ? "y" : "ies"} selected — the Guide and the Categories card show those.`
      : "Nothing picked, so the whole catalogue is read.";

  return [
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "Countries" }),
      el("p", { class: "option-desc", text: "Every provider in the catalogue belongs to a country. Pick the countries you want and both the Guide and the Categories card are scoped to them — the catalogue is shipped with the app, so this works with no network and with nothing to log in to." }),
      el("div", { class: "options" },
        radioRow(Boolean(live.allCountries), "live-countries", "All countries", "Every country the catalogue covers, read in one go.", () => save({ allCountries: true })),
        radioRow(!live.allCountries, "live-countries", "Only the countries I pick", "Pick them below — each channel carries its own country.", () => save({ allCountries: false })),
      ),
      el("div", { class: "source-form" }, search),
      rows,
      el("div", { class: "source-form" },
        el("button", { class: "btn subtle focusable", type: "button", text: "Clear countries", onclick: () => save({ countries: [], allCountries: false }) }),
        el("button", { class: "btn primary focusable", type: "button", text: "Apply countries", onclick: () => loadLive({ force: true }) }),
      ),
      el("div", { class: "provider-check" }, el("span", { class: "source-status", text: pickedNote })),
    ),
  ];
}

/** Settings → Guide & EPG: the XMLTV source the grid is drawn from. */
function paneLiveGuide() {
  const live = liveSource();
  const input = el("input", { class: "text-input focusable", type: "text", id: "live-epg", value: live.epg, placeholder: "https://…/guide.xml (XMLTV)" });
  const status = el("span", { class: "source-status", text: live.epg ? "An EPG URL is set." : "No EPG URL — the Guide draws the lineup only." });
  return [
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "XMLTV guide" }),
      el("p", {
        class: "option-desc",
        text: "An XMLTV (EPG) URL — `.xml` or `.xml.gz`. A DTH provider's guide is its lineup: Foxtel, Freeview Australia and Sky New Zealand publish one, so picking those providers is enough and this box can stay empty. Set it and it wins, for your own box's guide or another provider's. Channels are matched by `tvg-id`.",
      }),
      el("div", { class: "source-form" }, input,
        el("button", { class: "btn primary focusable", type: "button", text: "Save EPG", onclick: () => {
          state.liveSource = { ...liveSource(), epg: input.value.trim() };
          writeJSON(KEY.liveSource, state.liveSource);
          pushSettings({ live: state.liveSource });
          state.live = { ...state.live, guide: null, guideError: "" };
          loadGuide({ force: true });
        } }),
        el("button", { class: "btn subtle focusable", type: "button", text: "Reload guide", onclick: () => loadGuide({ force: true }) }),
      ),
      el("div", { class: "provider-check" }, status,
        state.live.guideError ? el("span", { class: "source-status bad", text: ` — ${state.live.guideError}` }) : null,
      ),
    ),
  ];
}

/** Settings → Live TV & Sports: the refresh clock for channels and guide. */
function paneLiveRefresh() {
  const live = liveSource();
  const choice = (minutes) => () => {
    state.liveSource = { ...liveSource(), refreshMinutes: minutes };
    writeJSON(KEY.liveSource, state.liveSource);
    pushSettings({ live: state.liveSource });
    render();
  };
  return [
    el("div", { class: "provider" },
      el("span", { class: "option-title", text: "How often the channels update" }),
      el("p", { class: "option-desc", text: "The playlist and the guide are re-read on this clock, so channels, logos and programme data keep themselves up to date." }),
      // **The same choices the Content refresh offers** — 30 minutes, 60 minutes, or
      // Manual — with one extra at the top that hands the interval to that setting,
      // so the two screens answer "how often?" the same way.
      el("div", { class: "options" },
        radioRow(Number(live.refreshMinutes) === 0, "live-refresh", "Follow the content refresh setting", "The same interval as Settings → Content, so one choice drives both.", choice(0)),
        radioRow(Number(live.refreshMinutes) === 30, "live-refresh", "Every 30 minutes", "Channels and programme data are re-read every 30 minutes.", choice(30)),
        radioRow(Number(live.refreshMinutes) === 60, "live-refresh", "Every 60 minutes", "Channels and programme data are re-read every 60 minutes.", choice(60)),
        radioRow(Number(live.refreshMinutes) === -1, "live-refresh", "Manual", "Nothing is re-read until you press Refresh now.", choice(-1)),
      ),
      el("div", { class: "source-form" },
        el("button", { class: "btn primary focusable", type: "button", text: "Refresh now", onclick: () => { state.gen = Date.now(); loadLive({ force: true }); loadGuide({ force: true }); } }),
      ),
    ),
  ];
}

/* ------------------------------------------------------------------- boot */

/** Re-read the cards — the regional OTT cards change with the country setting. */
async function refreshCollections() {
  try {
    // A cache-buster: For You's rows are rebuilt per request, and without one the
    // browser would hand back the list it already has.
    state.collections = await get(`/collections.json?_=${Date.now()}`);
  } catch {
    /* keep the cards already on screen */
  }
  // The manifest's catalog ids move with those rows, so it is re-read too, otherwise
  // the published-id filter drops the fresh For You rows.
  try {
    const manifest = await get(`/manifest.json?_=${Date.now()}`);
    const ids = (manifest?.catalogs || []).map((x) => x.id).filter(Boolean);
    if (ids.length) state.publishedCatalogs = new Set(ids);
  } catch {
    /* keep the ids already known */
  }
  state.order = {};
}

/* ---------------------------------------------------------------- playback */

/**
 * Play a stream inside the app.
 *
 * A live channel is an HLS playlist (`.m3u8`) far more often than it is a plain
 * file, and only Safari and Android's own player play those natively — everything
 * else needs `hls.js`. It is **vendored next to the app** (`./vendor/hls.min.js`)
 * rather than pulled from a CDN, so the Electron window and the APK play a live
 * stream with no third-party script and nothing to fetch but the stream itself. The
 * loader is kept, so opening a second channel does not download it again.
 */
let hlsLoader = null;
let playerHls = null;
// **Which player is the live one.** Changing the source in the Sources drawer opens a
// new player while the old one's setup is still in flight (an HLS loader is fetched
// and awaited). The late completion then attached itself to a video element that was
// already gone — the picture stayed black after switching source. Every open takes a
// number; only the newest one is allowed to finish its setup.
let playerSeq = 0;
let playerNode = null;
// **The torrent engine.** A torrent stream has no address to hand to a `<video>` —
// Stremio publishes it as an `infoHash` — so its magnet is played by WebTorrent,
// vendored exactly the way hls.js is (`npm run vendor:webtorrent`), and nothing is
// fetched from a CDN. One swarm at a time: switching source takes the old one down.
let torrentLoader = null;
let torrentClient = null;

const IS_HLS = (url) => /\.m3u8(\?|#|$)/i.test(String(url || ""));

/**
 * The path a scraped stream is played through.
 *
 * A site that serves its file only to a request carrying `Referer` and its session cookie
 * cannot be satisfied by a `<video>` element — a browser forbids script from setting
 * `Referer`, and cannot attach another site's cookies. So the server fetches it instead
 * (addon/proxy.mjs) and the browser points here. The manifest's own segment URLs are
 * rewritten server-side to come back the same way.
 */
const proxyPath = (url, referer = "") =>
  `/stream/proxy?url=${encodeURIComponent(String(url))}${referer ? `&ref=${encodeURIComponent(String(referer))}` : ""}`;

/** A `blob:`/`data:` URL exists only inside the page that made it: nothing can play it. */
const isUnplayableUrl = (url) => /^(?:blob|data|filesystem):/i.test(String(url || "").trim());

/** The torrent engine, loaded once and kept. */
function loadWebTorrent() {
  if (window.WebTorrent) return Promise.resolve(window.WebTorrent);
  if (!torrentLoader) {
    // **The vendored build is an ES module, not a classic script.** It ends in
    // `export { WebTorrent as default }` and never assigns a global, so loading it
    // through a `<script>` tag resolved to `undefined` and every torrent failed with
    // "WebTorrent did not load" — the engine was there the whole time, attached to
    // nothing. A dynamic import is what actually hands back the constructor.
    torrentLoader = import("./vendor/webtorrent.min.js")
      .then((mod) => {
        const WebTorrent = mod?.default || mod?.WebTorrent;
        if (typeof WebTorrent !== "function") throw new Error("the module did not export WebTorrent");
        window.WebTorrent = WebTorrent;
        return WebTorrent;
      })
      .catch((err) => {
        // A failed load must not be cached: the next Play deserves a fresh attempt.
        torrentLoader = null;
        throw new Error(`WebTorrent is not available — ${err?.message || err}`);
      });
  }
  return torrentLoader;
}

/** Bring the swarm down; the next stream gets a client of its own. */
function stopTorrent() {
  if (!torrentClient) return;
  try { torrentClient.destroy(); } catch { /* already gone */ }
  torrentClient = null;
}

/** The file a torrent stream names: its `fileIdx` if that holds one, else the biggest video. */
const fileForTorrent = (torrent, fileIdx) => {
  const files = torrent?.files || [];
  const named = Number.isFinite(fileIdx) ? files[fileIdx] : null;
  if (named) return named;
  const video = files.filter((f) => /\.(mp4|m4v|webm|mkv|mov|ogv|avi)$/i.test(f?.name || ""));
  return video.sort((a, b) => (b.length || 0) - (a.length || 0))[0] || files[0] || null;
};

/**
 * Play a torrent.
 *
 * **Debrid first, and that is not an optimisation — it is the difference between
 * working and not.** The engine below runs *in the page*, and a page can only reach
 * swarm peers that speak WebRTC; the public swarms speak TCP/UDP, so a magnet
 * handed straight to it usually reports "looking for peers" forever and never
 * shows a frame. A debrid account turns the torrent into a plain HTTPS URL, which is
 * an ordinary stream to the `<video>` element.
 *
 * When a debrid service is set up the magnet goes there, and the app's own engine is
 * the fallback if that service cannot serve this particular torrent. With no service
 * configured the engine is still tried, and the note over the picture says plainly
 * what is missing and where to add it — an unexplained black rectangle is the thing
 * worth avoiding.
 */
async function playTorrent(node, video, magnet, opts, seq) {
  const note = el("p", { class: "player-note player-torrent-note", text: "Starting the torrent…" });
  // A second line that is **not** touched by the swarm's own readout, so the reason
  // a torrent is not playing cannot be overwritten by "looking for peers…" a second
  // later.
  const hint = el("p", { class: "player-note player-torrent-hint", hidden: true });
  node.append(note, hint);
  const say = (text) => { hint.textContent = text || ""; hint.hidden = !text; };

  const service = debridActive();
  if (service) {
    note.textContent = `Resolving this torrent through ${service[1]}…`;
    try {
      const res = await post("/debrid/resolve", {
        magnet,
        infoHash: opts.infoHash || "",
        // The add-on's own label for this stream ("S02E04 1080p") is what picks the
        // right file out of a season pack.
        name: opts.streamName || opts.title || "",
      });
      if (seq !== playerSeq) return;
      if (res?.ok && res.url) {
        note.textContent = `Playing through ${res.label || service[1]}${res.file ? ` — ${res.file}` : ""}`;
        video.src = res.url;
        await video.play().catch(() => { /* autoplay refused: the controls are there */ });
        return;
      }
      // Still downloading on the service is not a failure: waiting is the answer,
      // and the engine below would only add a swarm that never fills in.
      if (res?.pending) {
        note.textContent = "Not playing yet";
        say(res.message || `${service[1]} is still fetching this torrent — try again shortly.`);
        return;
      }
      say(`${res?.message || `${service[1]} could not resolve this torrent`} — falling back to the app's own torrent engine.`);
    } catch (err) {
      if (seq !== playerSeq) return;
      say(`Could not ask ${service[1]} — ${err.message}. Falling back to the app's own torrent engine.`);
    }
  }
  // **Nothing is said when there is no service.** The engines below are still tried, and a
  // paragraph explaining what debrid would have done sat over the picture of every torrent
  // played without one.

  // **The server's own engine, first.** A page can only reach peers that speak WebRTC and
  // the public swarms speak TCP/UDP, so the in-page engine below usually sat at "looking
  // for peers…" forever — which is exactly "the torrent does not start". The server has
  // real sockets and the DHT, so when it has webtorrent installed the magnet is played
  // from there: one plain URL with range support, like any other stream.
  if (state.options?.torrent?.ready) {
    const serverUrl = `/stream/torrent?magnet=${encodeURIComponent(magnet)}${opts.infoHash ? `&ih=${encodeURIComponent(opts.infoHash)}` : ""}${opts.fileIdx != null ? `&idx=${encodeURIComponent(opts.fileIdx)}` : ""}`;
    const query = `magnet=${encodeURIComponent(magnet)}${opts.infoHash ? `&ih=${encodeURIComponent(opts.infoHash)}` : ""}${opts.fileIdx != null ? `&idx=${encodeURIComponent(opts.fileIdx)}` : ""}`;
    note.textContent = "Joining the swarm…";
    try {
      // **Start it, then watch it — never hold a request open on a swarm.** Joining one
      // takes as long as it takes, and a request that waits for it is one the proxy in
      // front of this app gives up on: the picture got "HTTP 502" for a torrent that was
      // doing exactly what it should. So the player asks the server to prepare, polls the
      // status, and only points the element at the stream **once the file is known** —
      // by which time `/stream/torrent` answers immediately.
      const started = await post("/torrent/prepare", { magnet, infoHash: opts.infoHash || "", fileIdx: opts.fileIdx ?? null }).catch(() => null);
      if (seq !== playerSeq) return;
      if (started && started.ok === false) {
        say(`The server's swarm could not be started — ${started.error || "no reason given"}. Trying this window instead.`);
      }
      const hash = started?.infoHash || opts.infoHash || "";
      const until = Date.now() + 120000;
      let ready = null;
      while (Date.now() < until) {
        if (seq !== playerSeq) return;
        const snap = await get(`/torrent/status?ih=${encodeURIComponent(hash)}${opts.fileIdx != null ? `&idx=${encodeURIComponent(opts.fileIdx)}` : ""}`).catch(() => null);
        const status = snap?.status;
        if (!status) break;
        if (status.state === "error") { say(`The swarm gave up — ${status.error}`); break; }
        if (status.peers) note.textContent = `${status.peers} peers · ${Math.round((status.progress || 0) * 100)}% · ${Math.round((status.downloadSpeed || 0) / 1e5) / 10} MB/s`;
        else note.textContent = "Looking for peers…";
        if (status.state === "ready") { ready = status; break; }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (seq !== playerSeq) return;
      if (ready) {
        say("");
        note.textContent = ready.name ? `Streaming ${ready.name}` : "Streaming from the swarm…";
        video.src = serverUrl;
        video.addEventListener("error", () => { if (playerSeq === seq) say("The server's swarm stalled — this stream may have no peers."); }, { once: true });
        await video.play().catch(() => { /* autoplay refused: the controls are there */ });
        // The same live readout the in-page engine gave, now from the server's swarm.
        const timer = setInterval(async () => {
          if (playerSeq !== seq || !video.isConnected) return clearInterval(timer);
          try {
            const { status } = await get(`/torrent/status?ih=${encodeURIComponent(hash)}`);
            if (!status || status.state !== "ready") return;
            if (status.peers) note.textContent = `${status.peers} peers · ${Math.round((status.progress || 0) * 100)}% · ${Math.round((status.downloadSpeed || 0) / 1e5) / 10} MB/s`;
          } catch { /* the readout is not worth a failure */ }
        }, 2000);
        video.addEventListener("emptied", () => clearInterval(timer), { once: true });
        return;
      }
      // Out of time, or the swarm gave up: the page's own engine still gets its turn.
      say("The server's swarm had no answer in time — trying this window instead.");
    } catch (err) {
      if (seq !== playerSeq) return;
      say(`The server could not start this torrent — ${err.message}. Trying this window instead.`);
    }
  }

  try {
    const WebTorrent = await loadWebTorrent();
    if (seq !== playerSeq) return;
    stopTorrent();
    const client = new WebTorrent();
    torrentClient = client;
    const torrent = client.add(magnet);
    const alive = () => torrentClient === client;
    client.on("error", (err) => { if (alive()) note.textContent = `Torrent error — ${err?.message || err}`; });
    torrent.on("error", (err) => { if (alive()) note.textContent = `Torrent error — ${err?.message || err}`; });
    const timer = setInterval(() => {
      if (!alive()) return clearInterval(timer);
      if (torrent.numPeers) {
        // Real peers are arriving: the explanation of *why it might not work* has
        // done its job and would only sit over the picture.
        say("");
        note.textContent = `${torrent.numPeers} peers · ${Math.round((torrent.progress || 0) * 100)}% · ${Math.round((torrent.downloadSpeed || 0) / 1e5) / 10} MB/s`;
      } else {
        note.textContent = "Looking for peers…";
      }
    }, 1000);
    let started = false;
    const start = () => {
      if (started || !alive()) return;
      started = true;
      const file = fileForTorrent(torrent, opts.fileIdx);
      if (!file) {
        note.textContent = "This torrent holds nothing to play.";
        return;
      }
      note.textContent = /\.(mkv|avi|mov)$/i.test(file.name)
        ? `${file.name} — this container may not play here`
        : `Streaming ${file.name}`;
      if (typeof file.streamTo === "function") file.streamTo(video);
      else if (typeof file.getBlobURL === "function") file.getBlobURL((err, url) => { if (!err && alive()) video.src = url; });
      video.play().catch(() => { /* autoplay refused: the controls are there */ });
    };
    // v2 fires `ready` when the metadata lands; `metadata` is the older name for it.
    torrent.on("ready", start);
    torrent.on("metadata", start);
  } catch (err) {
    note.textContent = `Could not start the torrent — ${err.message}`;
  }
}

/**
 * Is this stream **not** a video?
 *
 * Add-ons put a "support the project" line at the top of their streams, and that
 * line's URL is a donation page. The server marks the ones Stremio calls
 * `externalUrl` (a page to open elsewhere); this catches those as well as a page
 * that slipped through as a `url`, so the player never hands a web page to a
 * `<video>` element and never auto-plays one.
 */
const isExternalStream = (s) =>
  Boolean(s?.external) || /donat|support|patreon|buymeacoffee|ko-?fi|telegram|discord|paypal/i.test(`${s?.name || ""} ${s?.title || ""} ${s?.url || ""}`);

function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoader) {
    hlsLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "./vendor/hls.min.js";
      script.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error("hls.js did not load")));
      script.onerror = () => reject(new Error("hls.js is not available"));
      document.head.append(script);
    });
  }
  return hlsLoader;
}

function stopPlayer({ keepFullscreen = false } = {}) {
  playerSeq += 1;
  stopTorrent();
  if (playerHls) {
    try { playerHls.destroy(); } catch { /* already gone */ }
    playerHls = null;
  }
  if (playerNode) {
    playerNode.remove();
    playerNode = null;
  }
  // **Full screen belongs to the player, not to this node.** `openPlayer` tears the old
  // player down before building the new one, and leaving full screen there is the whole of
  // "pressing Play goes full screen on the finding-sources page and then drops out of it":
  // the exit ran, and the request that followed was no longer inside a click, so the
  // browser refused it. Closing the player for real still leaves full screen.
  if (document.fullscreenElement && !keepFullscreen) document.exitFullscreen?.().catch(() => {});
  document.removeEventListener("keydown", playerKey);
}

function playerKey(e) {
  if (e.key === "Escape") return stopPlayer();
  if (e.target?.tagName === "INPUT" || e.target?.tagName === "SELECT") return;
  const video = document.querySelector(".player-video");
  if (!video) return;
  const seek = (n) => {
    video.currentTime = Math.max(0, (video.currentTime || 0) + n);
  };
  if (e.key === " " || e.key === "k") {
    e.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  } else if (e.key === "ArrowRight") seek(10);
  else if (e.key === "ArrowLeft") seek(-10);
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    // The keyboard moves the same figure the icon's own gesture does, and keeps the
    // percentage beside it in step.
    const next = Math.min(1, Math.max(0, video.volume + (e.key === "ArrowUp" ? 0.01 : -0.01)));
    video.volume = next;
    if (next > 0) video.muted = false;
    const note = document.querySelector(".player-vol-note");
    if (note) note.textContent = `${Math.round(next * 100)}%`;
  }
  else if (e.key === "m") video.muted = !video.muted;
}

/** `1:04:07` / `4:07` — a clock, not a number. */
const timecode = (seconds) => {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`;
};

/**
 * The player.
 *
 * **Always full screen** — opening it asks the device for its own full screen, and
 * the overlay fills the window whatever the answer is. A compact control strip floats
 * at the bottom: the stream's own options on the left of a rule (settings, sources),
 * the transport on the right (play/pause, seek, time, volume, speed, aspect ratio),
 * and no fullscreen control, because pressing play already went full screen. For a
 * title there is also a **Sources** drawer: every stream the add-ons answered with,
 * one click to switch — and clicking one re-points the picture in place rather than
 * opening a second player. There is no title bar over the picture. Keyboard: space/k
 * play, ←/→ seek 10s, ↑/↓ volume, m mute, Esc close.
 */
async function openPlayer(url, title, opts = {}) {
  const src = String(url || "").trim();
  if (!src) return;
  // The player being replaced must not take full screen with it.
  stopPlayer({ keepFullscreen: true });

  const video = el("video", { class: "player-video", playsinline: true, autoplay: true });
  const seek = el("input", { class: "player-seek focusable", type: "range", min: "0", max: "1000", value: "0", step: "1" });
  // Elapsed on the left of the seek bar, duration on the right — the reading a
  // player's own bar uses, drawn in the app's tabular figures.
  const clock = el("span", { class: "player-time", text: "0:00" });
  const total = el("span", { class: "player-time", text: "0:00" });
  // **A button, not a dropdown.** Playback speed was a native `<select>` — an OS popup
  // in the middle of a player this app draws itself. One button cycles the speeds and
  // prints the current one, exactly like the rest of the player's controls.
  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  let rateIndex = RATES.indexOf(1);
  const rate = el("button", {
    class: "player-icon player-rate focusable",
    type: "button",
    text: "1×",
    title: "Playback speed",
    onclick: () => {
      rateIndex = (rateIndex + 1) % RATES.length;
      const v = RATES[rateIndex];
      video.playbackRate = v;
      rate.textContent = `${v}×`;
    },
  });
  // **Every control is a drawn mark**, in the same 24px stroked grid as the top
  // bar's icons — the emoji/text glyphs the player used (⏪ 🔇 PiP Close) read as
  // another app's controls inside this one. The play mark swaps between the two
  // shapes; the rest are one path each.
  const PLAY_MARK = () => [svgNode("path", { d: "M9 6.2v11.6L18.6 12z", fill: "currentColor", stroke: "none" })];
  const PAUSE_MARK = () => [svgNode("path", { d: "M9.5 6v12" }), svgNode("path", { d: "M14.5 6v12" })];
  const playBtn = el(
    "button",
    { class: "player-icon focusable", type: "button", title: "Play / pause",
      onclick: () => (video.paused ? video.play().catch(() => {}) : video.pause()) },
    playerGlyph(PAUSE_MARK()),
  );
  const setPlayMark = (paused) => playBtn.replaceChildren(playerGlyph(paused ? PLAY_MARK() : PAUSE_MARK()));

  video.addEventListener("play", () => setPlayMark(false));
  video.addEventListener("pause", () => setPlayMark(true));
  video.addEventListener("timeupdate", () => {
    const d = video.duration || 0;
    seek.value = d ? String(Math.round((video.currentTime / d) * 1000)) : "0";
    clock.textContent = timecode(video.currentTime);
    total.textContent = d ? timecode(d) : "live";
    watchedPast(opts.meta, d ? video.currentTime / d : 0);
  });
  video.addEventListener("loadedmetadata", () => { total.textContent = video.duration ? timecode(video.duration) : "live"; });
  seek.addEventListener("input", () => {
    const d = video.duration || 0;
    if (d) video.currentTime = (Number(seek.value) / 1000) * d;
  });

  // **One volume control, and no bar.** There were two buttons — a mute and a
  // ramp — drawn with the same speaker, with a "100%" figure beside them: three
  // things that together read as a volume slider this player does not have.
  const setVolume = (value) => {
    const next = Math.min(1, Math.max(0, Math.round(value * 100) / 100));
    video.volume = next;
    video.muted = next === 0;
  };

  // The speed ramp's readout, and the rate the speed button says is in force.
  const speedNote = el("span", { class: "player-speed-note", text: "" });

  // Full screen is asked for once, below, in the same synchronous run as the click
  // that opened this player — and there is no fullscreen button anywhere in the strip,
  // because there is nothing left for one to do.

  // The Sources drawer: which add-on this stream came from, and the others on offer.
  const drawer = el("aside", { class: "player-sources", hidden: true });
  // **The list the drawer is showing**, so switching a source can redraw it with the
  // new one marked active without rebuilding anything.
  let shown = Array.isArray(opts.streams) ? opts.streams.slice() : [];
  // Which stream the picture is on right now — the drawer marks it, and a switch
  // moves it.
  let currentSource = src;
  // **Which add-ons answered.** The stream list says where each stream came from, but
  // not which add-on stayed quiet — so an add-on you just pasted could look absent
  // from the player while it was simply the one with nothing to say about this title
  // (or the one that timed out). One line per add-on, with what it returned.
  const addonLines = Array.isArray(opts.addonStatus) ? opts.addonStatus : [];

  /**
   * **Custom Sites: the streams from the sites you added.**
   *
   * There is no paste-a-URL box here any more. A site is added once in
   * Settings → Custom Websites — with its search form detected from its homepage — and
   * from then on pressing Play searches it for the title, reads the best-matching page,
   * runs the scraper's tiers over it and adds what they found, tagged with the site's
   * domain. Search-on-play either works or it says why, on one line per site.
   *
   * The rows are **kept for as long as the app is running** (a module-level map, not a
   * file): closing the player and reopening it keeps them, and a restart clears them. A
   * stream URL carries a token and expires within hours, so persisting one would only
   * store a broken link.
   */
  const customKey = String(opts.meta?.id || opts.title || title || "unknown");
  const customBox = () => (state.customStreams[customKey] ||= { streams: [], sites: [], at: 0 });
  const customNote = el("p", { class: "drawer-extract-note" });
  const customSummary = el("div", { class: "drawer-summary", hidden: true });
  let customBusy = false;

  const fileNameOf = (url) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    } catch {
      return "";
    }
  };

  /** One line per site, so a site that failed says why instead of adding nothing. */
  const drawCustomSummary = () => {
    const box = customBox();
    const rows = box.streams || [];
    if (!state.prefs?.sourcesSummary || (!rows.length && !box.sites?.length)) {
      customSummary.hidden = true;
      customSummary.replaceChildren();
      return;
    }
    const failed = (box.sites || []).filter((x) => x.error);
    customSummary.hidden = false;
    // **The children are filtered.** `replaceChildren` stringifies anything that is not a
    // node, so the `null` this passed when no site had failed came out as the word "null"
    // printed in the summary line.
    customSummary.replaceChildren(...[
      el("span", { class: "drawer-summary-line", text: `Custom Sites: ${rows.length} stream${rows.length === 1 ? "" : "s"}` }),
      failed.length
        ? el("span", { class: "drawer-summary-note", text: failed.map((x) => `${x.domain}: ${x.error}`).join(" · ") })
        : null,
      el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: "Clear",
        onclick: () => {
          state.customStreams[customKey] = { streams: [], sites: [], at: 0 };
          drawSources(shown.filter((r) => !r.custom), currentSource);
        },
      }),
    ].filter(Boolean));
  };

  /** Ask the sites for this title. Runs once when the player opens. */
  const runSearchOnPlay = async (intro = "") => {
    if (customBusy || !state.prefs?.searchOnPlay) return;
    const meta = opts.meta || {};
    // Whatever happened just before — cookies saved for a site the user verified by hand —
    // stays readable under the search's own line instead of being overwritten by it.
    const lead = intro ? `${intro} ` : "";
    customBusy = true;
    customNote.className = "drawer-extract-note";
    customNote.replaceChildren(el("span", { class: "drawer-spinner", "aria-hidden": "true" }), el("span", { text: " Searching your sites…" }));
    /**
     * **Draw what the search has so far.**
     *
     * Called on every poll, so a site that answers first puts its streams on screen while
     * the slow ones are still working — and the note is the server's own line for the
     * state it is in, not a spinner that says nothing.
     */
    const showSearch = (res) => {
      const box = customBox();
      box.streams = (res?.streams || []).map((r) => ({ ...r, custom: true, name: r.title || r.name || "Stream" }));
      box.sites = res?.sites || [];
      box.at = Date.now();
      const text = res?.message || (box.streams.length ? `Custom Sites: ${box.streams.length} streams.` : "");
      customNote.className = `drawer-extract-note${box.streams.length ? " ok" : ""}`;
      if (res?.running && !box.streams.length) {
        customNote.replaceChildren(el("span", { class: "drawer-spinner", "aria-hidden": "true" }), el("span", { text: `${lead}${text || "Searching your sites…"}` }));
      } else {
        customNote.textContent = `${lead}${text}`;
      }
      drawSources([...shown.filter((r) => !r.custom), ...box.streams], currentSource);
    };

    try {
      // **Started, then watched.** The server runs the search in the background (a site is
      // allowed a long slice of the budget), and this polls it — one short request at a
      // time. Holding a single request open for the whole search is what the proxy in
      // front of the app answers with **502**, which is what "Custom Sites could not be
      // searched — HTTP 502" was.
      const started = await post("/custom-sites/streams.json", {
        title: meta.name || opts.title || title || "",
        year: meta.releaseInfo || "",
        type: meta.type === "series" ? "series" : "movie",
      });
      // A dead app server answers with this envelope rather than throwing, and "HTTP 503"
      // on its own does not say what failed.
      if (started?.unreachable) throw new Error(started.message);
      showSearch(started);
      // A server that answered the whole search in one go has nothing to poll.
      if (started?.id && started.running) {
        const until = Date.now() + 90000;
        while (Date.now() < until && customBusy) {
          await new Promise((r) => setTimeout(r, 700));
          if (!customBusy) return;
          const snap = await get(`/custom-sites/streams.json?id=${encodeURIComponent(started.id)}`).catch(() => null);
          if (!snap) break;
          showSearch(snap);
          if (!snap.running) break;
        }
      }
      drawCustomSummary();
    } catch (err) {
      customNote.className = "drawer-extract-note bad";
      customNote.textContent = `${lead}Custom Sites could not be searched — ${err.message}`;
      drawSources(shown, currentSource);
    } finally {
      customBusy = false;
      drawCustomSummary();
    }
  };

  /**
   * A site that answered with a bot check is asking for a person. The server opens a
   * visible window on the machine that runs it; the user solves the challenge and presses
   * Done, and the cookies it earned are kept for every later fetch of that domain.
   */
  const offerVerification = async (domain) => {
    const res = await post("/scraper/verify", { url: `https://${domain}/` });
    customNote.className = `drawer-extract-note${res?.ok ? " ok" : " bad"}`;
    customNote.textContent = res?.message || "No answer.";
    if (!res?.ok) return;
    const done = el("button", {
      class: "btn primary focusable",
      type: "button",
      text: "Done",
      onclick: async () => {
        const finished = await post("/scraper/verify/done", { sessionId: res.sessionId });
        customNote.className = `drawer-extract-note${finished?.ok ? " ok" : " bad"}`;
        customNote.textContent = finished?.message || "Cookies saved.";
        // The cookies are the point: with them the site can be searched for real, so the
        // search is run again straight away — and the line above is kept above its answer.
        if (finished?.ok) runSearchOnPlay(finished.message || "Cookies saved.");
      },
    });
    customNote.after(el("div", { class: "source-form" }, done));
  };


  /**
   * One stream row.
   *
   * A **scraped** row is drawn as the three-line card a Stremio add-on produces — the
   * identity, the name, the provenance — with the format as a chip. The domain appears
   * once, on the first line: it used to be printed twice, which is noise. An add-on's own
   * row keeps the one-line shape it always had.
   */
  const streamRow = (s, currentUrl) => {
    const active = (s.torrent ? s.magnet : s.url) === currentUrl;
    const classes = `stream focusable${active ? " active" : ""}${isExternalStream(s) ? " stream-external" : ""}${s.torrent ? " stream-torrent" : ""}${s.custom ? " stream-custom" : ""}`;
    const click = async () => {
      drawer.hidden = true;
      if (isExternalStream(s)) {
        window.open(s.url, "_blank", "noopener");
        return;
      }
      await attach(s);
      drawSources(shown, currentSource);
    };
    if (s.scraped || s.custom) {
      const card = s.card || { line1: [s.domain, s.quality, s.format].filter(Boolean).join(" · "), line2: s.title || s.name || "Stream", line3: s.protocol || s.source || "" };
      return el("button", { class: classes, type: "button", title: s.url, onclick: click },
        el("span", { class: "stream-card" },
          el("span", { class: "stream-line1", text: card.line1 || "stream" }),
          el("span", { class: "stream-line2", text: card.line2 || s.title || "Stream" }),
          el("span", { class: "stream-line3", text: card.line3 || "" }),
        ),
        el("span", { class: "stream-tag", text: s.tag || "direct" }),
      );
    }
    return el("button", { class: classes, type: "button", onclick: click },
      el("span", { class: "stream-name", text: s.name || s.source || "Stream" }),
      el("span", { class: "stream-detail", text: [s.quality, s.source, s.title].filter(Boolean).join(" · ") }),
      isExternalStream(s) ? el("span", { class: "stream-flag", text: "opens externally" }) : null,
      s.torrent
        ? el("span", {
            class: "stream-flag",
            // **"needs debrid" was true when the page had to join the swarm itself.** It
            // is not any more: the server has a real torrent engine, so a magnet with no
            // debrid account is streamed from here. The flag says what will actually
            // happen — through the account, from the server's swarm, or (with neither)
            // that a debrid account is the one thing that would make it play.
            text: `torrent · ${
              debridLabel()
                ? `via ${debridLabel()}`
                : s.seeders
                  ? `${s.seeders} seeders`
                  : state.options?.torrent?.ready
                    ? "played by the server"
                    : "needs debrid"
            }`,
          })
        : null,
    );
  };

  const drawSources = (list, currentUrl) => {
    if (Array.isArray(list)) shown = list;
    const blocked = (customBox().sites || []).filter((x) => x.needsVerification);
    // **The children are filtered.** `replaceChildren` stringifies anything that is not
    // a node, so the `null`s this used to pass for "no add-on lines" came out as the
    // word "null" printed under the heading — `el()` drops them, this did not.
    const parts = [
      el("h3", { class: "row-head", text: "Sources" }),
      customSummary,
      customNote,
      blocked.length
        ? el("div", { class: "source-form" },
            el("span", { class: "option-desc", text: `${blocked[0].domain} wants manual verification.` }),
            el("button", { class: "btn subtle focusable", type: "button", text: "Open a window", onclick: () => offerVerification(blocked[0].domain) }),
          )
        : null,
      addonLines.length
        ? el("div", { class: "drawer-addons" }, ...addonLines.map((s) =>
            el("p", {
              class: `drawer-addon${s.ok ? "" : " drawer-addon-failed"}`,
              text: `${s.name}: ${s.ok ? s.message : `failed — ${s.message}`}`,
              title: `${s.name} — ${s.ok ? s.message : `failed — ${s.message}`}`,
            })))
        : null,
      list && list.length
        ? el("div", { class: "stream-list" }, ...list.map((s) => streamRow(s, currentUrl)))
        : el("p", { class: "empty", text: "No streams returned. Add or fix an add-on in Settings → Add-ons & plugins, then press Sources again." }),
    ].filter(Boolean);
    drawer.replaceChildren(...parts);
  };
  // The rows already extracted for this title are re-seated: they survive closing the
  // player, and are gone on a restart, which is the lifetime a stream URL deserves.
  drawSources([...shown.filter((r) => !r.custom), ...(customBox().streams || [])], currentSource);
  drawCustomSummary();
  // **Search-on-play.** The sites are asked once, in the background, so the picture is
  // playing while the drawer fills in.
  Promise.resolve().then(runSearchOnPlay);
  // **More sources, on the way.** A channel starts playing on the lineup's own URL and
  // the add-ons are asked after that, so a tap is instant and the drawer fills in when
  // they answer — the alternative was holding the whole channel behind a scraping
  // add-on's response time.
  if (typeof opts.loadStreams === "function") {
    Promise.resolve()
      .then(opts.loadStreams)
      .then((more) => {
        const extra = more?.streams || [];
        if (more?.sources) addonLines.push(...more.sources);
        const list = [...shown, ...extra];
        if (list.length) drawSources(list, currentSource);
      })
      .catch(() => {
        /* the drawer simply keeps what it had */
      });
  }

  const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  // **A streaming player, not a browser control strip**: a big centre target while
  // the picture is paused (Nuvio's), and one floating rounded bar at the foot of the
  // screen (Stremio's), grouped left and right with the accent on what you touch.
  const centre = el(
    "button",
    { class: "player-center focusable", type: "button", title: "Play / pause", onclick: togglePlay },
    playerGlyph(PLAY_MARK(), 30),
  );
  const syncCentre = () => { centre.hidden = !video.paused; setPlayMark(video.paused); };
  video.addEventListener("play", syncCentre);
  video.addEventListener("pause", syncCentre);
  video.addEventListener("click", togglePlay);
  syncCentre();

  /**
   * A press-and-hold control.
   *
   * Quiver's own two-speed buttons did one jump per click; these ramp while the
   * button is held — one step at once, then a step every 110ms — and on release the
   * ramped value is handed back to what the button says is in force, so the readout
   * and the playhead never disagree. The plain click still does its original job.
   */
  const holdable = (button, step, onChange, onRelease) => {
    let timer = null;
    let ramped = false;
    const tick = () => {
      ramped = true;
      onChange(step);
      timer = setTimeout(tick, 110);
    };
    button.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      const dir = e.button === 2 ? Math.abs(step) : step;
      button.dataset.ramping = "1";
      onChange(dir);
      ramped = true;
      timer = setTimeout(tick, 260);
      button._rampStep = dir;
    });
    const stop = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (button.dataset.ramping) {
        delete button.dataset.ramping;
        if (onRelease) onRelease(ramped);
      }
    };
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointerleave", stop);
    button.addEventListener("pointercancel", stop);
    return () => button.dataset.ramping === "1";
  };

  // **The two ±10s buttons ramp the speed while held.** A press still seeks by ten
  // seconds; holding keeps pushing the rate — up on the forward button, down on the
  // back one — until you let go, and the release hands the rate back to the speed
  // button's own value.
  const speedRamp = (delta) => {
    const next = Math.min(3, Math.max(0.25, Math.round((video.playbackRate + delta) * 100) / 100));
    video.playbackRate = next;
    speedNote.textContent = `${next.toFixed(2)}×`;
  };
  const speedRelease = () => {
    video.playbackRate = RATES[rateIndex];
    speedNote.textContent = "";
  };

  const backBtn = el("button", { class: "player-icon focusable", type: "button", title: "Back 10 seconds (hold to slow down)", id: "player-back" },
    playerGlyph([svgNode("path", { d: "M17.5 6.5v11L9 12z" }), svgNode("path", { d: "M6 6.5v11" })]));
  const isRampingBack = holdable(backBtn, -0.25, speedRamp, speedRelease);
  backBtn.addEventListener("click", () => { if (!isRampingBack()) video.currentTime = Math.max(0, (video.currentTime || 0) - 10); });

  const fwdBtn = el("button", { class: "player-icon focusable", type: "button", title: "Forward 10 seconds (hold to speed up)", id: "player-forward" },
    playerGlyph([svgNode("path", { d: "M6.5 6.5v11L15 12z" }), svgNode("path", { d: "M18 6.5v11" })]));
  const isRampingFwd = holdable(fwdBtn, 0.25, speedRamp, speedRelease);
  fwdBtn.addEventListener("click", () => { if (!isRampingFwd()) video.currentTime = (video.currentTime || 0) + 10; });

  // **The volume is one box: − | the figure | +.**
  //
  // There was a single speaker mark that muted on a left click and stepped on a right
  // click or the wheel — three gestures on one button, none of them visible, and the
  // level itself only knowable from the picture's loudness. It is a group now: a down
  // mark, the percentage in the middle, an up mark, all inside one bordered box in the
  // strip. **Both marks ramp while held** (the same `holdable` the ±10s buttons use),
  // and a click is one 1% step — the increment the user asked for, on the buttons, on the
  // wheel and on the arrow keys, so nothing in the player moves the volume by a stride
  // the others do not. The figure is the mute button: press it to go silent
  // and again to come back, which is what the speaker mark used to do.
  const volValue = el("span", { class: "player-vol-value", id: "player-vol-value", text: "100%" });
  const volDown = el("button", { class: "player-vol-btn focusable", type: "button", title: "Volume down (hold to keep lowering)", id: "player-vol-down" },
    playerGlyph([svgNode("path", { d: "M4 9.5h3.3L11 6.6v10.8L7.3 14.5H4z" }), svgNode("path", { d: "M14.6 9.8h4.6M14.6 13.4h4.6" })]));
  const volUp = el("button", { class: "player-vol-btn focusable", type: "button", title: "Volume up (hold to keep raising)", id: "player-vol-up" },
    playerGlyph([svgNode("path", { d: "M4 9.5h3.3L11 6.6v10.8L7.3 14.5H4z" }), svgNode("path", { d: "M14.8 9.6a3.6 3.6 0 0 1 0 4.8" }), svgNode("path", { d: "M17.3 7.4a7 7 0 0 1 0 9.2" })]));
  const volRamp = (delta) => setVolume((video.muted ? 0 : video.volume) + delta);
  holdable(volDown, -0.01, volRamp, () => syncVolume());
  holdable(volUp, 0.01, volRamp, () => syncVolume());
  const syncVolume = () => {
    const level = video.muted ? 0 : video.volume;
    volValue.textContent = `${Math.round(level * 100)}%`;
    volValue.classList.toggle("muted", video.muted || level === 0);
    volValue.title = video.muted ? "Unmute" : "Mute";
    volDown.disabled = level === 0;
    volUp.disabled = level === 1;
  };
  volValue.addEventListener("click", () => { video.muted = !video.muted; syncVolume(); });
  volDown.addEventListener("wheel", (e) => { e.preventDefault(); volRamp(e.deltaY < 0 ? 0.01 : -0.01); syncVolume(); }, { passive: false });
  volUp.addEventListener("wheel", (e) => { e.preventDefault(); volRamp(e.deltaY < 0 ? 0.01 : -0.01); syncVolume(); }, { passive: false });
  video.addEventListener("volumechange", syncVolume);
  // **One inner box around the whole volume.** The three of them were separate chips in a
  // row — a shape nothing else in the bar wears twice — so the box is the chip now
  // (`height: 34px`, radius 9px, the same fill as the transport marks) and −, the figure
  // and + are marks drawn on it. The figure between them is the mute button.
  volDown.className = "player-vol-btn focusable";
  volUp.className = "player-vol-btn focusable";
  volValue.className = "player-vol-value";
  const volBox = el("div", { class: "player-vol", id: "player-volume" }, volDown, volValue, volUp);
  syncVolume();

  // **The aspect-ratio mark replaces Picture-in-picture.** It cycles how the picture
  // fills its stage: fit, fill, then two fixed shapes.
  const ASPECTS = [
    ["Fit", "contain", ""],
    ["Fill", "cover", ""],
    ["16:9", "contain", "16 / 9"],
    ["4:3", "contain", "4 / 3"],
  ];
  let aspectIndex = 0;
  const aspect = el("button", { class: "player-icon focusable", type: "button", title: "Aspect ratio", id: "player-aspect" },
    playerGlyph([svgNode("path", { d: "M3.5 6.5h17v11h-17z" }), svgNode("path", { d: "M8 10.5h8" }), svgNode("path", { d: "M8 13.5h5" })]));
  aspect.addEventListener("click", () => {
    aspectIndex = (aspectIndex + 1) % ASPECTS.length;
    const [label, fit, ratio] = ASPECTS[aspectIndex];
    video.style.objectFit = fit;
    video.style.aspectRatio = ratio;
    video.style.width = ratio ? "auto" : "100%";
    video.style.height = "100%";
    aspect.title = `Aspect ratio: ${label}`;
  });

  // **Audio and subtitle tracks live behind a gear, left of Sources.**
  //
  // The list is the stream's *real* tracks, gathered from both places they can live:
  // an HLS manifest's own track lists — which is where a multi-language IPTV channel
  // keeps its audios — and the element's native `audioTracks`/`textTracks`, which is
  // what a progressive file (or Safari) exposes. Reading only `video.textTracks` is
  // why this panel looked permanently empty: an hls.js stream keeps its tracks on the
  // Hls instance, not on the `<video>` element at all.
  const gearPanel = el("aside", { class: "player-settings-menu", hidden: true });
  const trackLabel = (t, i) => `${t.name || t.label || t.lang || t.language || `Track ${i + 1}`}${t.forced ? " (forced)" : ""}`;

  /**
   * **The subtitle services: the subtitles this stream does not carry.**
   *
   * The list below is what the manifest and the element *have*; this is where one
   * comes from when they have nothing. Every service enabled in Settings → Subtitles is
   * searched at once for the title you are watching — an episode is the show's IMDb id
   * plus its season and episode, which is the shape the catalogues index — and the pick
   * is fetched as **WebVTT from this app's own server**, so the `<track>` element reads
   * it with no CORS in the way and can seek inside it. The service a result came from
   * leads its row.
   *
   * Nothing is searched until the panel is opened: a subtitle lookup for every stream
   * you start would spend the quota on titles you never asked about — which, with
   * several keys in play, is several quotas.
   */
  const OS_TRACK_ID = "opensubtitles-track";
  const osState = { loading: false, note: "", error: "", results: [], active: null, busy: null };
  const osList = el("div", { class: "stream-list" });
  let osBlob = "";

  const osReady = () => Boolean(state.subtitles?.ready) || subtitleActive().length > 0;

  const osQuery = () => {
    const meta = opts.meta || {};
    const params = new URLSearchParams();
    if (meta.id) params.set("id", String(meta.id).replace(/^tmdb:/, ""));
    params.set("type", meta.type === "series" ? "series" : "movie");
    if (meta.season && meta.episode) {
      params.set("season", meta.season);
      params.set("episode", meta.episode);
    }
    // A live channel has no id to look up, so the name is the only handle there is.
    params.set("name", String(meta.name || opts.title || title || ""));
    if (state.subtitles?.language) params.set("lang", state.subtitles.language);
    return params.toString();
  };

  /** The service each result can come from — shown on the row, and in the track's label. */
  const OS_PROVIDER_LABELS = { opensubtitles: "OpenSubtitles", subdl: "SubDL", subsource: "SubSource", wyzie: "Wyzie" };
  /** A result's identity across services: two services can each hand out id 5. */
  const osKey = (r) => `${r.provider || "opensubtitles"}:${r.id}`;
  const osLabel = (r) => {
    // The service leads the row: with several enabled, "which catalogue is this from" is
    // the first thing the eye needs.
    const bits = [
      OS_PROVIDER_LABELS[r.provider || "opensubtitles"] || r.provider || "Subtitle",
      String(r.language || "").toUpperCase(),
      r.release || "Subtitle",
    ];
    if (r.hearingImpaired) bits.push("HI");
    if (r.automatic) bits.push("auto-translated");
    if (r.downloads) bits.push(`${Number(r.downloads).toLocaleString()}↓`);
    return bits.join(" · ");
  };

  const drawOpenSubtitles = () => {
    const list = [];
    if (!osReady()) {
      list.push(el("p", { class: "empty", text: "Subtitles are not set up — add a key for a service in Settings → Subtitles and this stream gets whatever language it does not carry." }));
      osList.replaceChildren(...list);
      return;
    }
    // "Off" leads the list, exactly as the stream's own subtitle list is written.
    list.push(el("button", {
      class: `stream focusable${osState.active ? "" : " active"}`,
      type: "button",
      text: "Off",
      onclick: () => osOff(),
    }));
    if (osState.loading) {
      list.push(el("p", { class: "empty", text: osState.note || "Searching for subtitles…" }));
    } else {
      if (osState.error) list.push(el("p", { class: "empty", text: osState.error }));
      else if (!osState.results.length) list.push(el("p", { class: "empty", text: osState.note || "None of the services has a subtitle for this title." }));
      for (const r of osState.results) {
        list.push(el("button", {
          class: `stream focusable${osState.active === osKey(r) ? " active" : ""}`,
          type: "button",
          // "fetching…" is the feedback for the second or two between the pick and the
          // picture having subtitles; without it the panel looks like the click missed.
          text: osState.busy === osKey(r) ? `${osLabel(r)} — fetching…` : osLabel(r),
          onclick: () => osPick(r),
        }));
      }
      list.push(el("button", {
        class: "btn subtle focusable",
        type: "button",
        text: osState.results.length ? "Search again" : "Search for subtitles",
        onclick: () => osSearch(true),
      }));
    }
    osList.replaceChildren(...list);
  };

  /** Take the fetched subtitle off the picture. */
  const osOff = () => {
    for (const t of Array.from(video.textTracks || [])) {
      if (t.id === OS_TRACK_ID) t.mode = "disabled";
    }
    for (const node of Array.from(video.querySelectorAll(`#${OS_TRACK_ID}`))) node.remove();
    if (osBlob) {
      URL.revokeObjectURL(osBlob);
      osBlob = "";
    }
    osState.active = null;
    drawOpenSubtitles();
  };

  /**
   * Attach one fetched subtitle to the picture.
   *
   * **One at a time.** Picking a second one replaces the first rather than stacking two
   * lines of dialogue, and the manifest's own subtitle display is switched off — a
   * stream that carries its own English subtitles would otherwise draw both.
   */
  const osAttach = (vtt, result) => {
    osOff();
    const track = el("track", {
      id: OS_TRACK_ID,
      kind: "subtitles",
      label: `${OS_PROVIDER_LABELS[result.provider || "opensubtitles"] || "Subtitle"} · ${String(result.language || "").toUpperCase()}`,
      srclang: result.language || "en",
    });
    osBlob = URL.createObjectURL(new Blob([vtt], { type: "text/vtt;charset=utf-8" }));
    track.setAttribute("src", osBlob);
    track.addEventListener("load", () => {
      if (track.track) track.track.mode = "showing";
    });
    video.append(track);
    if (track.track) track.track.mode = "showing";
    if (playerHls) {
      try { playerHls.subtitleDisplay = false; } catch { /* not loaded yet */ }
    }
    osState.active = osKey(result);
  };

  const osPick = async (result) => {
    const key = osKey(result);
    osState.busy = key;
    osState.error = "";
    drawOpenSubtitles();
    try {
      // The **service** is part of the path: the same subtitle id exists in several
      // catalogues, so the server has to be told which one to fetch from.
      const provider = encodeURIComponent(result.provider || "opensubtitles");
      const vtt = await getText(`/subtitles/${provider}/${encodeURIComponent(result.id)}.vtt`);
      osAttach(vtt, result);
    } catch (err) {
      osState.error = `Could not load that subtitle — ${err.message}`;
    } finally {
      osState.busy = null;
      drawOpenSubtitles();
    }
  };

  const osSearch = async (force = false) => {
    if (!osReady()) return;
    osState.loading = true;
    osState.error = "";
    osState.results = [];
    osState.note = "Searching for subtitles…";
    drawOpenSubtitles();
    try {
      const res = await get(`/subtitles/search.json?${osQuery()}${force ? `&_=${Date.now()}` : ""}`);
      if (!res?.ok) osState.error = res?.message || "No subtitle service answered.";
      else {
        osState.results = res.results || [];
        osState.note = res.message || "";
      }
    } catch (err) {
      osState.error = `Could not search for subtitles — ${err.message}`;
    } finally {
      osState.loading = false;
      drawOpenSubtitles();
    }
  };

  const drawTracks = () => {
    const hlsAudio = Array.from(playerHls?.audioTracks || []);
    const hlsSubs = Array.from(playerHls?.subtitleTracks || []);
    const nativeAudio = Array.from(video.audioTracks || []);
    // The OpenSubtitles track is a `<track>` element too, but it is listed in its own
    // section below — showing it twice would make the panel look like it had found
    // the same subtitle in two places.
    const nativeSubs = Array.from(video.textTracks || []).filter(
      (t) => (t.kind === "subtitles" || t.kind === "captions") && t.id !== OS_TRACK_ID,
    );

    // Subtitles: HLS tracks when the manifest declares them, the element's own
    // otherwise. Only one of the two can be in force, so they are one list.
    const subs = [];
    if (hlsSubs.length) {
      const active = Number(playerHls.subtitleTrack);
      subs.push(el("button", {
        class: `stream focusable${active < 0 ? " active" : ""}`, type: "button", text: "Off",
        onclick: () => { playerHls.subtitleDisplay = false; playerHls.subtitleTrack = -1; gearPanel.hidden = true; },
      }));
      hlsSubs.forEach((t, i) => subs.push(el("button", {
        class: `stream focusable${active === i ? " active" : ""}`, type: "button", text: trackLabel(t, i),
        onclick: () => { playerHls.subtitleDisplay = true; playerHls.subtitleTrack = i; gearPanel.hidden = true; },
      })));
    } else if (nativeSubs.length) {
      subs.push(el("button", {
        class: `stream focusable${nativeSubs.every((t) => t.mode !== "showing") ? " active" : ""}`, type: "button", text: "Off",
        onclick: () => { for (const t of nativeSubs) t.mode = "disabled"; gearPanel.hidden = true; },
      }));
      nativeSubs.forEach((t, i) => subs.push(el("button", {
        class: `stream focusable${t.mode === "showing" ? " active" : ""}`, type: "button", text: trackLabel(t, i),
        onclick: () => { for (const x of nativeSubs) x.mode = "disabled"; t.mode = "showing"; gearPanel.hidden = true; },
      })));
    }

    // Audio: a chooser only when there is a choice to make. With one track the panel
    // says which one it is instead of offering a button that changes nothing — and
    // when the browser exposes none, it says that too, because "Default" on its own
    // is the answer that made this screen look broken.
    const audios = [];
    if (hlsAudio.length > 1) {
      const active = Number(playerHls.audioTrack);
      hlsAudio.forEach((t, i) => audios.push(el("button", {
        class: `stream focusable${active === i ? " active" : ""}`, type: "button", text: trackLabel(t, i),
        onclick: () => { playerHls.audioTrack = i; gearPanel.hidden = true; },
      })));
    } else if (nativeAudio.length > 1) {
      nativeAudio.forEach((a, i) => audios.push(el("button", {
        class: `stream focusable${a.enabled ? " active" : ""}`, type: "button", text: trackLabel(a, i),
        onclick: () => { for (const x of nativeAudio) x.enabled = false; a.enabled = true; gearPanel.hidden = true; },
      })));
    }
    const only = hlsAudio[0] || nativeAudio[0];
    const audioNote = only
      ? `${trackLabel(only, 0)} — the stream's only audio track.`
      : "This stream declares one audio track, and the browser does not list it — so there is nothing here to choose between.";

    gearPanel.replaceChildren(
      el("h3", { class: "row-head", text: "Subtitles" }),
      el("div", { class: "stream-list" },
        ...(subs.length ? subs : [el("p", { class: "empty", text: "This stream carries no subtitles." })]),
      ),
      el("h3", { class: "row-head", text: "Audio" }),
      el("div", { class: "stream-list" },
        ...(audios.length ? audios : [el("p", { class: "empty", text: audioNote })]),
      ),
      el("h3", { class: "row-head", text: "Subtitle services" }),
      el("p", {
        class: "option-desc",
        text: "A subtitle this stream does not carry, fetched from the services set up in Settings → Subtitles for the title — and the episode — you are watching.",
      }),
      osList,
    );
    drawOpenSubtitles();
  };

  // A finished episode is followed by the season it belongs to: the row is drawn
  // here, over the picture, the moment playback ends.
  const episodes = Array.isArray(opts.episodes) ? opts.episodes : [];
  const epCard = el("aside", { class: "player-episodes", hidden: true });
  if (episodes.length) {
    video.addEventListener("ended", () => {
      epCard.replaceChildren(
        el("h3", { class: "row-head", text: "Up next in this season" }),
        el("div", { class: "episode-list" }, ...episodes.map((ep) =>
          el("button", {
            class: `episode-item focusable${ep.url === src ? " active" : ""}`,
            type: "button",
            text: `${ep.season ? `S${ep.season}` : ""}${ep.episode ? `E${ep.episode}` : ""}${ep.episode ? " · " : ""}${ep.name || "Episode"}`,
            onclick: async () => {
              epCard.hidden = true;
              if (ep.url) await openPlayer(ep.url, ep.name || title, { ...opts, episodes });
            },
          })
        )),
      );
      epCard.hidden = false;
    });
  }

  const node = el(
    "div",
    { class: "player" },
    el(
      "div",
      { class: "player-stage" },
      video,
      centre,
      drawer,
      gearPanel,
      episodes.length ? epCard : null,
      el(
        "div",
        { class: "player-controls" },
        el("div", { class: "player-group" },
          // **Settings sits left of Sources**: audio and subtitle tracks are options
          // on the thing you are watching, and the drawer of other streams sits next
          // to them.
          el("button", {
            class: "player-icon focusable", type: "button", id: "player-settings", title: "Audio & subtitles",
            onclick: () => {
              const opening = gearPanel.hidden;
              drawTracks();
              // **One panel at a time.** Both open above the same end of the bar now (their
              // buttons are the first two on the left), so leaving the other one open would
              // stack two boxes in the same place.
              if (opening) drawer.hidden = true;
              gearPanel.hidden = !opening;
              // The lookup is a live API call with a daily quota, so it happens when the
              // panel is opened for the first time — not for every stream that starts.
              if (opening && osReady() && !osState.loading && !osState.results.length && !osState.active && !osState.error) osSearch();
            },
          }, playerGlyph([svgNode("circle", { cx: "12", cy: "12", r: "3.2" }), svgNode("path", { d: "M12 3.4v2.2M12 18.4v2.2M20.6 12h-2.2M5.6 12H3.4M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6M18.1 18.1l-1.6-1.6M7.5 7.5L5.9 5.9" })])),
          opts.streams?.length
            ? el("button", {
                class: "player-icon focusable", type: "button", id: "player-sources", title: "Sources",
                // Above its own button — the Sources button is on the **left** of the bar,
                // so the drawer opens on the left (see `.player-sources`).
                onclick: () => {
                  const opening = drawer.hidden;
                  if (opening) gearPanel.hidden = true;
                  drawer.hidden = !opening;
                },
              }, playerGlyph([svgNode("path", { d: "M3.5 7.5a2 2 0 0 1 2-2h3.3l1.8 2h6.9a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" })]))
            : null,
          // **The rule that splits the bar.** Options on the left (what this stream
          // is), transport on the right of the line (what the picture is doing) —
          // without it the two groups read as one long row of unrelated buttons.
          opts.streams?.length ? el("span", { class: "player-rule", "aria-hidden": "true" }) : null,
          backBtn,
          playBtn,
          fwdBtn,
          speedNote,
          // **The seek bar and its two clocks are one card.** The times used to sit
          // outside it — the elapsed figure at the end of the transport group, the
          // duration at the start of the next one — so the bar read as a line drawn on
          // the strip rather than as a control with a surface, and its own readings
          // looked like they belonged to the buttons either side. They are inside the
          // card now: `0:00 ——— 1:34`, one object.
          el("div", { class: "player-seek-box" }, clock, seek, total),
        ),
        el("div", { class: "player-group end" },
          volBox,
          rate,
          aspect,
          // **No fullscreen button:** pressing Play already opened the picture in
          // full screen, so a control to enter it would be a button that does nothing
          // the moment you would use it. Escape and the close mark both leave.
          el("button", { class: "player-icon focusable", type: "button", title: "Close player", onclick: stopPlayer },
            playerGlyph([svgNode("path", { d: "M6.5 6.5l11 11" }), svgNode("path", { d: "M17.5 6.5l-11 11" })])),
        ),
      ),
    ),
  );
  // The failure line is **one element**, not one per attempt: switching sources
  // several times must not stack four copies of the same complaint.
  const errorNote = el("p", { class: "player-error", hidden: true });
  node.append(errorNote);
  const sayError = (text) => { errorNote.textContent = text || ""; errorNote.hidden = !text; };

  document.body.append(node);
  playerNode = node;
  document.addEventListener("keydown", playerKey);
  node.focus?.();
  // **Play means full screen.** The device's own full screen used to be one more
  // button to find after pressing play. It is asked for here, and **synchronously**:
  // a fullscreen request is only honoured while the click that caused it is still on
  // the stack, and the first `await` below would spend it. The overlay fills the
  // window either way, so a refusal costs nothing.
  // **The document is the fullscreen element, not this overlay.** A fullscreen request
  // made here is outside the click that asked for it (the player has awaited a round of
  // add-on calls by now), so browsers refuse it — and an element that is replaced takes
  // full screen with it. The document never gets replaced, and the overlay covers it.
  if (opts.fullscreen !== false && !document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => { /* the overlay still fills the window */ });
  }

  const native = video.canPlayType("application/vnd.apple.mpegurl");

  /** Take down the current picture: the swarm, the manifest, and the element's source. */
  const clearPicture = () => {
    stopTorrent();
    if (playerHls) {
      try { playerHls.destroy(); } catch { /* already gone */ }
      playerHls = null;
    }
    video.pause();
    video.removeAttribute("src");
    // The torrent notes belong to the source being left behind.
    for (const stale of Array.from(node.querySelectorAll(".player-torrent-note, .player-torrent-hint"))) stale.remove();
    sayError("");
    seek.value = "0";
    clock.textContent = "0:00";
    total.textContent = "0:00";
  };

  /**
   * **The one place a source becomes a picture.**
   *
   * The stream the player opened with and a source picked in the Sources drawer both
   * come through here, which is what makes switching instant: the picture is
   * re-pointed in place. Clicking a source used to call `openPlayer` again — tearing
   * the overlay down, re-asking every add-on through `loadStreams`, and asking for
   * fullscreen a second time — so a different source took seconds to appear on the
   * thing you were already watching.
   *
   * `seq` supersedes: a slow resolve or a slow manifest from a source you left must
   * not paint over the one you picked afterwards.
   */
  const attach = async (source) => {
    const s = typeof source === "string" ? { url: source } : source || {};
    const target = s.torrent ? s.magnet : s.url;
    if (!target) return;
    const seq = (playerSeq += 1);
    currentSource = target;
    clearPicture();
    // **The extracted URL, on the record.** When a stream will not play, the first
    // question is always *what was actually handed to the element* — and that answer
    // has to be visible without a debugger.
    console.log("[player] playing", target, s.scraped || s.custom ? `(scraped${s.source ? ` by ${s.source}` : ""})` : "");
    // **A `blob:` / `data:` URL is a page-local object.** It exists only inside the tab
    // that created it and no other element, process or fetch can reach it, so it is
    // called out instead of being set on the element for a black frame.
    if (!s.torrent && isUnplayableUrl(target)) {
      sayError(`This stream is a ${String(target).split(":")[0]}: URL — a page-local object that no player can open. Pick another source.`);
      return;
    }
    // **A scraped file is played through the server.** A site that serves only to a
    // request carrying its own `Referer` and its session cookie cannot be satisfied by a
    // `<video>` element; the proxy adds both and rewrites an HLS manifest's segments to
    // come back the same way. Anything the extractor produced takes this path.
    const needsProxy = !s.torrent && (s.scraped || s.custom || s.referer);
    const playUrl = needsProxy ? proxyPath(target, s.referer || s.page || "") : target;
    const hlsTarget = IS_HLS(target);
    if (needsProxy) console.log("[player] via proxy", playUrl);
    // **A torrent is not a URL.** The picture comes from the swarm — or from a
    // debrid account's direct link — so the element is handed a file, not an address.
    if (s.torrent) {
      await playTorrent(node, video, target, {
        fileIdx: s.fileIdx,
        infoHash: s.infoHash || "",
        streamName: s.title || s.name || "",
        title,
      }, seq);
      return;
    }
    try {
      if (hlsTarget && !native) {
        const Hls = await loadHls();
        if (seq !== playerSeq) return;
        if (Hls.isSupported()) {
          playerHls = new Hls({ lowLatencyMode: true });
          // **The Audio & subtitles panel reads this instance.** A manifest's tracks
          // are parsed after `loadSource`, so the panel is redrawn as they arrive —
          // otherwise it is filled from a list that did not exist yet, which is what
          // made it look permanently empty.
          const redrawTracks = () => { if (!gearPanel.hidden) drawTracks(); };
          for (const event of [Hls.Events.MANIFEST_PARSED, Hls.Events.AUDIO_TRACKS_UPDATED, Hls.Events.SUBTITLE_TRACKS_UPDATED]) {
            if (event) playerHls.on(event, redrawTracks);
          }
          playerHls.loadSource(playUrl);
          playerHls.attachMedia(video);
        } else {
          // No MSE either: the browser's own HLS is the only thing left to try.
          video.src = playUrl;
        }
      } else {
        // **`.mp4` (and everything not a playlist) goes to the element directly** — the
        // element is the standard player, and it seeks without an engine.
        video.src = playUrl;
      }
      if (seq !== playerSeq) return;
      await video.play().catch(() => {
        /* autoplay refused: the controls are right there */
      });
    } catch (err) {
      if (seq !== playerSeq) return;
      sayError(`Could not play this stream — ${err.message}`);
    }
  };

  await attach(opts.torrent
    ? { torrent: true, magnet: src, fileIdx: opts.fileIdx, infoHash: opts.infoHash, title: opts.streamName }
    : { url: src });
}

/**
 * Play a title: ask the server for its streams, then open the player.
 *
 * The streams come from the Stremio add-ons you added (see `addon/streams.mjs`) —
 * read on the server, because a browser cannot call another host's `/stream/…`.
 * With none configured, or with none answering, the player still opens and says so.
 */
async function openSources(meta) {
  const media = meta.type === "series" ? "series" : "movie";
  const id = String(meta.id || "").replace(/^tmdb:/, "");
  // The "finding sources" screen is the player too — full screen, one centred
  // panel, **no title bar across the top and no sentence about what it is doing**.
  const overlay = el("div", { class: "player loading-player empty-player" },
    el("div", { class: "player-empty-body" },
      el("span", { class: "player-spinner", "aria-hidden": "true" }),
      el("p", { class: "player-loading-title", text: meta.name || "Finding sources" }),
      el("p", { class: "player-note", text: "Finding sources…" }),
      el("button", { class: "btn subtle focusable", type: "button", text: "Close", onclick: () => overlay.remove() }),
    ),
  );
  document.body.append(overlay);
  let payload = null;
  try {
    // An episode's own streams: the add-on is asked for `<imdb>:<season>:<episode>`,
    // so a series that serves episodes returns the episode's hosts.
    const extra = meta.season && meta.episode ? `&season=${encodeURIComponent(meta.season)}&episode=${encodeURIComponent(meta.episode)}` : "";
    payload = await get(`/streams/${media}/${encodeURIComponent(id)}.json?name=${encodeURIComponent(meta.name || "")}${extra}`);
  } catch (err) {
    overlay.replaceChildren(
      el("div", { class: "player-empty-body" },
        el("p", { class: "player-error", text: `Could not read the streams — ${err.message}` }),
        el("button", { class: "btn primary focusable", type: "button", text: "Close", onclick: () => overlay.remove() }),
      ),
    );
    return;
  }
  const streams = payload?.streams || [];
  // Only a real video plays here. A stream that points at a page (a host's own site,
  // or the "support the project" line) is kept as a link to open, never auto-played.
  // **A torrent counts as playable.** It carries no `url` — its address is the magnet
  // — so a torrent add-on used to answer with streams that all looked unplayable and
  // the player said "no playable stream came back" for a title it could have played.
  const playable = streams.filter((s) => !isExternalStream(s) && (s.url || s.torrent));
  const external = streams.filter(isExternalStream);
  const lines = (payload?.sources || []).map((s) => `${s.name}: ${s.ok ? s.message : `failed — ${s.message}`}`);
  // **The same panel stays on screen.** Removing the full-screen overlay and
  // appending an identical one a frame later is the black flash ("the screen blinks
  // and glitches") between asking for sources and being told the answer — so every
  // answer below fills the panel that is already there.
  const panel = (children) => overlay.replaceChildren(el("div", { class: "player-empty-body" }, ...children));
  const tryAgain = () => {
    overlay.remove();
    openSources(meta);
  };

  if (!playable.length && external.length) {
    panel([
      el("p", { class: "player-error", text: "These add-ons answered with links to open, not playable video." }),
      el("div", { class: "stream-list" }, ...external.map((s) =>
        el("button", {
          class: "stream focusable",
          type: "button",
          onclick: () => window.open(s.url, "_blank", "noopener"),
        },
          el("span", { class: "stream-name", text: s.name || s.source || "Link" }),
          el("span", { class: "stream-detail", text: [s.source, s.title].filter(Boolean).join(" · ") }),
        )
      )),
      lines.length ? el("div", { class: "stream-list" }, ...lines.map((l) => el("p", { class: "player-note", text: l }))) : null,
      el("div", { class: "player-empty-actions" },
        el("button", { class: "btn primary focusable", type: "button", text: "Check again", onclick: tryAgain }),
        el("button", { class: "btn subtle focusable", type: "button", text: "Close", onclick: () => overlay.remove() }),
      ),
    ]);
    return;
  }

  if (!streams.length) {
    const reason =
      payload?.reason === "no-sources"
        ? "Nothing is configured to play anything. Add a Stremio add-on in Settings → Add-ons & plugins."
        : payload?.reason === "no-imdb"
          ? "This title has no IMDb id, so an add-on cannot be asked for streams."
          : "No playable stream came back.";
    panel([
      el("p", { class: "player-error", text: reason }),
      lines.length ? el("div", { class: "stream-list" }, ...lines.map((l) => el("p", { class: "player-note", text: l }))) : null,
      el("div", { class: "player-empty-actions" },
        el("button", { class: "btn primary focusable", type: "button", text: "Check again", onclick: tryAgain }),
        el("button", { class: "btn subtle focusable", type: "button", text: "Close", onclick: () => overlay.remove() }),
      ),
    ]);
    return;
  }

  overlay.remove();

  // The first stream that is not a trailer/cam rip plays straight away; the rest are
  // one click away in the Sources drawer.
  // **The Quality choice is a ceiling, not a demand.** The stream that plays is the
  // highest the list offers at or below it; a list with nothing that low falls back to
  // its *lowest* stream rather than refusing to play, and "Auto" is the old behaviour —
  // the first stream that is not a cam rip or a trailer.
  const ceiling = Number(state.prefs?.quality || 0);
  const heightOf = (s) => {
    const text = `${s.name || ""} ${s.title || ""} ${s.quality || ""} ${s.resolution || ""}`.toLowerCase();
    const hit = text.match(/\b(2160|1440|1080|720|576|480|360)p?\b/) || text.match(/\b(4k|uhd)\b/);
    if (!hit) return 0;
    return hit[1] === "4k" || hit[1] === "uhd" ? 2160 : Number(hit[1]);
  };
  const clean = playable.filter((s) => !/cam|trailer|sample/i.test(`${s.name} ${s.title}`));
  const pool = clean.length ? clean : playable;
  const best = ceiling
    ? [...pool].sort((a, b) => {
        const ha = heightOf(a);
        const hb = heightOf(b);
        const fitA = ha && ha <= ceiling ? ha : 0;
        const fitB = hb && hb <= ceiling ? hb : 0;
        if (fitA !== fitB) return fitB - fitA;
        // Nothing at or below the ceiling: the smallest stream is the nearest fit, and
        // a stream that does not state a height sorts after the ones that do.
        if (!fitA && !fitB) return (ha || Infinity) - (hb || Infinity);
        return 0;
      })[0]
    : pool[0];
  // The add-on lines ride along into the player, so its Sources drawer can say which
  // of the add-ons you pasted answered for this title — and which stayed quiet.
  const bestSrc = best.torrent ? best.magnet : best.url;
  await openPlayer(bestSrc, meta.name, {
    title: meta.name,
    meta,
    streams,
    current: bestSrc,
    // Which file of the torrent to open, when the add-on named one (a season pack).
    fileIdx: best.fileIdx,
    // The info hash rides along too: the magnet is what the server plays, but the hash
    // is what the live readout asks about.
    infoHash: best.infoHash,
    torrent: Boolean(best.torrent),
    addonStatus: payload?.sources || [],
  });
}

/**
 * **A screen that never arrives must say so.**
 *
 * The boot screen takes itself away on a timer — it has to, or a boot that cannot reach
 * the server would sit over the app for ever. But the screen underneath is only drawn
 * when its own request comes back, so a request that hangs leaves the top bar over an
 * empty page and nothing to read. This watches the newest render: if it is still pending
 * after `ms`, the app draws what it knows (the server is not answering) and offers the one
 * thing that can help — the button that asks again.
 */
let renderWatchdog = 0;
function watchRender(seq) {
  clearTimeout(renderWatchdog);
  renderWatchdog = setTimeout(() => {
    if (renderSeq !== seq) return;
    const main = document.getElementById("main");
    if (!main || main.childElementCount) return;
    main.replaceChildren(
      el("div", { class: "empty-panel" },
        el("p", { text: "The app server is not answering, so this screen has nothing to draw yet." }),
        el("button", {
          class: "btn focusable", type: "button", text: "Try again",
          onclick: () => { bootRetry(); },
        }),
      ),
    );
    // **Sooner is better than never.** A screen that cannot draw itself must say so
    // while the person is still looking at it, not twelve seconds later.
  }, Number(globalThis.NUVIO_RENDER_WATCHDOG_MS) || 5000);
}

/**
 * **Nothing on screen is not a state the app has.**
 *
 * Drawn when a screen throws, or when a screen answers with nothing at all: the page
 * says what happened and offers the two ways out — try the same screen again, or go
 * back to Home. `empty-panel` is the app's existing panel for "there is nothing here
 * yet", so this needs no new surface.
 */
function screenError(err, view) {
  const why = err ? String(err.message || err) : "This screen answered with nothing.";
  return el(
    "div",
    { class: "empty-panel" },
    el("p", { text: `This screen could not be drawn — ${why}` }),
    el(
      "div",
      { class: "empty-panel-actions" },
      el("button", {
        class: "btn primary focusable",
        type: "button",
        text: "Try again",
        onclick: () => { render().catch(() => {}); },
      }),
      view && view !== "home" && view !== "profiles"
        ? el("button", { class: "btn focusable", type: "button", text: "Back to Home", onclick: () => go("#/") })
        : null,
    ),
  );
}

/** The same boot read, without the splash: used by the watchdog's button. */
async function bootRetry() {
  const main = document.getElementById("main");
  if (main) main.replaceChildren(el("p", { class: "empty", text: "Asking again…" }));
  try {
    state.collections = await get(`/collections.json?_=${Date.now()}`, { timeoutMs: 15000 });
  } catch {
    /* the panel below says it for us */
  }
  await render().catch(() => {});
}

async function boot() {
  modal.root = document.getElementById("modal");
  // The app keeps its own place on the page (`render` remembers where each screen
  // was left), so the browser's own restore is turned off — two of them fighting
  // over the scroll on Back is what made it land somewhere unpredictable.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  applyTheme();
  setupInput();
  setupPreviews();
  setupSound();

  try {
    // A cache-buster, like `refreshCollections`: For You's rows are rebuilt per
    // request, and without one the browser can hand back the list it already has —
    // the same rows after every reload.
    state.collections = await get(`/collections.json?_=${Date.now()}`);
  } catch (err) {
    document.getElementById("main").replaceChildren(
      el("p", { class: "empty", text: `Could not reach the catalog server: ${err.message}` }),
    );
    return;
  }

  // What the addon actually publishes, read from its own manifest.
  //
  // A card is drawn from the list the app was handed, and that list can name a row
  // the addon no longer serves — a retired catalog, or a card list from an older
  // build. Those rows used to render and then answer 404 when they were opened. With
  // the manifest in hand, `rowOf` drops them before anything is drawn, so a screen
  // can only ever offer rows that exist.
  try {
    // Cache-busted with the cards above: the manifest carries For You's row ids,
    // which are re-rolled per request, so a cached copy would reference rows that
    // no longer resolve.
    const manifest = await get(`/manifest.json?_=${Date.now()}`);
    const ids = (manifest?.catalogs || []).map((c) => c.id).filter(Boolean);
    if (ids.length) state.publishedCatalogs = new Set(ids);
  } catch {
    /* no manifest: nothing is filtered, exactly as before */
  }

  // The country has no picker any more, but it is still real state: it decides
  // which services the Regional OTT cards name. It was read above the card
  // list, so a country changed elsewhere has to re-read the cards here.
  const cachedCountry = state.country;
  try {
    mergeServerSettings(await get("/settings"));
  } catch {
    /* server without the settings route */
  }
  if (state.country !== cachedCountry) await refreshCollections();

  // The AI state, from the server: which provider is in use, and whether it has a
  // key — the key itself may be in the environment rather than in this browser, so
  // the page must ask rather than guess. Without this, the Ask box and the AI
  // options all behaved as if nothing were configured.
  try {
    const ai = await get("/ai.json");
    if (ai && typeof ai === "object") {
      state.ai = { ...state.ai, ...ai, hasKey: { ...(state.ai?.hasKey || {}), ...(ai.hasKey || {}) } };
      writeJSON(KEY.ai, state.ai);
    }
  } catch {
    /* server without the AI route */
  }

  // The pins decide what the Watchlist card's three rows hold.
  try {
    applyWatchlist(await get("/watchlist.json"));
  } catch {
    /* server without the watchlist route */
  }

  // And the custom rows decide what the row after them holds.
  try {
    applyCustomRows(await get("/customrows.json"));
  } catch {
    /* server without the custom-row route */
  }

  // The search screen's filter vocabulary: the regions, the categories that exist
  // per row type, the periods and the sorts — from the server, so the panel can
  // never offer a genre TMDB does not have.
  try {
    const { filters } = await get("/search/filters.json");
    if (filters) state.searchVocab = filters;
  } catch {
    /* an older server: the panel falls back to a short list */
  }

  // Read every stored source again, on every start.
  //
  // "0 providers" was stored state: a source added when the read failed kept its
  // empty provider list forever, so it looked like add-ons and repos never worked
  // however many times you pressed the button. Re-reading them at boot means one
  // refresh fixes every source, and the list is only ever as stale as this page.
  if (state.sources.length) {
    // Sequential: a dozen parallel third-party fetches is a burst a lot of hosts
    // rate-limit, and this is not on the critical path.
    (async () => {
      for (let i = 0; i < state.sources.length; i++) {
        if (!state.sources[i]?.url) continue;
        await inspectSource(i, { quiet: true }).catch(() => {});
      }
      render();
    })();
  }

  // **A link opens what it points at; a plain load opens the mode picker.**
  //
  // Every route is opened straight away again — a title, a card, the Calendar, Settings.
  // What that must never do is arrive *empty*: the boot screen comes down on its own timer
  // and the screen underneath is drawn only when its own request answers, so a link whose
  // request hangs used to leave the top bar over nothing (and, worse, a reload on a title
  // URL sat on the boot screen while the hash was quietly rewritten to the picker, so the
  // title was never shown at all). The `render` watchdog covers the hang; this covers the
  // URL. With no route in the address bar there is nothing to honour, and that is when the
  // mode picker is the right screen.
  pendingDeepLink = "";
  if (!location.hash) location.hash = "#/profiles";
  // `render` is awaited: the boot screen must not fade out over a page that has
  // not been drawn yet (the title and list screens fetch before they render).
  await render();
  endBoot();
  // **What is out today, said once.** Reads the Calendar for the current month and
  // draws a notification for a plan of today's date and for anything from the Library
  // releasing today — the two events the Notifications pane names that the app can see
  // for itself. It runs after the first paint so nothing waits on it.
  checkNotifications().catch(() => { /* a notification is never worth an error */ });
}

// Safety net: a boot that cannot reach the server must not leave the splash up
// for ever, so the screen goes away on its own after a few seconds either way.
setTimeout(endBoot, 8000);

boot();
