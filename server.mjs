// Primer local server.
//   node server.mjs   →  http://localhost:8787
//
// Serves primer.html and answers POST /v1/messages using the Claude Agent SDK,
// which authenticates through your logged-in Claude Code session and draws on
// your plan's monthly Agent SDK credit instead of a pay-as-you-go API key.
//
// Setup:
//   npm i @anthropic-ai/claude-agent-sdk
//   npm i -g @anthropic-ai/claude-code && claude   (then /login, pick your plan)
//   unset ANTHROPIC_API_KEY                        (see note below)
//
// In primer.html set:  ENDPOINT: "/v1/messages"

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PORT = 8787;
const MODEL = "claude-sonnet-4-6";
const ROOT = new URL("./", import.meta.url);

if (process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "\n  ANTHROPIC_API_KEY is set. It overrides your subscription and this will\n" +
    "  bill as pay-as-you-go API usage. Run `unset ANTHROPIC_API_KEY` first.\n"
  );
}

/* Collapse Primer's {system, messages} into a single Agent SDK turn.
   No tools, no filesystem settings, one turn — a plain completion. */
async function complete({ system, messages }) {
  const prompt = (messages || []).map(m =>
    typeof m.content === "string"
      ? m.content
      : (m.content || []).filter(c => c.type === "text").map(c => c.text).join("\n")
  ).join("\n\n");

  let out = "";
  for await (const msg of query({
    prompt,
    options: {
      systemPrompt: system || "",
      model: MODEL,
      allowedTools: [],
      settingSources: [],
      maxTurns: 1
    }
  })) {
    if (msg.type === "assistant") {
      for (const c of msg.message.content) if (c.type === "text") out += c.text;
    }
  }
  return out;
}

const TYPES = { html:"text/html; charset=utf-8", js:"text/javascript", css:"text/css",
                md:"text/markdown", json:"application/json", txt:"text/plain; charset=utf-8" };

createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "POST" && req.url === "/v1/messages") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const text = await complete(JSON.parse(body));
      json(200, { content: [{ type: "text", text }], stop_reason: "end_turn" });
    } catch (e) {
      console.error(e);
      json(500, { error: { message: String(e && e.message || e) } });
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
