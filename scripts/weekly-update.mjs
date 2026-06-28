// SerieInfo — Weekly Update Agent
// Runs via GitHub Actions every Sunday at 03:00 UTC
// Also callable manually from the GitHub Actions tab (workflow_dispatch)
//
// Required GitHub Secrets:
//   TMDB_KEY             TMDB Read Access Token (Bearer)
//   GH_PAT               GitHub Personal Access Token (gist scope)
//   GH_GIST_ID       Gist ID — series bibliotheek
//   GH_FILMS_GIST_ID Gist ID — films bibliotheek

const GIST_API    = "https://api.github.com/gists";
const TMDB_BASE   = "https://api.themoviedb.org/3";
const SERIES_FILE = "serieinfo-series.json";
const FILMS_FILE  = "serieinfo-films.json";
const LOGO_BASE   = "https://image.tmdb.org/t/p/w45";
const BATCH       = 5;    // parallel TMDB calls per batch
const DELAY_MS    = 350;  // ms between batches (TMDB rate limit ~40 req/10s)

// ── Config & validation ───────────────────────────────────────────────────

const TMDB_KEY   = process.env.TMDB_KEY;
const GH_TOKEN   = process.env.GH_PAT;
const SERIES_ID  = process.env.GH_GIST_ID;
const FILMS_ID   = process.env.GH_FILMS_GIST_ID;

if (!TMDB_KEY)  { console.error("TMDB_KEY ontbreekt"); process.exit(1); }
if (!GH_TOKEN)  { console.error("GH_PAT ontbreekt");   process.exit(1); }
if (!SERIES_ID) { console.error("GH_GIST_ID ontbreekt"); process.exit(1); }
if (!FILMS_ID)  { console.error("GH_FILMS_GIST_ID ontbreekt"); process.exit(1); }

// ── Utilities ─────────────────────────────────────────────────────────────

const log = (...args) => console.log(new Date().toISOString().slice(11,19), ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeTitle(t) {
  return (t || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function detailScore(item) {
  let s = 0;
  if (item.year)             s++;
  if (item.genres?.length)   s += item.genres.length;
  if (item.description?.length > 20) s += 2;
  if (item.tmdb_rating)      s++;
  if (item.imdb_url)         s++;
  if (item.poster_url)       s++;
  if (item.season_count)     s++;
  if (item.streaming_service)s++;
  if (item.enriched)         s++;
  return s;
}

// ── Dutch streaming provider map ──────────────────────────────────────────

const NL_PROVIDERS = {
  "Netflix":              { name:"Netflix",       url:"https://www.netflix.com" },
  "Amazon Prime Video":   { name:"Prime Video",   url:"https://www.primevideo.com" },
  "Prime Video":          { name:"Prime Video",   url:"https://www.primevideo.com" },
  "Disney Plus":          { name:"Disney+",       url:"https://www.disneyplus.com" },
  "Disney+":              { name:"Disney+",       url:"https://www.disneyplus.com" },
  "Apple TV+":            { name:"Apple TV+",     url:"https://tv.apple.com" },
  "Apple TV Plus":        { name:"Apple TV+",     url:"https://tv.apple.com" },
  "Max":                  { name:"Max",           url:"https://www.max.com" },
  "HBO Max":              { name:"Max",           url:"https://www.max.com" },
  "SkyShowtime":          { name:"SkyShowtime",   url:"https://www.skyshowtime.com" },
  "Videoland":            { name:"Videoland",     url:"https://www.videoland.com" },
  "NPO Start":            { name:"NPO",           url:"https://www.npo.nl" },
  "NPO Plus":             { name:"NPO",           url:"https://www.npo.nl" },
  "Pathe Thuis":          { name:"Pathe Thuis",   url:"https://www.pathethuis.nl" },
  "MUBI":                 { name:"MUBI",          url:"https://mubi.com" },
};

// ── TMDB helpers ──────────────────────────────────────────────────────────

async function tmdbFetch(path) {
  const r = await fetch(TMDB_BASE + path, {
    headers: { Authorization: "Bearer " + TMDB_KEY, accept: "application/json" },
  });
  if (!r.ok) throw new Error("TMDB " + r.status + " voor " + path);
  return r.json();
}

async function getNLProvider(type, id) {
  try {
    const d  = await tmdbFetch("/" + type + "/" + id + "/watch/providers");
    const nl = d.results?.NL;
    if (!nl) return null;
    const flat = nl.flatrate || nl.ads || nl.free || [];
    if (!flat.length) return null;
    const p      = flat[0];
    const mapped = NL_PROVIDERS[p.provider_name];
    return {
      name: mapped?.name || p.provider_name,
      url:  mapped?.url  || nl.link || "",
      logo: p.logo_path  ? LOGO_BASE + p.logo_path : null,
    };
  } catch { return null; }
}

async function getNLReleaseDate(tmdbId) {
  try {
    const d  = await tmdbFetch("/movie/" + tmdbId + "/release_dates");
    const nl = (d.results || []).find(r => r.iso_3166_1 === "NL");
    if (!nl?.release_dates?.length) return null;
    // Prefer theatrical (3), digital (4), then any other
    const sorted = [...nl.release_dates].sort((a, b) => {
      const order = { 3:0, 4:1, 1:2, 2:3, 5:4, 6:5 };
      return (order[a.type] ?? 9) - (order[b.type] ?? 9);
    });
    return sorted[0].release_date?.slice(0, 10) || null;
  } catch { return null; }
}

// ── Item update functions ─────────────────────────────────────────────────

async function updateSeries(item) {
  if (!item.tmdb_id) return item;
  try {
    const [det, ext, prov] = await Promise.all([
      tmdbFetch("/tv/" + item.tmdb_id + "?language=en-US"),
      tmdbFetch("/tv/" + item.tmdb_id + "/external_ids"),
      getNLProvider("tv", item.tmdb_id),
    ]);
    if (det.success === false) return item;

    const year    = det.first_air_date?.slice(0, 4) || item.year;
    const endYear = det.last_air_date?.slice(0, 4);
    const yearStr = year && endYear && endYear !== year ? year + "-" + endYear : year;

    return {
      ...item,
      year:              yearStr              || item.year,
      genres:            det.genres?.map(g => g.name) || item.genres || [],
      description:       det.overview         || item.description,
      tmdb_rating:       det.vote_average ? parseFloat(det.vote_average).toFixed(1) + "/10" : item.tmdb_rating,
      imdb_url:          ext.imdb_id ? "https://www.imdb.com/title/" + ext.imdb_id + "/" : item.imdb_url,
      poster_url:        det.poster_path ? "https://image.tmdb.org/t/p/w342" + det.poster_path : item.poster_url,
      season_count:      det.number_of_seasons || item.season_count,
      streaming_service: prov?.name  || item.streaming_service,
      streaming_url:     prov?.url   || item.streaming_url,
      streaming_logo:    prov?.logo  || item.streaming_logo,
      last_updated:      new Date().toISOString(),
    };
  } catch (e) {
    log("  Fout bij serie", item.title, ":", e.message);
    return item;
  }
}

async function updateFilm(item) {
  if (!item.tmdb_id) return item;
  try {
    const [det, ext, prov, nlDate] = await Promise.all([
      tmdbFetch("/movie/" + item.tmdb_id + "?language=en-US"),
      tmdbFetch("/movie/" + item.tmdb_id + "/external_ids"),
      getNLProvider("movie", item.tmdb_id),
      getNLReleaseDate(item.tmdb_id),
    ]);
    if (det.success === false) return item;

    return {
      ...item,
      year:              det.release_date?.slice(0, 4) || item.year,
      genres:            det.genres?.map(g => g.name)  || item.genres || [],
      description:       det.overview                   || item.description,
      tmdb_rating:       det.vote_average ? parseFloat(det.vote_average).toFixed(1) + "/10" : item.tmdb_rating,
      imdb_url:          ext.imdb_id ? "https://www.imdb.com/title/" + ext.imdb_id + "/" : item.imdb_url,
      poster_url:        det.poster_path ? "https://image.tmdb.org/t/p/w342" + det.poster_path : item.poster_url,
      streaming_service: prov?.name  || item.streaming_service,
      streaming_url:     prov?.url   || item.streaming_url,
      streaming_logo:    prov?.logo  || item.streaming_logo,
      nl_release_date:   nlDate      || item.nl_release_date,
      last_updated:      new Date().toISOString(),
    };
  } catch (e) {
    log("  Fout bij film", item.title, ":", e.message);
    return item;
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────

function deduplicate(items) {
  const byTitle = {};
  items.forEach(item => {
    const key = normalizeTitle(item.title);
    if (!key) return;
    (byTitle[key] = byTitle[key] || []).push(item);
  });
  const kept = [];
  let removed = 0;
  Object.values(byTitle).forEach(group => {
    if (group.length === 1) { kept.push(group[0]); return; }
    group.sort((a, b) => detailScore(b) - detailScore(a));
    const winner = { ...group[0] };
    for (const dup of group.slice(1)) {
      if (!winner.year        && dup.year)        winner.year        = dup.year;
      if (!winner.poster_url  && dup.poster_url)  winner.poster_url  = dup.poster_url;
      if (!winner.imdb_url    && dup.imdb_url)    winner.imdb_url    = dup.imdb_url;
      if (!winner.description && dup.description) winner.description = dup.description;
      winner.watched = winner.watched || dup.watched;
      winner.watched_seasons = [...new Set([...(winner.watched_seasons||[]),...(dup.watched_seasons||[])])].sort((a,b)=>a-b);
    }
    kept.push(winner);
    removed += group.length - 1;
  });
  return { items: kept, removed };
}

// ── Batch processor ───────────────────────────────────────────────────────

async function processBatch(items, fn, label) {
  const results = [];
  const total = items.length;
  for (let i = 0; i < total; i += BATCH) {
    const batch  = items.slice(i, i + BATCH);
    const done   = Math.min(i + BATCH, total);
    log(label + ": " + done + "/" + total);
    const updated = await Promise.all(batch.map(fn));
    results.push(...updated);
    if (done < total) await sleep(DELAY_MS);
  }
  return results;
}

// ── Gist read / write ─────────────────────────────────────────────────────

async function readGist(gistId, filename) {
  const r = await fetch(GIST_API + "/" + gistId, {
    headers: {
      "Accept":        "application/vnd.github+json",
      "Authorization": "Bearer " + GH_TOKEN,
      "User-Agent":    "SerieInfo-Agent",
    },
  });
  if (!r.ok) throw new Error("Gist GET mislukt: " + r.status);
  const d = await r.json();
  const content = d.files?.[filename]?.content;
  if (!content) throw new Error("Bestand " + filename + " niet gevonden in Gist");
  return JSON.parse(content);
}

async function writeGist(gistId, filename, data) {
  const r = await fetch(GIST_API + "/" + gistId, {
    method:  "PATCH",
    headers: {
      "Accept":        "application/vnd.github+json",
      "Content-Type":  "application/json",
      "Authorization": "Bearer " + GH_TOKEN,
      "User-Agent":    "SerieInfo-Agent",
    },
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(data) } } }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Gist PATCH mislukt: " + r.status + " - " + t.slice(0, 80));
  }
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const started = Date.now();
  log("=== SerieInfo Weekly Update gestart ===");

  // 1. Read
  log("Gists lezen...");
  const [seriesData, filmsData] = await Promise.all([
    readGist(SERIES_ID, SERIES_FILE),
    readGist(FILMS_ID,  FILMS_FILE),
  ]);
  let library = Array.isArray(seriesData?.library) ? seriesData.library : [];
  let films   = Array.isArray(filmsData?.films)    ? filmsData.films    : [];
  log("Geladen: " + library.length + " series, " + films.length + " films");

  // 2. Deduplicate
  const { items: dedLib,   removed: remLib   } = deduplicate(library);
  const { items: dedFilms, removed: remFilms } = deduplicate(films);
  library = dedLib;
  films   = dedFilms;
  if (remLib   > 0) log(remLib   + " dubbele series verwijderd");
  if (remFilms > 0) log(remFilms + " dubbele films verwijderd");

  // 3. Update series
  const seriesWithId    = library.filter(i => i.tmdb_id);
  const seriesWithoutId = library.filter(i => !i.tmdb_id);
  if (seriesWithoutId.length > 0) log(seriesWithoutId.length + " series zonder TMDB ID overgeslagen");
  const updatedSeries = await processBatch(seriesWithId, updateSeries, "Series");
  library = [...updatedSeries, ...seriesWithoutId];

  // 4. Update films
  const filmsWithId    = films.filter(f => f.tmdb_id);
  const filmsWithoutId = films.filter(f => !f.tmdb_id);
  if (filmsWithoutId.length > 0) log(filmsWithoutId.length + " films zonder TMDB ID overgeslagen");
  const updatedFilms = await processBatch(filmsWithId, updateFilm, "Films");
  films = [...updatedFilms, ...filmsWithoutId];

  // 5. Write back
  log("Schrijven naar Gist...");
  await Promise.all([
    writeGist(SERIES_ID, SERIES_FILE, { library }),
    writeGist(FILMS_ID,  FILMS_FILE,  { films }),
  ]);

  const elapsed = Math.round((Date.now() - started) / 1000);
  log("=== Klaar in " + elapsed + "s: " + library.length + " series, " + films.length + " films ===");
}

main().catch(e => { console.error("Fatale fout:", e.message); process.exit(1); });
