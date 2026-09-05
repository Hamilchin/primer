// Primer server.
//   npm start   →  http://localhost:8787
//
// Serves the app, keeps each user's primers, and answers POST /api/complete
// {system, user, role, model?} as a stream of newline-delimited JSON frames
// (model, when given, replaces the role's own):
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
// the finder chose into DATA_DIR/media and answers {local}. POST /api/models
// answers {defaults:{role:model}, models:[{id,name}]}: what each role runs
// on the caller's key when nothing is chosen, and what that key can run.
// The agents themselves, the models and the kinds of key are in agents.mjs.
//
// Accounts: POST /api/signup {name,password,invite}, /api/login, /api/logout,
// GET /api/me. Signing up needs the invite code, which is printed at boot
// (or set INVITE). Everything the page stores goes through
// GET/PUT/DELETE /api/store/:key, per user.
//
// Keys: every call runs on a named key, added in Settings: a Claude
// subscription token (from `claude setup-token`), or an Anthropic, OpenRouter
// or OpenAI key. GET /api/keys lists yours and the ones you have linked to;
// POST /api/keys adds one (shared keys carry a password); PUT /api/keys/:id
// renames, shares or re-passwords it (a new password drops everyone
// linked); DELETE /api/keys/:id removes it. POST /api/keys/link
// {name,password} links you to someone's shared key, DELETE
// /api/keys/link/:id unlinks, and PUT /api/keys/active {id} picks the one
// you run on. Each key sums what it was used for, per day, for its owner. A
// new account has no key and is sent to Settings before its first primer.
// Every call logs who made it and on which key. See store.mjs for the
// database.
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
// No model credential comes from the environment: keys are added in Settings,
// and each key's provider runs the agents' web searches on it.
//
// Setup:
//   npm install
//   npm i -g @anthropic-ai/claude-code        (runs a subscription's calls)
//   npm start                                 (prints the invite code)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { openStore } from "./store.mjs";
import { ROLES, PROVIDERS, halt, kindOf, identify, choices, modelFor, complete, left, fetchImage, images, keepImagesIn } from "./agents.mjs";

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1";
const DATA = resolve(process.env.DATA_DIR || "data");
const ROOT = new URL("./", import.meta.url);
const MEDIA = pathToFileURL(DATA + "/media/");
const db = openStore(DATA);
keepImagesIn(MEDIA);

/* A guest has a cookie but no account: a random value signed with the
   server's secret, so it costs no row and survives a restart. */
const guestToken = () => { const r = randomBytes(12).toString("hex"); return "g." + r + "." + db.hmac("guest:" + r); };
const isGuest = t => { const m = /^g\.([0-9a-f]{24})\.([0-9a-f]{64})$/.exec(String(t || "")); return !!m && db.hmac("guest:" + m[1]) === m[2]; };
const GUEST_OK = /^\/api\/(complete|media|models|guest\/)/;
/* The credential a guest sends with each call: {kind, value} for a key of
   their own, whose kind its prefix confirms; {name, password} for someone's
   shared key. The same shape the store gives a signed-in user. */
function guestCred(c, ip) {
  if (!c || typeof c !== "object") return null;
  if (c.value) {
    const value = String(c.value), kind = kindOf(value) || (PROVIDERS[c.kind] ? c.kind : null);
    return kind ? { kind, value, own: true, key: { name: "your " + PROVIDERS[kind].word, kind, owner: "you" } } : null;
  }
  if (!c.name) return null;
  /* A shared key's password is guessed no faster here than at the link
     endpoints: the same buckets, so /api/complete is no way around them. */
  const name = String(c.name).trim();
  guard("link:" + ip, 40); guard("link:" + name, 8);
  const r = db.keys.sharedCredential(name, String(c.password || ""));
  if (!r) { strike("link:" + ip, "link:" + name); throw halt(403, "The shared key “" + name + "” no longer accepts that password. Link to it again in Settings."); }
  return { ...r, own: false };
}

/* ── http ───────────────────────────────────────────────────── */
const TYPES = { html: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8", png: "image/png",
                jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
/* Addresses the page answers for itself: /, /guide, /settings, /p/<id>, /p/<id>/inspector. */
const PAGE_PATH = /^\/(guide(\/\w+)?|settings|p\/[\w-]+(\/inspector)?)?$/;
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
   text, the calls behind the pieces and the failures among them stay
   with the owner. Null once the primer is gone. */
function snapshot(user, docId) {
  let d, st = {};
  try { d = JSON.parse(db.kv.get(user, "primer:doc:" + docId)); } catch { return null; }
  if (!d || !Array.isArray(d.blocks)) return null;
  try { st = JSON.parse(db.kv.get(user, "primer:settings")) || {}; } catch {}
  const blocks = d.blocks.filter(b => b && (b.md || b.src)).map(({ by, origin, slot, fail, checked, ...r }) => {
    if (r.md) r.md = String(r.md).replace(/\[([^\]]*)\]\(primer:\w+\)/g, "$1");
    /* A revision's mark stays, without the words the reader typed to ask
       for it; a research correction keeps its reason and its source. */
    if (r.edit && typeof r.edit === "object") {
      const e = r.edit;
      r.edit = e.by === "research" ? { label: e.label, ts: e.ts, by: "research", note: e.note, url: e.url } : { label: e.label, ts: e.ts };
    }
    return r;
  });
  const out = { title: String(d.title || d.topic || "Primer").slice(0, 200), topic: d.topic, known: d.known || "", instruction: d.instruction || "",
                created: d.created, status: d.status || "done", blocks, view: { sources: st.showSources !== false, marks: st.showMarks !== false } };
  if (d.note) out.note = String(d.note).slice(0, 600);
  if (d.researched) out.researched = d.researched;
  if (d.rewrite) out.rewrite = { ofTitle: d.rewrite.ofTitle, instruction: d.rewrite.instruction };
  return out;
}
/* What the library's list keeps of a primer, in the page's own shape. */
const DOC_ID = /^[\w-]{1,40}$/;
function indexEntry(id, b) {
  b = b && typeof b === "object" ? b : {};
  const e = { id, title: String(b.title || "").slice(0, 200), updated: Number(b.updated) || Date.now(),
              status: String(b.status || "done").slice(0, 20), short: Number(b.short) || 0 };
  if (b.words != null) e.words = Number(b.words) || 0;
  /* Why it is not being carried on, and how often carrying on has failed: see the page. */
  if (b.halt) e.halt = String(b.halt).slice(0, 20);
  if (b.tries) e.tries = Number(b.tries) || 0;
  return e;
}
const NAME = /^[a-z0-9][a-z0-9._-]{1,31}$/;
const KEY_NAME = /^[^\s"“”][^"“”]{0,39}$/;
const keyId = p => { const m = /^\/api\/keys\/(\d+)$/.exec(p); return m ? Number(m[1]) : null; };
const linkId = p => { const m = /^\/api\/keys\/link\/(\d+)$/.exec(p); return m ? Number(m[1]) : null; };
const keyLeft = p => { const m = /^\/api\/keys\/(\d+)\/left$/.exec(p); return m ? Number(m[1]) : null; };
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

/* Failed attempts within the minute, by what was tried and from where: past
   a bucket's limit the next try waits. A password is guessed no faster than
   eight times a minute whatever the addresses, while the many people behind
   one address share a looser bucket that only their failures fill. */
const strikes = new Map();
function guard(key, max) {
  const now = Date.now();
  for (const [k, v] of strikes) if (now - v.at > 6e4) strikes.delete(k);
  const t = strikes.get(key);
  if (t && t.n >= max) throw halt(429, "Too many attempts. Wait a minute.");
}
function strike(...keys) {
  for (const k of keys) { const t = strikes.get(k) || { n: 0 }; t.n++; t.at = Date.now(); strikes.set(k, t); }
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
  console.log("Calls run on named keys added in Settings; no model credential is read from the environment.");
  if (!process.env.PRIMER_SECRET) console.log("No PRIMER_SECRET: stored keys are encrypted with a secret kept in the database itself. Set PRIMER_SECRET so a leaked data directory can't be decrypted.");
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
  /* Fly's proxy names the caller; anything the caller sent itself is not trusted. */
  const ip = req.headers["fly-client-ip"] || req.socket.remoteAddress || "";

  /* ── accounts ── */
  if (req.method === "POST" && (path === "/api/signup" || path === "/api/login")) {
    const b = await readBody(req);
    const name = String(b.name || "").trim().toLowerCase(), password = String(b.password || "");
    let user;
    if (path === "/api/signup") {
      guard("signup:" + ip, 8);
      if (!NAME.test(name)) throw halt(400, "A username is 2 to 32 letters, digits, dots, dashes or underscores.");
      if (password.length < 8) throw halt(400, "A password is at least 8 characters.");
      if (String(b.invite || "").trim() !== db.invite) { strike("signup:" + ip); throw halt(403, "That invite code isn't right."); }
      try { user = db.users.create(name, password); } catch (e) { throw halt(409, e.message); }
    } else {
      guard("login:" + ip, 40); guard("login:" + name, 8);
      user = NAME.test(name) && password ? db.users.check(name, password) : null;
      if (!user) { strike("login:" + ip, "login:" + name); throw halt(401, "Wrong username or password."); }
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
    if (!me) { guard("feedback:" + ip, 20); strike("feedback:" + ip); }
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
    const b = await readBody(req), name = String(b.name || "").trim();
    guard("link:" + ip, 40); guard("link:" + name, 8);
    const r = db.keys.sharedCredential(name, String(b.password || ""));
    if (!r) { strike("link:" + ip, "link:" + name); throw halt(403, "No shared key with that name and password."); }
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
  /* What is left on one of your keys, as its provider tells it; {} where it doesn't. */
  if (req.method === "GET" && keyLeft(path) != null) {
    let cred;
    try { cred = db.keys.own(me.id, keyLeft(path)); } catch (e) { throw halt(404, e.message); }
    return json(200, await left(cred) || {});
  }
  if (req.method === "POST" && path === "/api/keys/link") {
    const b = await readBody(req), name = String(b.name || "").trim();
    guard("link:" + ip, 40); guard("link:" + name, 8);
    try { db.keys.link(me.id, name, String(b.password || "")); } catch (e) { strike("link:" + ip, "link:" + name); throw halt(403, e.message); }
    console.log("  " + me.name + "  linked to “" + name + "”");
    return answerKeys();
  }
  if (req.method === "DELETE" && linkId(path) != null) { db.keys.unlink(me.id, linkId(path)); return answerKeys(); }
  if (req.method === "PUT" && path === "/api/keys/active") {
    const b = await readBody(req);
    try { db.keys.activate(me.id, Number(b.id)); } catch (e) { throw halt(403, e.message); }
    return answerKeys();
  }

  /* ── the library's list ──
     Changed an entry at a time and merged here, so two tabs saving at once
     keep each other's primers. Each change answers with the list as it now
     stands: a new entry goes to the top, a known one keeps its place. */
  if (path.startsWith("/api/index/") && (req.method === "PUT" || req.method === "DELETE")) {
    const id = decode(path.slice("/api/index/".length));
    if (!DOC_ID.test(id)) throw halt(400, "Bad id.");
    const entry = req.method === "PUT" ? indexEntry(id, await readBody(req)) : null;
    let list = [];
    try { list = JSON.parse(db.kv.get(me.id, "primer:index")); } catch {}
    list = Array.isArray(list) ? list.filter(x => x && typeof x === "object" && x.id) : [];
    const i = list.findIndex(x => x.id === id);
    if (!entry) list = list.filter(x => x.id !== id);
    else if (i < 0) list.unshift(entry);
    else list[i] = entry;
    db.kv.set(me.id, "primer:index", JSON.stringify(list));
    return json(200, list);
  }

  /* ── the page's storage ── */
  if (path.startsWith("/api/store/")) {
    const k = decode(path.slice("/api/store/".length));
    if (!k || k.length > 200) throw halt(400, "Bad key.");
    if (k === "primer:index" && req.method === "PUT") throw halt(400, "The library's list is changed an entry at a time, at /api/index/<id>.");
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

  /* ── model calls ── */
  if (req.method === "POST" && path === "/api/complete") {
    const body = await readBody(req);
    const cred = me ? db.users.credential(me.id) : guestCred(body.cred, ip);
    if (!cred) throw halt(400, "No key to run on. Add one, or link to a shared key, in Settings.", "no_key");
    /* Who is calling, on which key: the record of shared use. */
    console.log("  " + (me ? me.name : "guest") + "  " + (body.role || "?") + "  on “" + cred.key.name + "”" + (cred.own ? "" : " (" + cred.key.owner + "’s)"));
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
      if (obj.usage && cred.key.id) { try { db.keys.addUsage(cred.key.id, obj.usage); } catch (e) { console.warn("usage not recorded: " + e.message); } }
      start(); res.write(JSON.stringify(obj) + "\n");
    };
    try {
      const text = await complete(body, cred, frame, ctrl.signal);
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

  /* What each role runs on the caller's key when nothing is chosen, and what that key can run. */
  if (req.method === "POST" && path === "/api/models") {
    const cred = me ? db.users.credential(me.id) : guestCred((await readBody(req)).cred, ip);
    const defaults = Object.fromEntries(Object.keys(ROLES).map(r => [r, cred ? modelFor(r, cred.kind).id : ROLES[r].model]));
    return json(200, { defaults, models: cred ? choices(cred.kind) : [] });
  }

  if (req.method === "POST" && path === "/api/media") {
    const { url } = await readBody(req);
    try { return json(200, images.get(url) || (await fetchImage(url)).info); }
    catch (e) { throw halt(400, String(e && e.message || e)); }
  }

  /* ── files: the page and what it needs, and the images that were found ── */
  if (req.method !== "GET" && req.method !== "HEAD") throw halt(405, "method not allowed");
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
