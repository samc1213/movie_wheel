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
  let pendingSpin = null; // { seed, nominations, mode?, entries?, winnerIdx? } if spin_start arrived while hidden
  let selectionMode = "manual";
  let joining = false;
  let shouldReconnect = true;

  // Auto mode Phase 1 state
  let autoSelectedMovies = [];       // Completed selections
  let pendingAutoSpins = [];         // Queued spins if tab is hidden

  // --- DOM refs ---
  const $ = (s) => document.querySelector(s);
  const views = {
    home: $("#view-home"),
    lobby: $("#view-lobby"),
    "auto-selecting": $("#view-auto-selecting"),
    nominating: $("#view-nominating"),
    spinning: $("#view-spinning"),
    result: $("#view-result"),
  };

  function showView(name) {
    // Stop confetti when leaving result view
    if (name !== "result" && typeof stopConfetti === "function") {
      stopConfetti();
    }
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
    shouldReconnect = true;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?wheel=${wheelId}&visitorId=${visitorId}`);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      setTimeout(() => {
        if (wheelId && shouldReconnect) connectWS();
      }, 2000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function handleMessage(msg) {
    if (msg.type === "error") {
      if (msg.message === "Wheel not found") {
        shouldReconnect = false;
        wheelId = null;
        location.hash = "#/";
      }
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
      if (msg.mode === "auto_final") {
        // Auto mode final wheel: entries have poster URLs
        if (document.hidden) {
          pendingSpin = { seed: msg.seed, entries: msg.entries, winnerIdx: msg.winnerIdx, mode: "auto_final" };
        } else {
          startSpinAnimationAutoFinal(msg.seed, msg.entries, msg.winnerIdx);
        }
      } else if (msg.mode === "auto") {
        // Legacy auto mode (shouldn't happen with new flow)
        if (document.hidden) {
          pendingSpin = { seed: msg.seed, entries: msg.entries, winnerIdx: msg.winnerIdx, mode: "auto" };
        } else {
          startSpinAnimationAuto(msg.seed, msg.entries, msg.winnerIdx);
        }
      } else {
        // Manual mode: existing logic
        nominations = msg.nominations;
        if (document.hidden) {
          pendingSpin = { seed: msg.seed, nominations: msg.nominations };
        } else {
          startSpinAnimation(msg.seed, msg.nominations);
        }
      }
      return;
    }

    // Auto selection Phase 1 messages
    if (msg.type === "auto_select_start") {
      autoSelectedMovies = [];
      showView("auto-selecting");
      $("#selecting-progress").textContent = `Selecting from ${msg.users.length} users...`;
      $("#selecting-current-user").textContent = "";
      $("#selected-movies-grid").innerHTML = "";
      return;
    }

    if (msg.type === "auto_select_spin") {
      if (document.hidden) {
        // Queue for replay when tab is visible
        pendingAutoSpins.push(msg);
      } else {
        runMiniWheelAnimation(msg);
      }
      return;
    }

    if (msg.type === "auto_selections_complete") {
      autoSelectedMovies = msg.selections;
      // Transition to spinning view will happen via state update
      return;
    }
  }

  function updateState(state) {
    const prevPhase = currentPhase;
    currentPhase = state.phase;
    if (state.creatorId) creatorId = state.creatorId;
    if (state.selectionMode) selectionMode = state.selectionMode;

    if (state.phase === "lobby") {
      showView("lobby");
      renderLobby(state);
    } else if (state.phase === "auto_selecting") {
      showView("auto-selecting");
      // Initialize from state for users who join mid-selection
      if (state.selectingUsers && state.selectingUsers.length > 0) {
        const total = state.selectingUsers.length;
        const current = state.currentSelectingIndex || 0;
        $("#selecting-progress").textContent = `User ${current + 1} of ${total}`;
        $("#selecting-current-user").textContent = `${state.selectingUsers[current]}'s turn`;
      }
      // Show already-selected movies
      if (state.autoSelections && state.autoSelections.length > 0) {
        const grid = $("#selected-movies-grid");
        grid.innerHTML = "";
        autoSelectedMovies = [];
        state.autoSelections.forEach(sel => {
          addSelectedMovieCard(sel.username, sel.movie);
        });
      }
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
      if (!prevPhase || prevPhase === "nominating" || prevPhase === "lobby" || prevPhase === "auto_selecting") {
        if (selectionMode === "auto" && autoSelectedMovies.length > 0) {
          // Auto mode with Phase 1 selections: draw wheel with movie titles
          const entries = autoSelectedMovies.map(s => ({
            title: s.movie.title,
          }));
          drawWheel(entries, 0, "manual");
        } else if (selectionMode === "auto") {
          // Fallback for old auto mode
          const entries = state.users
            .filter((u) => u.watchlistCount > 0)
            .map((u) => ({ username: u.username }));
          drawWheel(entries, 0, "auto");
        } else {
          // Manual mode: use nominations
          nominations = state.users.filter((u) => u.nomination).map((u) => u.nomination);
          drawWheel(nominations, 0, "manual");
        }
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
    const modeSelector = $("#mode-selector");
    if (isCreator && state.users.length >= 2) {
      startBtn.classList.remove("hidden");
      modeSelector.classList.remove("hidden");
      $("#lobby-status").textContent = "";
    } else if (isCreator && state.users.length === 1) {
      startBtn.classList.add("hidden");
      modeSelector.classList.add("hidden");
      $("#lobby-status").textContent = "Share the link above — at least one other person needs to join before you can start.";
    } else if (!isCreator && alreadyJoined) {
      startBtn.classList.add("hidden");
      modeSelector.classList.add("hidden");
      $("#lobby-status").textContent = "Waiting for the wheel creator to start.";
    } else {
      startBtn.classList.add("hidden");
      modeSelector.classList.add("hidden");
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
    const mode = document.querySelector('input[name="selection-mode"]:checked')?.value || "manual";
    send({ type: "start_nominations", selectionMode: mode });
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

  function drawWheel(entries, rotation = 0, mode = "manual") {
    const canvas = $("#wheel-canvas");
    const ctx = canvas.getContext("2d");
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = cx - 20;
    const n = entries.length;
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

      // Text label based on mode
      ctx.save();
      ctx.rotate(a0 + slice / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = "#fff";
      ctx.font = "bold 14px sans-serif";
      let label;
      if (mode === "auto") {
        label = entries[i].username; // Show username for auto mode
      } else {
        label = entries[i].title; // Show movie title for manual mode
      }
      if (label.length > 18) label = label.slice(0, 16) + "...";
      ctx.fillText(label, r - 15, 5);
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

  function startSpinAnimationAuto(seed, entries, winnerIdx) {
    showView("spinning");
    const rng = mulberry32(seed);

    const n = entries.length;
    const slice = (2 * Math.PI) / n;
    // Target: pointer at top (angle 0) points to winner slice
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

      drawWheel(entries, currentRotation, "auto");

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        // Animation done — wait for result state from server
        setTimeout(() => {
          if (currentPhase === "result" || currentPhase === "spinning") {
            // Server will send full result with movie info
          }
        }, 500);
      }
    }

    requestAnimationFrame(animate);
  }

  // --- Auto Mode Phase 1 Functions ---

  function runMiniWheelAnimation(data) {
    const { username, userIndex, totalUsers, movies, seed, winnerIdx, selectedMovie } = data;

    showView("auto-selecting");
    $("#selecting-progress").textContent = `User ${userIndex + 1} of ${totalUsers}`;
    $("#selecting-current-user").textContent = `${username}'s turn`;

    const canvas = $("#mini-wheel-canvas");
    const ctx = canvas.getContext("2d");
    const rng = mulberry32(seed);

    const n = movies.length;
    const slice = (2 * Math.PI) / n;
    const targetCenter = winnerIdx * slice + slice / 2;
    const targetRotation = -Math.PI / 2 - targetCenter;
    const fullSpins = 3 + Math.floor(rng() * 2);
    const totalRotation = fullSpins * 2 * Math.PI + ((targetRotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    const duration = 3000;
    const start = performance.now();

    function animate(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const currentRotation = totalRotation * ease;

      drawMiniWheel(ctx, movies, currentRotation, canvas.width, canvas.height);

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        // Animation done - add selected movie to grid
        addSelectedMovieCard(username, selectedMovie);
      }
    }

    requestAnimationFrame(animate);
  }

  function drawMiniWheel(ctx, entries, rotation, width, height) {
    const cx = width / 2;
    const cy = height / 2;
    const r = cx - 15;
    const n = entries.length;
    const slice = (2 * Math.PI) / n;

    ctx.clearRect(0, 0, width, height);
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

      // Text label
      ctx.save();
      ctx.rotate(a0 + slice / 2);
      ctx.textAlign = "right";
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif";
      let label = entries[i].title;
      if (label.length > 16) label = label.slice(0, 14) + "...";
      ctx.fillText(label, r - 10, 4);
      ctx.restore();
    }

    ctx.restore();

    // Pointer (top)
    ctx.beginPath();
    ctx.moveTo(cx, 8);
    ctx.lineTo(cx - 10, 0);
    ctx.lineTo(cx + 10, 0);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  function addSelectedMovieCard(username, movie) {
    const grid = $("#selected-movies-grid");
    const card = document.createElement("div");
    card.className = "selected-movie-card";

    if (movie.poster) {
      const img = document.createElement("img");
      img.src = movie.poster;
      img.alt = movie.title;
      card.appendChild(img);
    }

    const titleBadge = document.createElement("div");
    titleBadge.className = "movie-title-badge";
    titleBadge.textContent = movie.title;
    card.appendChild(titleBadge);

    const userBadge = document.createElement("div");
    userBadge.className = "username-badge";
    userBadge.textContent = username;
    card.appendChild(userBadge);

    grid.appendChild(card);

    // Store in autoSelectedMovies for later
    autoSelectedMovies.push({ username, movie });
  }

  function startSpinAnimationAutoFinal(seed, entries, winnerIdx) {
    showView("spinning");
    const rng = mulberry32(seed);

    const n = entries.length;
    const slice = (2 * Math.PI) / n;
    const targetCenter = winnerIdx * slice + slice / 2;
    const targetRotation = -Math.PI / 2 - targetCenter;
    const fullSpins = 5 + Math.floor(rng() * 3);
    const totalRotation = fullSpins * 2 * Math.PI + ((targetRotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    const duration = 4500;
    const start = performance.now();

    $("#btn-spin").classList.add("hidden");

    // Map entries to have title for drawWheel
    const wheelEntries = entries.map(e => ({ title: e.title }));

    function animate(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      const currentRotation = totalRotation * ease;

      drawWheel(wheelEntries, currentRotation, "manual");

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        // Animation done — show result after a brief pause
        setTimeout(() => {
          if (currentPhase === "result" || currentPhase === "spinning") {
            showView("result");
            renderResult({ result: entries[winnerIdx] });
          }
        }, 500);
      }
    }

    requestAnimationFrame(animate);
  }

  $("#btn-spin").addEventListener("click", () => {
    send({ type: "spin" });
  });

  // --- Confetti ---
  let confettiAnimationId = null;

  function startConfetti() {
    const canvas = $("#confetti-canvas");
    const ctx = canvas.getContext("2d");

    // Set canvas size to window size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const particleCount = 150;
    const colors = ["#e63946", "#457b9d", "#2a9d8f", "#e9c46a", "#f4a261", "#a855f7", "#ec4899", "#3fb950"];

    // Create particles
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        size: Math.random() * 8 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        speedY: Math.random() * 3 + 2,
        speedX: Math.random() * 4 - 2,
        rotation: Math.random() * 360,
        rotationSpeed: Math.random() * 10 - 5,
        shape: Math.random() > 0.5 ? "rect" : "circle",
      });
    }

    let startTime = performance.now();
    const duration = 4000; // 4 seconds

    function animate(now) {
      const elapsed = now - startTime;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach((p) => {
        p.y += p.speedY;
        p.x += p.speedX;
        p.rotation += p.rotationSpeed;

        // Add some wobble
        p.x += Math.sin(p.y * 0.02) * 0.5;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;

        if (p.shape === "rect") {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();

        // Reset particle if it goes off screen
        if (p.y > canvas.height + 20) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }
      });

      if (elapsed < duration) {
        confettiAnimationId = requestAnimationFrame(animate);
      } else {
        // Fade out
        fadeOutConfetti(ctx, canvas, particles, performance.now());
      }
    }

    confettiAnimationId = requestAnimationFrame(animate);
  }

  function fadeOutConfetti(ctx, canvas, particles, startTime) {
    const fadeDuration = 1000;

    function animateFade(now) {
      const elapsed = now - startTime;
      const alpha = 1 - elapsed / fadeDuration;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (alpha > 0) {
        ctx.globalAlpha = alpha;
        particles.forEach((p) => {
          p.y += p.speedY;
          p.x += p.speedX;
          p.rotation += p.rotationSpeed;

          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.fillStyle = p.color;

          if (p.shape === "rect") {
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.restore();
        });
        ctx.globalAlpha = 1;
        confettiAnimationId = requestAnimationFrame(animateFade);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        confettiAnimationId = null;
      }
    }

    confettiAnimationId = requestAnimationFrame(animateFade);
  }

  function stopConfetti() {
    if (confettiAnimationId) {
      cancelAnimationFrame(confettiAnimationId);
      confettiAnimationId = null;
      const canvas = $("#confetti-canvas");
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  // --- Result ---
  function renderResult(state) {
    if (!state.result) return;
    startConfetti();
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

    // Show subtitle for auto mode
    const subtitle = $("#result-subtitle");
    if (state.result.selectedFrom) {
      subtitle.textContent = `Selected from ${state.result.selectedFrom}'s watchlist`;
      subtitle.classList.remove("hidden");
    } else {
      subtitle.classList.add("hidden");
    }
  }

  // --- Replay spin on tab focus ---
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // Process pending auto spins from Phase 1
      if (pendingAutoSpins.length > 0) {
        // Process all queued spins sequentially with a delay
        let delay = 0;
        pendingAutoSpins.forEach((spinData, i) => {
          setTimeout(() => {
            // Fast-forward: just add the card without animation
            addSelectedMovieCard(spinData.username, spinData.selectedMovie);
          }, delay);
          delay += 100;
        });
        pendingAutoSpins = [];
      }

      // Process pending final spin
      if (pendingSpin) {
        if (pendingSpin.mode === "auto_final") {
          const { seed, entries, winnerIdx } = pendingSpin;
          pendingSpin = null;
          startSpinAnimationAutoFinal(seed, entries, winnerIdx);
        } else if (pendingSpin.mode === "auto") {
          const { seed, entries, winnerIdx } = pendingSpin;
          pendingSpin = null;
          startSpinAnimationAuto(seed, entries, winnerIdx);
        } else {
          const { seed, nominations: noms } = pendingSpin;
          pendingSpin = null;
          startSpinAnimation(seed, noms);
        }
      }
    }
  });

  // --- Init ---
  route();
})();
