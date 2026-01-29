(() => {
  // --- State ---
  let visitorId = localStorage.getItem("visitorId");
  if (!visitorId) {
    visitorId = Math.random().toString(36).slice(2, 10);
    localStorage.setItem("visitorId", visitorId);
  }

  let ws = null;
  let wheelId = null;
  let currentPhase = null;
  let myWatchlist = [];
  let selectedSlug = null;
  let nominations = [];
  let creatorId = null;
  let pendingSpin = null; // { seed, nominations } if spin_start arrived while hidden
  let joining = false;

  // --- DOM refs ---
  const $ = (s) => document.querySelector(s);
  const views = {
    home: $("#view-home"),
    lobby: $("#view-lobby"),
    nominating: $("#view-nominating"),
    spinning: $("#view-spinning"),
    result: $("#view-result"),
  };

  function showView(name) {
    Object.values(views).forEach((v) => v.classList.add("hidden"));
    views[name].classList.remove("hidden");
  }

  function showError(msg) {
    const t = $("#error-toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    setTimeout(() => t.classList.add("hidden"), 4000);
  }

  // --- Routing ---
  function route() {
    const hash = location.hash || "#/";
    const m = hash.match(/^#\/wheel\/(\w+)$/);
    if (m) {
      wheelId = m[1];
      showView("lobby");
      $("#share-url").value = location.href;
      connectWS();
    } else {
      showView("home");
    }
  }

  window.addEventListener("hashchange", route);

  // --- Home ---
  $("#home-username").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-create").click();
  });

  $("#btn-create").addEventListener("click", async () => {
    const btn = $("#btn-create");
    const username = $("#home-username").value.trim();
    if (!username) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/wheels", { method: "POST" });
      const { id } = await res.json();
      // Store username to auto-join
      sessionStorage.setItem("pendingJoin", username);
      location.hash = `#/wheel/${id}`;
    } catch {
      showError("Failed to create wheel");
    } finally {
      btn.disabled = false;
    }
  });

  // --- WebSocket ---
  function connectWS() {
    if (ws) ws.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?wheel=${wheelId}&visitorId=${visitorId}`);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      // Reconnect after 2s
      setTimeout(() => {
        if (wheelId) connectWS();
      }, 2000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function handleMessage(msg) {
    if (msg.type === "error") {
      showError(msg.message);
      joining = false;
      $("#lobby-status").textContent = "";
      return;
    }

    if (msg.type === "scraping") {
      $("#lobby-status").textContent = msg.message;
      return;
    }

    if (msg.type === "state") {
      updateState(msg);
      return;
    }

    if (msg.type === "watchlist") {
      myWatchlist = msg.movies;
      renderWatchlist();
      return;
    }

    if (msg.type === "spin_start") {
      nominations = msg.nominations;
      if (document.hidden) {
        pendingSpin = { seed: msg.seed, nominations: msg.nominations };
      } else {
        startSpinAnimation(msg.seed, msg.nominations);
      }
      return;
    }
  }

  function updateState(state) {
    const prevPhase = currentPhase;
    currentPhase = state.phase;
    if (state.creatorId) creatorId = state.creatorId;

    if (state.phase === "lobby") {
      showView("lobby");
      renderLobby(state);
    } else if (state.phase === "nominating") {
      showView("nominating");
      renderNominationStatus(state);
    } else if (state.phase === "spinning") {
      showView("spinning");
      const spinBtn = $("#btn-spin");
      if (creatorId === visitorId) {
        spinBtn.classList.remove("hidden");
        $("#spin-status").textContent = "";
      } else {
        spinBtn.classList.add("hidden");
        $("#spin-status").textContent = "Waiting for the wheel creator to spin...";
      }
      if (!prevPhase || prevPhase === "nominating") {
        nominations = state.users.filter((u) => u.nomination).map((u) => u.nomination);
        drawWheel(nominations);
      }
    } else if (state.phase === "result") {
      if (pendingSpin) {
        // Will transition to result after animation completes
      } else {
        showView("result");
        renderResult(state);
      }
    }

    // Auto-join if pending
    const pending = sessionStorage.getItem("pendingJoin");
    if (pending && state.phase === "lobby") {
      const alreadyJoined = state.users.some((u) => u.visitorId === visitorId && u.username);
      if (!alreadyJoined) {
        sessionStorage.removeItem("pendingJoin");
        joining = true;
        $("#lobby-status").textContent = `Loading ${pending}'s data from Letterboxd...`;
        $("#join-section").classList.add("hidden");
        send({ type: "join", username: pending });
      } else {
        sessionStorage.removeItem("pendingJoin");
      }
    }
  }

  // --- Lobby ---
  function renderLobby(state) {
    const shareUrl = location.href;
    $("#share-url").value = shareUrl;

    const alreadyJoined = state.users.some((u) => u.visitorId === visitorId);
    if (alreadyJoined) {
      joining = false;
      $("#join-section").classList.add("hidden");
    } else if (!joining) {
      $("#join-section").classList.remove("hidden");
    }

    $("#user-count").textContent = state.users.length;
    const ul = $("#user-list");
    ul.innerHTML = "";
    state.users.forEach((u) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${u.username}</span><span class="badge">${u.watchlistCount} films</span>`;
      ul.appendChild(li);
    });

    if (joining) return; // don't overwrite loading status

    const isCreator = state.creatorId === visitorId;
    const startBtn = $("#btn-start");
    if (isCreator && state.users.length >= 2) {
      startBtn.classList.remove("hidden");
      $("#lobby-status").textContent = "";
    } else if (isCreator && state.users.length === 1) {
      startBtn.classList.add("hidden");
      $("#lobby-status").textContent = "Share the link above — at least one other person needs to join before you can start.";
    } else if (!isCreator && alreadyJoined) {
      startBtn.classList.add("hidden");
      $("#lobby-status").textContent = "Waiting for the wheel creator to start nominations.";
    } else {
      startBtn.classList.add("hidden");
      $("#lobby-status").textContent = "";
    }
  }

  $("#lobby-username").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-join").click();
  });

  $("#btn-join").addEventListener("click", () => {
    const username = $("#lobby-username").value.trim();
    if (!username) return;
    joining = true;
    $("#lobby-status").textContent = `Loading ${username}'s data from Letterboxd...`;
    send({ type: "join", username });
  });

  $("#btn-copy").addEventListener("click", () => {
    $("#share-url").select();
    navigator.clipboard.writeText($("#share-url").value);
  });

  $("#btn-start").addEventListener("click", () => {
    send({ type: "start_nominations" });
  });

  // --- Nomination ---
  function renderNominationStatus(state) {
    const me = state.users.find((u) => u.visitorId === visitorId);
    const done = state.users.filter((u) => u.nomination).length;
    const total = state.users.length;
    if (me && me.nomination) {
      $("#nom-status").textContent = `You nominated: ${me.nomination.title}. (${done}/${total} picked)`;
      $("#watchlist-grid").innerHTML = "";
      $("#search-entry").classList.add("hidden");
    } else {
      $("#nom-status").textContent = `${done}/${total} users have nominated. Pick your movie!`;
    }
  }

  function renderWatchlist() {
    const grid = $("#watchlist-grid");
    grid.innerHTML = "";
    selectedSlug = null;

    const eligible = myWatchlist.filter((m) => !m.seenByOther);
    if (eligible.length === 0) {
      // No eligible watchlist films — search box is always visible
    }

    myWatchlist.forEach((m) => {
      const card = document.createElement("div");
      card.className = "poster-card" + (m.seenByOther ? " seen" : "");
      const img = document.createElement("img");
      img.alt = m.title;
      img.loading = "lazy";
      img.src = ""; // resolved below
      card.appendChild(img);
      const label = document.createElement("div");
      label.className = "poster-title";
      label.textContent = m.title;
      card.appendChild(label);

      // Resolve real poster URL via proxy
      fetch(m.poster).then(r => r.json()).then(d => {
        if (d.url) img.src = d.url;
      }).catch(() => {});

      if (!m.seenByOther) {
        card.addEventListener("click", () => {
          grid.querySelectorAll(".poster-card").forEach((c) => c.classList.remove("selected"));
          card.classList.add("selected");
          selectedSlug = m.slug;
          send({ type: "nominate", slug: m.slug });
        });
      }
      grid.appendChild(card);
    });
  }

  // --- Movie search ---
  let searchTimeout = null;
  $("#search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (!q) {
      $("#search-results").classList.add("hidden");
      return;
    }
    searchTimeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const results = await res.json();
        const ul = $("#search-results");
        ul.innerHTML = "";
        if (results.length === 0) {
          ul.classList.add("hidden");
          return;
        }
        results.forEach((m) => {
          const li = document.createElement("li");
          li.innerHTML = `
            ${m.poster ? `<img src="${m.poster}" alt="">` : ""}
            <div class="search-info">
              <span class="search-title">${m.title}</span>
              ${m.year ? `<span class="search-year">${m.year}</span>` : ""}
            </div>
          `;
          li.addEventListener("click", () => {
            const title = m.title;
            const poster = m.poster || "";
            send({ type: "nominate", title, poster, manual: true });
            ul.classList.add("hidden");
            $("#search-input").value = title;
          });
          ul.appendChild(li);
        });
        ul.classList.remove("hidden");
      } catch {}
    }, 300);
  });

  // Hide dropdown when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-box")) {
      $("#search-results").classList.add("hidden");
    }
  });

  // --- Wheel / Canvas ---
  const COLORS = ["#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261", "#264653", "#a855f7", "#ec4899"];

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function drawWheel(noms, rotation = 0) {
    const canvas = $("#wheel-canvas");
    const ctx = canvas.getContext("2d");
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = cx - 20;
    const n = noms.length;
    const slice = (2 * Math.PI) / n;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);

    for (let i = 0; i < n; i++) {
      const a0 = i * slice;
      const a1 = a0 + slice;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.fill();
      ctx.strokeStyle = "#0d1117";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Text
      ctx.save();
      ctx.rotate(a0 + slice / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = "#fff";
      ctx.font = "bold 14px sans-serif";
      const title = noms[i].title.length > 20 ? noms[i].title.slice(0, 18) + "..." : noms[i].title;
      ctx.fillText(title, r - 15, 5);
      ctx.restore();
    }

    ctx.restore();

    // Pointer (top)
    ctx.beginPath();
    ctx.moveTo(cx, 8);
    ctx.lineTo(cx - 12, 0);
    ctx.lineTo(cx + 12, 0);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  function startSpinAnimation(seed, noms) {
    showView("spinning");
    const rng = mulberry32(seed);
    const winnerIdx = seed % noms.length;

    const n = noms.length;
    const slice = (2 * Math.PI) / n;
    // Target: pointer at top (angle 0) points to winner slice
    // Slice i covers from i*slice to (i+1)*slice from the positive x-axis
    // Pointer is at -PI/2 (top), so we need the winner slice center at -PI/2
    const targetCenter = winnerIdx * slice + slice / 2;
    const targetRotation = -Math.PI / 2 - targetCenter;
    // Add 5+ full spins
    const fullSpins = 5 + Math.floor(rng() * 3);
    const totalRotation = fullSpins * 2 * Math.PI + ((targetRotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    const duration = 4500;
    const start = performance.now();

    $("#btn-spin").classList.add("hidden");

    function animate(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      const currentRotation = totalRotation * ease;

      drawWheel(noms, currentRotation);

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        // Animation done — show result after a brief pause
        setTimeout(() => {
          if (currentPhase === "result" || currentPhase === "spinning") {
            showView("result");
            renderResult({ result: noms[winnerIdx] });
          }
        }, 500);
      }
    }

    requestAnimationFrame(animate);
  }

  $("#btn-spin").addEventListener("click", () => {
    send({ type: "spin" });
  });

  // --- Result ---
  function renderResult(state) {
    if (!state.result) return;
    const poster = $("#result-poster");
    const posterVal = state.result.poster || "";
    if (posterVal.startsWith("/api/poster/")) {
      // Resolve via proxy
      poster.classList.add("hidden");
      fetch(posterVal).then(r => r.json()).then(d => {
        if (d.url) {
          poster.src = d.url;
          poster.classList.remove("hidden");
        }
      }).catch(() => {});
    } else if (posterVal) {
      poster.src = posterVal;
      poster.classList.remove("hidden");
    } else {
      poster.classList.add("hidden");
    }
    $("#result-title").textContent = state.result.title;
  }

  // --- Replay spin on tab focus ---
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && pendingSpin) {
      const { seed, nominations: noms } = pendingSpin;
      pendingSpin = null;
      startSpinAnimation(seed, noms);
    }
  });

  // --- Init ---
  route();
})();
