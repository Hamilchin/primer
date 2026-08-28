// Primer server.
//   npm start   →  http://localhost:8787
//
// Serves the app and answers POST /api/complete through the Claude Agent SDK
// as a stream of newline-delimited JSON frames:
//   {start:{model,tools}}            first, so the client knows what ran
//   {delta:"..."}                    as text arrives
//   {event:{kind:"tool",...}}        an agent called a tool
//   {event:{kind:"result",...}}      what the tool returned, in brief
//   {done:true, text}  or  {error}   last
// Closing the request aborts the call. POST /api/media {url} fetches an image
// the finder chose into media/ and answers {local}. The SDK authenticates
// with your logged-in Claude Code session and bills your plan's Agent SDK
// credit, not a pay-as-you-go API key.
//
// Setup:
//   npm install
//   npm i -g @anthropic-ai/claude-code && claude   (then /login, pick your plan)
//   unset ANTHROPIC_API_KEY                        (see note below)

import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const PORT = Number(process.env.PORT) || 8787;
const ROOT = new URL("./", import.meta.url);
const MEDIA = new URL("./media/", import.meta.url);

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
              tools: ["WebSearch", "WebFetch"] }
};

if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "\n  ANTHROPIC_API_KEY is set. It overrides your subscription and this will\n" +
    "  bill as pay-as-you-go API usage. Run `unset ANTHROPIC_API_KEY` first.\n"
  );
}

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
function brief(content) {
  const s = typeof content === "string" ? content
    : (Array.isArray(content) ? content : []).map(c => c.type === "text" ? c.text : "[" + c.type + "]").join(" ");
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

async function complete({ system, user, role }, emit, signal) {
  const spec = ROLES[role] || ROLES.section;
  const tools = spec.tools || [];
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const options = {
    systemPrompt: String(system || ""),
    model: spec.model,
    abortController,
    settingSources: [],
    includePartialMessages: true,
    maxTurns: spec.maxTurns || 1,
    tools: tools.filter(t => !t.startsWith("mcp__")),
    allowedTools: tools,
    permissionMode: "dontAsk"
  };
  if (tools.some(t => t.startsWith("mcp__primer__"))) options.mcpServers = { primer: primerTools };
  emit({ start: { model: spec.model, tools } });

  let last = "", partial = "", result = null;
  for await (const msg of query({ prompt: String(user || ""), options })) {
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
        partial += ev.delta.text;
        emit({ delta: ev.delta.text });
      }
    } else if (msg.type === "assistant") {
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
  }
  if (signal.aborted) throw new Error("Stopped.");
  if (!last && result && result.subtype !== "success") {
    throw new Error(result.subtype === "error_max_turns"
      ? "The agent used all " + options.maxTurns + " turns without answering."
      : "The call ended with " + result.subtype + (result.errors && result.errors.length ? ": " + result.errors.join("; ") : "."));
  }
  return last || partial;
}

/* ── http ───────────────────────────────────────────────────── */
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css",
                txt: "text/plain; charset=utf-8", json: "application/json",
                png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
                webp: "image/webp", svg: "image/svg+xml" };

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "POST" && req.url === "/api/complete") {
    let body;
    try { body = await readBody(req); } catch (e) { return json(400, { error: { message: "Bad JSON body." } }); }
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
    const frame = obj => { start(); res.write(JSON.stringify(obj) + "\n"); };
    try {
      const text = await complete(body, frame, ctrl.signal);
      frame({ done: true, text });
      res.end();
    } catch (e) {
      if (ctrl.signal.aborted) { console.log("  stopped  " + (body.role || "")); return res.end(); }
      console.error(e);
      const error = { message: String(e && e.message || e) };
      if (!started) return json(500, { error });
      frame({ error });
      res.end();
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/media") {
    try {
      const { url } = await readBody(req);
      const { info } = images.has(url) ? { info: images.get(url) } : await fetchImage(url);
      return json(200, info);
    } catch (e) {
      return json(400, { error: { message: String(e && e.message || e) } });
    }
  }

  if (req.method !== "GET") return json(405, { error: { message: "method not allowed" } });

  const name = req.url === "/" ? "primer.html" : decodeURIComponent(req.url.slice(1).split("?")[0]);
  if (name.includes("..") || name.startsWith("/")) return json(400, { error: { message: "bad path" } });
  try {
    const buf = await readFile(new URL(name, ROOT));
    res.writeHead(200, { "content-type": TYPES[name.split(".").pop()] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Primer  →  http://localhost:${PORT}`);
});
