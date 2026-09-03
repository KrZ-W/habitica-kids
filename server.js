#!/usr/bin/env node
/*
 * habitica-kids — a tiny, kid-friendly web client for Habitica.
 *
 * Why it exists: the official apps are single-account (switching users means
 * logging out and back in) and show the full RPG UI. This serves one page where
 * a child taps their face, sees today's chores as big pictogram tiles, and taps
 * one to complete it.
 *
 * The family is DISCOVERED, not hardcoded: members come from the configured
 * party (and/or explicitly listed accounts) in config.json.
 *
 * API tokens never reach the browser — the browser talks to this server, the
 * server talks to Habitica.
 *
 * No dependencies: Node 18+ (global fetch) and the standard library only.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { sendMail } = require("./notify");
const CH = require("./lib/chores");
const { parseSentence } = require("./lib/parse");

const CONFIG_PATH = process.env.HK_CONFIG || path.join(__dirname, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  cfg.apiBase = String(cfg.apiBase || "https://habitica.com/api/v3").replace(/\/+$/, "");
  cfg.port = cfg.port || 3001;
  cfg.members = Array.isArray(cfg.members) ? cfg.members : [];
  cfg.memberTTL = (cfg.memberCacheSeconds != null ? cfg.memberCacheSeconds : 300) * 1000;
  cfg.hide = Array.isArray(cfg.hideMembers) ? cfg.hideMembers : [];
  // When set, the real Habitica web app is proxied on this same origin so a
  // member can be logged straight into it (see /open).
  cfg.shortcutToken = cfg.shortcutToken || "";  // shared secret for Siri Shortcuts
  cfg.parentPin = cfg.parentPin ? String(cfg.parentPin) : "";   // gate the parent page
  cfg.parentSessionMinutes = cfg.parentSessionMinutes || 30;
  cfg.habiticaOrigin = cfg.habiticaOrigin || "";
  cfg.proxyHabitica = !!cfg.habiticaOrigin;
  return cfg;
}
let config = loadConfig();

const CDN = "https://habitica-assets.s3.amazonaws.com/mobileApp/images/";
const X_CLIENT = "habitica-kids";

const authHeaders = (u) => ({
  "x-api-user": u.userId,
  "x-api-key": u.apiToken,
  "x-client": X_CLIENT
});

async function api(pathname, user, init = {}) {
  const res = await fetch(config.apiBase + pathname, {
    ...init,
    headers: { ...authHeaders(user), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

/* ---------- family discovery ---------- */

// Build the ordered list of members: the party roster (if a party is
// configured) plus any explicitly-listed accounts, de-duplicated by userId.
let membersCache = { ts: 0, list: [] };

async function getMembers(force = false) {
  if (!force && Date.now() - membersCache.ts < config.memberTTL && membersCache.list.length) {
    return membersCache.list;
  }
  const byId = new Map();
  // explicit accounts first — these carry credentials
  for (const m of config.members) {
    if (!m.userId || !m.apiToken) continue;
    byId.set(m.userId, { userId: m.userId, apiToken: m.apiToken, name: m.name || null, avatar: null, lvl: null });
  }
  // enrich/extend from the party roster
  if (config.party && config.party.id) {
    const cred = config.party.userId && config.party.apiToken
      ? { userId: config.party.userId, apiToken: config.party.apiToken }
      : config.members[0];
    if (cred) {
      try {
        const j = await api(`/groups/${config.party.id}/members?includeAllPublicFields=true`, cred);
        for (const m of j.data || []) {
          const known = byId.get(m._id);
          const name = (m.profile && m.profile.name) || (m.auth && m.auth.local && m.auth.local.username) || "?";
          const info = {
            userId: m._id,
            apiToken: known ? known.apiToken : null, // no creds => view-only
            name: (known && known.name) || name,
            avatar: buildAvatarLayers(m.preferences || {}, ((m.items || {}).gear || {}).equipped || {}),
            lvl: (m.stats && m.stats.lvl) != null ? m.stats.lvl : null
          };
          byId.set(m._id, { ...(known || {}), ...info });
        }
      } catch (e) {
        console.error("[habitica-kids] party roster fetch failed:", e.message);
      }
    }
  }
  let list = [...byId.values()].filter((m) => m.apiToken); // only tappable accounts
  const hide = config.hide.map((h) => String(h).toLowerCase());
  list = list.filter((m) => !hide.includes(String(m.name).toLowerCase()) && !hide.includes(m.userId));
  if (Array.isArray(config.order) && config.order.length) {
    const ix = (n) => { const i = config.order.findIndex((o) => String(o).toLowerCase() === String(n).toLowerCase()); return i < 0 ? 999 : i; };
    list.sort((a, b) => ix(a.name) - ix(b.name));
  }
  // fill in avatars for explicit members not in the party
  for (const m of list) {
    if (m.avatar) continue;
    try {
      const j = await api("/user?userFields=stats,preferences,items.gear.equipped", m);
      const d = j.data || {};
      m.avatar = buildAvatarLayers(d.preferences || {}, ((d.items || {}).gear || {}).equipped || {});
      if (m.lvl == null && d.stats) m.lvl = d.stats.lvl;
      if (!m.name && d.profile) m.name = d.profile.name;
    } catch (e) { /* leave avatar null */ }
  }
  membersCache = { ts: Date.now(), list };
  return list;
}

function buildAvatarLayers(prefs, gear) {
  const size = prefs.size || "slim";
  const skin = prefs.skin || "915533";
  const shirt = prefs.shirt || "blue";
  const hair = prefs.hair || {};
  const hc = hair.color || "red";
  const out = [];
  const add = (k) => out.push(CDN + k + ".png");
  const worn = (k) => k && !/_base_0$/.test(k);
  add(`skin_${skin}`);
  add(`${size}_shirt_${shirt}`);
  if (worn(gear.armor)) add(`${size}_${gear.armor}`);
  add("head_0");
  if (hair.base) add(`hair_base_${hair.base}_${hc}`);
  if (hair.bangs) add(`hair_bangs_${hair.bangs}_${hc}`);
  if (worn(gear.head)) add(gear.head);
  if (worn(gear.eyewear)) add(gear.eyewear);
  if (hair.flower) add(`hair_flower_${hair.flower}`);
  if (worn(gear.shield)) add(gear.shield);
  if (worn(gear.weapon)) add(gear.weapon);
  return out;
}

const memberById = async (id) => (await getMembers()).find((m) => m.userId === id);

/* ---------- reward redemptions (webhook) ---------- */

// Habitica fires a taskActivity/scored webhook when a reward is bought. We keep
// a small rolling log so the parent can be told (mirror + email).
const LOG_PATH = path.join(__dirname, "redemptions.json");
let redemptions = [];
try { redemptions = JSON.parse(fs.readFileSync(LOG_PATH, "utf8")); } catch (_) { redemptions = []; }
// backfill entries written before ids/fulfilled existed
let _migrated = false;
for (const r of redemptions) {
  if (!r.id) { r.id = Math.random().toString(36).slice(2, 10) + Date.parse(r.at || Date.now()).toString(36); _migrated = true; }
  if (r.fulfilled === undefined) { r.fulfilled = false; _migrated = true; }
}
if (_migrated) setImmediate(() => saveRedemptions());
const saveRedemptions = () => { try { fs.writeFileSync(LOG_PATH, JSON.stringify(redemptions.slice(0, 100), null, 2)); } catch (e) { console.error("[habitica-kids] cannot save redemptions:", e.message); } };

async function recordRedemption(payload) {
  const task = payload.task || {};
  const who = (await getMembers()).find((m) => m.userId === (payload.user && payload.user._id));
  const { icon, label } = splitEmoji(task.text || "");
  const entry = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    fulfilled: false,
    at: new Date().toISOString(),
    name: (who && who.name) || (payload.user && payload.user.profile && payload.user.profile.name) || "?",
    icon, label,
    cost: Math.round(task.value || 0),
    goldLeft: Math.floor(((payload.user || {}).stats || {}).gp || 0)
  };
  redemptions.unshift(entry);
  redemptions = redemptions.slice(0, 100);
  saveRedemptions();
  console.log(`[habitica-kids] redemption: ${entry.name} → ${entry.label} (${entry.cost} or)`);

  if (config.notify && config.notify.email && config.notify.email.to) {
    const when = new Date(entry.at).toLocaleString("fr-CA");
    sendMail(config.notify.email,
      `${entry.name} a échangé : ${entry.label}`,
      `${entry.name} vient d'échanger une récompense.\n\n` +
      `Récompense : ${entry.icon ? entry.icon + " " : ""}${entry.label}\n` +
      `Coût       : ${entry.cost} or\n` +
      `Or restant : ${entry.goldLeft}\n` +
      `Quand      : ${when}\n`
    ).catch((e) => console.error("[habitica-kids] email failed:", e.message));
  }
  return entry;
}

// Make sure every member has a webhook pointing back at us, so redemptions are
// reported without any manual setup. Idempotent.
async function ensureWebhooks() {
  if (!config.webhookUrl) return;
  for (const m of await getMembers()) {
    try {
      const existing = (await api("/user/webhook", m)).data || [];
      const mine = existing.find((w) => w.url === config.webhookUrl);
      if (mine) { if (mine.enabled) continue; await api(`/user/webhook/${mine.id}`, m, { method: "PUT", body: JSON.stringify({ enabled: true }) }); continue; }
      await api("/user/webhook", m, {
        method: "POST",
        body: JSON.stringify({
          url: config.webhookUrl, label: "habitica-kids", enabled: true, type: "taskActivity",
          options: { created: false, updated: false, deleted: false, scored: true, checklistScored: false }
        })
      });
      console.log(`[habitica-kids] webhook registered for ${m.name}`);
    } catch (e) {
      console.error(`[habitica-kids] webhook setup failed for ${m.name}: ${e.message}`);
    }
  }
}

/* ---------- chores ---------- */

function splitEmoji(text) {
  const t = (text || "").trim();
  // leading emoji (pictogram) used as the tile icon, rest is the label
  const m = t.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*(.*)$/u);
  return m ? { icon: m[1], label: m[2] || t } : { icon: null, label: t };
}

// Gold + the custom rewards this member can buy.
async function getRewards(member) {
  const [tasks, user] = await Promise.all([
    api("/tasks/user?type=rewards", member),
    api("/user?userFields=stats", member)
  ]);
  const gp = Math.floor((((user.data || {}).stats || {}).gp) || 0);
  const rewards = (tasks.data || []).map((t) => {
    const cost = Math.round(t.value || 0);
    return { id: t.id || t._id, ...splitEmoji(t.text), cost, affordable: gp >= cost };
  }).sort((a, b) => a.cost - b.cost);
  return { gold: gp, rewards };
}

// Turn Habitica's drop payload into something a kid can read.
function describeDrop(tmp) {
  if (!tmp) return null;
  const out = [];
  if (tmp.drop && (tmp.drop.dialog || tmp.drop.text)) {
    out.push(String(tmp.drop.dialog || tmp.drop.text));
  }
  const fd = tmp.firstDrops;
  if (fd) {
    const pretty = (s) => String(s).replace(/([a-z])([A-Z])/g, "$1 $2");
    if (fd.egg) out.push(`🥚 Œuf : ${pretty(fd.egg)}`);
    if (fd.hatchingPotion) out.push(`🧪 Potion : ${pretty(fd.hatchingPotion)}`);
    if (fd.food) out.push(`🍖 Nourriture : ${pretty(fd.food)}`);
    if (fd.quest) out.push(`📜 Quête : ${pretty(fd.quest)}`);
  }
  return out.length ? out.join(" · ") : null;
}

async function getChores(member) {
  const j = await api("/tasks/user", member);
  const tasks = j.data || [];
  const chores = tasks
    .filter((t) => (t.type === "daily" && t.isDue !== false) || t.type === "todo")
    .map((t) => ({
      id: t.id || t._id,
      type: t.type,
      ...splitEmoji(t.text),
      completed: !!t.completed
    }));
  // group (household) chores the member is assigned to
  if (config.party && config.party.id) {
    try {
      const g = await api(`/tasks/group/${config.party.id}`, member);
      for (const t of g.data || []) {
        if (t.type !== "daily" || t.isDue === false) continue;
        const grp = t.group || {};
        const detail = grp.assignedUsersDetail || {};
        if (!(grp.assignedUsers || []).includes(member.userId)) continue;
        chores.push({
          id: t.id || t._id,
          type: "group",
          ...splitEmoji(t.text),
          completed: !!(detail[member.userId] && detail[member.userId].completed)
        });
      }
    } catch (e) { /* group chores are optional */ }
  }
  return chores;
}

/* ---------- parent access (short PIN) ---------- */

const parentSessions = new Map(); // token -> expiry
function newParentSession() {
  const t = require("crypto").randomBytes(18).toString("hex");
  parentSessions.set(t, Date.now() + config.parentSessionMinutes * 60000);
  return t;
}
function isParent(req) {
  if (!config.parentPin) return true; // no PIN configured => open
  const m = /(?:^|;\s*)hk_parent=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const exp = parentSessions.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { parentSessions.delete(m[1]); return false; }
  return true;
}

/* ---------- http ---------- */

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// Reverse-proxy the real Habitica web app so it shares this origin. That's what
// makes "log this kid in and open the full app" possible: localStorage (where
// the web client keeps its session) is per-origin.
// A floating "back to the face picker" button, injected into proxied pages so
// kids can get out of the full Habitica app without a browser chrome/back key
// (there is none in kiosk / home-screen mode).
const BACK_BUTTON = `
<style>
#hk-back{position:fixed;left:14px;bottom:14px;z-index:2147483647;
  background:#1d283c;color:#f2f5fa;font:600 16px system-ui,sans-serif;
  border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:11px 18px;
  text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.45);opacity:.92}
#hk-back:active{transform:scale(.96)}
@media print{#hk-back{display:none}}
</style>
<a id="hk-back" href="/kids">← Retour</a>`;

function proxy(req, res) {
  const target = new URL(config.habiticaOrigin);
  const headers = { ...req.headers, host: target.host };
  delete headers["accept-encoding"]; // so we can inject into HTML responses
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: req.url,
    headers
  };
  const mod = target.protocol === "https:" ? require("https") : http;
  const up = mod.request(opts, (r) => {
    const type = String(r.headers["content-type"] || "");
    if (config.backButton !== false && /text\/html/i.test(type)) {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        body = body.includes("</body>")
          ? body.replace("</body>", BACK_BUTTON + "</body>")
          : body + BACK_BUTTON;
        const h = { ...r.headers };
        delete h["content-length"];
        delete h["content-encoding"];
        res.writeHead(r.statusCode, h);
        res.end(body);
      });
      return;
    }
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("upstream unavailable: " + e.message);
  });
  req.pipe(up);
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

const readBody = (req) => new Promise((resolve) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/_hk/members") {
      const list = await getMembers(url.searchParams.get("refresh") === "1");
      // never expose tokens to the browser
      return sendJSON(res, 200, { members: list.map((m) => ({ id: m.userId, name: m.name, avatar: m.avatar, lvl: m.lvl })) });
    }
    if (url.pathname === "/_hk/chores") {
      const m = await memberById(url.searchParams.get("member"));
      if (!m) return sendJSON(res, 404, { error: "unknown member" });
      return sendJSON(res, 200, { chores: await getChores(m) });
    }
    if (url.pathname === "/_hk/complete" && req.method === "POST") {
      const body = await readBody(req);
      const m = await memberById(body.member);
      if (!m || !body.task) return sendJSON(res, 400, { error: "member and task required" });
      const j = await api(`/tasks/${body.task}/score/up`, m, { method: "POST" });
      const d = (j && j.data) || {};
      const delta = d.delta != null ? Math.round(d.delta * 10) / 10 : null;
      return sendJSON(res, 200, {
        ok: true, lvl: d.lvl, exp: d.exp, gp: Math.floor(d.gp || 0), delta,
        drop: describeDrop(d._tmp)
      });
    }
    // Habitica webhook target (taskActivity/scored). We only care about rewards.
    if (url.pathname === "/_hk/hook" && req.method === "POST") {
      const body = await readBody(req);
      if (body && body.type === "scored" && body.task && body.task.type === "reward" && body.direction === "up") {
        await recordRedemption(body);
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (url.pathname === "/_hk/redemptions") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 100);
      const sinceH = parseFloat(url.searchParams.get("hours") || "0");
      let list = redemptions;
      // default view is what still has to be handed over
      if (url.searchParams.get("pending") !== "0") list = list.filter((r) => !r.fulfilled);
      else if (!isParent(req)) return sendJSON(res, 403, { error: "parent only" });
      if (sinceH > 0) {
        const cut = Date.now() - sinceH * 3600e3;
        list = list.filter((r) => Date.parse(r.at) >= cut);
      }
      return sendJSON(res, 200, { redemptions: list.slice(0, limit) });
    }
    // --- Siri / Shortcuts: one dictated sentence in, plain sentence out ---
    if (url.pathname === "/_hk/say") {
      const body = req.method === "POST" ? await readBody(req) : {};
      const token = body.token || url.searchParams.get("token") ||
        (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!config.shortcutToken || token !== config.shortcutToken) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        return res.end("Non autorisé");
      }
      const said = String(body.text || url.searchParams.get("text") || "").trim();
      const say = (msg, code = 200) => {
        res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(msg);
      };
      if (!said) return say("Je n'ai rien entendu.", 400);
      try {
        const chores = CH.loadConfig(CONFIG_PATH);
        const people = chores.members.map((m) => m.name);
        const p = parseSentence(said, people);

        if (p.action === "list") {
          const rows = await CH.listChores(chores, { who: p.who });
          if (!rows.length) return say(p.who ? `${p.who} n'a aucune tâche.` : "Aucune tâche.");
          const by = {};
          rows.forEach((r) => { (by[r.person] = by[r.person] || []).push(r.text); });
          return say(Object.entries(by).map(([n, t]) => `${n} : ${t.join(", ")}`).join(". "));
        }
        if (!p.text) return say("Je n'ai pas compris quelle tâche.", 400);

        if (p.action === "remove") {
          if (p.house) { const r = await CH.removeHouseChore(chores, { task: p.text }); return say(`Supprimé de la maison : ${r.removed}`); }
          if (!p.who) return say("Pour qui ? Précise un prénom.", 400);
          const r = await CH.removeChore(chores, { who: p.who, task: p.text });
          return say(`Supprimé pour ${r.person} : ${r.removed}`);
        }
        // add
        if (p.house) {
          const r = await CH.addHouseChore(chores, { text: p.text, difficulty: p.difficulty || "easy", days: p.days });
          return say(`Tâche de maison ajoutée : ${r.text}`);
        }
        if (p.everyone) {
          const r = await CH.addChoreForAll(chores, { text: p.text, difficulty: p.difficulty || "easy", days: p.days });
          const ok = r.filter((x) => !x.error).length;
          return say(`Ajouté pour ${ok} personnes : ${p.text}`);
        }
        if (!p.who) return say("Pour qui ? Précise un prénom.", 400);
        const r = await CH.addChore(chores, { who: p.who, text: p.text, difficulty: p.difficulty || "easy", days: p.days });
        return say(`Ajouté pour ${r.person} : ${r.text}`);
      } catch (e) {
        return say("Désolé : " + e.message, 400);
      }
    }
    if (url.pathname === "/_hk/parent-check") {
      return sendJSON(res, 200, { ok: isParent(req), pinRequired: !!config.parentPin });
    }
    if (url.pathname === "/_hk/parent-login" && req.method === "POST") {
      const body = await readBody(req);
      if (!config.parentPin || String(body.pin || "") !== config.parentPin) {
        return sendJSON(res, 401, { ok: false });
      }
      const t = newParentSession();
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `hk_parent=${t}; Path=/; Max-Age=${config.parentSessionMinutes * 60}; HttpOnly; SameSite=Lax`
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    // mark a redemption as handed over (or undo)
    if (url.pathname === "/_hk/fulfill" && req.method === "POST") {
      if (!isParent(req)) return sendJSON(res, 403, { error: "parent only" });
      const body = await readBody(req);
      const r = redemptions.find((x) => x.id === body.id);
      if (!r) return sendJSON(res, 404, { error: "unknown redemption" });
      r.fulfilled = body.undo ? false : true;
      r.fulfilledAt = r.fulfilled ? new Date().toISOString() : null;
      saveRedemptions();
      return sendJSON(res, 200, { ok: true, id: r.id, fulfilled: r.fulfilled });
    }
    if (url.pathname === "/_hk/rewards") {
      const m = await memberById(url.searchParams.get("member"));
      if (!m) return sendJSON(res, 404, { error: "unknown member" });
      return sendJSON(res, 200, await getRewards(m));
    }
    if (url.pathname === "/_hk/buy" && req.method === "POST") {
      const body = await readBody(req);
      const m = await memberById(body.member);
      if (!m || !body.reward) return sendJSON(res, 400, { error: "member and reward required" });
      try {
        await api(`/tasks/${body.reward}/score/up`, m, { method: "POST" });
      } catch (e) {
        // Habitica refuses when there isn't enough gold
        if (/gold|or\b|afford|assez/i.test(e.message)) return sendJSON(res, 200, { ok: false, reason: "not_enough_gold" });
        throw e;
      }
      const after = await getRewards(m);
      return sendJSON(res, 200, { ok: true, gold: after.gold });
    }
    // Hand off to the full Habitica web UI, already logged in as this member.
    // Only possible when Habitica is reachable on this same origin (see the
    // reverse proxy below) — localStorage is per-origin.
    if (url.pathname === "/open") {
      const m = await memberById(url.searchParams.get("member"));
      if (!m) { res.writeHead(404); return res.end("unknown member"); }
      const session = JSON.stringify({ auth: { apiId: m.userId, apiToken: m.apiToken } });
      const html = `<!doctype html><meta charset="utf-8"><title>Ouverture…</title>
<body style="background:#141c2b;color:#f2f5fa;font:18px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>Ouverture de Habitica…</p>
<script>
  localStorage.setItem('habit-mobile-settings', ${JSON.stringify(session)});
  location.replace('/');
</script></body>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    if (url.pathname.startsWith("/_hk/")) return sendJSON(res, 404, { error: "not found" });
    // Our own UI lives under /kids; everything else is the real Habitica.
    if (url.pathname === "/kids/parent.html" && !isParent(req)) {
      return serveStatic(req, res, "/parent-login.html");
    }
    if (url.pathname === "/kids" || url.pathname.startsWith("/kids/")) {
      return serveStatic(req, res, url.pathname.replace(/^\/kids\/?/, "/") || "/");
    }
    if (config.proxyHabitica) return proxy(req, res);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error("[habitica-kids]", err.message);
    return sendJSON(res, err.status && err.status < 500 ? err.status : 500, { error: err.message });
  }
});

server.listen(config.port, () => {
  console.log(`[habitica-kids] listening on :${config.port} → ${config.apiBase}`);
  if (config.webhookUrl) {
    ensureWebhooks().catch((e) => console.error("[habitica-kids] webhook setup:", e.message));
  }
});
