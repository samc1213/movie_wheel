const cheerio = require("cheerio");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

let _browser = null;
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  _browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  console.log("[scraper] browser launched");
  return _browser;
}

async function fetchPageWithBrowser(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    console.log(`[scraper] browser fetching ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // Wait for Cloudflare "Just a moment..." to resolve
    if ((await page.title()).includes("Just a moment")) {
      console.log(`[scraper] waiting for Cloudflare challenge...`);
      await page.waitForFunction(
        () => !document.title.includes("Just a moment"),
        { timeout: 15000 }
      );
    }
    return await page.content();
  } finally {
    await page.close();
  }
}

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
  const start = Date.now();
  console.log(`[scraper] fetching ${url}`);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  console.log(`[scraper] ${res.status} ${url} (${Date.now() - start}ms)`);
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

  console.log(`[scraper] scraping watchlist for "${username}"`);
  const movies = [];
  const urls = Array.from({ length: 20 }, (_, i) =>
    `https://letterboxd.com/${username}/watchlist/page/${i + 1}/`
  );
  const pages = await Promise.all(urls.map((url, i) =>
    fetchPage(url).catch((err) => {
      console.log(`[scraper] watchlist page ${i + 1} failed: ${err.message}`);
      if (i === 0) throw new Error(`Could not load watchlist for "${username}". Check the username.`);
      return null;
    })
  ));

  console.log(`[scraper] watchlist fetch complete, parsing ${pages.filter(Boolean).length} pages`);
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
  console.log(`[scraper] watchlist for "${username}": ${movies.length} movies`);
  setCache(key, movies);
  return movies;
}

async function scrapeWatched(username) {
  const key = `watched:${username}`;
  const cached = getCached(key);
  if (cached) return cached;

  console.log(`[scraper] scraping watched films for "${username}"`);
  const slugs = new Set();

  for (let i = 0; i < 20; i++) {
    const url = `https://letterboxd.com/${username}/films/page/${i + 1}/`;
    let html;
    try {
      html = await fetchPageWithBrowser(url);
    } catch (err) {
      console.log(`[scraper] watched page ${i + 1} failed: ${err.message}`);
      break; // stop on first failure (403 = private or end of pages)
    }

    const $ = cheerio.load(html);
    const before = slugs.size;

    const bySlug = $("div[data-film-slug]");
    if (bySlug.length > 0) {
      bySlug.each((_, el) => {
        const slug = $(el).attr("data-film-slug");
        if (slug) slugs.add(slug);
      });
    } else {
      $("div[data-target-link]").each((_, el) => {
        const slug = extractSlugFromLink($(el).attr("data-target-link"));
        if (slug) slugs.add(slug);
      });
    }

    if (slugs.size === before) break; // no new films = last page
  }

  console.log(`[scraper] watched films for "${username}": ${slugs.size} slugs`);
  setCache(key, slugs);
  return slugs;
}

async function resolvePosterUrl(slug, filmId) {
  const key = `poster:${slug}`;
  const cached = getCached(key);
  if (cached) return cached;

  console.log(`[scraper] resolving poster for "${slug}"`);
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
