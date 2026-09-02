#!/usr/bin/env node
/*
 * chores — manage the family's Habitica chores from the command line.
 * Designed to be easy for a human OR an AI agent to drive.
 *
 *   chores list [--who felix] [--type daily|todo|reward] [--all]
 *   chores add "🧹 Ranger sa chambre" --who arthur [--difficulty medium] [--days mon,wed] [--notes "..."]
 *   chores add "🧹 Ranger" --everyone [--except alex]
 *   chores update "Ranger" --who arthur [--text "..."] [--difficulty hard] [--days weekdays]
 *   chores remove "Ranger" --who arthur
 *   chores house list
 *   chores house add "🍽️ Vider le lave-vaisselle" [--days daily] [--assign felix,emile]
 *   chores house remove "lave-vaisselle"
 *
 * Output is human-readable by default, or JSON with --json (handy for agents).
 */
const C = require("../lib/chores");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const USAGE = `chores — manage family Habitica chores

  list                        [--who NAME] [--type daily|todo|reward] [--all] [--json]
  add "TEXT"  --who NAME      [--difficulty trivial|easy|medium|hard] [--days SPEC] [--notes T] [--type todo|reward] [--value N]
  add "TEXT"  --everyone      [--except a,b]  (same options)
  update "TEXT|ID" --who NAME [--text NEW] [--difficulty D] [--days SPEC] [--notes T]
  remove "TEXT|ID" --who NAME
  house list | house add "TEXT" [--days SPEC] [--assign a,b] | house remove "TEXT"

  --days: mon,wed,fri | weekdays | weekend | daily   (French names work too)
  --json: machine-readable output`;

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  const cfg = C.loadConfig(args.config);
  const json = !!args.json;
  const show = (v) => console.log(json ? JSON.stringify(v, null, 2) : v);

  const listSplit = (v) => String(v || "").split(/[,\s]+/).filter(Boolean);

  try {
    switch (cmd) {
      case "list": {
        const rows = await C.listChores(cfg, { who: args.who, type: args.type || "daily", includeCompleted: !!args.all });
        if (json) return show(rows);
        if (!rows.length) return console.log("(aucune tâche)");
        let person = null;
        for (const r of rows) {
          if (r.person !== person) { person = r.person; console.log(`\n${person}`); }
          console.log(`  ${r.completed ? "☑" : "☐"} ${r.text}   [${r.difficulty}${r.days ? ", " + r.days : ""}]  ${r.id.slice(0, 8)}`);
        }
        return;
      }
      case "add": {
        const text = rest[0];
        const opts = { text, type: args.type || "daily", difficulty: args.difficulty || "easy", days: args.days, notes: args.notes, value: args.value };
        if (args.everyone) {
          const except = listSplit(args.except).map((s) => s.toLowerCase());
          const people = cfg.members.map((m) => m.name).filter((n) => !except.includes(n.toLowerCase()));
          const res = await C.addChoreForAll(cfg, { ...opts, people });
          return show(json ? res : res.map((r) => (r.error ? `✗ ${r.person}: ${r.error}` : `✓ ${r.person}: ${r.text}`)).join("\n"));
        }
        const res = await C.addChore(cfg, { ...opts, who: args.who });
        return show(json ? res : `✓ ${res.person}: ${res.text}  [${res.difficulty}${res.days ? ", " + res.days : ""}]`);
      }
      case "update": {
        const res = await C.updateChore(cfg, {
          who: args.who, task: rest[0], text: args.text,
          difficulty: args.difficulty, days: args.days, notes: args.notes, value: args.value
        });
        return show(json ? res : `✓ ${res.person}: ${res.text}  [${res.difficulty}${res.days ? ", " + res.days : ""}]`);
      }
      case "remove": case "rm": case "delete": {
        const res = await C.removeChore(cfg, { who: args.who, task: rest[0] });
        return show(json ? res : `✓ supprimé pour ${res.person}: ${res.removed}`);
      }
      case "house": {
        const sub = rest[0];
        if (sub === "list" || !sub) {
          const rows = await C.listHouseChores(cfg);
          if (json) return show(rows);
          if (!rows.length) return console.log("(aucune tâche de maison)");
          rows.forEach((r) => console.log(`  ${r.completed ? "☑" : "☐"} ${r.text}   [${r.difficulty}${r.days ? ", " + r.days : ""}] → ${r.assigned.join(", ") || "personne"}`));
          return;
        }
        if (sub === "add") {
          const res = await C.addHouseChore(cfg, { text: rest[1], difficulty: args.difficulty || "easy", days: args.days, assignTo: listSplit(args.assign) });
          return show(json ? res : `✓ maison: ${res.text} → ${res.assigned.join(", ")}`);
        }
        if (sub === "remove" || sub === "rm") {
          const res = await C.removeHouseChore(cfg, { task: rest[1] });
          return show(json ? res : `✓ supprimé de la maison: ${res.removed}`);
        }
        throw new Error("house: use list | add | remove");
      }
      case "help": case undefined: return console.log(USAGE);
      default: throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
    }
  } catch (e) {
    if (json) console.log(JSON.stringify({ error: e.message }));
    else console.error("✗ " + e.message);
    process.exit(1);
  }
})();
