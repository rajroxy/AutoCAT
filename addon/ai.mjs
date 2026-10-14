/**
 * AI providers.
 *
 * The AI section in Settings used to be a handful of switches with nothing
 * behind them: "Ask" handed whatever you typed straight to the plain text search.
 * This module is the API that was missing — a real provider call, with a key you
 * paste in, from a provider that has a free tier.
 *
 * Every provider below is called with plain `fetch` from Node (no SDK to
 * install) and is free to start on:
 *
 *   groq        Groq Cloud        LPU inference, OpenAI-shaped, most generous free tier
 *   google      Google AI Studio  Gemini, free tier
 *   openrouter  OpenRouter        `:free` models, OpenAI-shaped
 *   cerebras    Cerebras Cloud    free tier, OpenAI-shaped
 *
 * The key lives next to the provider keys in `addon/settings.json` and, like
 * them, is never sent back to the browser — `publicSettings()` only reports
 * whether one is set. `hasAiKey()`/`aiReady()` are the server-side truth, so the
 * Ask box degrades to plain search instead of failing when no key is set.
 */
import { getSettings, updateSettings } from "./settings.mjs";

export const AI_PROVIDERS = {
  groq: {
    label: "Groq Cloud",
    free: true,
    // Verified with `node scripts/probe-ai.mjs`: Groq retired
    // `llama-3.1-8b-instant`, and this is what its key serves now.
    model: "openai/gpt-oss-20b",
    shape: "openai",
    chat: "https://api.groq.com/openai/v1/chat/completions",
    models: "https://api.groq.com/openai/v1/models",
    signup: "https://console.groq.com/keys",
    note: "Free tier, fastest responses — the default.",
  },
  google: {
    label: "Google AI Studio",
    free: true,
    // **A `-latest` alias, not a version.** Google retires version numbers for new keys
    // ("This model models/gemini-2.5-flash is no longer available to new users") while it
    // still lists them — so the default is the alias, which always resolves.
    model: "gemini-flash-latest",
    shape: "gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    signup: "https://aistudio.google.com/app/apikey",
    note: "Free tier with a daily quota; Gemini models.",
  },
  openrouter: {
    label: "OpenRouter",
    free: true,
    model: "meta-llama/llama-3.3-70b-instruct:free",
    shape: "openai",
    chat: "https://openrouter.ai/api/v1/chat/completions",
    models: "https://openrouter.ai/api/v1/key",
    signup: "https://openrouter.ai/keys",
    note: "One key for many models; the `:free` ones cost nothing.",
  },
  cerebras: {
    label: "Cerebras Cloud",
    free: true,
    model: "llama3.1-8b",
    shape: "openai",
    chat: "https://api.cerebras.ai/v1/chat/completions",
    models: "https://api.cerebras.ai/v1/models",
    signup: "https://cloud.cerebras.ai",
    note: "Free tier on wafer-scale hardware.",
  },
};

/**
 * The provider the app will use, or "" for plain search.
 *
 * With nothing picked, the first provider that actually **has a key** is used
 * instead of returning "". A key can come from the environment (or from a key
 * pasted for a provider other than the chosen one), and returning "" there made
 * every AI control look broken while the key sat there unused.
 */
export const aiProviderName = () => {
  const name = String(getSettings().ai?.provider || "");
  if (AI_PROVIDERS[name]) return name;
  return Object.keys(AI_PROVIDERS).find((slug) => aiKey(slug)) || "";
};

/** The key for a provider: the one pasted in Settings, else its environment key. */
export function aiKey(name = aiProviderName()) {
  const cfg = AI_PROVIDERS[name];
  if (!cfg) return "";
  return getSettings().ai?.keys?.[name] || process.env[`${name.toUpperCase()}_API_KEY`] || "";
}

export const hasAiKey = (name = aiProviderName()) => Boolean(aiKey(name));

/**
 * **The model you picked — or `""`, which is Auto.**
 *
 * Auto means "whichever of this provider's models should answer the question", so it must
 * not quietly fall back to the name written in this file: that would be a fixed model
 * wearing the word Auto, and the fixed one (`gemini-flash-latest`, `gemini-2.5-flash`
 * before it, Groq's `llama-3.1-8b-instant` before that) is exactly the one a provider
 * retires or lets go slow. Auto is decided from the provider's own list instead, and
 * `candidateOrder` keeps the built-in name as the last resort.
 */
export const aiModel = (_name = aiProviderName()) => getSettings().ai?.model || "";

/** Everything the UI needs to describe the AI configuration (never a key). */
export function aiState() {
  const s = getSettings().ai || {};
  const provider = aiProviderName();
  return {
    enabled: s.enabled !== false,
    provider,
    model: s.model || "",
    ready: Boolean(provider) && hasAiKey(provider),
    hasKey: Object.fromEntries(Object.keys(AI_PROVIDERS).map((k) => [k, Boolean(aiKey(k))])),
    providers: Object.fromEntries(
      Object.entries(AI_PROVIDERS).map(([slug, cfg]) => [slug, { label: cfg.label, free: cfg.free, model: cfg.model, note: cfg.note, signup: cfg.signup }]),
    ),
  };
}

const SYSTEM = [
  "You turn a viewer's request into ONE short search query for a movie and TV catalog search box.",
  "Answer with the query only — no quotes, no explanation, at most 6 words.",
  "Keep the genre, mood, decade, country and platform words that are in the request.",
  "If the request names a title, answer with that title.",
].join(" ");

/**
 * Models that think before they answer.
 *
 * `gpt-oss` and friends spend the token budget on reasoning, and with a small
 * budget they return an **empty** `content` — which reaches the app as "the model
 * output nothing". They get a much larger budget, and the provider is asked to
 * keep the reasoning short.
 */
const REASONING = /gpt-oss|\bo[1-4](-|$)|deepseek-r1|reasoning|qwq/i;
const ANSWER_TOKENS = 512;
const REASONING_TOKENS = 4096;

/**
 * **A refused name is remembered.** A provider that answers 404 for a model has retired it
 * for this key — Google says so in as many words ("no longer available to new users") — and
 * nothing is gained by asking it again on the next question. The name goes into `REFUSED`,
 * and `rankModels` stops offering it.
 */
function refusedBy(status, model) {
  if (status === 404 && model) {
    REFUSED.add(model);
    forgetRetired(model);
  }
  return new Error(status === 404 ? `${model} is not served to this key (404) — pick another model` : `HTTP ${status}`);
}

/**
 * **A name the provider has retired does not stay in Settings.**
 *
 * The model box remembers what you picked. When the provider answers 404 for that name it
 * is gone for this key — Google says so in as many words — and leaving it there means the
 * next question starts by asking for a model that is not served, and the pane keeps
 * advertising a name that cannot answer. It is cleared, so the box says **Auto** again and
 * the next question goes straight to a model that answers.
 */
function forgetRetired(id) {
  try {
    if (getSettings().ai?.model !== id) return;
    updateSettings({ ai: { model: "" } });
  } catch {
    /* read-only settings — the in-memory REFUSED set still keeps it out of the way */
  }
}

/**
 * **Thinking off, where the model takes the switch.**
 *
 * A Gemini flagship spends its output budget on reasoning before it writes a word: asked
 * for one word with a 16-token budget it answers with *nothing* (`finishReason:
 * MAX_TOKENS`, no text), and asked for a search query it can take eleven to fifteen
 * seconds to return six words. `thinkingBudget: 0` turns that off — the same one-word
 * answer came back in 2.6s instead of 11.4s, measured. A model that does not take the
 * switch (`gemini-flash-lite` answers 400 for it) is remembered in `NO_THINKING` and asked
 * again without it.
 */
const THINKING_OFF = { thinkingConfig: { thinkingBudget: 0 } };
const NO_THINKING = new Set();

/** One chat completion, in whichever shape the provider speaks. */
async function complete(cfg, key, model, prompt, { maxTokens, system, bare, timeoutMs } = {}) {
  const thinking = REASONING.test(model);
  const budget = maxTokens || (thinking ? REASONING_TOKENS : ANSWER_TOKENS);
  // **The system prompt, unless the caller asked for none.** A connection test wants the
  // smallest possible call — no persona in front of it — so `bare` leaves it out entirely.
  const sys = bare ? "" : system || SYSTEM;
  // **A ceiling per attempt.** A provider can simply not answer; without this the whole
  // question waited on it, which is what "the AI is not answering" looked like.
  const ceiling = timeoutMs || 15000;
  if (cfg.shape === "gemini") {
    const url = `${cfg.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const call = (withThinking) => fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(ceiling),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: budget, ...(withThinking ? THINKING_OFF : {}) },
      }),
    });
    let res = await call(!NO_THINKING.has(model));
    // **The switch, refused.** Lite models reject `thinkingBudget` with a 400; that is a
    // fact about the model, not a failure of the question, so it goes on the list and the
    // same model is asked once more without it.
    if (res.status === 400 && !NO_THINKING.has(model)) {
      NO_THINKING.add(model);
      res = await call(false);
    }
    if (!res.ok) {
      // **Say what the code means.** "HTTP 401" is the provider's answer, not an
      // explanation: 401 is the key itself (wrong console, truncated, or revoked), 403 is
      // a key that is real but not allowed to do this, and 429 is a quota.
      const why = res.status === 401
        ? `the key was refused (401) — it may be from another provider's console, or copied without its last characters`
        : res.status === 403
          ? `the key is not allowed to list models (403)`
          : res.status === 429
            ? `the free tier's rate limit was hit (429) — try again shortly`
            : refusedBy(res.status, model).message;
      throw new Error(why);
    }
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text || "").join("");
  }

  const res = await fetch(cfg.chat, {
    method: "POST",
    signal: AbortSignal.timeout(ceiling),
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        ...(sys ? [{ role: "system", content: sys }] : []),
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: budget,
      ...(thinking ? { reasoning_effort: "low" } : {}),
    }),
  });
  if (!res.ok) throw refusedBy(res.status, model);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

/**
 * **The header a key rides in — and Google's is not a bearer.**
 *
 * Every provider here but one is OpenAI-shaped and takes `Authorization: Bearer <key>`.
 * Google's Generative Language API does not: an API key sent as a bearer token is
 * answered with **HTTP 401 "API keys are not supported by this API. Expected OAuth2
 * access token or other authentication credentials"** — *with a key that works*. Its
 * key goes in the `x-goog-api-key` header (or the `?key=` query it already uses).
 *
 * This was sending the bearer to Google on the **connection test** and on **Load
 * models**, which is why a valid Google AI Studio key reported "HTTP 401" when it was
 * applied and then "no models listed (check the key)" — the key was never the problem.
 */
const authHeaders = (cfg, key) =>
  cfg.shape === "gemini" ? { "x-goog-api-key": key } : { authorization: `Bearer ${key}` };

/**
 * The models a provider will actually accept right now.
 *
 * Providers retire model names without warning — Groq answered a hard-coded
 * `llama-3.1-8b-instant` with HTTP 404 while the same key listed models fine. So
 * a name is never trusted on its own: it is tried, and if the provider rejects
 * it the list is fetched and a current model is used instead.
 */
async function listModels(cfg, key) {
  try {
    const url = cfg.shape === "gemini" ? `${cfg.base}/models?key=${encodeURIComponent(key)}` : cfg.models;
    const res = await fetch(url, { headers: authHeaders(cfg, key) });
    if (!res.ok) return [];
    const data = await res.json();
    const ids = cfg.shape === "gemini"
      ? (data.models || []).map((m) => String(m.name || "").replace(/^models\//, ""))
      : (data.data || []).map((m) => m.id);
    // **One entry per name.** Google's list carries the same model twice (an alias and
    // its target), which made "50 models · 58 for chat" — more chat models than models.
    return [...new Set(ids.filter(Boolean))];
  } catch {
    return [];
  }
}

// Of the models a provider offers, the small fast ones are the right shape for
// "one sentence in, six words out".
const SMALL_AND_FAST = /instant|8b|mini|small|flash|oss-|20b|lite|qwen|gemini-\d/i;

/**
 * **Names the provider has refused, this run.**
 *
 * A provider lists models it will no longer serve to a new key — Google answers
 * `gemini-2.5-flash` with *"no longer available to new users, please use gemini-3.8-flash"*
 * — so the list cannot be trusted on its own. Every refusal is remembered here for the
 * life of the process, and nothing tries that name again, which is what keeps a question
 * from walking through half a dozen dead models before it is answered.
 */
const REFUSED = new Set();

/** A `-latest` alias is the one name a provider keeps pointing at the current model. */
const STABLE_ALIAS = /-latest$/i;

/**
 * **The genuinely small ones.** A "flash" flagship is fast to a person and slow to a
 * question that must be answered before a screen can be drawn: the lite/mini cuts answer in
 * a second or two. These go first, ahead of the bigger models that are merely quick.
 */
const TINY = /(^|[-_/])(lite|mini|nano|small|instant|qwen|8b|20b)([-_/]|$)/i;

/**
 * **The size of the model, as a number** — the tie-break inside `rankModels`.
 *
 * Two live aliases of the same family tie on everything else, and the alphabetical order
 * then put the **flagship** first: `gemini-flash-latest` sorts before
 * `gemini-flash-lite-latest`, and the flagship is the one that took eleven to twenty-nine
 * seconds to return one word (measured) and sometimes answered with nothing. The little
 * one answers in half a second. So the size is scored, and the smallest cut of the fastest
 * family goes first — which is what Auto wants.
 */
const SIZE = [
  [/(^|[-_/])(lite|mini|nano|small|instant|tiny|8b|20b|3b|7b)([-_/]|$)/i, 0],
  [/flash|turbo|haiku|speed|fast/i, 1],
  [/pro|max|ultra|opus|405b|70b|large/i, 2],
];
const sizeOf = (id) => SIZE.find(([re]) => re.test(id))?.[1] ?? 1;

/**
 * The order to try models in.
 *
 * **Aliases first**, then the small fast ones, then everything else — so a question is
 * answered by the model the provider is actually serving today rather than by whatever
 * name its list happens to put first.
 */
function rankModels(ids) {
  const live = [...new Set(ids.filter((id) => id && !REFUSED.has(id)))];
  // One score per name, so no name can appear twice and the order is total:
  // a stable alias beats a version number, a tiny cut beats a big one, and a chat-shaped
  // model beats everything else on the list.
  const score = (id) =>
    (STABLE_ALIAS.test(id) ? 0 : 4) + (TINY.test(id) ? 0 : 2) + (SMALL_AND_FAST.test(id) ? 0 : 1) + sizeOf(id) / 10;
  return live
    .map((id) => [score(id), id])
    .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
    .map(([, id]) => id);
}


/**
 * **The model that answered last time, per provider.** A question is asked in a second or
 * two once one model has answered, instead of re-walking a list every time — and the first
 * attempt after a restart is the only one that pays for finding a live name.
 */
const WORKING = new Map();

/**
 * The order to try models in: **the one you picked, then the one that last answered, then
 * the provider's own list** (aliases first). Names the provider has already refused this
 * run are left out entirely.
 */
async function candidateOrder(cfg, key, picked) {
  const seen = new Set();
  const out = [];
  const push = (id) => {
    if (id && !seen.has(id) && !REFUSED.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  push(picked);
  push(WORKING.get(cfg.label));
  for (const id of await chooseModels(cfg, key)) push(id);
  // **What this file calls the provider's default goes last, not first.** It is a name
  // written here, and a name written here is the first one a provider retires — `gemini-2.5`
  // and Groq's `llama-3.1-8b-instant` are both on that list. It stays as the final safety
  // net for a provider whose list came back empty.
  push(cfg.model);
  return out;
}
// …and these are not general chat models at all: guards, transcribers, voices.
// Groq currently lists several of them, so picking "the first small model" lands
// on a safety classifier that rejects a chat completion.
const NOT_CHAT = /guard|safeguard|whisper|tts|orpheus|embed|rerank|moderation|speech|audio|image|vision/i;

/** Models worth trying, best first — small and fast, then the rest. */
async function chooseModels(cfg, key) {
  const ids = (await listModels(cfg, key)).filter((id) => !NOT_CHAT.test(id));
  return rankModels(ids);
}

const isModelRejected = (err) => /HTTP (400|404)/.test(String(err?.message || ""));

const tidy = (text) =>
  String(text || "")
    .split("\n")[0]
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(search|query)\s*[:=-]\s*/i, "")
    .trim()
    .slice(0, 120);

/**
 * Turn a sentence into a search query. Never throws: a provider problem comes
 * back as `{ ok: false }` so the caller can fall back to the literal text.
 */
export async function askAI(prompt, opts = {}) {
  const provider = opts.provider || aiProviderName();
  const cfg = AI_PROVIDERS[provider];
  const text = String(prompt || "").trim();
  if (!text) return { ok: false, text: "nothing to ask" };
  if (!cfg) return { ok: false, text: "no AI provider selected" };
  const key = opts.key ?? aiKey(provider);
  if (!key) return { ok: false, text: `no ${cfg.label} key saved` };
  let lastError = "no model answered";

  /**
   * Ask with one model. Returns the answer, or the error it hit.
   *
   * An empty answer is retried with a full token budget, because that is exactly
   * what a reasoning model returns when it thinks its budget away: no error, no
   * text — the "the model doesn't output anything" report.
   */
  const attempt = async (candidate) => {
    const ask = async (maxTokens) => {
      try {
        return { raw: await complete(cfg, key, candidate, text, maxTokens ? { maxTokens } : {}) };
      } catch (err) {
        return { err };
      }
    };
    let out = await ask(undefined);
    if (out.err) {
      lastError = `${candidate} → ${out.err.message}`;
      return out.err;
    }
    let query = tidy(out.raw);
    if (!query) {
      out = await ask(REASONING_TOKENS);
      if (out.err) {
        lastError = `${candidate} → ${out.err.message}`;
        return out.err;
      }
      query = tidy(out.raw);
    }
    if (!query) {
      lastError = `${candidate} returned nothing`;
      return null;
    }
    return { ok: true, provider, model: candidate, query, text: `“${query}” · ${cfg.label}` };
  };

  // Two things go wrong in practice: the model name was retired (Groq dropped
  // `llama-3.1-8b-instant` while its key still verified; Google retires numbers for new
  // keys), or the model answers with an empty `content` — which a reasoning model does
  // when its token budget runs out before it writes anything. So the names are tried in
  // order — the one you picked, the one that last answered, then what the provider serves
  // today — and each refusal is remembered so no name is tried twice.
  const order = await candidateOrder(cfg, key, opts.model || aiModel(provider));
  for (const candidate of order) {
    const next = await attempt(candidate);
    if (next?.ok) {
      WORKING.set(cfg.label, candidate);
      return next;
    }
    if (lastError.includes("→ HTTP 400")) break; // a request problem, not the model
  }
  return { ok: false, text: `${cfg.label} — ${lastError}` };
}

/**
 * **A question about one title, answered in prose.**
 *
 * The Ask box next to it turns a sentence into a *search* — that is what the app is for,
 * and `SYSTEM` keeps the model on that job. A title page needs the other thing: "what is
 * this about?", "will I like it?", "should I start it with someone who does not watch
 * horror?". Those are answered, not translated, so this asks with a different system
 * prompt and returns the sentences exactly as they come.
 *
 * `context` is the title the page is on: its name, year, and what it is. It is put in
 * front of the question, so "will I like it?" has something to be about.
 */
const ABOUT_SYSTEM = `You answer questions about one film or series, in plain English, in two or three short sentences. Answer the question that was asked and nothing else: no search queries, no lists, no catalog names, no markdown. Use what you know about the title — its story, its tone, who it is for. Never invent a plot, a cast member or a fact. If the question is not about this title — a request for something to watch, an either/or, a mood — answer it anyway from your own knowledge of films and series. Never reply that you do not know which title is meant.`;

/**
 * **A box with no title on it is not a question about a title.**
 *
 * The Ask AI box on Home carries no film or series — you open it and ask for one ("name a
title to watch in a pair tonight", "something funny under two hours"). It was answered with
the *about this title* system prompt all the same, and that prompt tells the model to say so
when it does not know the title it is being asked about — so **every** question, typed or
spoken, came back as "I do not know the title you are referring to". With no title in the
context the model is a **recommender**, and the prompt says exactly that: name concrete
titles, one line each, and never ask which title is meant.
 */
const RECOMMEND_SYSTEM = `You recommend things to watch, from your own knowledge of films and television. Answer the request with at most three concrete titles, each on its own line as "Title (year) — one short reason". No preamble, no markdown, no bullet characters, no questions back, and never reply that you do not know which title is meant: no title is being referred to. If the request names a title, answer about that one. If you truly cannot name a title, say it in one line.`;

export async function askAbout(question, context = {}, opts = {}) {
  const provider = opts.provider || aiProviderName();
  const cfg = AI_PROVIDERS[provider];
  const asked = String(question || "").trim();
  if (!asked) return { ok: false, text: "Ask something about the title first." };
  if (!cfg) return { ok: false, text: "No AI provider is selected — pick one in Settings → Assistant." };
  const key = opts.key ?? aiKey(provider);
  if (!key) return { ok: false, text: `No ${cfg.label} key saved — paste one in Settings → Assistant.` };

  // **What the box is holding, if anything.** A name in the context means the question is
  // about that one title and is answered as prose; nothing means the question is for a
  // recommendation, which is a different job with a different prompt (see above).
  const aboutTitle = Boolean(String(context.name || "").trim());
  const about = [context.name && `Title: ${context.name}`, context.year && `Year: ${context.year}`, context.type && `Type: ${context.type === "series" ? "series" : "film"}`, context.overview && `Synopsis: ${String(context.overview).slice(0, 600)}`]
    .filter(Boolean)
    .join("\n");
  const prompt = `${about ? `${about}\n\n` : ""}Question: ${asked}`;
  const model = opts.model || aiModel(provider);
  // Prose needs room for a paragraph; the search path's six words do not.
  const speak = async (candidate) => {
    try {
      const raw = await complete(cfg, key, candidate, prompt, { system: aboutTitle ? ABOUT_SYSTEM : RECOMMEND_SYSTEM, maxTokens: 400 });
      // **One line per title stays one line.** An about-this-title answer is a paragraph and
      // its newlines are wrapped away; a recommendation is a list of names, and flattening it
      // into one line was the "three titles, one line each" answer arriving as a wall.
      const text = aboutTitle
        ? String(raw || "").replace(/\s*\n\s*/g, " ").trim().slice(0, 900)
        : String(raw || "").split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 6).join("\n").slice(0, 900);
      return text ? { ok: true, provider, model: candidate, text } : null;
    } catch (err) {
      return err;
    }
  };

  let lastError = "no model answered";
  for (const candidate of await candidateOrder(cfg, key, model)) {
    const next = await speak(candidate);
    if (next?.ok) {
      WORKING.set(cfg.label, candidate);
      return next;
    }
    if (next instanceof Error) lastError = `${candidate} → ${next.message}`;
  }
  return { ok: false, text: `${cfg.label} — ${lastError}` };
}

/**
 * **The suggestions the Ask AI box wears, written for this open.**
 *
 * The box's chips were a fixed list in `app.js`; the owner asked for them to be **random and
 * written by the AI itself**, in place of the written ones. This asks the same provider (and the
 * same model chain) for six short suggestions — questions about the title on a title page,
 * things to watch on Home — one per line, and hands back only the lines. Any failure is an empty
 * list, which the box reads as "keep what is written".
 */
const TAGS_SYSTEM = `You write the suggestion buttons for a streaming app's Ask AI box. Reply with six short suggestions, one per line, no numbering, no bullet marks, no markdown, no explanation. Each suggestion is at most five words and is something the person could tap: a question about the title, or a request for something to watch tonight. Never repeat a suggestion.`;

export async function askTags(context = {}, opts = {}) {
  const provider = opts.provider || aiProviderName();
  const cfg = AI_PROVIDERS[provider];
  if (!cfg) return { ok: false, tags: [] };
  const key = opts.key ?? aiKey(provider);
  if (!key) return { ok: false, tags: [] };
  const about = [
    context.name && `Title: ${context.name}`,
    context.year && `Year: ${context.year}`,
    context.type && `Type: ${context.type === "series" ? "series" : "film"}`,
    context.overview && `Synopsis: ${String(context.overview).slice(0, 300)}`,
  ].filter(Boolean).join("\n");
  // **The row the person is browsing.** The box is opened on either the Movies or the Shows side
  // of the app, and a suggestion about a series on the films side is a suggestion for the wrong
  // screen — the owner asked for the tags to be written "according to the tab I am on".
  const browsing = context.row === "series" ? "shows" : context.row === "movie" ? "films" : "";
  const tab = browsing ? ` The person is browsing ${browsing} right now: every suggestion must be about ${browsing}.` : "";
  const prompt = about
    ? `${about}\n\nWrite six suggestions someone could tap about this title.${tab}`
    : `Nothing is chosen yet. Write six suggestions someone could tap tonight — things to watch, and questions that get them a pick.${tab}`;
  const model = opts.model || aiModel(provider);
  for (const candidate of await candidateOrder(cfg, key, model)) {
    try {
      const raw = await complete(cfg, key, candidate, prompt, { system: TAGS_SYSTEM, maxTokens: 220 });
      const tags = String(raw || "")
        .split("\n")
        .map((line) => line.replace(/^\s*[-*\d.)\]]+\s*/, "").trim())
        .filter((line) => line && line.length <= 60 && !/^suggestions?[:\s]/i.test(line))
        .slice(0, 8);
      if (tags.length >= 3) {
        WORKING.set(cfg.label, candidate);
        return { ok: true, provider, model: candidate, tags };
      }
    } catch {
      /* the next model, or the box keeps its written tags */
    }
  }
  return { ok: false, tags: [] };
}

/**
 * The provider's current model list — what the Settings screen's "Load models"
 * shows, and what the model box is meant to be filled from.
 *
 * Requesting it is also a connection test: the list only comes back with a valid
 * key, which is why the button can do both jobs at once.
 */
export async function aiModels(name) {
  const cfg = AI_PROVIDERS[name];
  if (!cfg) return { ok: false, text: "unknown AI provider", models: [] };
  const key = aiKey(name);
  if (!key) return { ok: false, text: `no ${cfg.label} key saved — paste one first`, models: [] };
  const ids = await listModels(cfg, key);
  if (!ids.length) return { ok: false, text: `${cfg.label} — no models listed (check the key)`, models: [] };
  const chat = rankModels(ids.filter((id) => !NOT_CHAT.test(id)));
  return {
    ok: true,
    models: ids,
    chat,
    // The same pick the Ask box makes, so "Use" on a model does not have to guess.
    recommended: (chat.filter((id) => SMALL_AND_FAST.test(id))[0]) || chat[0] || "",
    text: `${ids.length} models · ${chat.length} for chat · ${cfg.label}`,
  };
}

/** Verify a key by actually calling the provider with it. */
/**
 * @param {string} [model]  The model to test. **A key and a model are two different
 *   questions**: a key can be perfectly valid while the model name saved beside it was
 *   retired by the provider months ago, which is exactly the case that reported
 *   "connected" and then never answered a question. Given a model, this **calls it** —
 *   one tiny prompt — and reports what it said. Given none (the Auto choice), it lists
 *   what the key serves and names the model Auto would use.
 */
export async function verifyAI(name, key, model = "") {
  const cfg = AI_PROVIDERS[name];
  if (!cfg) return { ok: false, text: "unknown AI provider" };
  // **A key is trimmed before it is used.** A paste from a browser or a password
  // manager routinely carries a trailing space or newline, and the provider answers
  // 401 for it — which reads as "my key does not work" when the key is fine.
  const useKey = String(key || aiKey(name) || "").trim();
  if (!useKey) return { ok: false, text: "no key saved" };
  // **A model was named: ask it something.** "Reply with the single word ready" is the
  // smallest call that proves the name is one the provider still serves.
  const wanted = String(model || "").trim();
  if (wanted) {
    try {
      // **The smallest call that proves the name.** No system prompt, one word back, a
      // short ceiling: this answers "does this key serve this model", not "is it clever".
      // It used to ask with the full system prompt and a 16-token budget — which a thinking
      // model spends entirely on reasoning and answers with nothing at all, so a perfectly
      // good model read as a failure after a fifteen-second wait.
      const said = await complete(cfg, useKey, wanted, "Reply with the single word: ready", { bare: true, maxTokens: 128, timeoutMs: 12000 });
      const answered = String(said || "").replace(/\s+/g, " ").trim();
      if (!answered) {
        return { ok: false, model: wanted, text: `${cfg.label} · ${wanted} answered with nothing — pick another model, or Auto` };
      }
      return {
        ok: true,
        model: wanted,
        models: [],
        chat: [],
        text: `${cfg.label} · ${wanted} answered — “${answered.slice(0, 40)}”`,
      };
    } catch (err) {
      // **A timeout is not the key's fault and should not read like it.** A flagship model
      // on a free tier can simply be busy; saying so is the difference between "the model
      // is overloaded" and "my key is broken".
      const why = err?.name === "TimeoutError" ? "did not answer within 12s — it may be a busy model; try another, or Auto" : err.message;
      return { ok: false, model: wanted, text: `${cfg.label} · ${wanted} — ${why}` };
    }
  }
  try {
    const url = cfg.shape === "gemini"
      ? `${cfg.base}/models?key=${encodeURIComponent(useKey)}`
      : cfg.models;
    const res = await fetch(url, { headers: authHeaders(cfg, useKey) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Report what it serves too: a key that works but only lists guard models is
    // the case that used to look "connected" and then answer nothing.
    const listed = await listModels(cfg, useKey);
    const chat = rankModels(listed.filter((id) => !NOT_CHAT.test(id)));
    return {
      ok: true,
      models: listed,
      chat,
      // What Auto would pick for a question, so the pane can say it out loud.
      recommended: chat.filter((id) => SMALL_AND_FAST.test(id))[0] || chat[0] || "",
      text: `connected · ${cfg.label}${chat.length ? ` · ${chat.length} chat models` : " · no chat models listed"}`,
    };
  } catch (err) {
    return { ok: false, text: `${cfg.label} — ${err.message}` };
  }
}
