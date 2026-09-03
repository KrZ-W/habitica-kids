/*
 * Turn one dictated sentence into a chore.
 *
 * Built for Siri / Shortcuts, where you get a single blob of speech rather than
 * neat fields. Deterministic (no LLM): it pulls out the person, the difficulty
 * and the repeat days, and whatever is left becomes the chore text.
 *
 *   "ajouter pour Arthur ranger sa chambre difficile le lundi et mercredi"
 *     → { who: "Arthur", text: "Ranger sa chambre", difficulty: "hard",
 *         days: "m,w", action: "add" }
 */
const DIFFICULTY_WORDS = {
  trivial: ["trivial", "triviale", "facile facile"],
  easy: ["facile", "easy", "simple"],
  medium: ["moyen", "moyenne", "medium", "normal"],
  hard: ["difficile", "dur", "dure", "hard", "exigeant"]
};

const DAY_WORDS = {
  su: ["dimanche", "sunday"],
  m: ["lundi", "monday"],
  t: ["mardi", "tuesday"],
  w: ["mercredi", "wednesday"],
  th: ["jeudi", "thursday"],
  f: ["vendredi", "friday"],
  s: ["samedi", "saturday"]
};

const GROUP_WORDS = {
  "weekdays": ["en semaine", "la semaine", "jours d'école", "jours d ecole", "weekdays", "school days"],
  "weekend": ["fin de semaine", "week-end", "weekend"],
  "daily": ["tous les jours", "chaque jour", "quotidien", "quotidienne", "every day", "daily"]
};

const REMOVE_WORDS = ["enlever", "enleve", "supprimer", "supprime", "retirer", "retire", "efface", "effacer", "remove", "delete"];
const LIST_WORDS = ["liste", "lister", "montre", "montrer", "affiche", "quelles", "list", "show"];
const HOUSE_WORDS = ["maison", "menage", "ménage", "familiale", "partagee", "partagée", "household", "house", "shared"];
const EVERYONE_WORDS = ["tout le monde", "toute la famille", "chacun", "everyone", "all kids", "les enfants", "tous les enfants"];

const strip = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Normalise while remembering where each character came from, so a match in the
// normalised text can be removed from the ORIGINAL text.
function normMap(str) {
  let norm = "";
  const idx = [];
  for (let i = 0; i < str.length; i++) {
    const c = strip(str[i]);
    for (const ch of c) { norm += ch; idx.push(i); }
  }
  idx.push(str.length);
  return { norm, idx };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Remove `needle` from the sentence as a WHOLE WORD (accent-insensitive).
// Substring matching would find "thu" inside "Arthur" and "mon" inside "monde".
function cut(hay, needle) {
  const { norm, idx } = normMap(String(hay));
  const n = strip(needle).trim();
  if (!n) return null;
  const re = new RegExp("(^|[^a-z0-9])" + escapeRe(n).replace(/\s+/g, "\\s+") + "($|[^a-z0-9])", "i");
  const m = re.exec(norm);
  if (!m) return null;
  const start = m.index + m[1].length;
  const end = start + (m[0].length - m[1].length - m[2].length);
  const out = String(hay).slice(0, idx[start]) + " " + String(hay).slice(idx[end]);
  return out.replace(/\s+/g, " ").trim();
}

function parseSentence(sentence, people = []) {
  let rest = String(sentence || "").trim();
  const out = { action: "add", who: null, everyone: false, house: false, difficulty: null, days: null, text: "" };
  const s0 = strip(rest);

  // what to do
  if (REMOVE_WORDS.some((w) => s0.includes(w))) out.action = "remove";
  else if (LIST_WORDS.some((w) => s0.startsWith(w) || s0.includes(" " + w + " "))) out.action = "list";
  for (const w of [...REMOVE_WORDS, ...LIST_WORDS, "ajouter", "ajoute", "add", "nouvelle tache", "nouvelle tâche", "une tache", "une tâche", "tache", "tâche"]) {
    const r = cut(rest, w); if (r !== null) rest = r;
  }

  // household chore?
  for (const w of HOUSE_WORDS) {
    const r = cut(rest, "de " + w) ?? cut(rest, w);
    if (r !== null) { out.house = true; rest = r; break; }
  }

  // days — named groups first, then individual days
  for (const [spec, words] of Object.entries(GROUP_WORDS)) {
    let hit = false;
    for (const w of words) {
      const r = cut(rest, w);
      if (r !== null) { out.days = spec; rest = r; hit = true; break; }
    }
    if (hit) break;
  }
  if (!out.days) {
    const found = [];
    for (const [code, words] of Object.entries(DAY_WORDS)) {
      for (const w of words) {
        const r = cut(rest, w);
        if (r !== null) { found.push(code); rest = r; break; }
      }
    }
    if (found.length) out.days = found.join(",");
  }

  // who
  for (const w of EVERYONE_WORDS) {
    const r = cut(rest, w);
    if (r !== null) { out.everyone = true; rest = r; break; }
  }
  if (!out.everyone) {
    for (const p of people) {
      const r = cut(rest, "pour " + p) ?? cut(rest, "a " + p) ?? cut(rest, "à " + p) ?? cut(rest, p);
      if (r !== null) { out.who = p; rest = r; break; }
    }
  }

  // difficulty
  for (const [level, words] of Object.entries(DIFFICULTY_WORDS)) {
    let hit = false;
    for (const w of words) {
      const r = cut(rest, w);
      if (r !== null) { out.difficulty = level; rest = r; hit = true; break; }
    }
    if (hit) break;
  }

  // tidy leftovers ("le", "les", "et", "the", stray punctuation)
  rest = rest.replace(/[.,;!?]+/g, " ").replace(/\s+/g, " ").trim();
  // strip leading/trailing filler only — keep articles inside the chore itself
  rest = rest.replace(/^(?:\b(?:le|la|les|de|du|des|et|and|on|the|a|à|pour)\b\s*)+/i, "")
             .replace(/(?:\s*\b(?:le|la|les|de|du|des|et|and|on|the)\b)+$/i, "")
             .trim();
  out.text = rest.charAt(0).toUpperCase() + rest.slice(1);
  return out;
}

module.exports = { parseSentence };
