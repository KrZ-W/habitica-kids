/*
 * Shared chore-management core — used by the CLI (bin/chores.js) and the MCP
 * server (mcp-server.js). Everything an agent needs to add / list / change /
 * remove chores for a family, including shared household chores on a party.
 */
const fs = require("fs");
const path = require("path");

const X_CLIENT = "habitica-kids";

const DIFFICULTY = { trivial: 0.1, easy: 1, medium: 1.5, hard: 2 };
const DAYS = { sun: "su", mon: "m", tue: "t", wed: "w", thu: "th", fri: "f", sat: "s" };
const DAY_ALIASES = {
  su: "su", sun: "su", sunday: "su", dim: "su", dimanche: "su",
  m: "m", mon: "m", monday: "m", lun: "m", lundi: "m",
  t: "t", tue: "t", tues: "t", tuesday: "t", mar: "t", mardi: "t",
  w: "w", wed: "w", wednesday: "w", mer: "w", mercredi: "w",
  th: "th", thu: "th", thurs: "th", thursday: "th", jeu: "th", jeudi: "th",
  f: "f", fri: "f", friday: "f", ven: "f", vendredi: "f",
  s: "s", sat: "s", saturday: "s", sam: "s", samedi: "s"
};

function loadConfig(configPath) {
  const p = configPath || process.env.HK_CONFIG || path.join(__dirname, "..", "config.json");
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.apiBase = String(cfg.apiBase || "https://habitica.com/api/v3").replace(/\/+$/, "");
  cfg.members = Array.isArray(cfg.members) ? cfg.members : [];
  return cfg;
}

const headers = (u) => ({
  "x-api-user": u.userId, "x-api-key": u.apiToken,
  "x-client": X_CLIENT, "content-type": "application/json"
});

async function api(cfg, pathname, user, init = {}) {
  const res = await fetch(cfg.apiBase + pathname, { ...init, headers: headers(user) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const detail = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return json;
}

/** Resolve a person by name (case/accent-insensitive) or userId. */
function findMember(cfg, who) {
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const n = norm(who);
  const m = cfg.members.find((x) => norm(x.name) === n || x.userId === who);
  if (!m) {
    throw new Error(`unknown person "${who}". Known: ${cfg.members.map((x) => x.name).join(", ")}`);
  }
  return m;
}

/** "mon,wed,fri" | "weekdays" | "daily" → Habitica repeat object */
function parseDays(spec) {
  if (!spec) return null;
  const s = String(spec).trim().toLowerCase();
  const all = { su: false, m: false, t: false, w: false, th: false, f: false, s: false };
  if (s === "daily" || s === "everyday" || s === "tous") return { su: true, m: true, t: true, w: true, th: true, f: true, s: true };
  if (s === "weekdays" || s === "semaine") return { ...all, m: true, t: true, w: true, th: true, f: true };
  if (s === "weekend" || s === "fin de semaine") return { ...all, su: true, s: true };
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const key = DAY_ALIASES[part];
    if (!key) throw new Error(`unknown day "${part}"`);
    all[key] = true;
  }
  return all;
}

const shape = (t) => ({
  id: t.id || t._id,
  text: t.text,
  type: t.type,
  notes: t.notes || "",
  difficulty: Object.keys(DIFFICULTY).find((k) => DIFFICULTY[k] === t.priority) || String(t.priority),
  completed: !!t.completed,
  isDue: t.isDue !== false,
  days: t.repeat ? Object.entries(t.repeat).filter(([, v]) => v).map(([d]) => d).join(",") : null,
  value: t.type === "reward" ? t.value : undefined
});

/* ---------- operations ---------- */

async function listChores(cfg, { who, type = "daily", includeCompleted = false } = {}) {
  const targets = who ? [findMember(cfg, who)] : cfg.members;
  const out = [];
  for (const m of targets) {
    const j = await api(cfg, `/tasks/user${type ? "?type=" + (type === "daily" ? "dailys" : type + "s") : ""}`, m);
    for (const t of j.data || []) {
      if (!includeCompleted && t.completed) continue;
      out.push({ person: m.name, ...shape(t) });
    }
  }
  return out;
}

async function addChore(cfg, { who, text, type = "daily", difficulty = "easy", days, notes, value }) {
  if (!text) throw new Error("text is required");
  const m = findMember(cfg, who);
  const body = { text, type, notes: notes || "" };
  if (type !== "reward") {
    if (!(difficulty in DIFFICULTY)) throw new Error(`difficulty must be one of ${Object.keys(DIFFICULTY).join(", ")}`);
    body.priority = DIFFICULTY[difficulty];
  }
  if (type === "reward") body.value = Number(value || 0);
  const repeat = parseDays(days);
  if (repeat && type === "daily") { body.frequency = "weekly"; body.everyX = 1; body.repeat = repeat; }
  const j = await api(cfg, "/tasks/user", m, { method: "POST", body: JSON.stringify(body) });
  return { person: m.name, ...shape(j.data) };
}

/** Find a task by id, or by (fuzzy) text for a given person. */
async function resolveTask(cfg, { who, task }) {
  const m = findMember(cfg, who);
  const j = await api(cfg, "/tasks/user", m);
  const all = j.data || [];
  let hit = all.find((t) => (t.id || t._id) === task);
  if (!hit) {
    const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const q = norm(task);
    const matches = all.filter((t) => norm(t.text).includes(q));
    if (matches.length > 1) {
      throw new Error(`"${task}" matches ${matches.length} tasks for ${m.name}: ${matches.map((t) => t.text).join(" | ")}`);
    }
    hit = matches[0];
  }
  if (!hit) throw new Error(`no task matching "${task}" for ${m.name}`);
  return { member: m, task: hit };
}

async function updateChore(cfg, { who, task, text, difficulty, days, notes, value }) {
  const { member, task: t } = await resolveTask(cfg, { who, task });
  const body = {};
  if (text) body.text = text;
  if (notes !== undefined) body.notes = notes;
  if (value !== undefined) body.value = Number(value);
  if (difficulty) {
    if (!(difficulty in DIFFICULTY)) throw new Error(`difficulty must be one of ${Object.keys(DIFFICULTY).join(", ")}`);
    body.priority = DIFFICULTY[difficulty];
  }
  const repeat = parseDays(days);
  if (repeat) { body.frequency = "weekly"; body.everyX = 1; body.repeat = repeat; }
  if (!Object.keys(body).length) throw new Error("nothing to change");
  const j = await api(cfg, `/tasks/${t.id || t._id}`, member, { method: "PUT", body: JSON.stringify(body) });
  return { person: member.name, ...shape(j.data) };
}

async function removeChore(cfg, { who, task }) {
  const { member, task: t } = await resolveTask(cfg, { who, task });
  await api(cfg, `/tasks/${t.id || t._id}`, member, { method: "DELETE" });
  return { person: member.name, removed: t.text, id: t.id || t._id };
}

/** Same chore for several people at once (e.g. all the kids). */
async function addChoreForAll(cfg, opts) {
  const people = opts.people && opts.people.length ? opts.people : cfg.members.map((m) => m.name);
  const out = [];
  for (const who of people) {
    try { out.push(await addChore(cfg, { ...opts, who })); }
    catch (e) { out.push({ person: who, error: e.message }); }
  }
  return out;
}

/* ---------- shared / household chores (party group tasks) ---------- */

async function listHouseChores(cfg) {
  if (!cfg.party || !cfg.party.id) throw new Error("no party configured");
  const cred = { userId: cfg.party.userId, apiToken: cfg.party.apiToken };
  const j = await api(cfg, `/tasks/group/${cfg.party.id}`, cred);
  const byId = Object.fromEntries(cfg.members.map((m) => [m.userId, m.name]));
  return (j.data || []).map((t) => ({
    ...shape(t),
    assigned: ((t.group || {}).assignedUsers || []).map((u) => byId[u] || u)
  }));
}

async function addHouseChore(cfg, { text, difficulty = "easy", days, assignTo }) {
  if (!cfg.party || !cfg.party.id) throw new Error("no party configured");
  const cred = { userId: cfg.party.userId, apiToken: cfg.party.apiToken };
  const body = { text, type: "daily", priority: DIFFICULTY[difficulty] || 1 };
  const repeat = parseDays(days);
  if (repeat) { body.frequency = "weekly"; body.everyX = 1; body.repeat = repeat; }
  const j = await api(cfg, `/tasks/group/${cfg.party.id}`, cred, { method: "POST", body: JSON.stringify(body) });
  const id = j.data.id || j.data._id;
  const people = (assignTo && assignTo.length ? assignTo : cfg.members.map((m) => m.name))
    .map((n) => findMember(cfg, n).userId);
  // NB: this endpoint takes a bare JSON array, not an object
  await api(cfg, `/tasks/${id}/assign`, cred, { method: "POST", body: JSON.stringify(people) });
  return { ...shape(j.data), assigned: people.map((u) => (cfg.members.find((m) => m.userId === u) || {}).name) };
}

async function removeHouseChore(cfg, { task }) {
  if (!cfg.party || !cfg.party.id) throw new Error("no party configured");
  const cred = { userId: cfg.party.userId, apiToken: cfg.party.apiToken };
  const j = await api(cfg, `/tasks/group/${cfg.party.id}`, cred);
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hit = (j.data || []).find((t) => (t.id || t._id) === task || norm(t.text).includes(norm(task)));
  if (!hit) throw new Error(`no household chore matching "${task}"`);
  await api(cfg, `/tasks/${hit.id || hit._id}`, cred, { method: "DELETE" });
  return { removed: hit.text };
}

module.exports = {
  loadConfig, findMember, parseDays, DIFFICULTY,
  listChores, addChore, addChoreForAll, updateChore, removeChore,
  listHouseChores, addHouseChore, removeHouseChore
};
