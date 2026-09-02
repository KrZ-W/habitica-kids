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
- **Pre-reader friendly.** A leading emoji in a task name (`🪥 Brosser ses dents`)
  becomes the tile's pictogram, so kids who can't read yet can still find their
  chores. Big touch targets, ⭐/🪙 burst and a "Bravo !" toast on completion.
- **Personal + household chores.** Shows a member's due Dailies and To-Dos, plus
  any **group/party chores** assigned to them (🏠).
- **Launcher into the real app.** Set `habiticaOrigin` and this also reverse-proxies
  your Habitica on the same origin, so a tap can write that member's session and
  open the complete web client as them. Everything the simple view doesn't cover
  (buying rewards, equipment, pets, item drops) is one tap away — no reimplementation.
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

## Security

API tokens live only in `config.json` (git-ignored) and are used server-side; the
browser only ever sees names, avatars and chore text. **There is no
authentication** — anyone who can reach the page can complete chores as any
listed member. That's the point (kids shouldn't need passwords), so **keep it on
your LAN**, not the public internet.

## License

[MIT](LICENSE) — not affiliated with or endorsed by Habitica.
