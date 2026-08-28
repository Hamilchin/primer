// Primer server.
//   npm start   →  http://localhost:8787
//
// Serves the app and answers POST /api/complete through the Claude Agent SDK
// as a stream of newline-delimited JSON frames: {delta} as text arrives, then
// {done, text} or {error}. The SDK
// authenticates with your logged-in Claude Code session and bills your
// plan's Agent SDK credit, not a pay-as-you-go API key.
//
// Setup:
//   npm install
//   npm i -g @anthropic-ai/claude-code && claude   (then /login, pick your plan)
//   unset ANTHROPIC_API_KEY                        (see note below)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = 8787;
/* One model per role. */
const MODELS = {
  outline: "claude-sonnet-4-6",
  section: "claude-sonnet-4-6",
  edit:    "claude-sonnet-4-6",
  figure:  "claude-fable-5"
};
const ROOT = new URL("./", import.meta.url);

if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "\n  ANTHROPIC_API_KEY is set. It overrides your subscription and this will\n" +
    "  bill as pay-as-you-go API usage. Run `unset ANTHROPIC_API_KEY` first.\n"
  );
}

/* One system prompt, one user message, one turn, no tools: a plain completion.
   Text is handed to onDelta as it arrives; the resolved value is the final text
   from the assistant message (or the assembled deltas if that never came). */
async function complete({ system, user, role }, onDelta) {
  let final = "", partial = "";
  for await (const msg of query({
    prompt: String(user || ""),
    options: {
      systemPrompt: String(system || ""),
      model: MODELS[role] || MODELS.section,
      allowedTools: [],
      settingSources: [],
      maxTurns: 1,
      includePartialMessages: true
    }
  })) {
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
        partial += ev.delta.text;
        if (onDelta) onDelta(ev.delta.text);
      }
    } else if (msg.type === "assistant") {
      for (const c of msg.message.content) if (c.type === "text") final += c.text;
    }
  }
  return final || partial;
}

const TYPES = { html:"text/html; charset=utf-8", js:"text/javascript", css:"text/css",
                txt:"text/plain; charset=utf-8", json:"application/json" };

createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "POST" && req.url === "/api/complete") {
    let body = "";
    for await (const chunk of req) body += chunk;
    /* Headers go out with the first delta, so a failure before any text can
       still be a plain 500 that the client retries. After that, errors travel
       as a frame. */
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8",
                           "cache-control": "no-cache", "x-accel-buffering": "no" });
    };
    const frame = obj => res.write(JSON.stringify(obj) + "\n");
    try {
      const text = await complete(JSON.parse(body), delta => { start(); frame({ delta }); });
      start();
      frame({ done: true, text });
      res.end();
    } catch (e) {
      console.error(e);
      const error = { message: String(e && e.message || e) };
      if (!started) return json(500, { error });
      frame({ error });
      res.end();
    }
    return;
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
