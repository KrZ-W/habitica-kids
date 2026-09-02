#!/usr/bin/env node
/*
 * MCP server for family chore management (stdio transport, no dependencies).
 *
 * Lets any MCP-capable agent — Claude Code, Claude Desktop, a personal
 * assistant bot — add / list / change / remove chores in plain language.
 *
 * Register it (Claude Code):
 *   claude mcp add chores -- node /opt/habitica-kids/mcp-server.js
 * or in a client's config:
 *   { "command": "node", "args": ["/opt/habitica-kids/mcp-server.js"],
 *     "env": { "HK_CONFIG": "/opt/habitica-kids/config.json" } }
 */
const C = require("./lib/chores");

const cfg = C.loadConfig(process.env.HK_CONFIG);
const PEOPLE = cfg.members.map((m) => m.name);

const DAYS_DESC =
  'Which days it repeats: a list like "mon,wed,fri", or "daily", "weekdays", "weekend". ' +
  "French day names work too. Omit to leave unchanged / every day.";
const DIFF = { type: "string", enum: ["trivial", "easy", "medium", "hard"], description: "Reward level: harder chores give more XP and gold." };

const TOOLS = [
  {
    name: "list_chores",
    description: "List chores for one family member or everyone. Use this first to see what exists before changing anything.",
    inputSchema: {
      type: "object",
      properties: {
        who: { type: "string", description: `Person's name (${PEOPLE.join(", ")}). Omit for everyone.` },
        type: { type: "string", enum: ["daily", "todo", "reward"], description: "daily = recurring chore (default), todo = one-off, reward = something to buy with gold." },
        includeCompleted: { type: "boolean", description: "Also show ones already done today." }
      }
    }
  },
  {
    name: "add_chore",
    description: "Add a chore for one person, or for everyone at once. Tip: start the text with an emoji (e.g. \"🪥 Brosser ses dents\") — it becomes the pictogram young children see.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The chore as it should appear, ideally starting with an emoji." },
        who: { type: "string", description: `Person's name (${PEOPLE.join(", ")}). Required unless everyone=true.` },
        everyone: { type: "boolean", description: "Add it to every family member." },
        except: { type: "array", items: { type: "string" }, description: "Names to skip when everyone=true." },
        type: { type: "string", enum: ["daily", "todo", "reward"], description: "Default daily." },
        difficulty: DIFF,
        days: { type: "string", description: DAYS_DESC },
        notes: { type: "string", description: "Optional extra detail." },
        value: { type: "number", description: "For type=reward: its price in gold." }
      },
      required: ["text"]
    }
  },
  {
    name: "update_chore",
    description: "Change an existing chore — rename it, change difficulty, or change which days it repeats.",
    inputSchema: {
      type: "object",
      properties: {
        who: { type: "string", description: `Whose chore (${PEOPLE.join(", ")}).` },
        task: { type: "string", description: "The chore to change: part of its text, or its id." },
        text: { type: "string", description: "New text." },
        difficulty: DIFF,
        days: { type: "string", description: DAYS_DESC },
        notes: { type: "string" },
        value: { type: "number", description: "For rewards: new gold price." }
      },
      required: ["who", "task"]
    }
  },
  {
    name: "remove_chore",
    description: "Delete a chore. This cannot be undone, so confirm with the user first if the match is ambiguous.",
    inputSchema: {
      type: "object",
      properties: {
        who: { type: "string", description: `Whose chore (${PEOPLE.join(", ")}).` },
        task: { type: "string", description: "Part of its text, or its id." }
      },
      required: ["who", "task"]
    }
  },
  {
    name: "list_house_chores",
    description: "List shared household chores (the ones anyone in the family can do).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "add_house_chore",
    description: "Add a shared household chore, assigned to several people so whoever gets to it first can complete it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The chore, ideally starting with an emoji." },
        difficulty: DIFF,
        days: { type: "string", description: DAYS_DESC },
        assignTo: { type: "array", items: { type: "string" }, description: `Who can do it (${PEOPLE.join(", ")}). Default: everyone.` }
      },
      required: ["text"]
    }
  },
  {
    name: "remove_house_chore",
    description: "Delete a shared household chore.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "Part of its text, or its id." } }, required: ["task"] }
  }
];

async function call(name, a = {}) {
  switch (name) {
    case "list_chores": return C.listChores(cfg, a);
    case "add_chore":
      if (a.everyone) {
        const except = (a.except || []).map((s) => String(s).toLowerCase());
        const people = PEOPLE.filter((n) => !except.includes(n.toLowerCase()));
        return C.addChoreForAll(cfg, { ...a, people });
      }
      if (!a.who) throw new Error("who is required (or set everyone: true)");
      return C.addChore(cfg, a);
    case "update_chore": return C.updateChore(cfg, a);
    case "remove_chore": return C.removeChore(cfg, a);
    case "list_house_chores": return C.listHouseChores(cfg);
    case "add_house_chore": return C.addHouseChore(cfg, a);
    case "remove_house_chore": return C.removeHouseChore(cfg, a);
    default: throw new Error(`unknown tool ${name}`);
  }
}

/* ---------- minimal MCP over stdio (JSON-RPC 2.0, line-delimited) ---------- */

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

let buf = "";
let pending = 0;       // in-flight tool calls
let draining = false;  // still working through buffered lines
let stdinEnded = false;
const maybeExit = () => { if (stdinEnded && !draining && pending === 0) process.exit(0); };

process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  if (draining) return;   // an earlier invocation is still consuming the buffer
  draining = true;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        reply(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "habitica-chores", version: "1.0.0" }
        });
      } else if (method === "tools/list") {
        reply(id, { tools: TOOLS });
      } else if (method === "tools/call") {
        pending++;
        try {
          const out = await call(params.name, params.arguments || {});
          reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
        } finally { pending--; maybeExit(); }
      } else if (method === "ping") {
        reply(id, {});
      } else if (id !== undefined) {
        fail(id, `unsupported method ${method}`);
      }
    } catch (e) {
      if (id !== undefined) {
        // report as tool output so the model can read and correct itself
        reply(id, { content: [{ type: "text", text: "Error: " + e.message }], isError: true });
      }
    }
  }
  draining = false;
  maybeExit();
});
// don't cut off work that's already running when the pipe closes
process.stdin.on("end", () => { stdinEnded = true; maybeExit(); });
