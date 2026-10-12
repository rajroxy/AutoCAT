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
import { getSettings } from "./settings.mjs";

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
    model: "gemini-2.0-flash",
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

/** An optional model override — providers rename models faster than this ships. */
export const aiModel = (name = aiProviderName()) => getSettings().ai?.model || AI_PROVIDERS[name]?.model || "";

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

/** One chat completion, in whichever shape the provider speaks. */
async function complete(cfg, key, model, prompt, { maxTokens, system } = {}) {
  const thinking = REASONING.test(model);
  const budget = maxTokens || (thinking ? REASONING_TOKENS : ANSWER_TOKENS);
  if (cfg.shape === "gemini") {
    const url = `${cfg.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system || SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: budget },
      }),
    });
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
            : `HTTP ${res.status}`;
      throw new Error(why);
    }
    const data = await res.json();
    return (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text || "").join("");
  }

  const res = await fetch(cfg.chat, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system || SYSTEM },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: budget,
      ...(thinking ? { reasoning_effort: "low" } : {}),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

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
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const ids = cfg.shape === "gemini"
      ? (data.models || []).map((m) => String(m.name || "").replace(/^models\//, ""))
      : (data.data || []).map((m) => m.id);
    return ids.filter(Boolean);
  } catch {
    return [];
  }
}

// Of the models a provider offers, the small fast ones are the right shape for
// "one sentence in, six words out".
const SMALL_AND_FAST = /instant|8b|mini|small|flash|oss-|20b|lite|qwen|gemini-\d/i;
// …and these are not general chat models at all: guards, transcribers, voices.
// Groq currently lists several of them, so picking "the first small model" lands
// on a safety classifier that rejects a chat completion.
const NOT_CHAT = /guard|safeguard|whisper|tts|orpheus|embed|rerank|moderation|speech|audio|image|vision/i;

/** Models worth trying, best first — small and fast, then the rest. */
async function chooseModels(cfg, key) {
  const ids = (await listModels(cfg, key)).filter((id) => !NOT_CHAT.test(id));
  return [...ids.filter((id) => SMALL_AND_FAST.test(id)), ...ids];
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

  const model = opts.model || aiModel(provider);
  const first = await attempt(model);
  if (first?.ok) return first;

  // Two things go wrong in practice: the model name was retired (Groq dropped
  // `llama-3.1-8b-instant` while its key still verified), or the model answers
  // with an empty `content` — which a reasoning model does when its token budget
  // runs out before it writes anything. Both are worth a second opinion, so the
  // provider is asked what it serves now and the best few are tried.
  if (!first || isModelRejected(first)) {
    for (const candidate of await chooseModels(cfg, key)) {
      if (candidate === model) continue;
      const next = await attempt(candidate);
      if (next?.ok) return next;
      if (lastError.includes("→ HTTP 400")) break; // a request problem, not the model
    }
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
const ABOUT_SYSTEM = `You answer questions about one film or series, in plain English, in two or three short sentences. Answer the question that was asked and nothing else: no search queries, no lists, no catalog names, no markdown. Use what you know about the title — its story, its tone, who it is for. Never invent a plot, a cast member or a fact; if you do not know the title, say so in one sentence.`;

export async function askAbout(question, context = {}, opts = {}) {
  const provider = opts.provider || aiProviderName();
  const cfg = AI_PROVIDERS[provider];
  const asked = String(question || "").trim();
  if (!asked) return { ok: false, text: "Ask something about the title first." };
  if (!cfg) return { ok: false, text: "No AI provider is selected — pick one in Settings → Assistant." };
  const key = opts.key ?? aiKey(provider);
  if (!key) return { ok: false, text: `No ${cfg.label} key saved — paste one in Settings → Assistant.` };

  const about = [context.name && `Title: ${context.name}`, context.year && `Year: ${context.year}`, context.type && `Type: ${context.type === "series" ? "series" : "film"}`, context.overview && `Synopsis: ${String(context.overview).slice(0, 600)}`]
    .filter(Boolean)
    .join("\n");
  const prompt = `${about ? `${about}\n\n` : ""}Question: ${asked}`;
  const model = opts.model || aiModel(provider);
  // Prose needs room for a paragraph; the search path's six words do not.
  const speak = async (candidate) => {
    try {
      const raw = await complete(cfg, key, candidate, prompt, { system: ABOUT_SYSTEM, maxTokens: 400 });
      const text = String(raw || "").replace(/\s*\n\s*/g, " ").trim().slice(0, 900);
      return text ? { ok: true, provider, model: candidate, text } : null;
    } catch (err) {
      return err;
    }
  };

  let lastError = "no model answered";
  const first = await speak(model);
  if (first?.ok) return first;
  if (first instanceof Error) lastError = `${model} → ${first.message}`;
  for (const candidate of await chooseModels(cfg, key)) {
    if (candidate === model) continue;
    const next = await speak(candidate);
    if (next?.ok) return next;
    if (next instanceof Error) lastError = `${candidate} → ${next.message}`;
  }
  return { ok: false, text: `${cfg.label} — ${lastError}` };
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
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
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
export async function verifyAI(name, key) {
  const cfg = AI_PROVIDERS[name];
  if (!cfg) return { ok: false, text: "unknown AI provider" };
  // **A key is trimmed before it is used.** A paste from a browser or a password
  // manager routinely carries a trailing space or newline, and the provider answers
  // 401 for it — which reads as "my key does not work" when the key is fine.
  const useKey = String(key || aiKey(name) || "").trim();
  if (!useKey) return { ok: false, text: "no key saved" };
  try {
    const url = cfg.shape === "gemini"
      ? `${cfg.base}/models?key=${encodeURIComponent(useKey)}`
      : cfg.models;
    const res = await fetch(url, { headers: { authorization: `Bearer ${useKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Report what it serves too: a key that works but only lists guard models is
    // the case that used to look "connected" and then answer nothing.
    const listed = await listModels(cfg, useKey);
    const chat = listed.filter((id) => !NOT_CHAT.test(id));
    return {
      ok: true,
      models: listed,
      chat,
      text: `connected · ${cfg.label}${chat.length ? ` · ${chat.length} chat models` : " · no chat models listed"}`,
    };
  } catch (err) {
    return { ok: false, text: `${cfg.label} — ${err.message}` };
  }
}
