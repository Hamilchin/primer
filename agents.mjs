// Primer's agents: everything between a prompt and an answer.
//
// A role is an agent: a model and, for the ones that research, tools and a
// turn limit. Every call runs on a key of one of four kinds. A Claude
// subscription token may only be spent by Claude Code, so those calls go
// through the Claude Agent SDK, which runs it; an Anthropic, OpenRouter or
// OpenAI key is spoken to directly, through the AI SDK, which knows each
// provider's API. The tools are the same on both paths: a page reader and
// the finder's eyes, defined once here, and a web search, which every
// provider runs for itself on the key's own account, so nobody's searches
// are paid for by anyone else.
//
// MODELS is the catalogue: what a key may run, under the name its provider
// knows it by. A role runs on its own model, or the one Settings chose for
// it, when the key serves it; a key that serves neither runs its provider's
// stand-in. Nothing here knows about HTTP beyond `halt`, an error that
// carries the status it should be answered with.

import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { query, tool as sdkTool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { streamText, stepCountIs, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

export const halt = (status, message, kind) => Object.assign(new Error(message), { status, kind });

/* One entry per role. A role with no tools is a single completion. A role
   with tools is an agent: it may call them for up to maxTurns turns, and
   its answer is the text of its last message. Add a role here, and a prompt
   pair in prompts/, to add an agent.                                      */
export const ROLES = {
  outline:  { model: "claude-sonnet-4-6" },
  section:  { model: "claude-sonnet-4-6" },
  edit:     { model: "claude-sonnet-4-6" },
  figure:   { model: "claude-fable-5" },
  finder:   { model: "claude-sonnet-4-6", maxTurns: 40, tools: ["web_search", "fetch_page", "look_at_image"] },
  research: { model: "claude-sonnet-4-6", maxTurns: 40, tools: ["web_search", "fetch_page"] },
  define:   { model: "claude-sonnet-4-6", maxTurns: 12, tools: ["web_search", "fetch_page"] }
};

/* ── models and keys ──────────────────────────────────────────────
   The catalogue. `anthropic`, `openai` and `openrouter` are the model's
   name at that provider; a subscription runs what Anthropic does. A model
   the finder's tool cannot show an image to is told so instead. */
const MODELS = [
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", anthropic: "claude-sonnet-4-6", openrouter: "anthropic/claude-sonnet-4.6" },
  { id: "claude-sonnet-5",   name: "Claude Sonnet 5",   anthropic: "claude-sonnet-5",   openrouter: "anthropic/claude-sonnet-5" },
  { id: "claude-opus-5",     name: "Claude Opus 5",     anthropic: "claude-opus-5",     openrouter: "anthropic/claude-opus-5" },
  { id: "claude-fable-5",    name: "Claude Fable 5",    anthropic: "claude-fable-5",    openrouter: "anthropic/claude-fable-5" },
  { id: "claude-fable-5-1",  name: "Claude Fable 5.1",  anthropic: "claude-fable-5-1",  openrouter: "anthropic/claude-fable-5.1" },
  { id: "gpt-6-astra",       name: "GPT-6 Astra",       openai: "gpt-6-astra",   openrouter: "openai/gpt-6-astra" },
  { id: "gpt-5.6-terra",     name: "GPT-5.6 Terra",     openai: "gpt-5.6-terra", openrouter: "openai/gpt-5.6-terra" },
  { id: "gpt-5.6-luna",      name: "GPT-5.6 Luna",      openai: "gpt-5.6-luna",  openrouter: "openai/gpt-5.6-luna" },
  { id: "gemini-3.8-flash",  name: "Gemini 3.8 Flash",  openrouter: "google/gemini-3.8-flash", vision: false },   // Google refuses an image inside a tool result via OpenRouter (2026-09-05)
  { id: "deepseek-v4-pro",   name: "DeepSeek V4 Pro",   openrouter: "deepseek/deepseek-v4-pro-0813", vision: false },
  { id: "kimi-k3",           name: "Kimi K3",           openrouter: "moonshotai/kimi-k3" },
  { id: "grok-4.6",          name: "Grok 4.6",          openrouter: "x-ai/grok-4.6" }
];
const model = id => MODELS.find(m => m.id === id);

/* One entry per kind of key. `at` names the column of MODELS a key of this
   kind runs; `word` is what a person pastes; `probe` is the one free request
   that tells a wrong key from a right one; `client` opens the AI SDK to
   the provider (a subscription has none: Claude Code runs those calls);
   `standIn` is what runs when the key serves none of the role's models.
   The prefixes are tried in this order, so OpenAI's, the plainest, is last. */
const ANTHROPIC = "https://api.anthropic.com/v1";
export const PROVIDERS = {
  subscription: { name: "Anthropic", word: "subscription token", prefix: /^sk-ant-oat/, at: "anthropic", credit: "claude.ai",
                  probe: v => [ANTHROPIC + "/models?limit=1", { authorization: "Bearer " + v, "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" }] },
  anthropic:    { name: "Anthropic", word: "API key", prefix: /^sk-ant-api/, at: "anthropic", credit: "console.anthropic.com",
                  probe: v => [ANTHROPIC + "/models?limit=1", { "x-api-key": v, "anthropic-version": "2023-06-01" }],
                  client: v => createAnthropic({ apiKey: v }) },
  openrouter:   { name: "OpenRouter", word: "OpenRouter key", prefix: /^sk-or-/, at: "openrouter", credit: "openrouter.ai/credits",
                  probe: v => ["https://openrouter.ai/api/v1/key", { authorization: "Bearer " + v }],
                  client: v => createOpenRouter({ apiKey: v }) },
  openai:       { name: "OpenAI", word: "OpenAI key", prefix: /^sk-/, at: "openai", credit: "platform.openai.com", standIn: "gpt-5.6-terra",
                  probe: v => ["https://api.openai.com/v1/models?limit=1", { authorization: "Bearer " + v }],
                  client: v => createOpenAI({ apiKey: v }) }
};
/* The kind a credential's prefix says it is, if any. */
export const kindOf = value => Object.keys(PROVIDERS).find(k => PROVIDERS[k].prefix.test(value)) || null;
/* The models a kind of key can run, in the catalogue's order. */
export const choices = kind => MODELS.filter(m => m[PROVIDERS[kind].at]).map(({ id, name }) => ({ id, name }));
/* The model a role runs on a kind of key: the one chosen for it, or its
   own, whichever the key serves first; else the provider's stand-in. */
export function modelFor(role, kind, chosen) {
  const at = PROVIDERS[kind].at, served = id => { const m = model(id); return m && m[at] ? m : null; };
  return served(chosen) || served((ROLES[role] || ROLES.section).model) || served(PROVIDERS[kind].standIn);
}

/* ── web search ─────────────────────────────────────────────────
   Each provider searches for itself, on the key in use: Anthropic's and
   OpenAI's server-side tools, OpenRouter's server tool (the model's own
   search where it has one, Exa otherwise), and Claude Code's WebSearch for
   a subscription. The model asks for a search like any other tool; the
   provider runs it and hands the results straight back. `tool` opens the
   provider's tool on its client; `price` is a search at list price, for
   the providers that do not say what they charged. */
const SEARCH = {
  subscription: { builtin: "WebSearch" },
  anthropic:    { tool: c => c.tools.webSearch_20260209({ maxUses: 10 }), price: 0.01 },
  openrouter:   { tool: c => c.tools.webSearch({}) },
  openai:       { tool: c => c.tools.webSearch({}), price: 0.01 }
};
/* The pages a search found, as one line: for the Inspector, whichever
   provider ran it. Anthropic answers a list of pages; OpenAI says what it
   did (a search, or a page it opened) and the sources it drew on; the
   pages OpenRouter found arrive as sources, gathered by the caller. */
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return String(url); } };
const pages = list => list.length
  ? list.length + (list.length === 1 ? " page: " : " pages: ") + list.map(p => p.title || hostOf(p.url)).join(" · ")
  : "No results.";
/* What one provider-run search was, read from the stream part that
   answered it: {query|open|find, text}. */
function searched(out) {
  if (Array.isArray(out)) return { text: pages(out) };
  const a = (out && out.action) || {}, sources = ((out && out.sources) || []).filter(x => x.type === "url");
  const ask = a.type === "openPage" ? { open: a.url } : a.type === "findInPage" ? { find: a.pattern, in: a.url }
    : { query: a.query || (a.queries || []).join(" | ") || "" };
  return { ask, text: a.type === "openPage" ? "read " + hostOf(a.url) : pages(sources) };
}

/* Which kind a credential is: its prefix says, and the provider confirms.
   A wrong key has to be caught here: Claude Code retries one quietly for
   minutes. A value with no known prefix is tried every way. */
export async function identify(value) {
  const guess = kindOf(value);
  let status;
  for (const kind of guess ? [guess] : Object.keys(PROVIDERS)) {
    status = await refused(kind, value);
    if (!status) return kind;
  }
  throw halt(400, guess ? "That " + PROVIDERS[guess].word + " was refused by " + PROVIDERS[guess].name + " (" + status + ")."
                        : "No provider accepted that as a key.");
}
async function refused(kind, value) {
  const [url, headers] = PROVIDERS[kind].probe(value);
  let r;
  try { r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw halt(502, "Couldn't reach " + PROVIDERS[kind].name + " to check it: " + e.message); }
  return r.status === 401 || r.status === 403 ? r.status : null;
}

/* What is left on a key, where its provider will say: OpenRouter's credit
   in dollars, a subscription's usage windows as a share used and when each
   resets. Anthropic and OpenAI tell a plain key nothing, so null; asked at
   most once a minute for each key. */
const lefts = new Map();   // credential hash → {at, value}
export async function left({ kind, value }) {
  const ask = LEFT[kind];
  if (!ask) return null;
  const id = createHash("sha256").update(kind + ":" + value).digest("hex"), hit = lefts.get(id);
  if (hit && Date.now() - hit.at < 6e4) return hit.value;
  let v = null;
  try { v = await ask(value); } catch (e) { console.warn("What is left on a key went unanswered: " + e.message); }
  lefts.set(id, { at: Date.now(), value: v });
  return v;
}
const asJSON = async (url, headers) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + new URL(url).host);
  return r.json();
};
const LEFT = {
  async openrouter(v) {
    const d = (await asJSON("https://openrouter.ai/api/v1/credits", { authorization: "Bearer " + v })).data || {};
    return { credit: { left: Number(d.total_credits) - Number(d.total_usage), spent: Number(d.total_usage) } };
  },
  async subscription(v) {
    const u = await asJSON(ANTHROPIC.replace("/v1", "") + "/api/oauth/usage",
      { authorization: "Bearer " + v, "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-code/2.1" });
    const at = (name, x) => x && { name, used: Number(x.percent ?? x.utilization) / 100 || 0, resets: x.resets_at ? Date.parse(x.resets_at) || null : null };
    const windows = (u.limits || []).map(l => at(l.kind === "session" ? "5-hour window" : l.kind === "weekly_all" ? "Week"
      : l.kind === "weekly_scoped" ? "Week, " + ((((l.scope || {}).model || {}).display_name) || "scoped") : l.kind, l));
    if (!windows.length) windows.push(at("5-hour window", u.five_hour), at("Week", u.seven_day));
    return { windows: windows.filter(Boolean) };
  }
};

/* What a call cost, at list price. OpenRouter says what it charged; for a
   key of another kind, the price OpenRouter publishes for the same model,
   asked for once a day. Claude Code prices its own calls. */
let prices = null;   // {at, of: openrouter id → pricing}
async function priceOf(m) {
  if (!prices || Date.now() - prices.at > 864e5) {
    let of = new Map();
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15000) });
      of = new Map(((await r.json()).data || []).map(x => [x.id, x.pricing || {}]));
    } catch (e) { console.warn("No price list from OpenRouter, so costs will read as zero: " + e.message); }
    prices = { at: Date.now(), of };
  }
  return prices.of.get(m.openrouter);
}
function priced(u, p) {
  if (!p) return 0;
  const n = x => Number(x) || 0, d = u.inputTokenDetails || {};
  const read = n(d.cacheReadTokens), wrote = n(d.cacheWriteTokens), fresh = d.noCacheTokens != null ? n(d.noCacheTokens) : n(u.inputTokens) - read - wrote;
  return fresh * n(p.prompt) + read * n(p.input_cache_read ?? p.prompt) + wrote * n(p.input_cache_write ?? p.prompt) + n(u.outputTokens) * n(p.completion);
}

/* ── images ─────────────────────────────────────────────────────
   Images the finder looks at are kept in media/ under a name derived from
   their URL, so the one it picks is already on disk and the page never
   hotlinks. The same fetch serves the look_at_image tool and /api/media. */
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const IMAGE_MAX = 4 * 1024 * 1024;
export const images = new Map();   // url → {local, type, bytes}
const UA = "Primer/1.0 (local explainer tool; one page at a time; https://github.com/anthropics/claude-code)";
let MEDIA;
/* Where the images go, set once by whoever owns the data directory. */
export const keepImagesIn = dir => { MEDIA = dir; };

/* Wikimedia is the best source of reusable diagrams and the worst to link to:
   a thumbnail URL only works at widths it has already rendered, so a guessed
   .../800px-Name.svg.png is a 400 far more often than not, and an SVG cannot
   be viewed at all. Both are fixable without the model having to get the URL
   right: ask the API which file this is and let it name a real rendering.
   Anything not on Wikimedia is left exactly as it was given.              */
const WIKI_FILE = /^\/wikipedia\/([a-z-]+)\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/;
async function wikiThumb(u, width) {
  let api, title;
  const m = u.host === "upload.wikimedia.org" && WIKI_FILE.exec(u.pathname);
  if (m) { api = m[1] === "commons" ? "commons.wikimedia.org" : m[1] + ".wikipedia.org"; title = m[2]; }
  else if (/(^|\.)(wikipedia|wikimedia)\.org$/.test(u.host)) {
    const p = /\/wiki\/(?:File|Image|Fichier|Datei):(.+)$/.exec(decodeURIComponent(u.pathname));
    if (!p) return null;
    api = u.host; title = p[1];
  } else return null;

  const q = new URL("https://" + api + "/w/api.php");
  q.search = new URLSearchParams({ action: "query", titles: "File:" + decodeURIComponent(title),
    prop: "imageinfo", iiprop: "url|mime", iiurlwidth: String(width), format: "json" });
  const r = await fetch(q, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const pages = (((await r.json()) || {}).query || {}).pages || {};
  const info = (Object.values(pages)[0] || {}).imageinfo;
  if (!info || !info[0]) return null;
  /* thumburl is a PNG rendering even when the file itself is an SVG. */
  return info[0].thumburl || (info[0].mime !== "image/svg+xml" ? info[0].url : null) || null;
}

const webURL = url => {
  let u;
  try { u = new URL(url); } catch { throw new Error("Not a URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs.");
  return u;
};
/* The tools fetch a URL the model chose, so they must not be aimed at the
   machine itself or its private network. An address in a private, loopback
   or link-local range is refused; a hostname is refused if it resolves to
   one. redirect is manual so every hop is checked, not just the first. */
const isPrivate = ip => {
  if (isIP(ip) === 6) {
    const a = ip.toLowerCase();
    if (a.startsWith("::ffff:") && isIP(a.slice(7)) === 4) return isPrivate(a.slice(7));
    return a === "::1" || a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  }
  const p = ip.split(".").map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
};
async function publicOnly(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) { if (isPrivate(bare)) throw new Error("That address isn't allowed."); return; }
  if (host === "localhost" || /\.(internal|local|localhost)$/i.test(host)) throw new Error("That address isn't allowed.");
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error("Couldn't resolve that host."); }
  if (!addrs.length || addrs.some(a => isPrivate(a.address))) throw new Error("That address isn't allowed.");
}
async function safeFetch(url, opts = {}) {
  let u = webURL(url);
  for (let hop = 0; hop < 5; hop++) {
    await publicOnly(u.hostname);
    const r = await fetch(u, { ...opts, redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = webURL(new URL(r.headers.get("location"), u)); continue; }
    return r;
  }
  throw new Error("Too many redirects.");
}
export async function fetchImage(url) {
  const u = webURL(url);
  const wiki = await wikiThumb(u, 1000).catch(() => null);
  const r = await safeFetch(wiki || url, {
    headers: { "user-agent": UA, accept: "image/*" },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const type = (r.headers.get("content-type") || "").split(";")[0].trim();
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new Error(type === "image/svg+xml"
    ? "SVG cannot be viewed. Use a PNG rendering of it."
    : "Not an image file (" + (type || "unknown type") + ").");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > IMAGE_MAX) throw new Error("Too large (" + (buf.length / 1048576).toFixed(1) + " MB). Find a smaller rendering.");
  const name = createHash("sha1").update(url).digest("hex").slice(0, 20) + "." + ext;
  await mkdir(MEDIA, { recursive: true });
  await writeFile(new URL(name, MEDIA), buf);
  const info = { local: "/media/" + name, type, bytes: buf.length };
  images.set(url, info);
  return { info, buf };
}

/* ── the web ────────────────────────────────────────────────────
   The page reader. */
const PAGE_MAX = 40000;
async function readPage(url) {
  const r = await safeFetch(url, { headers: { "user-agent": UA, accept: "text/html, text/plain;q=0.9, */*;q=0.5" },
                                   signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const type = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^text\/|json|xml/.test(type)) throw new Error("Not a text page (" + (type || "unknown type") + ").");
  const text = /html/.test(type) ? plain(await r.text()) : await r.text();
  return text.length > PAGE_MAX ? text.slice(0, PAGE_MAX) + "\n… (cut at " + PAGE_MAX + " characters)" : text;
}
/* A page's words, without its furniture. */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function plain(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre|dd|dt)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => e in ENTITIES ? ENTITIES[e]
      : e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10) || 32) : m)
    .replace(/[ \t\r\f]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ── tools ──────────────────────────────────────────────────────
   Our own, defined once, in the shape both SDKs can be given. Each answers
   {text}, or {text, image, type} with the image as base64; a failure is
   caught and answered as {error}, so the agent reads why and goes on. The
   web search is not here: it is the provider's, above. */
const TOOLS = {
  fetch_page: {
    description: "Read a web page as plain text, up to 40,000 characters.",
    input: { url: z.string().describe("The page's URL") },
    run: async ({ url }) => ({ text: await readPage(url) })
  },
  look_at_image: {
    description: "Download an image file and look at it, to judge a candidate before choosing it. " +
      "Takes a direct URL to a PNG, JPEG, GIF or WebP file up to 4 MB. On Wikimedia any " +
      "form works, including an SVG and a File: page URL: the right PNG rendering is found for you.",
    input: { url: z.string().describe("Direct URL of the image file") },
    run: async ({ url }) => {
      const { info, buf } = await fetchImage(url);
      return { text: "Loaded " + info.type + ", " + Math.round(info.bytes / 1024) + " KB.", image: buf.toString("base64"), type: info.type };
    }
  }
};
const attempt = (t, input) => t.run(input).catch(e => ({ error: String(e && e.message || e) }));
/* The tools as Claude Code sees them: an MCP server of its own. */
const primerTools = createSdkMcpServer({
  name: "primer", version: "1.0.0",
  tools: Object.entries(TOOLS).map(([name, t]) => sdkTool(name, t.description, t.input, async input => {
    const r = await attempt(t, input);
    if (r.error) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [...(r.image ? [{ type: "image", data: r.image, mimeType: r.type }] : []), { type: "text", text: r.text }] };
  }))
});
/* The tools as the AI SDK sees them, for a model that can or cannot see. */
const aiTools = (names, sees) => Object.fromEntries(names.map(name => {
  const t = TOOLS[name];
  return [name, tool({
    description: t.description, inputSchema: z.object(t.input),
    execute: input => attempt(t, input),
    toModelOutput: ({ output: r }) => r.error ? { type: "error-text", value: r.error }
      : !r.image || !sees ? { type: "text", value: r.text + (r.image ? " This model cannot view images." : "") }
      : { type: "content", value: [{ type: "file", data: { type: "data", data: r.image }, mediaType: r.type }, { type: "text", text: r.text }] }
  })];
}));

/* ── a call ─────────────────────────────────────────────────────
   One system prompt, one user message. `cred` is {kind, value, key, own}:
   the credential, the key's public face, and whether the caller owns it.
   emit(frame) is called for every frame but the last; the resolved value
   is the text of the model's last message (or the assembled deltas if it
   never sent one). signal aborts. */
export async function complete({ system, user, role, model: chosen }, cred, emit, signal) {
  const spec = ROLES[role] || ROLES.section;
  const m = modelFor(role, cred.kind, chosen);
  const names = spec.tools || [];
  emit({ start: { model: m.id, tools: names } });
  const call = { system: String(system || ""), user: String(user || ""), model: m, names, maxTurns: spec.maxTurns || 1 };
  return (cred.kind === "subscription" ? viaClaudeCode : viaProvider)(call, cred, emit, signal);
}

const IDLE = 150000;
const QUIET = "No answer from the model for " + IDLE / 60000 + " minutes. If this keeps happening, check the key in Settings.";
/* Aborts a call that has gone quiet for IDLE. */
function watchdog(abort) {
  let t;
  const w = { quiet: false, stop: () => clearTimeout(t),
              arm() { clearTimeout(t); t = setTimeout(() => { w.quiet = true; abort(); }, IDLE); } };
  w.arm();
  return w;
}
function brief(content) {
  const s = typeof content === "string" ? content
    : (Array.isArray(content) ? content : []).map(c => c.type === "text" ? c.text : "[" + c.type + "]").join(" ");
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}
const FATAL = new Set(["billing_error", "authentication_failed", "rate_limit"]);
/* A provider's refusal, as a sentence that names the key and says where to
   fix it. `kind` is Claude Code's word for what went wrong. */
function refusal(kind, text, cred) {
  const p = PROVIDERS[cred.kind], key = cred.key;
  const t = String(text || "").replace(/\s*·\s*(Please run \/login|Fix external API key)\s*$/i, "").trim();
  const name = "the key “" + key.name + "”", said = t ? " (" + t + ")." : ".";
  const other = " Tell " + key.owner + ", or switch to another key in Settings.";
  const e = new Error(
    kind === "billing_error" ? "Out of credit on " + name + said + (cred.own ? " Add credit at " + p.credit + ", or switch to another key in Settings." : other)
    : kind === "authentication_failed" ? "The " + p.word + " behind " + name + " was refused" + said + (cred.own ? " Replace it in Settings." : other)
    : kind === "rate_limit" ? (/limit/i.test(t) && cred.kind === "subscription"
        ? "The Claude subscription behind " + name + " has hit its usage limit" + (t ? ": " + t : ".") + " Wait for it to reset, or switch to another key in Settings."
        : p.name + " rate-limited " + name + (t ? " (" + t + ")" : "") + ". Try again in a minute.")
    : t || kind);
  if (FATAL.has(kind)) e.kind = kind;
  return e;
}

/* A subscription's calls: Claude Code, run by the Agent SDK, with the
   token in its environment, our tools as an MCP server and the search its
   own. A search's result is a text with the pages found as a JSON list
   after "Links:"; the Inspector gets them in the same words as any other
   provider's. */
const WEBSEARCH = SEARCH.subscription.builtin;
function foundByClaudeCode(content) {
  const text = brief(content), m = /Links:\s*(\[[\s\S]*?\])/.exec(typeof content === "string" ? content
    : (Array.isArray(content) ? content : []).map(c => c.type === "text" ? c.text : "").join("\n"));
  try { if (m) return pages(JSON.parse(m[1])); } catch {}
  return text;
}
async function viaClaudeCode({ system, user, model: m, names, maxTurns }, cred, emit, signal) {
  const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: cred.value };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const dog = watchdog(() => abortController.abort());
  let stderr = "";
  const builtin = names.includes("web_search") ? [WEBSEARCH] : [], ours = names.filter(n => TOOLS[n]);
  const options = {
    stderr: s => { stderr = (stderr + s).slice(-2000); },
    systemPrompt: system, model: m.anthropic, abortController, env,
    settingSources: [], includePartialMessages: true, maxTurns,
    tools: builtin, allowedTools: [...builtin, ...ours.map(n => "mcp__primer__" + n)], permissionMode: "dontAsk"
  };
  if (ours.length) options.mcpServers = { primer: primerTools };

  let last = "", partial = "", result = null, failure = null, searches = 0;
  const uses = new Map();   // tool_use id → name, to read each result by the tool it answers
  try { for await (const msg of query({ prompt: user, options })) {
    dog.arm();
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
        partial += ev.delta.text;
        emit({ delta: ev.delta.text });
      }
    } else if (msg.type === "assistant") {
      if (msg.error) { failure = { kind: msg.error, text: brief(msg.message && msg.message.content) }; continue; }
      let text = "";
      for (const c of msg.message.content) {
        if (c.type === "text") text += c.text;
        else if (c.type === "tool_use") {
          const name = c.name === WEBSEARCH ? "web_search" : c.name.replace(/^mcp__primer__/, "");
          if (name === "web_search") searches++;
          uses.set(c.id, name);
          emit({ event: { kind: "tool", name, input: name === "web_search" ? { query: (c.input || {}).query } : c.input } });
        }
      }
      if (text.trim()) last = text;
    } else if (msg.type === "user" && Array.isArray(msg.message && msg.message.content)) {
      for (const c of msg.message.content) {
        if (c.type === "tool_result") {
          const search = uses.get(c.tool_use_id) === "web_search" && !c.is_error;
          emit({ event: { kind: "result", ok: !c.is_error, text: search ? foundByClaudeCode(c.content) : brief(c.content) } });
        }
      }
    } else if (msg.type === "result") {
      result = msg;
    }
  } } catch (e) { dog.stop(); if (!dog.quiet && !signal.aborted) throw withStderr(e, stderr); }
  dog.stop();
  if (result && result.usage) {
    const u = result.usage;
    /* Claude Code counts the searches it was billed for; the tool uses seen are the fallback. */
    const billed = Object.values(result.modelUsage || {}).reduce((n, x) => n + (Number(x.webSearchRequests) || 0), 0);
    emit({ usage: { in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
                    out: u.output_tokens || 0, cost: result.total_cost_usd || 0, turns: result.num_turns || 0, searches: billed || searches } });
  }
  if (dog.quiet) throw new Error(QUIET);
  if (signal.aborted) throw new Error("Stopped.");
  if (failure && (!last || (result && result.is_error))) throw refusal(failure.kind, failure.text, cred);
  if (!last && result && result.subtype !== "success") {
    throw new Error(result.subtype === "error_max_turns"
      ? "The agent used all " + maxTurns + " turns without answering."
      : "The call ended with " + result.subtype + (result.errors && result.errors.length ? ": " + result.errors.join("; ") : "."));
  }
  return last || partial;
}
/* What the CLI said on the way out, when it exited without an answer. */
function withStderr(e, stderr) {
  const line = String(stderr || "").split("\n").map(l => l.trim()).filter(Boolean).pop();
  if (line && /exited with code/.test(String(e && e.message))) e.message += ": " + line.slice(0, 300);
  return e;
}

/* Every other key's calls: the AI SDK, straight to the provider. A step is
   one message from the model; the answer is the last one with words in it.
   The provider runs the searches itself, so what the stream says of them
   differs: Anthropic and OpenAI answer each as a tool result, OpenRouter
   says only how many it ran, with the pages it cited as sources. All of it
   reaches the Inspector as the same two events, a search and its pages. */
async function viaProvider({ system, user, model: m, names, maxTurns }, cred, emit, signal) {
  const p = PROVIDERS[cred.kind], client = p.client(cred.value), id = m[p.at], search = SEARCH[cred.kind];
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const dog = watchdog(() => abortController.abort());
  const tools = aiTools(names.filter(n => TOOLS[n]), m.vision !== false);
  if (names.includes("web_search")) tools.web_search = search.tool(client);
  const stream = streamText({
    model: cred.kind === "openrouter" ? client(id, { usage: { include: true } }) : client(id),
    system, prompt: user, tools, stopWhen: stepCountIs(maxTurns),
    maxOutputTokens: 32000, abortSignal: abortController.signal,
    providerOptions: cred.kind === "anthropic" ? { anthropic: { thinking: { type: "adaptive" } } } : undefined,
    onError() {}   // an error arrives as a part of the stream, below; the SDK would also print it
  });

  let last = "", step = "", partial = "", turns = 0, searches = 0, charged = 0, usage = null, error = null;
  let seen = 0, sources = [];   // this step's searches answered in the stream, and the pages cited
  for await (const part of stream.fullStream) {
    dog.arm();
    if (part.type === "text-delta") { step += part.text; partial += part.text; emit({ delta: part.text }); }
    else if (part.type === "tool-call") {
      /* A search names its query when it answers, if the call did not; the filtering a search may run under the hood is not news. */
      if (part.toolName === "web_search") { if (part.input && part.input.query) emit({ event: { kind: "tool", name: "web_search", input: { query: part.input.query } } }); }
      else if (!part.providerExecuted) emit({ event: { kind: "tool", name: part.toolName, input: part.input } });
    }
    else if (part.type === "tool-result") {
      if (part.toolName === "web_search") {
        seen++;
        const { ask, text } = searched(part.output);
        if (ask) emit({ event: { kind: "tool", name: "web_search", input: ask } });
        emit({ event: { kind: "result", ok: true, text: brief(text) } });
      } else if (!part.providerExecuted) emit({ event: { kind: "result", ok: !part.output.error, text: brief(part.output.error || part.output.text) } });
    }
    else if (part.type === "tool-error") {
      const e = part.error;
      emit({ event: { kind: "result", ok: false, text: brief(e && e.errorCode ? "Search failed: " + String(e.errorCode).replace(/_/g, " ") + "." : String(e && e.message || e)) } });
    }
    else if (part.type === "source") { if (part.sourceType === "url") sources.push({ url: part.url, title: part.title }); }
    else if (part.type === "finish-step") {
      turns++;
      if (step.trim()) last = step;
      step = "";
      /* OpenRouter's count is under server_tool_use_details, whatever its docs say; Anthropic's under server_tool_use. */
      const raw = (part.usage || {}).raw || {}, billed = (raw.server_tool_use_details || raw.server_tool_use || {}).web_search_requests;
      if (!seen && (billed || sources.length)) {   // searched out of sight: OpenRouter
        emit({ event: { kind: "tool", name: "web_search", input: { searches: Number(billed) || 1 } } });
        emit({ event: { kind: "result", ok: true, text: brief(sources.length ? pages(sources) : "Pages not reported.") } });
      }
      searches += Math.max(Number(billed) || 0, seen);
      seen = 0; sources = [];
      charged += Number((((part.providerMetadata || {}).openrouter || {}).usage || {}).cost) || 0;
    }
    else if (part.type === "finish") usage = part.totalUsage;
    else if (part.type === "error") error = part.error;
  }
  dog.stop();
  if (usage) emit({ usage: { in: usage.inputTokens || 0, out: usage.outputTokens || 0, turns, searches,
                             cost: charged || priced(usage, await priceOf(m)) + searches * (search.price || 0) } });
  if (dog.quiet) throw new Error(QUIET);
  if (signal.aborted) throw new Error("Stopped.");
  if (error && !last) throw refusal(...failureOf(error), cred);
  if (!last && turns >= maxTurns && names.length) throw new Error("The agent used all " + maxTurns + " turns without answering.");
  return last || partial;
}
/* What went wrong, in Claude Code's words, and what the provider said. */
function failureOf(e) {
  const status = Number(e && e.statusCode) || 0;
  let text = String(e && e.message || e);
  try { text = JSON.parse(e.responseBody).error.message || text; } catch {}
  const kind = status === 401 || status === 403 ? "authentication_failed"
    : status === 402 || /credit|quota|billing|balance/i.test(text) ? "billing_error"
    : status === 429 ? "rate_limit" : "error";
  return [kind, text];
}
