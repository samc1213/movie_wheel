const cheerio = require("cheerio");

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractSlugFromLink(link) {
  // "/film/the-breakfast-club/" -> "the-breakfast-club"
  const m = (link || "").match(/\/film\/([^/]+)\//);
  return m ? m[1] : "";
}

function buildPosterUrl(filmId, slug) {
  // Letterboxd CDN pattern: split film ID digits into path segments
  // e.g. 50518 -> "5/0/5/1/8" -> https://a.ltrbxd.com/resized/film-poster/5/0/5/1/8/50518-slug-0-230-0-345-crop.jpg
  const digits = String(filmId).split("/").join("").split("").join("/");
  return `https://a.ltrbxd.com/resized/film-poster/${digits}/${filmId}-${slug}-0-230-0-345-crop.jpg`;
}

async function scrapeWatchlist(username) {
  const key = `watchlist:${username}`;
  const cached = getCached(key);
  if (cached) return cached;

  const movies = [];
  const urls = Array.from({ length: 5 }, (_, i) =>
    `https://letterboxd.com/${username}/watchlist/page/${i + 1}/`
  );
  const pages = await Promise.all(urls.map((url, i) =>
    fetchPage(url).catch((err) => {
      if (i === 0) throw new Error(`Could not load watchlist for "${username}". Check the username.`);
      return null;
    })
  ));

  for (const html of pages) {
    if (!html) continue;
    const $ = cheerio.load(html);
    const items = $("li.griditem");
    if (items.length === 0) continue;

    items.each((_, el) => {
      const container = $(el).find("div[data-target-link]");
      const targetLink = container.attr("data-target-link") || "";
      const slug = extractSlugFromLink(targetLink);
      const filmId = container.attr("data-film-id") || "";
      const name = container.attr("data-item-name") || "";
      const img = $(el).find("img");
      const alt = img.attr("alt") || name;
      if (slug) {
        movies.push({
          slug,
          filmId,
          title: alt || slug,
          poster: `/api/poster/${slug}` + (filmId ? `?filmId=${filmId}` : ""),
        });
      }
    });
  }

  if (movies.length === 0) {
    throw new Error(`Watchlist for "${username}" is empty or could not be parsed.`);
  }
  setCache(key, movies);
  return movies;
}

async function scrapeWatched(username) {
  const key = `watched:${username}`;
  const cached = getCached(key);
  if (cached) return cached;

  // The /films/ page is often blocked by Cloudflare challenges when scraped.
  // Try to fetch it, but return empty set on failure (graceful degradation).
  const slugs = new Set();
  const urls = Array.from({ length: 10 }, (_, i) =>
    `https://letterboxd.com/${username}/films/page/${i + 1}/`
  );
  const pages = await Promise.all(urls.map((url) =>
    fetchPage(url).catch(() => null)
  ));

  for (const html of pages) {
    if (!html) continue;
    const $ = cheerio.load(html);
    const items = $("li.griditem");
    if (items.length === 0) {
      const alt = $("li.poster-container");
      if (alt.length === 0) continue;
      alt.each((_, el) => {
        const div = $(el).find("div[data-target-link]");
        const slug = extractSlugFromLink(div.attr("data-target-link"));
        if (slug) slugs.add(slug);
      });
      continue;
    }

    items.each((_, el) => {
      const container = $(el).find("div[data-target-link]");
      const slug = extractSlugFromLink(container.attr("data-target-link"));
      if (slug) slugs.add(slug);
    });
  }

  setCache(key, slugs);
  return slugs;
}

async function resolvePosterUrl(slug, filmId) {
  const key = `poster:${slug}`;
  const cached = getCached(key);
  if (cached) return cached;

  // Try constructed CDN URL first (works for most films)
  if (filmId) {
    const digits = String(filmId).split("").join("/");
    const cdnUrl = `https://a.ltrbxd.com/resized/film-poster/${digits}/${filmId}-${slug}-0-230-0-345-crop.jpg`;
    try {
      const check = await fetch(cdnUrl, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" } });
      if (check.ok) {
        setCache(key, cdnUrl);
        return cdnUrl;
      }
    } catch {}
  }

  // Fall back to og:image from the film page
  try {
    const html = await fetchPage(`https://letterboxd.com/film/${slug}/`);
    const $ = cheerio.load(html);
    const ogImage = $('meta[property="og:image"]').attr("content") || "";
    if (ogImage) {
      setCache(key, ogImage);
      return ogImage;
    }
  } catch {}
  return null;
}

module.exports = { scrapeWatchlist, scrapeWatched, resolvePosterUrl };
