// Primer's database: one SQLite file under DATA_DIR, opened with Node's own
// node:sqlite, so there is nothing to install and nothing to run.
//
//   users      who can sign in, and which key their calls run on (active_key)
//   keys       named credentials of a kind agents.mjs knows (a Claude
//              subscription token, an Anthropic, OpenRouter or OpenAI key),
//              owned by a user, optionally shared behind a password so
//              others can link to it by name
//   key_links  which users have linked to which shared keys
//   key_usage  what each key has been used for, summed per day
//   sessions   a cookie per signed-in browser
//   kv         everything the page keeps, per user, by key: primers, prompt
//              edits, settings. The client already talks to storage as
//              get/set/del by key, so the server stores it the same way.
//   shares     a link to a primer, readable by anyone with the id: a frozen
//              copy of it as it was, or a live one that the server makes
//              afresh from the stored primer each time it is opened
//   share_media  the image files a share refers to, so they can be served
//              to a reader who is not signed in
//   meta       the server's own few facts: its secret, its invite code
//
// Passwords are scrypt hashes. A key's value is encrypted with a secret that
// is generated once and kept in meta, or given as PRIMER_SECRET. Nothing
// here knows about HTTP.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from "node:crypto";

export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "primer.db"));
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists meta     (k text primary key, v text not null);
    create table if not exists users    (id integer primary key, name text unique not null, pass text not null,
                                         active_key integer, created integer not null);
    create table if not exists sessions (token text primary key, user integer not null references users(id) on delete cascade,
                                         created integer not null);
    create table if not exists kv       (user integer not null references users(id) on delete cascade, k text not null,
                                         v text not null, updated integer not null, primary key (user, k));
    create table if not exists shares   (id text primary key, user integer not null references users(id) on delete cascade,
                                         doc text not null, title text not null, hash text not null, body text not null,
                                         live integer not null default 0, created integer not null);
    create table if not exists share_media (share text not null, name text not null, primary key (share, name));
    create table if not exists keys     (id integer primary key, owner integer not null references users(id) on delete cascade,
                                         name text not null, kind text not null, secret text not null,
                                         shared integer not null default 0, pass text, created integer not null);
    create table if not exists key_links (user integer not null, key integer not null, created integer not null,
                                         primary key (user, key));
    create table if not exists feedback (id integer primary key, user integer, name text not null, kind text not null,
                                         text text not null, ctx text not null, created integer not null);
    create table if not exists key_usage (key integer not null, day text not null, calls integer not null default 0,
                                         tokens_in integer not null default 0, tokens_out integer not null default 0,
                                         searches integer not null default 0, cost real not null default 0,
                                         primary key (key, day));
  `);

  const q = {
    metaGet: db.prepare("select v from meta where k = ?"),
    metaSet: db.prepare("insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v"),
    userByName: db.prepare("select * from users where name = ?"),
    userById: db.prepare("select * from users where id = ?"),
    userAdd: db.prepare("insert into users (name, pass, created) values (?, ?, ?)"),
    userActive: db.prepare("update users set active_key = ? where id = ?"),
    userClearActive: db.prepare("update users set active_key = null where active_key = ?"),
    userClearActiveExcept: db.prepare("update users set active_key = null where active_key = ? and id <> ?"),
    sessAdd: db.prepare("insert into sessions (token, user, created) values (?, ?, ?)"),
    sessUser: db.prepare("select users.* from sessions join users on users.id = sessions.user where sessions.token = ?"),
    sessDel: db.prepare("delete from sessions where token = ?"),
    kvGet: db.prepare("select v from kv where user = ? and k = ?"),
    kvSet: db.prepare("insert into kv (user, k, v, updated) values (?, ?, ?, ?) on conflict(user, k) do update set v = excluded.v, updated = excluded.updated"),
    kvDel: db.prepare("delete from kv where user = ? and k = ?"),
    shareAdd: db.prepare("insert into shares (id, user, doc, title, hash, body, created) values (?, ?, ?, ?, ?, ?, ?)"),
    shareAddLive: db.prepare("insert into shares (id, user, doc, title, hash, body, live, created) values (?, ?, ?, ?, 'live', '', 1, ?)"),
    shareLive: db.prepare("select id, created from shares where user = ? and doc = ? and live = 1"),
    shareLast: db.prepare("select id, hash, created from shares where user = ? and doc = ? and live = 0 order by created desc limit 1"),
    shareGet: db.prepare("select shares.*, users.name as by from shares join users on users.id = shares.user where shares.id = ?"),
    shareList: db.prepare("select id, created, live from shares where user = ? and doc = ? order by live desc, created desc"),
    shareDel: db.prepare("delete from shares where id = ? and user = ?"),
    shareMediaAdd: db.prepare("insert or ignore into share_media (share, name) values (?, ?)"),
    shareMediaDel: db.prepare("delete from share_media where share = ?"),
    shareMediaHas: db.prepare("select 1 from share_media where name = ? limit 1"),
    keyAdd: db.prepare("insert into keys (owner, name, kind, secret, shared, pass, created) values (?, ?, ?, ?, ?, ?, ?)"),
    keyById: db.prepare("select keys.*, users.name as ownerName from keys join users on users.id = keys.owner where keys.id = ?"),
    keyMine: db.prepare("select keys.*, users.name as ownerName from keys join users on users.id = keys.owner where owner = ? order by created"),
    keyMineNamed: db.prepare("select id from keys where owner = ? and name = ?"),
    keySharedNamed: db.prepare("select keys.*, users.name as ownerName from keys join users on users.id = keys.owner where shared = 1 and keys.name = ?"),
    keySet: db.prepare("update keys set name = ?, shared = ?, pass = ? where id = ?"),
    keyDel: db.prepare("delete from keys where id = ?"),
    linkAdd: db.prepare("insert or ignore into key_links (user, key, created) values (?, ?, ?)"),
    linkDel: db.prepare("delete from key_links where user = ? and key = ?"),
    linkDelKey: db.prepare("delete from key_links where key = ?"),
    linkHas: db.prepare("select 1 from key_links where user = ? and key = ?"),
    linkMine: db.prepare("select keys.*, users.name as ownerName from key_links join keys on keys.id = key_links.key join users on users.id = keys.owner where key_links.user = ? order by key_links.created"),
    linkCount: db.prepare("select count(*) as n from key_links where key = ?"),
    usageAdd: db.prepare(`insert into key_usage (key, day, calls, tokens_in, tokens_out, searches, cost) values (?, ?, 1, ?, ?, ?, ?)
                          on conflict(key, day) do update set calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in,
                          tokens_out = tokens_out + excluded.tokens_out, searches = searches + excluded.searches, cost = cost + excluded.cost`),
    usageDays: db.prepare("select day, calls, tokens_in, tokens_out, searches, cost from key_usage where key = ? order by day desc limit ?"),
    usageTotal: db.prepare("select coalesce(sum(calls),0) as calls, coalesce(sum(tokens_in),0) as tokens_in, coalesce(sum(tokens_out),0) as tokens_out, coalesce(sum(searches),0) as searches, coalesce(sum(cost),0) as cost from key_usage where key = ?"),
    usageDel: db.prepare("delete from key_usage where key = ?"),
    firstUser: db.prepare("select min(id) as id from users"),
    fbAdd: db.prepare("insert into feedback (user, name, kind, text, ctx, created) values (?, ?, ?, ?, ?, ?)"),
    fbList: db.prepare("select * from feedback order by created desc limit ?")
  };
  /* Who hosts: the accounts named in ADMIN, or, unset, the first account
     made. The host reads the feedback that comes in. */
  const admins = (process.env.ADMIN || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const isAdmin = u => admins.length ? admins.includes(u.name) : u.id === (q.firstUser.get() || {}).id;

  /* ── meta: a value that is made once and then kept ── */
  const meta = (k, make) => {
    const row = q.metaGet.get(k);
    if (row) return row.v;
    const v = make();
    q.metaSet.run(k, v);
    return v;
  };
  const secret = process.env.PRIMER_SECRET || meta("secret", () => randomBytes(32).toString("hex"));
  const invite = process.env.INVITE || meta("invite", () => randomBytes(4).toString("hex"));
  const aesKey = createHash("sha256").update(secret).digest();

  /* ── passwords ── */
  const hashPassword = pw => {
    const salt = randomBytes(16);
    return salt.toString("hex") + ":" + scryptSync(pw, salt, 32).toString("hex");
  };
  const checkPassword = (pw, stored) => {
    const [salt, hash] = String(stored).split(":");
    const a = scryptSync(pw, Buffer.from(salt, "hex"), 32), b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /* ── secrets at rest ── */
  const seal = text => {
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", aesKey, iv);
    const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  };
  const open = blob => {
    const b = Buffer.from(blob, "base64"), d = createDecipheriv("aes-256-gcm", aesKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  };

  /* A session token is random; only its hash is kept, so the database
     alone cannot sign anyone in. */
  const hashToken = t => createHash("sha256").update(t).digest("hex");
  const hint = s => s.length > 8 ? "…" + s.slice(-4) : "set";
  const today = () => new Date().toISOString().slice(0, 10);

  /* What a key looks like from outside: never its value. `mine` adds what
     only the owner may see: whether it is shared, how many are linked,
     and what it has been used for. */
  const publicKey = (k, mine) => {
    const r = { id: k.id, name: k.name, kind: k.kind, owner: k.ownerName, hint: hint(open(k.secret)), created: k.created };
    if (mine) {
      r.shared = !!k.shared;
      r.links = q.linkCount.get(k.id).n;
      r.usage = { total: q.usageTotal.get(k.id), days: q.usageDays.all(k.id, 60) };
    }
    return r;
  };
  /* A user may run on a key they own or one they have linked to. */
  const canUse = (userId, k) => !!k && (k.owner === userId || (k.shared && !!q.linkHas.get(userId, k.id)));
  /* The key a user's calls run on: null when there is none, or it has
     been taken away since they picked it. */
  const activeKey = u => { const k = u.active_key ? q.keyById.get(u.active_key) : null; return canUse(u.id, k) ? k : null; };
  /* A key as a call runs on it: its kind and value, with its public face. */
  const credential = k => ({ kind: k.kind, value: open(k.secret), key: publicKey(k, false) });
  const publicUser = u => {
    const k = activeKey(u);
    return { id: u.id, name: u.name, key: k ? publicKey(k, false) : null, admin: isAdmin(u) };
  };

  return {
    invite,
    users: {
      create(name, password) {
        if (q.userByName.get(name)) throw new Error("That name is taken.");
        const r = q.userAdd.run(name, hashPassword(password), Date.now());
        return publicUser(q.userById.get(r.lastInsertRowid));
      },
      check(name, password) {
        const u = q.userByName.get(name);
        return u && checkPassword(password, u.pass) ? publicUser(u) : null;
      },
      /* The key a user's calls run on, as a call runs on it, and whether it
         is their own; null when there is none. */
      credential(id) {
        const u = q.userById.get(id), k = u && activeKey(u);
        return k ? { ...credential(k), own: k.owner === id } : null;
      }
    },
    /* A short signature with the server's secret, for tokens that need no row. */
    hmac: text => createHash("sha256").update(secret + ":" + String(text)).digest("hex"),
    keys: {
      /* Someone's shared key, for a guest who has no account to link it to:
         the name and password are checked on every call. */
      sharedCredential(name, password) {
        const k = q.keySharedNamed.get(name);
        return k && k.pass && checkPassword(password, k.pass) ? credential(k) : null;
      },
      /* One of a user's own keys, as a call runs on it: to ask its provider
         what is left on it. */
      own(userId, id) {
        const k = q.keyById.get(id);
        if (!k || k.owner !== userId) throw new Error("No such key of yours.");
        return credential(k);
      },
      /* Everything a user can see: their own keys in full, the shared keys
         they have linked to in brief, and the one they run on. */
      list(userId) {
        const k = activeKey(q.userById.get(userId));
        return { mine: q.keyMine.all(userId).map(k => publicKey(k, true)),
                 linked: q.linkMine.all(userId).map(k => publicKey(k, false)),
                 key: k ? publicKey(k, false) : null };
      },
      /* kind is one agents.mjs knows. A shared key needs a password. A user
         with no key to run on runs on this one from now on. */
      create(userId, { name, kind, value, shared, password }) {
        if (q.keyMineNamed.get(userId, name)) throw new Error("You already have a key called that.");
        if (shared && q.keySharedNamed.get(name)) throw new Error("A shared key with that name already exists. Pick another name.");
        const r = q.keyAdd.run(userId, name, kind, seal(value), shared ? 1 : 0, shared ? hashPassword(password) : null, Date.now());
        if (!activeKey(q.userById.get(userId))) q.userActive.run(r.lastInsertRowid, userId);
        return publicKey(q.keyById.get(r.lastInsertRowid), true);
      },
      /* Rename, share or unshare, or set a new password. A new password,
         or unsharing, takes the key away from everyone linked to it. */
      update(userId, id, { name, shared, password }) {
        const k = q.keyById.get(id);
        if (!k || k.owner !== userId) throw new Error("No such key of yours.");
        const newName = name == null ? k.name : name;
        const nowShared = shared == null ? !!k.shared : !!shared;
        if (newName !== k.name && q.keyMineNamed.get(userId, newName)) throw new Error("You already have a key called that.");
        if (nowShared) {
          const other = q.keySharedNamed.get(newName);
          if (other && other.id !== k.id) throw new Error("A shared key with that name already exists. Pick another name.");
          if (!k.pass && !password) throw new Error("A shared key needs a password.");
        }
        const revoke = (nowShared && password) || (!nowShared && k.shared);
        q.keySet.run(newName, nowShared ? 1 : 0, nowShared ? (password ? hashPassword(password) : k.pass) : null, id);
        if (revoke) { q.linkDelKey.run(id); q.userClearActiveExcept.run(id, userId); }
        return publicKey(q.keyById.get(id), true);
      },
      delete(userId, id) {
        const k = q.keyById.get(id);
        if (!k || k.owner !== userId) throw new Error("No such key of yours.");
        q.linkDelKey.run(id); q.usageDel.run(id); q.userClearActive.run(id); q.keyDel.run(id);
      },
      /* Link to someone's shared key by its exact name and password. */
      link(userId, name, password) {
        const k = q.keySharedNamed.get(name);
        if (!k || !k.pass || !checkPassword(password, k.pass)) throw new Error("No shared key with that name and password.");
        if (k.owner === userId) throw new Error("That key is your own.");
        q.linkAdd.run(userId, k.id, Date.now());
        if (!activeKey(q.userById.get(userId))) q.userActive.run(k.id, userId);
        return publicKey(k, false);
      },
      unlink(userId, id) {
        q.linkDel.run(userId, id);
        if (q.userById.get(userId).active_key === id) q.userActive.run(null, userId);
      },
      /* Which key this user's calls run on. */
      activate(userId, id) {
        if (!canUse(userId, q.keyById.get(id))) throw new Error("That key isn't yours to use.");
        q.userActive.run(id, userId);
      },
      /* A finished call, added to the key's day. */
      addUsage(id, u) {
        q.usageAdd.run(id, today(), u.in || 0, u.out || 0, u.searches || 0, u.cost || 0);
      }
    },
    sessions: {
      create(userId) {
        const token = randomBytes(32).toString("base64url");
        q.sessAdd.run(hashToken(token), userId, Date.now());
        return token;
      },
      user(token) { const u = token && q.sessUser.get(hashToken(token)); return u ? publicUser(u) : null; },
      delete(token) { if (token) q.sessDel.run(hashToken(token)); }
    },
    kv: {
      get(user, k) { const r = q.kvGet.get(user, k); return r ? r.v : null; },
      set(user, k, v) { q.kvSet.run(user, k, v, Date.now()); },
      del(user, k) { q.kvDel.run(user, k); },
    },
    shares: {
      /* body is the primer as JSON text; doc is the id it was made from,
         so its links can be listed together. Sharing the same text twice
         gives the same link back rather than a second one. */
      create(user, doc, title, body, media) {
        const hash = createHash("sha256").update(body).digest("hex");
        const last = q.shareLast.get(user, doc);
        if (last && last.hash === hash) return { id: last.id, created: last.created, reused: true };
        const id = randomBytes(9).toString("base64url"), created = Date.now();
        q.shareAdd.run(id, user, doc, title, hash, body, created);
        for (const name of media) q.shareMediaAdd.run(id, name);
        return { id, created, reused: false };
      },
      /* One live link per primer: the same one back each time it is asked for. */
      live(user, doc, title) {
        const r = q.shareLive.get(user, doc);
        if (r) return { id: r.id, created: r.created, live: true, reused: true };
        const id = randomBytes(9).toString("base64url"), created = Date.now();
        q.shareAddLive.run(id, user, doc, title, created);
        return { id, created, live: true, reused: false };
      },
      get(id) {
        const r = q.shareGet.get(id);
        return r ? { id: r.id, by: r.by, title: r.title, created: r.created, body: r.body, live: !!r.live, user: r.user, doc: r.doc } : null;
      },
      list(user, doc) { return q.shareList.all(user, doc).map(r => ({ id: r.id, created: r.created, live: !!r.live })); },
      /* The image files a live link shows right now, so its readers can load them. */
      media(id, names) { for (const name of names) q.shareMediaAdd.run(id, name); },
      delete(user, id) {
        const r = q.shareDel.run(id, user);
        if (r.changes) q.shareMediaDel.run(id);
        return !!r.changes;
      },
      /* Whether any share, by anyone, shows this image file. */
      mediaShared(name) { return !!q.shareMediaHas.get(name); }
    },
    /* ── feedback: a word from a reader to whoever hosts, with where it came from ── */
    feedback: {
      add(user, name, kind, text, ctx) { q.fbAdd.run(user, name, kind, text, JSON.stringify(ctx || {}), Date.now()); },
      list(n) {
        return q.fbList.all(n).map(r => {
          let ctx = {}; try { ctx = JSON.parse(r.ctx); } catch {}
          return { id: r.id, name: r.name, kind: r.kind, text: r.text, where: ctx, created: r.created };
        });
      }
    }
  };
}
