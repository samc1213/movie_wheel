const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const crypto = require("crypto");
const { scrapeWatchlist, scrapeWatched, resolvePosterUrl } = require("./scraper");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// In-memory wheel storage
const wheels = new Map();
const WHEEL_TTL = 24 * 60 * 60 * 1000;

function genId() {
  return crypto.randomBytes(3).toString("hex");
}

function createWheel() {
  const id = genId();
  const wheel = {
    id,
    phase: "lobby",
    selectionMode: "manual", // "manual" | "auto"
    users: new Map(),
    result: null,
    spinSeed: null,
    creatorId: null,
    createdAt: Date.now(),
    // Auto mode Phase 1 state
    autoSelections: [],        // Array of {username, movie: {slug, title, poster}}
    currentSelectingIndex: 0,  // Index of user currently being selected
    selectingUsers: [],        // Ordered list of usernames for selection
  };
  wheels.set(id, wheel);
  return wheel;
}

function wheelState(wheel) {
  const users = [];
  for (const [vid, u] of wheel.users) {
    users.push({
      visitorId: vid,
      username: u.username,
      watchlistCount: u.watchlist.length,
      nomination: u.nomination,
      ready: u.nomination !== null,
    });
  }
  return {
    id: wheel.id,
    phase: wheel.phase,
    selectionMode: wheel.selectionMode,
    users,
    result: wheel.result,
    creatorId: wheel.creatorId,
    autoSelections: wheel.autoSelections,
    currentSelectingIndex: wheel.currentSelectingIndex,
    selectingUsers: wheel.selectingUsers,
  };
}

function broadcast(wheel, msg) {
  const data = JSON.stringify(msg);
  for (const u of wheel.users.values()) {
    if (u.ws && u.ws.readyState === 1) {
      u.ws.send(data);
    }
  }
}

// Auto mode Phase 1: Sequential selection for each user
async function runAutoSelections(wheel, usersWithMovies) {
  const ANIMATION_DELAY = 4000; // 4 seconds for animation

  for (let i = 0; i < usersWithMovies.length; i++) {
    wheel.currentSelectingIndex = i;
    const user = usersWithMovies[i];

    // Use full watchlist
    const movies = user.watchlist;

    // Generate random selection
    const seed = crypto.randomInt(0, 2 ** 32);
    const winnerIdx = seed % movies.length;
    const selectedMovie = movies[winnerIdx];

    // Resolve poster URL
    const posterUrl = await resolvePosterUrl(selectedMovie.slug, selectedMovie.filmId || "");

    // Store selection
    const selection = {
      username: user.username,
      movie: {
        slug: selectedMovie.slug,
        title: selectedMovie.title,
        poster: posterUrl || "",
      },
    };
    wheel.autoSelections.push(selection);

    // Broadcast spin to ALL clients - everyone sees the same mini-wheel
    broadcast(wheel, {
      type: "auto_select_spin",
      username: user.username,
      userIndex: i,
      totalUsers: usersWithMovies.length,
      movies: movies.map(m => ({ slug: m.slug, title: m.title })),
      seed,
      winnerIdx,
      selectedMovie: selection.movie,
    });

    // Wait for animation to complete before moving to next user
    await new Promise(resolve => setTimeout(resolve, ANIMATION_DELAY));
  }

  // Phase 1 complete - broadcast and transition to spinning phase
  wheel.phase = "spinning";

  broadcast(wheel, {
    type: "auto_selections_complete",
    selections: wheel.autoSelections,
  });

  // Also send state update
  broadcast(wheel, { type: "state", ...wheelState(wheel) });
}

// REST: create wheel
app.post("/api/wheels", (req, res) => {
  const wheel = createWheel();
  res.json({ id: wheel.id });
});

// Poster proxy: resolves real poster URL from Letterboxd film page
app.get("/api/poster/:slug", async (req, res) => {
  const slug = req.params.slug;
  const filmId = req.query.filmId || "";
  const url = await resolvePosterUrl(slug, filmId);
  if (url) {
    res.json({ url });
  } else {
    res.json({ url: "" });
  }
});

// TMDB movie search
const TMDB_TOKEN = process.env.TMDB_TOKEN;

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    const r = await fetch(`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent(q)}&page=1`, {
      headers: { Authorization: `Bearer ${TMDB_TOKEN}` },
    });
    if (!r.ok) return res.json([]);
    const data = await r.json();
    const results = (data.results || []).slice(0, 8).map((m) => ({
      id: m.id,
      title: m.title,
      year: m.release_date ? m.release_date.slice(0, 4) : "",
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w185${m.poster_path}` : "",
    }));
    res.json(results);
  } catch {
    res.json([]);
  }
});

// Cleanup expired wheels periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, w] of wheels) {
    if (now - w.createdAt > WHEEL_TTL) wheels.delete(id);
  }
}, 60 * 1000);

// WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const wheelId = url.searchParams.get("wheel");
  const visitorId = url.searchParams.get("visitorId");
  console.log(`[ws] connection: wheel=${wheelId} visitor=${visitorId}`);

  const wheel = wheels.get(wheelId);
  if (!wheel) {
    console.log(`[ws] wheel not found: ${wheelId}`);
    ws.send(JSON.stringify({ type: "error", message: "Wheel not found" }));
    ws.close();
    return;
  }

  // Reconnect support: attach ws to existing user
  const existing = wheel.users.get(visitorId);
  if (existing) {
    existing.ws = ws;
  }

  // Send current state
  const state = wheelState(wheel);
  console.log(`[ws] sending state to ${visitorId}: ${state.users.length} users, phase=${state.phase}`);
  ws.send(JSON.stringify({ type: "state", ...state, visitorId }));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      console.log(`[ws] join request: visitor=${visitorId} username=${msg.username}`);
      if (wheel.phase !== "lobby") {
        ws.send(JSON.stringify({ type: "error", message: "Wheel is no longer in lobby phase" }));
        return;
      }
      if (wheel.users.has(visitorId) && wheel.users.get(visitorId).username) {
        ws.send(JSON.stringify({ type: "error", message: "Already joined" }));
        return;
      }
      const username = (msg.username || "").trim().toLowerCase();
      if (!username) {
        ws.send(JSON.stringify({ type: "error", message: "Username required" }));
        return;
      }
      // Check duplicate username
      for (const u of wheel.users.values()) {
        if (u.username === username) {
          ws.send(JSON.stringify({ type: "error", message: "Username already in this wheel" }));
          return;
        }
      }

      ws.send(JSON.stringify({ type: "scraping", message: `Loading ${username}'s data from Letterboxd...` }));
      console.log(`[ws] starting scrape for "${username}"`);
      const scrapeStart = Date.now();

      try {
        const [watchlist, watched] = await Promise.all([
          scrapeWatchlist(username),
          scrapeWatched(username),
        ]);
        console.log(`[ws] scrape done for "${username}" in ${Date.now() - scrapeStart}ms (${watchlist.length} watchlist, ${watched.size} watched)`);

        const user = {
          username,
          watchlist,
          watchedSlugs: watched,
          nomination: null,
          ws,
        };
        wheel.users.set(visitorId, user);
        if (!wheel.creatorId) wheel.creatorId = visitorId;

        console.log(`[ws] user "${username}" added, total users: ${wheel.users.size}`);
        broadcast(wheel, { type: "state", ...wheelState(wheel) });
      } catch (err) {
        console.log(`[ws] scrape failed for "${username}": ${err.message}`);
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      }

    } else if (msg.type === "start_nominations") {
      if (wheel.phase !== "lobby") return;
      if (wheel.creatorId !== visitorId) {
        ws.send(JSON.stringify({ type: "error", message: "Only the creator can start nominations" }));
        return;
      }
      if (wheel.users.size < 2) {
        ws.send(JSON.stringify({ type: "error", message: "Need at least 2 users" }));
        return;
      }

      const mode = msg.selectionMode || "manual";
      wheel.selectionMode = mode;

      if (mode === "auto") {
        // Build list of users with watchlists
        const usersWithMovies = [];
        for (const [vid, u] of wheel.users) {
          if (u.watchlist.length > 0) {
            usersWithMovies.push({ visitorId: vid, username: u.username, watchlist: u.watchlist });
          }
        }
        if (usersWithMovies.length === 0) {
          ws.send(JSON.stringify({ type: "error", message: "No movies available in any watchlist" }));
          return;
        }

        // Reset auto selection state
        wheel.autoSelections = [];
        wheel.currentSelectingIndex = 0;
        wheel.selectingUsers = usersWithMovies.map(u => u.username);

        // Set phase to auto_selecting and start Phase 1
        wheel.phase = "auto_selecting";

        // Broadcast start of auto selection
        broadcast(wheel, {
          type: "auto_select_start",
          users: wheel.selectingUsers,
        });

        // Start the sequential selection process
        runAutoSelections(wheel, usersWithMovies);
      } else {
        // Manual mode: existing logic
        wheel.phase = "nominating";

        // Send each user their eligible watchlist
        for (const [vid, u] of wheel.users) {
          const otherWatched = new Set();
          for (const [ovid, ou] of wheel.users) {
            if (ovid !== vid) {
              for (const s of ou.watchedSlugs) otherWatched.add(s);
            }
          }
          const eligible = u.watchlist.map((m) => ({
            ...m,
            seenByOther: otherWatched.has(m.slug),
          }));
          if (u.ws && u.ws.readyState === 1) {
            u.ws.send(JSON.stringify({
              type: "watchlist",
              movies: eligible,
            }));
          }
        }

        broadcast(wheel, { type: "state", ...wheelState(wheel) });
      }

    } else if (msg.type === "nominate") {
      if (wheel.phase !== "nominating") return;
      const user = wheel.users.get(visitorId);
      if (!user) return;
      if (user.nomination) {
        ws.send(JSON.stringify({ type: "error", message: "Already nominated" }));
        return;
      }

      const slug = msg.slug;
      const title = msg.title || "";

      // Manual entry fallback
      if (msg.manual) {
        user.nomination = { slug: null, title, poster: msg.poster || null, manual: true };
      } else {
        const movie = user.watchlist.find((m) => m.slug === slug);
        if (!movie) {
          ws.send(JSON.stringify({ type: "error", message: "Movie not in your watchlist" }));
          return;
        }
        const posterUrl = await resolvePosterUrl(movie.slug, movie.filmId || "");
        user.nomination = { slug: movie.slug, title: movie.title, poster: posterUrl || "" };
      }

      // Check if all nominated
      let allNominated = true;
      for (const u of wheel.users.values()) {
        if (!u.nomination) { allNominated = false; break; }
      }
      if (allNominated) {
        wheel.phase = "spinning";
      }

      broadcast(wheel, { type: "state", ...wheelState(wheel) });

    } else if (msg.type === "spin") {
      if (wheel.phase !== "spinning") return;
      if (wheel.spinSeed !== null) return;
      if (wheel.creatorId !== visitorId) {
        ws.send(JSON.stringify({ type: "error", message: "Only the creator can spin the wheel" }));
        return;
      }

      if (wheel.selectionMode === "auto" && wheel.autoSelections.length > 0) {
        // Auto mode with Phase 1 selections: final wheel spin
        const entries = wheel.autoSelections.map(sel => ({
          username: sel.username,
          title: sel.movie.title,
          poster: sel.movie.poster,
          slug: sel.movie.slug,
        }));

        if (entries.length === 0) {
          ws.send(JSON.stringify({ type: "error", message: "No movies available" }));
          return;
        }

        // Equal probability per entry
        wheel.spinSeed = crypto.randomInt(0, 2 ** 32);
        const winnerIdx = wheel.spinSeed % entries.length;
        const winner = entries[winnerIdx];

        wheel.result = {
          slug: winner.slug,
          title: winner.title,
          poster: winner.poster,
          selectedFrom: winner.username,
        };
        wheel.phase = "result";

        broadcast(wheel, {
          type: "spin_start",
          seed: wheel.spinSeed,
          entries,
          winnerIdx,
          mode: "auto_final",
        });

        // Broadcast result after animation delay
        setTimeout(() => {
          broadcast(wheel, { type: "state", ...wheelState(wheel) });
        }, 5000);

      } else {
        // Manual mode: existing logic
        const nominations = [];
        for (const u of wheel.users.values()) {
          nominations.push(u.nomination);
        }

        wheel.spinSeed = crypto.randomInt(0, 2 ** 32);
        broadcast(wheel, {
          type: "spin_start",
          seed: wheel.spinSeed,
          nominations,
        });

        // Compute winner server-side too
        const winnerIdx = wheel.spinSeed % nominations.length;
        wheel.result = nominations[winnerIdx];
        wheel.phase = "result";

        // Broadcast result after animation delay
        setTimeout(() => {
          broadcast(wheel, { type: "state", ...wheelState(wheel) });
        }, 5000);
      }
    }
  });

  ws.on("close", () => {
    const user = wheel.users.get(visitorId);
    if (user) user.ws = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Movie Wheel running at http://localhost:${PORT}`);
});
