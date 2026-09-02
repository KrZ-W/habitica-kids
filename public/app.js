/* habitica-kids — front-end. Tokens stay on the server; this only talks to /api/*. */
(() => {
  const $ = (id) => document.getElementById(id);
  const peopleScreen = $("people"), choresScreen = $("chores");
  const grid = $("people-grid"), choreGrid = $("chore-grid");
  let current = null, refreshTimer = null;

  const avatarEl = (layers, cls = "") => {
    const d = document.createElement("div");
    d.className = "avatar " + cls;
    (layers || []).forEach((src) => {
      const i = document.createElement("img");
      i.src = src;
      i.onerror = () => i.remove();
      d.appendChild(i);
    });
    return d;
  };

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add("hidden"), 2600);
  }

  async function loadPeople() {
    try {
      const r = await fetch("/api/members");
      const { members } = await r.json();
      grid.innerHTML = "";
      if (!members || !members.length) {
        grid.innerHTML = '<p class="muted">Aucun compte configuré.</p>';
        return;
      }
      members.forEach((m) => {
        const b = document.createElement("button");
        b.className = "person";
        b.appendChild(avatarEl(m.avatar, "lg"));
        const n = document.createElement("span");
        n.className = "person-name";
        n.textContent = m.name;
        b.appendChild(n);
        if (m.lvl != null) {
          const l = document.createElement("span");
          l.className = "person-lvl";
          l.textContent = "Niv " + m.lvl;
          b.appendChild(l);
        }
        b.onclick = () => openMember(m);
        grid.appendChild(b);
      });
    } catch (e) {
      grid.innerHTML = '<p class="muted">Connexion impossible.</p>';
    }
  }

  function openMember(m) {
    current = m;
    $("who-name").textContent = m.name;
    const a = $("who-avatar");
    a.replaceWith(Object.assign(avatarEl(m.avatar, "sm"), { id: "who-avatar" }));
    peopleScreen.classList.add("hidden");
    choresScreen.classList.remove("hidden");
    loadChores();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(loadChores, 30000); // keep in sync if done elsewhere
  }

  function goBack() {
    clearInterval(refreshTimer);
    current = null;
    choresScreen.classList.add("hidden");
    peopleScreen.classList.remove("hidden");
    loadPeople();
  }
  $("back").onclick = goBack;

  async function loadChores() {
    if (!current) return;
    try {
      const r = await fetch("/api/chores?member=" + encodeURIComponent(current.id));
      const { chores } = await r.json();
      render(chores || []);
    } catch (e) {
      toast("Connexion impossible");
    }
  }

  function render(chores) {
    choreGrid.innerHTML = "";
    const todo = chores.filter((c) => !c.completed);
    const done = chores.filter((c) => c.completed);
    $("progress").textContent = chores.length ? `${done.length}/${chores.length}` : "";
    $("all-done").classList.toggle("hidden", !(chores.length && !todo.length));

    [...todo, ...done].forEach((c) => {
      const b = document.createElement("button");
      b.className = "tile" + (c.completed ? " done" : "") + (c.type === "group" ? " group" : "");
      b.disabled = c.completed;

      const ic = document.createElement("span");
      ic.className = "tile-icon";
      ic.textContent = c.icon || (c.type === "group" ? "🏠" : "⭐");
      b.appendChild(ic);

      const tx = document.createElement("span");
      tx.className = "tile-label";
      tx.textContent = c.label;
      b.appendChild(tx);

      if (c.completed) {
        const chk = document.createElement("span");
        chk.className = "tile-check";
        chk.textContent = "✓";
        b.appendChild(chk);
      }
      b.onclick = () => complete(c, b);
      choreGrid.appendChild(b);
    });
  }

  async function complete(chore, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("popping");
    try {
      const r = await fetch("/api/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ member: current.id, task: chore.id })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "erreur");
      btn.classList.add("done");
      const chk = document.createElement("span");
      chk.className = "tile-check";
      chk.textContent = "✓";
      btn.appendChild(chk);
      burst(btn);
      const bits = ["Bravo ! 🎉"];
      if (j.drop && j.drop.text) bits.push("Trouvé : " + j.drop.text);
      toast(bits.join("  "));
      setTimeout(loadChores, 900);
    } catch (e) {
      btn.disabled = false;
      btn.classList.remove("popping");
      toast("Oups, réessaie");
    }
  }

  // little star burst on completion
  function burst(el) {
    const r = el.getBoundingClientRect();
    for (let i = 0; i < 10; i++) {
      const s = document.createElement("span");
      s.className = "spark";
      s.textContent = ["⭐", "✨", "🪙"][i % 3];
      s.style.left = r.left + r.width / 2 + "px";
      s.style.top = r.top + r.height / 2 + "px";
      s.style.setProperty("--dx", (Math.random() * 160 - 80).toFixed(0) + "px");
      s.style.setProperty("--dy", (-60 - Math.random() * 90).toFixed(0) + "px");
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 900);
    }
  }

  loadPeople();
  // back to the picker if the tablet is left sitting on someone's list
  let idle = null;
  ["click", "touchstart"].forEach((ev) => document.addEventListener(ev, () => {
    clearTimeout(idle);
    idle = setTimeout(() => { if (current) goBack(); }, 3 * 60 * 1000);
  }, { passive: true }));
})();
