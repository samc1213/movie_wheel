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
    users: new Map(),
    result: null,
    spinSeed: null,
    creatorId: null,
    createdAt: Date.now(),
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
    users,
    result: wheel.result,
    creatorId: wheel.creatorId,
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

  const wheel = wheels.get(wheelId);
  if (!wheel) {
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
  ws.send(JSON.stringify({ type: "state", ...wheelState(wheel), visitorId }));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
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

      try {
        const [watchlist, watched] = await Promise.all([
          scrapeWatchlist(username),
          scrapeWatched(username),
        ]);

        const user = {
          username,
          watchlist,
          watchedSlugs: watched,
          nomination: null,
          ws,
        };
        wheel.users.set(visitorId, user);
        if (!wheel.creatorId) wheel.creatorId = visitorId;

        broadcast(wheel, { type: "state", ...wheelState(wheel) });
      } catch (err) {
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
