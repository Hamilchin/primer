// Primer server.
//   npm start   →  http://localhost:8787
//
// Serves the app, keeps each user's primers, and answers POST /api/complete
// through the Claude Agent SDK as a stream of newline-delimited JSON frames:
//   {start:{model,tools}}            first, so the client knows what ran
//   {delta:"..."}                    as text arrives
//   {event:{kind:"tool",...}}        an agent called a tool
//   {event:{kind:"result",...}}      what the tool returned, in brief
//   {usage:{in,out,cost,searches}}   what the call cost, once it is known
//   {done:true, text}  or  {error:{message,kind?}}   last; kind names a
//                                    dead credential: billing_error,
//                                    authentication_failed, rate_limit
//                                    (a 400 with kind no_key: no key at all)
// Closing the request aborts the call. POST /api/media {url} fetches an image
// the finder chose into DATA_DIR/media and answers {local}.
//
// Accounts: POST /api/signup {name,password,invite}, /api/login, /api/logout,
// GET /api/me. Signing up needs the invite code, which is printed at boot
// (or set INVITE). Everything the page stores goes through
// GET/PUT/DELETE /api/store/:key, per user.
//
// Keys: every call runs on a named key, an Anthropic API key or a Claude
// subscription token (from `claude setup-token`), added in Settings.
// GET /api/keys lists yours and the ones you have linked to; POST /api/keys
// adds one (shared keys carry a password); PUT /api/keys/:id renames,
// shares or re-passwords it (a new password drops everyone linked); DELETE
// /api/keys/:id removes it. POST /api/keys/link {name,password} links you
// to someone's shared key, DELETE /api/keys/link/:id unlinks, and PUT
// /api/keys/active {id} picks the one you run on. Each key sums what it was
// used for, per day, for its owner. A new account has no key and is sent to
// Settings before its first primer. Every call logs who made it and on
// which key. See store.mjs for the database.
//
// Guests: POST /api/guest sets a signed cookie and keeps nothing else; a
// guest's primers stay in their browser, and each /api/complete carries
// `cred`: {kind, value} for a key of their own, or {name, password} for
// someone's shared key. POST /api/guest/check {value} says which kind a
// credential is; POST /api/guest/link {name, password} confirms a shared key.
//
// Sharing: POST /api/share {of} freezes a primer as it is stored and answers
// {id}; with live:true it answers the one link that follows the primer as
// it changes. GET /s/:id is that primer as a page and GET /api/share/:id as
// JSON, for anyone, signed in or not. What a link shows is `snapshot`, the
// one place the server reads inside a stored primer. GET /api/shares?doc=
// lists a primer's links, DELETE /api/share/:id removes one.
//
// Environment (all optional):
//   PORT=8787  HOST=127.0.0.1  DATA_DIR=./data  INVITE=...  PRIMER_SECRET=...  ADMIN=name,name
// No credential comes from the environment: keys are added in Settings.
//
// Setup:
//   npm install
//   npm i -g @anthropic-ai/claude-code        (the SDK runs the claude CLI)
//   npm start                                 (prints the invite code)

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { openStore } from "./store.mjs";

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const DATA = resolve(process.env.DATA_DIR || "data");
const ROOT = new URL("./", import.meta.url);
const MEDIA = pathToFileURL(DATA + "/media/");
const db = openStore(DATA);
/* Images found before there was a data directory move into it. */
try { const old = new URL("./media/", ROOT); if (!existsSync(MEDIA) && existsSync(old)) { mkdirSync(DATA, { recursive: true }); renameSync(old, MEDIA); } } catch (e) { console.warn("media/ not moved: " + e.message); }

/* One entry per role. A role with no tools is a single completion. A role
   with tools is an agent: it may call them for up to maxTurns turns, and
   its answer is the text of its last message. Add a role here, and a prompt
   pair in prompts/, to add an agent.                                      */
const ROLES = {
  outline:  { model: "claude-sonnet-4-6" },
  section:  { model: "claude-sonnet-4-6" },
  edit:     { model: "claude-sonnet-4-6" },
  figure:   { model: "claude-fable-5" },
  finder:   { model: "claude-sonnet-4-6", maxTurns: 40,
              tools: ["WebSearch", "WebFetch", "mcp__primer__look_at_image"] },
  research: { model: "claude-fable-5", maxTurns: 40,
              tools: ["WebSearch", "WebFetch"] },
  define:   { model: "claude-sonnet-4-6", maxTurns: 12,
              tools: ["WebSearch", "WebFetch"] }
};

/* ── images ─────────────────────────────────────────────────────
   Images the finder looks at are kept in media/ under a name derived from
   their URL, so the one it picks is already on disk and the page never
   hotlinks. The same fetch serves the look_at_image tool and /api/media. */
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const IMAGE_MAX = 4 * 1024 * 1024;
const images = new Map();   // url → {local, type, bytes}
const UA = "Primer/1.0 (local explainer tool; one image at a time; https://github.com/anthropics/claude-code)";

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

async function fetchImage(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error("Not a URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs.");
  const wiki = await wikiThumb(u, 1000).catch(() => null);
  const r = await fetch(wiki || url, {
    headers: { "user-agent": UA, accept: "image/*" },
    signal: AbortSignal.timeout(20000), redirect: "follow"
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

/* The finder's eyes: it downloads a candidate and sees it as an image. */
const primerTools = createSdkMcpServer({
  name: "primer", version: "1.0.0",
  tools: [
    tool("look_at_image",
      "Download an image file and look at it, to judge a candidate before choosing it. " +
      "Takes a direct URL to a PNG, JPEG, GIF or WebP file up to 4 MB. On Wikimedia any " +
      "form works, including an SVG and a File: page URL: the right PNG rendering is found for you.",
      { url: z.string().describe("Direct URL of the image file") },
      async ({ url }) => {
        try {
          const { info, buf } = await fetchImage(url);
          return { content: [
            { type: "image", data: buf.toString("base64"), mimeType: info.type },
            { type: "text", text: "Loaded " + info.type + ", " + Math.round(info.bytes / 1024) + " KB." }
          ] };
        } catch (e) {
          return { content: [{ type: "text", text: "Could not load that image: " + e.message }], isError: true };
        }
      })
  ]
});


/* ── completions ────────────────────────────────────────────────
   One system prompt, one user message. emit(frame) is called for every
   frame but the last; the resolved value is the text of the model's last
   message (or the assembled deltas if it never sent one). signal aborts. */
const IDLE = 150000;
const FATAL = new Set(["billing_error", "authentication_failed", "rate_limit"]);
function brief(content) {
  const s = typeof content === "string" ? content
    : (Array.isArray(content) ? content : []).map(c => c.type === "text" ? c.text : "[" + c.type + "]").join(" ");
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

/* The CLI's own word for what went wrong, turned into a sentence that names
   the key and says where to fix it. `key` is the key the call ran on; `own`
   whether the caller owns it (else it is someone's shared key). */
function failureText(kind, text, key, own) {
  const t = String(text || "").replace(/\s*·\s*(Please run \/login|Fix external API key)\s*$/i, "").trim();
  const name = "the key “" + key.name + "”", said = t ? " (" + t + ")." : ".";
  const other = " Tell " + key.owner + ", or switch to another key in Settings.";
  if (kind === "billing_error") return "Out of API credits on " + name + said +
    (own ? " Add credit at console.anthropic.com, or switch to another key in Settings." : other);
  if (kind === "authentication_failed") return "The " + (key.kind === "token" ? "subscription token" : "API key") + " behind " + name +
    " was refused" + said + (own ? " Replace it in Settings." : other);
  if (kind === "rate_limit") return /limit/i.test(t) && key.kind === "token"
    ? "The Claude subscription behind " + name + " has hit its usage limit" + (t ? ": " + t : ".") + " Wait for it to reset, or switch to another key in Settings."
    : "Anthropic rate-limited " + name + (t ? " (" + t + ")" : "") + ". Try again in a minute.";
  return t || kind;
}
/* What a finished call cost, in the shape the page keeps per call. */
function callUsage(r) {
  if (!r || !r.usage) return null;
  const u = r.usage, m = r.modelUsage || {};
  return { in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
           out: u.output_tokens || 0, cost: r.total_cost_usd || 0, turns: r.num_turns || 0,
           searches: Object.values(m).reduce((n, x) => n + (x.webSearchRequests || 0), 0) };
}

async function complete({ system, user, role }, env, key, own, emit, signal) {
  const spec = ROLES[role] || ROLES.section;
  const tools = spec.tools || [];
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });

  let stderr = "";
  const options = {
    stderr: s => { stderr = (stderr + s).slice(-2000); },
    systemPrompt: String(system || ""),
    model: spec.model,
    abortController,
    env,
    settingSources: [],
    includePartialMessages: true,
    maxTurns: spec.maxTurns || 1,
    tools: tools.filter(t => !t.startsWith("mcp__")),
    allowedTools: tools,
    permissionMode: "dontAsk"
  };
  if (tools.some(t => t.startsWith("mcp__primer__"))) options.mcpServers = { primer: primerTools };
  emit({ start: { model: spec.model, tools } });

  let last = "", partial = "", result = null, quiet = false, failure = null;
  let idle = setTimeout(() => { quiet = true; abortController.abort(); }, IDLE);
  const iter = query({ prompt: String(user || ""), options });
  try { for await (const msg of iter) {
    clearTimeout(idle); idle = setTimeout(() => { quiet = true; abortController.abort(); }, IDLE);
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
        else if (c.type === "tool_use") emit({ event: { kind: "tool", name: c.name, input: c.input } });
      }
      if (text.trim()) last = text;
    } else if (msg.type === "user" && Array.isArray(msg.message && msg.message.content)) {
      for (const c of msg.message.content) {
        if (c.type === "tool_result") emit({ event: { kind: "result", ok: !c.is_error, text: brief(c.content) } });
      }
    } else if (msg.type === "result") {
      result = msg;
    }
  } } catch (e) { clearTimeout(idle); if (!quiet && !signal.aborted) throw withStderr(e, stderr); }
  clearTimeout(idle);
  const usage = callUsage(result);
  if (usage) emit({ usage });
  if (quiet) throw new Error("No answer from the model for " + IDLE / 60000 + " minutes. If this keeps happening, check the key or token in Settings.");
  if (signal.aborted) throw new Error("Stopped.");
  if (failure && (!last || (result && result.is_error))) {
    const e = new Error(failureText(failure.kind, failure.text, key, own));
    if (FATAL.has(failure.kind)) e.kind = failure.kind;
    throw e;
  }
  if (!last && result && result.subtype !== "success") {
    throw new Error(result.subtype === "error_max_turns"
      ? "The agent used all " + options.maxTurns + " turns without answering."
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

/* ── credentials ────────────────────────────────────────────────
   An error with a status is an answer: the handler sends it as JSON. */
const halt = (status, message, kind) => Object.assign(new Error(message), { status, kind });

/* A wrong key or token does not fail: the CLI retries it quietly for
   minutes. So a credential is tried against the API before it is kept, with
   the one free request there is, and a call that goes silent is given up
   on. Answers the status Anthropic refused it with, or null when it passed. */
async function refusal(kind, value) {
  const headers = { "anthropic-version": "2023-06-01" };
  if (kind === "key") headers["x-api-key"] = value;
  else { headers.authorization = "Bearer " + value; headers["anthropic-beta"] = "oauth-2025-04-20"; }
  let r;
  try { r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers, signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw halt(502, "Couldn't reach Anthropic to check it: " + e.message); }
  return r.status === 401 || r.status === 403 ? r.status : null;
}
/* Which kind a credential is: its prefix says, and Anthropic confirms. A
   value with neither prefix is tried both ways. */
async function identify(value) {
  const guess = /^sk-ant-oat/.test(value) ? "token" : /^sk-ant-api/.test(value) ? "key" : null;
  let status;
  for (const kind of guess ? [guess] : ["key", "token"]) {
    status = await refusal(kind, value);
    if (!status) return kind;
  }
  throw halt(400, guess ? "That " + (guess === "key" ? "key" : "token") + " was refused by Anthropic (" + status + ")."
                        : "Anthropic refused that as an API key and as a subscription token.");
}

/* A guest has a cookie but no account: a random value signed with the
   server's secret, so it costs no row and survives a restart. */
const guestToken = () => { const r = randomBytes(12).toString("hex"); return "g." + r + "." + db.hmac("guest:" + r); };
const isGuest = t => { const m = /^g\.([0-9a-f]{24})\.([0-9a-f]{64})$/.exec(String(t || "")); return !!m && db.hmac("guest:" + m[1]) === m[2]; };
const GUEST_OK = /^\/api\/(complete|media|guest\/)/;
/* The credential a guest sends with each call: {kind, value} for a key of
   their own, {name, password} for someone's shared key. */
function guestClaude(c) {
  if (!c || typeof c !== "object") return null;
  if (c.value) {
    const kind = c.kind === "token" ? "token" : "key";
    return { env: db.keys.envFor(kind, String(c.value)), own: true,
             key: { name: "your " + (kind === "key" ? "API key" : "subscription token"), kind, owner: "you" } };
  }
  if (!c.name) return null;
  const r = db.keys.sharedEnv(String(c.name), String(c.password || ""));
  if (!r) throw halt(403, "The shared key “" + c.name + "” no longer accepts that password. Link to it again in Settings.");
  return { ...r, own: false };
}

/* ── http ───────────────────────────────────────────────────── */
const TYPES = { html: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8", png: "image/png",
                jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
/* Addresses the page answers for itself: /, /guide, /settings, /p/<id>, /p/<id>/inspector. */
const PAGE_PATH = /^\/(guide|settings|p\/[\w-]+(\/inspector)?)?$/;
const SHARE_ID = /^[\w-]{8,40}$/;
const MEDIA_NAME = /^[0-9a-f]{20}\.(png|jpg|gif|webp)$/;
/* The image files among a primer's blocks, by name. */
const mediaOf = blocks => [...new Set(blocks.map(x => x && typeof x.src === "string" && x.src.startsWith("/media/") ? x.src.slice(7) : "")
  .filter(n => MEDIA_NAME.test(n)))];
/* What a link shows of a stored primer: its finished pieces, with links to
   the owner's other primers made plain, and the display switches that
   shape them. A frozen link keeps this as it is now; a live link makes it
   afresh each time. This is the one place the server reads inside the
   page's blobs, and it copies out only what it names: a rewrite's source
   text, a definition's context, the calls behind the pieces and the
   failures among them stay with the owner. Null once the primer is gone. */
function snapshot(user, docId) {
  let d, st = {};
  try { d = JSON.parse(db.kv.get(user, "primer:doc:" + docId)); } catch { return null; }
  if (!d || !Array.isArray(d.blocks)) return null;
  try { st = JSON.parse(db.kv.get(user, "primer:settings")) || {}; } catch {}
  const blocks = d.blocks.filter(b => b && (b.md || b.src)).map(({ by, origin, slot, fail, checked, ...r }) => {
    if (r.md) r.md = String(r.md).replace(/\[([^\]]*)\]\(primer:\w+\)/g, "$1");
    return r;
  });
  const out = { title: String(d.title || d.topic || "Primer").slice(0, 200), topic: d.topic, known: d.known || "", instruction: d.instruction || "",
                created: d.created, status: d.status || "done", blocks, view: { sources: st.showSources !== false, marks: st.showMarks !== false } };
  if (d.note) out.note = String(d.note).slice(0, 600);
  if (d.researched) out.researched = d.researched;
  if (d.rewrite) out.rewrite = { ofTitle: d.rewrite.ofTitle, instruction: d.rewrite.instruction };
  if (d.define && d.define.from) out.define = { term: d.define.term, from: { title: d.define.from.title } };
  return out;
}
const NAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const KEY_NAME = /^[^\s"“”][^"“”]{0,39}$/;
const keyId = p => { const m = /^\/api\/keys\/(\d+)$/.exec(p); return m ? Number(m[1]) : null; };
const linkId = p => { const m = /^\/api\/keys\/link\/(\d+)$/.exec(p); return m ? Number(m[1]) : null; };
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(c => c[0]));
const secure = req => /^https/.test(req.headers["x-forwarded-proto"] || "");
const decode = s => { try { return decodeURIComponent(s); } catch { throw halt(400, "Bad path."); } };

async function readText(req, max) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > max) throw halt(413, "Too large."); }
  return body;
}
async function readBody(req, max = 4e6) {
  const text = await readText(req, max);
  try { return JSON.parse(text || "{}"); } catch { throw halt(400, "Bad JSON body."); }
}

/* Sign-in attempts per address, so a password cannot be guessed at speed. */
const tries = new Map();
function slow(ip) {
  const now = Date.now();
  for (const [k, v] of tries) if (now - v.at > 6e4) tries.delete(k);
  const t = tries.get(ip) || { n: 0 };
  t.n++; t.at = now; tries.set(ip, t);
  if (t.n > 8) throw halt(429, "Too many attempts. Wait a minute.");
}

createServer(async (req, res) => {
  try { await serve(req, res); }
  catch (e) {
    if (res.headersSent) return res.end();
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: e.status ? e.message : "Something went wrong on the server.", kind: e.kind } }));
  }
}).listen(PORT, HOST, () => {
  console.log(`Primer  →  http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`Invite code for new accounts: ${db.invite}`);
  console.log("Calls run on named keys added in Settings; nothing is read from the environment.");
});

async function serve(req, res) {
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const token = cookies(req).primer;
  const me = db.sessions.user(token);
  const guest = !me && isGuest(token);
  const setCookie = t => res.setHeader("set-cookie",
    "primer=" + (t || "") + "; Path=/; HttpOnly; SameSite=Lax" + (secure(req) ? "; Secure" : "") + (t ? "; Max-Age=31536000" : "; Max-Age=0"));
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";

  /* ── accounts ── */
  if (req.method === "POST" && (path === "/api/signup" || path === "/api/login")) {
    const b = await readBody(req);
    slow(ip);
    const name = String(b.name || "").trim().toLowerCase(), password = String(b.password || "");
    let user;
    if (path === "/api/signup") {
      if (!NAME.test(name)) throw halt(400, "A username is 2 to 32 letters, digits, dots, dashes or underscores.");
      if (password.length < 8) throw halt(400, "A password is at least 8 characters.");
      if (String(b.invite || "").trim() !== db.invite) throw halt(403, "That invite code isn't right.");
      try { user = db.users.create(name, password); } catch (e) { throw halt(409, e.message); }
    } else {
      user = NAME.test(name) && password ? db.users.check(name, password) : null;
      if (!user) throw halt(401, "Wrong username or password.");
    }
    setCookie(db.sessions.create(user.id));
    return json(200, { name: user.name, key: user.key, admin: user.admin });
  }
  if (req.method === "POST" && path === "/api/logout") { db.sessions.delete(token); setCookie(null); return json(200, {}); }
  if (path === "/api/me") {
    if (me) return json(200, { name: me.name, key: me.key, admin: me.admin });
    if (guest) return json(200, { guest: true });
    throw halt(401, "Not signed in.");
  }
  /* A guest: no account, primers kept in their browser, a credential sent with each call. */
  if (req.method === "POST" && path === "/api/guest") { setCookie(guestToken()); return json(200, { guest: true }); }

  /* ── a shared primer: anyone with the link ── */
  if (req.method === "GET" && path.startsWith("/api/share/")) {
    const id = path.slice("/api/share/".length);
    const s = SHARE_ID.test(id) && db.shares.get(id);
    /* A live link: the primer as its owner has it right now. */
    const snap = s && s.live && snapshot(s.user, s.doc);
    if (!s || (s.live && !snap)) throw halt(404, "That link doesn't lead to a primer any more.");
    if (snap) db.shares.media(s.id, mediaOf(snap.blocks));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
    return res.end('{"id":' + JSON.stringify(s.id) + ',"by":' + JSON.stringify(s.by) + ',"created":' + s.created
                 + (snap ? ',"live":true,"doc":' + JSON.stringify(snap) : ',"doc":' + s.body) + "}");
  }

  /* ── feedback: from anyone on the page, to whoever hosts ── */
  if (req.method === "POST" && path === "/api/feedback") {
    const b = await readBody(req);
    if (!me) slow(ip);
    const text = String(b.text || "").trim().slice(0, 4000);
    if (!text) throw halt(400, "Say something first.");
    const kind = b.kind === "complaint" ? "complaint" : "feedback";
    const w = b.where && typeof b.where === "object" ? b.where : {}, cut = (v, n) => v == null ? undefined : String(v).slice(0, n);
    const where = { url: cut(w.url, 500), route: cut(w.route, 40), doc: cut(w.doc, 40), title: cut(w.title, 200), section: cut(w.section, 200),
                    block: cut(w.block, 40), quote: cut(w.quote, 500), passage: cut(w.passage, 2000), width: Number(w.width) || undefined };
    db.feedback.add(me ? me.id : null, me ? me.name : guest ? "a guest" : "a reader", kind, text, where);
    console.log("  " + (me ? me.name : "guest") + "  " + kind + ": " + text.slice(0, 80).replace(/\s+/g, " "));
    return json(200, {});
  }

  /* Everything below needs a signed-in user, except the page itself, and
     the few calls a guest may make. */
  if (path.startsWith("/api/") && !me && !(guest && GUEST_OK.test(path))) throw halt(401, "Not signed in.");

  /* ── a guest's credential: which kind it is, or whose shared key it opens ── */
  if (req.method === "POST" && path === "/api/guest/check") {
    const value = String((await readBody(req)).value || "").trim();
    if (!value) throw halt(400, "Paste the key or token first.");
    return json(200, { kind: await identify(value) });
  }
  if (req.method === "POST" && path === "/api/guest/link") {
    const b = await readBody(req);
    slow(ip);
    const r = db.keys.sharedEnv(String(b.name || "").trim(), String(b.password || ""));
    if (!r) throw halt(403, "No shared key with that name and password.");
    console.log("  guest  linked to “" + r.key.name + "”");
    return json(200, { name: r.key.name, owner: r.key.owner, kind: r.key.kind });
  }

  if (req.method === "GET" && path === "/api/feedback") {
    if (!me.admin) throw halt(403, "Only the host reads feedback.");
    return json(200, { items: db.feedback.list(300) });
  }

  /* ── sharing: freeze a primer, list a primer's links, take one back ── */
  if (req.method === "POST" && path === "/api/share") {
    const b = await readBody(req);
    const of = String(b.of || "").slice(0, 40);
    const snap = of && snapshot(me.id, of);
    if (!snap) throw halt(404, "That primer isn't saved.");
    /* A live link follows the primer; a frozen one is a copy of it now. */
    if (b.live) {
      const s = db.shares.live(me.id, of, snap.title);
      if (!s.reused) console.log("  " + me.name + "  public link " + s.id);
      return json(200, s);
    }
    if (!snap.blocks.length) throw halt(400, "Nothing to share yet.");
    /* What the primer cost comes from the page, which keeps the trace. */
    if (b.usage) snap.usage = String(b.usage).slice(0, 200);
    const s = db.shares.create(me.id, of, snap.title, JSON.stringify(snap), mediaOf(snap.blocks));
    console.log("  " + me.name + "  share " + s.id + (s.reused ? "  (unchanged, same link)" : ""));
    return json(200, s);
  }
  if (req.method === "GET" && path === "/api/shares") {
    const of = String(url.searchParams.get("doc") || "").slice(0, 40);
    return json(200, { shares: of ? db.shares.list(me.id, of) : [] });
  }
  if (req.method === "DELETE" && path.startsWith("/api/share/")) {
    const id = path.slice("/api/share/".length);
    if (!SHARE_ID.test(id) || !db.shares.delete(me.id, id)) throw halt(404, "No such link of yours.");
    return json(200, {});
  }

  /* ── named keys: every change answers with the whole picture ── */
  const answerKeys = () => json(200, db.keys.list(me.id));
  if (req.method === "GET" && path === "/api/keys") return answerKeys();
  if (req.method === "POST" && path === "/api/keys") {
    const b = await readBody(req);
    const name = String(b.name || "").trim(), value = String(b.value || "").trim();
    const shared = !!b.shared, password = String(b.password || "");
    if (!KEY_NAME.test(name)) throw halt(400, "Give the key a name: up to 40 characters, no quotes.");
    if (!value) throw halt(400, "Paste the key or token first.");
    if (shared && password.length < 6) throw halt(400, "A shared key needs a password of at least 6 characters.");
    const kind = await identify(value);
    try { db.keys.create(me.id, { name, kind, value, shared, password }); } catch (e) { throw halt(409, e.message); }
    console.log("  " + me.name + "  key + “" + name + "”" + (shared ? " (shared)" : ""));
    return answerKeys();
  }
  if (req.method === "PUT" && keyId(path) != null) {
    const b = await readBody(req), patch = {};
    if (b.name != null) { patch.name = String(b.name).trim(); if (!KEY_NAME.test(patch.name)) throw halt(400, "A name is up to 40 characters, no quotes."); }
    if (b.shared != null) patch.shared = !!b.shared;
    if (b.password) { patch.password = String(b.password); if (patch.password.length < 6) throw halt(400, "A password is at least 6 characters."); }
    try { db.keys.update(me.id, keyId(path), patch); } catch (e) { throw halt(400, e.message); }
    console.log("  " + me.name + "  key #" + keyId(path) + " changed" + (patch.password ? " (password, links dropped)" : ""));
    return answerKeys();
  }
  if (req.method === "DELETE" && keyId(path) != null) {
    try { db.keys.delete(me.id, keyId(path)); } catch (e) { throw halt(404, e.message); }
    console.log("  " + me.name + "  key #" + keyId(path) + " deleted");
    return answerKeys();
  }
  if (req.method === "POST" && path === "/api/keys/link") {
    const b = await readBody(req), name = String(b.name || "").trim();
    slow(ip);
    try { db.keys.link(me.id, name, String(b.password || "")); } catch (e) { throw halt(403, e.message); }
    console.log("  " + me.name + "  linked to “" + name + "”");
    return answerKeys();
  }
  if (req.method === "DELETE" && linkId(path) != null) { db.keys.unlink(me.id, linkId(path)); return answerKeys(); }
  if (req.method === "PUT" && path === "/api/keys/active") {
    const b = await readBody(req);
    try { db.keys.activate(me.id, Number(b.id)); } catch (e) { throw halt(403, e.message); }
    return answerKeys();
  }

  /* ── the page's storage ── */
  if (path.startsWith("/api/store/")) {
    const k = decode(path.slice("/api/store/".length));
    if (!k || k.length > 200) throw halt(400, "Bad key.");
    if (req.method === "GET") {
      const v = db.kv.get(me.id, k);
      if (v == null) throw halt(404, "Nothing stored under that key.");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(v);
    }
    if (req.method === "PUT") {
      const body = await readText(req, 8e6);
      try { JSON.parse(body); } catch { throw halt(400, "Not JSON."); }
      db.kv.set(me.id, k, body);
      return json(200, {});
    }
    if (req.method === "DELETE") { db.kv.del(me.id, k); return json(200, {}); }
    throw halt(405, "method not allowed");
  }
  if (req.method === "GET" && path === "/api/store") return json(200, { keys: db.kv.keys(me.id) });

  /* ── model calls ── */
  if (req.method === "POST" && path === "/api/complete") {
    const body = await readBody(req);
    const claude = me ? db.users.claudeEnv(me.id) : guestClaude(body.cred);
    if (!claude) throw halt(400, "No key to run on. Add one, or link to a shared key, in Settings.", "no_key");
    /* Who is calling, on which key: the record of shared use. */
    console.log("  " + (me ? me.name : "guest") + "  " + (body.role || "?") + "  on “" + claude.key.name + "”" + (claude.own ? "" : " (" + claude.key.owner + "’s)"));
    /* Headers go out with the first frame, so a failure before any text can
       still be a plain 500 that the client retries. After that, errors travel
       as a frame. Closing the connection aborts the model call. */
    const ctrl = new AbortController();
    res.on("close", () => { if (!res.writableFinished) ctrl.abort(); });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8",
                           "cache-control": "no-cache", "x-accel-buffering": "no" });
    };
    const frame = obj => {
      /* What the call cost goes on the key's day, whoever made it; a guest's own key has no id. */
      if (obj.usage && claude.key.id) { try { db.keys.addUsage(claude.key.id, obj.usage); } catch (e) { console.warn("usage not recorded: " + e.message); } }
      start(); res.write(JSON.stringify(obj) + "\n");
    };
    try {
      const text = await complete(body, claude.env, claude.key, claude.own, frame, ctrl.signal);
      frame({ done: true, text });
      res.end();
    } catch (e) {
      if (ctrl.signal.aborted) { console.log("  stopped  " + (body.role || "")); return res.end(); }
      console.error(e);
      const error = { message: String(e && e.message || e) };
      if (e && e.kind) error.kind = e.kind;
      if (!started) return json(500, { error });
      frame({ error });
      res.end();
    }
    return;
  }

  if (req.method === "POST" && path === "/api/media") {
    const { url } = await readBody(req);
    try { return json(200, images.get(url) || (await fetchImage(url)).info); }
    catch (e) { throw halt(400, String(e && e.message || e)); }
  }

  /* ── files: the page and what it needs, and the images that were found ── */
  if (req.method !== "GET") throw halt(405, "method not allowed");
  /* A shared primer is the same page, titled after the primer so the link
     unfurls and the tab reads right; the page does the rest from the URL. */
  if (path.startsWith("/s/")) {
    const s = SHARE_ID.test(path.slice(3)) && db.shares.get(path.slice(3));
    let html = await readFile(new URL("primer.html", ROOT), "utf8");
    const live = s && s.live && snapshot(s.user, s.doc);
    if (s) html = html.replace("<title>primer</title>", "<title>" + escapeHtml(live ? live.title : s.title) + " · primer</title>");
    res.writeHead(200, { "content-type": TYPES.html, "cache-control": "no-cache" });
    return res.end(html);
  }
  /* The guide, Settings and a primer are the same page at their own addresses. */
  const name = PAGE_PATH.test(path) ? "primer.html" : decode(path.slice(1));
  if (name.includes("..") || name.startsWith("/")) throw halt(400, "Bad path.");
  const from = name.startsWith("media/") ? new URL(name.slice(6), MEDIA) : new URL(name, ROOT);
  /* An image is private to the people signed in, and guests, unless a shared primer shows it. */
  const ok = name === "primer.html" || name === "favicon.svg" || name === "apple-touch-icon.png" || /^prompts\/[\w-]+\.txt$/.test(name)
    || (name.startsWith("media/") && (me || guest || db.shares.mediaShared(name.slice(6))));
  if (!ok) throw halt(404, "Not found.");
  let buf;
  try { buf = await readFile(from); } catch { throw halt(404, "Not found."); }
  res.writeHead(200, { "content-type": TYPES[name.split(".").pop()] || "application/octet-stream",
                       "cache-control": name.startsWith("media/") ? "private, max-age=31536000" : "no-cache" });
  res.end(buf);
}
