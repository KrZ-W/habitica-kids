# habitica-kids

A tiny, **kid-friendly web client for [Habitica](https://habitica.com)** — built for a
family tablet on the fridge.

Tap your face → see today's chores as big pictogram tiles → tap one to complete it.
Or tap **Habitica →** on a face to jump into the *full* Habitica web app **already
logged in as that person** — rewards shop, equipment, pets, drops and all.
No logins, no account switching, works on any device with a browser.

> **Why it exists.** The official Habitica apps are single-account: switching
> between family members means logging out and back in. They also show the full
> RPG interface, which is a lot for a 5-year-old. This is the missing piece — one
> screen, several kids, no passwords.

## Features

- **Multi-user, no logins.** Every family member is a face on the home screen;
  one tap switches. API tokens stay on the server and never reach the browser.
- **The family is discovered, not hardcoded.** Members come from your Habitica
  **party** (and/or accounts you list in the config), so adding a kid in Habitica
  adds them here.
- **Live avatars.** Each face is that member's actual Habitica character,
  composited from their current appearance and equipped gear — it changes as they
  level up and equip things (refreshed every `memberCacheSeconds`).
- **Pre-reader friendly.** A leading emoji in a task name (`🪥 Brosser ses dents`)
  becomes the tile's pictogram, so kids who can't read yet can still find their
  chores. Big touch targets, ⭐/🪙 burst and a "Bravo !" toast on completion.
- **Personal + household chores.** Shows a member's due Dailies and To-Dos, plus
  any **group/party chores** assigned to them (🏠).
- **Launcher into the real app.** Set `habiticaOrigin` and this also reverse-proxies
  your Habitica on the same origin, so a tap can write that member's session and
  open the complete web client as them. Everything the simple view doesn't cover
  (buying rewards, equipment, pets, item drops) is one tap away — no reimplementation.
  A floating **← Retour** button is injected into those pages so kids can get back
  to the picker without browser chrome (disable with `"backButton": false`).
- **Know when a reward is cashed in.** Registers a Habitica webhook per member,
  so redeeming a reward is logged (who / what / cost / gold left), optionally
  emailed, and exposed at `/_hk/redemptions` for other displays. A parent page at
  **`/kids/parent.html`** lists what still has to be handed over — tap *✓ Remis*
  and it clears everywhere.
- **Self-host friendly.** Point `apiBase` at your own Habitica instance.
- **No dependencies.** Node 18+ and the standard library. One file, ~250 lines.

## Install

```bash
git clone https://github.com/KrZ-W/habitica-kids.git
cd habitica-kids
cp config.example.json config.json   # then edit it
node server.js
```

Then open **`http://<host>:3001/kids`** — the face picker. When `habiticaOrigin`
is set, the real Habitica is served from `/` on the same port.

### config.json

```jsonc
{
  "port": 3001,
  "apiBase": "http://localhost:3000/api/v3",  // or https://habitica.com/api/v3
  "habiticaOrigin": "http://localhost:3000",   // optional: proxy the real web app
                                               // here, enabling the "Habitica →" launcher
  "party": {                                   // optional: discover the family
    "id": "<group id>",
    "userId": "<a manager's userId>",
    "apiToken": "<that manager's API token>"
  },
  "members": [                                 // accounts that can be tapped
    { "name": "Kid One", "userId": "…", "apiToken": "…" }
  ],
  "order": ["Kid One", "Kid Two"],             // optional display order
  "hideMembers": [],                           // names/ids to leave off the picker
  "parentPin": "1234",                         // gates the parent page (blank = no gate)
  "parentSessionMinutes": 30,
  "memberCacheSeconds": 300
}
```

Find each person's **User ID** and **API token** under
Habitica → Settings → Site Data. A member needs credentials to be tappable;
party members without them are skipped.

Run it as a service (systemd):

```ini
[Unit]
Description=habitica-kids
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/habitica-kids/server.js
WorkingDirectory=/opt/habitica-kids
Restart=always

[Install]
WantedBy=multi-user.target
```

On a tablet, open the URL and **Add to Home Screen** for a full-screen app.

## Managing chores with an AI agent (or the command line)

Two front-ends over the same core, so a person, a script, or an assistant can
add / change / remove chores.

### CLI

```bash
node bin/chores.js list --who felix
node bin/chores.js add "🧹 Ranger sa chambre" --who arthur --difficulty medium --days mon,wed
node bin/chores.js add "🛏️ Faire son lit" --everyone --except Alex
node bin/chores.js update "Ranger" --who arthur --difficulty hard --days weekdays
node bin/chores.js remove "Ranger" --who arthur
node bin/chores.js house add "🍽️ Vider le lave-vaisselle" --days daily --assign felix,emile
```

`--days` takes `mon,wed,fri`, `weekdays`, `weekend` or `daily` (French names work
too). Add `--json` for machine-readable output — handy when an agent shells out.

### MCP server

`mcp-server.js` exposes the same operations as typed tools
(`list_chores`, `add_chore`, `update_chore`, `remove_chore`,
`list_house_chores`, `add_house_chore`, `remove_house_chore`), so an MCP-capable
assistant can manage chores conversationally:

```bash
claude mcp add chores -- node /path/to/habitica-kids/mcp-server.js
```

…then just ask: *"add a medium chore for Arthur to tidy his room on Mondays and
Wednesdays"*. No dependencies — plain JSON-RPC over stdio.

### Siri / Apple Shortcuts

`GET|POST /_hk/say?token=…&text=…` takes **one dictated sentence**, works out the
person, difficulty and repeat days, and replies with a short sentence Siri can
read back. Set `shortcutToken` in the config to a long random string.

```
"ajouter une tâche pour Arthur ranger sa chambre difficile le lundi et mercredi"
   → Ajouté pour Arthur : Ranger sa chambre
"ajoute pour Félix pratiquer le piano tous les jours"   → daily
"nouvelle tâche de maison sortir les poubelles"          → shared household chore
"quelles sont les tâches de Arthur"                      → reads them back
"enlever pour Arthur ranger sa chambre"                  → deletes it
```

Understands French and English day names, `en semaine` / `fin de semaine` /
`tous les jours`, and difficulties (`facile`, `moyen`, `difficile`). Matching is
whole-word, so names like *Arthur* aren't mistaken for *Thursday*.

Build the Shortcut: **Ask for Input** (text, "Quelle tâche ?") → **URL** →
**Get Contents of URL** (`…/_hk/say`, POST, JSON body `text` = the input,
`token` = your token) → **Show Result** / **Speak Text**. Name it *"Ajouter une
tâche"* and say *"Dis Siri, ajouter une tâche"*. Works on your Wi-Fi; put the
server behind a domain + HTTPS to use it away from home.

## Security

API tokens live only in `config.json` (git-ignored) and are used server-side; the
browser only ever sees names, avatars and chore text. Chore completion has **no
authentication** — anyone who can reach the page can complete chores as any
listed member (only the parent page is PIN-gated). That's the point (kids shouldn't need passwords), so **keep it on
your LAN**, not the public internet.

## License

[MIT](LICENSE) — not affiliated with or endorsed by Habitica.
