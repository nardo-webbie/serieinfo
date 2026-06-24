import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import "./App.css";

// --- API via Vercel proxy (geen directe Anthropic calls) ------------------
async function claude(messages, maxTokens = 1000, system = null) {
  const body = { model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Lees ruwe tekst eerst  -  voorkomt crash als het geen JSON is
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Server fout: " + raw.slice(0, 120));
  }

  if (!res.ok) throw new Error(data?.error?.message || data?.error || "API fout " + res.status);
  if (data.error) throw new Error(data.error.message || String(data.error));

  let text = "";
  for (const b of data.content || []) if (b.type === "text") text += b.text;
  if (!text) throw new Error("Leeg antwoord van API");
  return text;
}

// --- Library (localStorage) -----------------------------------------------
const LIB_KEY = "serieinfo-lib";
const loadLib = () => {
  try { const v = localStorage.getItem(LIB_KEY); return v ? JSON.parse(v) : []; }
  catch { return []; }
};
const saveLib = (items) => {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(items)); } catch {}
};

// --- TMDB API -------------------------------------------------------------
const TMDB_KEY_LS = "serieinfo-tmdb";
const getTmdbKey = () => { try { return localStorage.getItem(TMDB_KEY_LS) || ""; } catch { return ""; } };
const setTmdbKey = (k) => { try { localStorage.setItem(TMDB_KEY_LS, k); } catch {} };

async function tmdbSearch(title) {
  const key = getTmdbKey();
  if (!key) return null;

  // 1. Search
  const s = await fetch(
    "https://api.themoviedb.org/3/search/tv?query=" + encodeURIComponent(title) +
    "&language=en-US&page=1",
    { headers: { Authorization: "Bearer " + key, accept: "application/json" } }
  );
  const sd = await s.json();
  if (!sd.results?.length) return null;

  const show = sd.results[0];
  const id   = show.id;

  // 2. Details + external IDs + NL provider in parallel
  const [det, ext, prov] = await Promise.all([
    fetch("https://api.themoviedb.org/3/tv/" + id + "?language=en-US",
      { headers: { Authorization: "Bearer " + key, accept: "application/json" } }).then(r => r.json()),
    fetch("https://api.themoviedb.org/3/tv/" + id + "/external_ids",
      { headers: { Authorization: "Bearer " + key, accept: "application/json" } }).then(r => r.json()),
    fetchNLProvider("tv", id),
  ]);

  const imdbId  = ext.imdb_id || null;
  const year    = show.first_air_date ? show.first_air_date.slice(0, 4) : null;
  const endYear = det.last_air_date   ? det.last_air_date.slice(0, 4)   : null;
  const yearStr = year && endYear && endYear !== year ? year + "-" + endYear : year;

  const voteAvg = det.vote_average || show.vote_average || null;
  return {
    title:             det.name || show.name,
    year:              yearStr,
    genres:            (det.genres || []).map(g => g.name),
    description:       show.overview || det.overview || null,
    imdb_rating:       null,
    tmdb_rating:       voteAvg ? voteAvg.toFixed(1) + "/10" : null,
    imdb_url:          imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null,
    poster_url:        show.poster_path ? "https://image.tmdb.org/t/p/w342" + show.poster_path : null,
    season_count:      det.number_of_seasons || null,
    streaming_service:  prov ? prov.name : null,
    streaming_url:      prov ? prov.url  : null,
    streaming_logo:      prov ? prov.logo : null,
  };
}

// --- Enrich one series: TMDB first, Claude as fallback --------------------
async function enrichOne(title, streamingService) {
  // Try TMDB
  try {
    const t = await tmdbSearch(title);
    if (t && (t.description || t.year || t.genres.length)) return { ...t, source: "tmdb" };
  } catch (_) {}

  // Fallback: Claude AI
  const text = await claude(
    [{ role: "user", content:
      'TV series "' + title + '" on ' + streamingService + '. Return JSON only:\n' +
      '{"year":"YYYY or null","genres":["str"],"desc":"2-3 sentences English","imdb":"X.X/10 or null","imdb_url":"url or null"}'
    }],
    400,
    "Return only a raw JSON object. No markdown."
  );
  const ai = parseJsonObject(text);
  return {
    title, year: ai.year || null, genres: ai.genres || [],
    description: ai.desc || null, imdb_rating: null, tmdb_rating: null,
    imdb_url: ai.imdb_url || null, poster_url: null, source: "claude",
  };
}



// --- Cloud Sync via npoint.io (proxy: /api/sync) -------------------------
const SYNC_ENABLED_KEY = "serieinfo-sync-on";
const getSyncEnabled = () => localStorage.getItem(SYNC_ENABLED_KEY) === "true";
const setSyncEnabled = (v) => localStorage.setItem(SYNC_ENABLED_KEY, v ? "true" : "false");

// Parse response safely  -  returns object or throws readable error
async function parseSync(r) {
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch {
    throw new Error("Server fout (" + r.status + "): " + text.replace(/<[^>]+>/g, "").trim().slice(0, 80));
  }
  if (!r.ok) throw new Error(d.error || "Sync fout " + r.status);
  return d;
}

async function cloudGet() {
  return parseSync(await fetch("/api/sync"));
}
async function cloudPut(data) {
  return parseSync(await fetch("/api/sync", {
    method:  "PUT",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(data),
  }));
}
async function cloudCreate(data) {
  return parseSync(await fetch("/api/sync", {
    method:  "POST",
    headers: { "content-type": "application/json" },
    body:    JSON.stringify(data),
  }));
}

function exportLibrary(library, films) {
  const data = { library, films, exportedAt: new Date().toISOString(), version: 1 };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = "serieinfo-backup.json"; a.click();
  URL.revokeObjectURL(url);
}

// --- Sync Bar Component --------------------------------------------------
// Helper: union-merge two arrays by ID
function unionById(localItems, cloudItems) {
  const cloudById = {};
  cloudItems.forEach(i => { cloudById[i.id] = i; });
  const localIds = new Set(localItems.map(i => i.id));
  const cloudOnly = cloudItems.filter(i => !localIds.has(i.id));
  // Local wins for items in both (latest user action), cloud fills in missing items
  return [...localItems, ...cloudOnly];
}

function SyncBar({ library, films, onImport }) {
  const [enabled,  setEnabled]  = useState(getSyncEnabled);
  const [status,   setStatus]   = useState("idle");
  const [msg,      setMsg]      = useState("");
  const [lastSync, setLastSync] = useState(null);

  // Refs always hold the latest values
  const libRef   = useRef(library);
  const filmsRef = useRef(films);
  useEffect(() => { libRef.current   = library; }, [library]);
  useEffect(() => { filmsRef.current = films;   }, [films]);

  // Auto-sync 2s after any change  -  uses merge-push to never overwrite cloud additions
  useEffect(() => {
    if (!enabled) return;
    if (library.length === 0 && films.length === 0) return;
    const timer = setTimeout(() => doMergePush(), 2000);
    return () => clearTimeout(timer);
  }, [library, films, enabled]);

  // Merge-push: pull cloud first, union-merge, then push back.
  // This guarantees the cloud always ends up with the SUPERSET of all devices.
  async function doMergePush() {
    const localLib   = libRef.current;
    const localFilms = filmsRef.current;
    if (localLib.length === 0 && localFilms.length === 0) return;
    setStatus("syncing"); setMsg("");
    try {
      // 1. Fetch current cloud state
      let cloudLib = [], cloudFilms = [];
      try {
        const d = await cloudGet();
        cloudLib   = Array.isArray(d?.library) ? d.library : [];
        cloudFilms = Array.isArray(d?.films)   ? d.films   : [];
      } catch (_) { /* cloud unreachable: push local only */ }

      // 2. Union-merge: result always contains items from BOTH sides
      const mergedLib   = unionById(localLib,   cloudLib);
      const mergedFilms = unionById(localFilms, cloudFilms);

      // 3. Push merged result to cloud
      const sizeKB = Math.round(JSON.stringify({ library: mergedLib, films: mergedFilms }).length / 1024);
      await cloudPut({ library: mergedLib, films: mergedFilms });

      // 4. Update local state if cloud had extra items not present locally
      if (mergedLib.length > localLib.length || mergedFilms.length > localFilms.length) {
        onImport(mergedLib, mergedFilms);
      }

      setStatus("ok"); setLastSync(new Date());
      setMsg(mergedLib.length + " series, " + mergedFilms.length + " films (" + sizeKB + " KB)");
    } catch (e) {
      setStatus("error"); setMsg(e.message.slice(0, 120));
    }
  }

  async function pullFromCloud() {
    setStatus("syncing"); setMsg("");
    try {
      const d = await cloudGet();
      if (!d || typeof d !== "object") {
        setStatus("error"); setMsg("Ongeldig antwoord van cloud"); return;
      }
      const cloudLib   = Array.isArray(d.library) ? d.library : null;
      const cloudFilms = Array.isArray(d.films)   ? d.films   : null;
      if (!cloudLib && !cloudFilms) {
        setStatus("error"); setMsg("Geen data gevonden"); return;
      }
      onImport(cloudLib || [], cloudFilms || []);
      setStatus("ok"); setLastSync(new Date());
      setMsg((cloudLib?.length || 0) + " series, " + (cloudFilms?.length || 0) + " films geladen");
    } catch (e) {
      setStatus("error"); setMsg(e.message.slice(0, 80));
    }
  }

  function handleToggle() {
    const next = !enabled;
    setEnabled(next); setSyncEnabled(next);
    if (next) pullFromCloud();
  }

  const dot = !enabled ? "off" : { syncing:"syncing", ok:"ok", error:"error" }[status] || "off";
  const time = lastSync ? lastSync.toLocaleTimeString("nl-NL", { hour:"2-digit", minute:"2-digit" }) : "";

  return (
    <div className="sync-bar">
      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        <div className="sync-status">
          <div className={"sync-dot " + dot} />
          {!enabled   && "Cloud sync uitgeschakeld"}
          {enabled && status === "idle"    && "Sync ingeschakeld - wacht op wijziging"}
          {enabled && status === "syncing" && "Bezig met synchroniseren..."}
          {enabled && status === "ok"      && ("Gesynchroniseerd" + (time ? " om " + time : "") + (msg ? " - " + msg : " (" + library.length + " series, " + films.length + " films)"))}
          {enabled && status === "error"   && <span style={{ color:"#dc2626" }}>{"Fout: " + msg}</span>}
        </div>
      </div>
      <div className="sync-actions">
        <button className="sync-btn" onClick={() => exportLibrary(library, films)}>
          Exporteer JSON
        </button>
        <label className="sync-btn" style={{ cursor:"pointer" }} title="Importeer een eerder geexporteerd JSON-bestand">
          Importeer JSON
          <input type="file" accept=".json,application/json" style={{ display:"none" }}
            onChange={e => {
              const file = e.target.files[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = evt => {
                try {
                  const data = JSON.parse(evt.target.result);
                  if (!data.library && !data.films) {
                    alert("Ongeldig bestand: geen library of films gevonden.");
                    return;
                  }
                  onImport(Array.isArray(data.library) ? data.library : [],
                           Array.isArray(data.films)   ? data.films   : []);
                  alert("Import geslaagd: " +
                    (data.library ? data.library.length : 0) + " series, " +
                    (data.films   ? data.films.length   : 0) + " films geladen.");
                } catch {
                  alert("Fout: kon het bestand niet lezen. Is het een geldig SerieInfo JSON-bestand?");
                }
                e.target.value = "";
              };
              reader.readAsText(file);
            }} />
        </label>
        {enabled && (
          <>
            <button className="sync-btn primary" onClick={() => doMergePush()} disabled={status === "syncing"}>
              {status === "syncing" ? "Bezig..." : "Stuur naar cloud"}
            </button>
            <button className="sync-btn" onClick={pullFromCloud} disabled={status === "syncing"}>
              Haal op van cloud
            </button>
          </>
        )}
        <button className={"sync-btn" + (!enabled ? " primary" : "")} onClick={handleToggle}>
          {enabled ? "Sync uitschakelen" : "Sync inschakelen + ophalen"}
        </button>
      </div>
    </div>
  );
}

// --- Film Library Storage -----------------------------------------------
const FILM_KEY = "serieinfo-films";
const loadFilms = () => { try { return JSON.parse(localStorage.getItem(FILM_KEY) || "[]"); } catch { return []; } };
const saveFilms = (items) => { try { localStorage.setItem(FILM_KEY, JSON.stringify(items)); } catch {} };

// --- TMDB Movie Search ---------------------------------------------------
async function tmdbMovieSearch(title) {
  const key = getTmdbKey();
  if (!key) return null;
  const headers = { Authorization: "Bearer " + key, accept: "application/json" };

  const s = await fetch(
    "https://api.themoviedb.org/3/search/movie?query=" + encodeURIComponent(title) + "&language=en-US&page=1",
    { headers }
  );
  const sd = await s.json();
  if (!sd.results || !sd.results.length) return null;

  const movie = sd.results[0];
  const id = movie.id;

  const [det, ext] = await Promise.all([
    fetch("https://api.themoviedb.org/3/movie/" + id + "?language=en-US", { headers }).then(r => r.json()),
    fetch("https://api.themoviedb.org/3/movie/" + id + "/external_ids", { headers }).then(r => r.json()),
  ]);

  const imdbId = ext.imdb_id || null;
  const vote = det.vote_average || movie.vote_average || null;

  return {
    title:       det.title || movie.title,
    year:        (det.release_date || movie.release_date || "").slice(0, 4) || null,
    genres:      (det.genres || []).map(g => g.name),
    description: det.overview || movie.overview || null,
    tmdb_rating: vote ? parseFloat(vote).toFixed(1) + "/10" : null,
    imdb_rating: null,
    imdb_url:    imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null,
    poster_url:  (det.poster_path || movie.poster_path)
                   ? "https://image.tmdb.org/t/p/w342" + (det.poster_path || movie.poster_path)
                   : null,
    tmdb_id:     id,
  };
}

// --- TMDB Movie fetch by ID ---------------------------------------------
async function fetchMovieFromTmdbId(tmdbId) {
  const key = getTmdbKey();
  if (!key) throw new Error("Geen TMDB API-sleutel ingesteld");
  const headers = { Authorization: "Bearer " + key, accept: "application/json" };
  const base = "https://api.themoviedb.org/3/movie/" + tmdbId;

  const [det, ext] = await Promise.all([
    fetch(base + "?language=en-US", { headers }).then(r => r.json()),
    fetch(base + "/external_ids",   { headers }).then(r => r.json()),
  ]);
  if (det.success === false) throw new Error("Film niet gevonden (ID " + tmdbId + ")");

  const imdbId = ext.imdb_id || null;
  const vote   = det.vote_average || null;

  return {
    title:       det.title || null,
    year:        (det.release_date || "").slice(0, 4) || null,
    genres:      (det.genres || []).map(g => g.name),
    description: det.overview || null,
    tmdb_rating: vote ? parseFloat(vote).toFixed(1) + "/10" : null,
    imdb_rating: null,
    imdb_url:    imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null,
    poster_url:  det.poster_path ? "https://image.tmdb.org/t/p/w342" + det.poster_path : null,
    tmdb_id:     det.id,
  };
}


// --- NL streaming provider mapping --------------------------------------
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

async function fetchNLProvider(type, tmdbId) {
  const key = getTmdbKey();
  if (!key) return null;
  try {
    const r = await fetch(
      "https://api.themoviedb.org/3/" + type + "/" + tmdbId + "/watch/providers",
      { headers: { Authorization: "Bearer " + key, accept: "application/json" } }
    );
    const d = await r.json();
    const nl = d.results && d.results.NL;
    if (!nl) return null;
    const flat = nl.flatrate || nl.ads || nl.free || [];
    if (!flat.length) return null;
    const tmdbProvider = flat[0];
    const mapped = NL_PROVIDERS[tmdbProvider.provider_name];
    return {
      name: mapped ? mapped.name : tmdbProvider.provider_name,
      url:  mapped ? mapped.url  : (nl.link || ""),
      logo: tmdbProvider.logo_path ? "https://image.tmdb.org/t/p/w45" + tmdbProvider.logo_path : null,
    };
  } catch { return null; }
}

// Fetch ALL NL watch providers (streaming + rent + buy)
async function fetchAllNLProviders(tmdbId) {
  const key = getTmdbKey();
  if (!key) throw new Error("Geen TMDB API-sleutel ingesteld");
  const r = await fetch(
    "https://api.themoviedb.org/3/movie/" + tmdbId + "/watch/providers",
    { headers: { Authorization: "Bearer " + key, accept: "application/json" } }
  );
  const d = await r.json();
  const nl = d.results && d.results.NL;
  if (!nl) return null;

  function mapList(arr) {
    return (arr || []).map(p => ({
      name: NL_PROVIDERS[p.provider_name]?.name || p.provider_name,
      url:  NL_PROVIDERS[p.provider_name]?.url  || nl.link || "",
      logo: p.logo_path ? "https://image.tmdb.org/t/p/w45" + p.logo_path : null,
    }));
  }

  return {
    link:     nl.link || "",
    flatrate: mapList(nl.flatrate),
    rent:     mapList(nl.rent),
    buy:      mapList(nl.buy),
    free:     mapList(nl.free || nl.ads),
  };
}

// --- TMDB multi-result search (TV) --------------------------------------
async function tmdbSearchResults(query) {
  const key = getTmdbKey();
  if (!key) return [];
  const r = await fetch(
    "https://api.themoviedb.org/3/search/tv?query=" + encodeURIComponent(query) +
    "&language=en-US&page=1",
    { headers: { Authorization: "Bearer " + key, accept: "application/json" } }
  );
  const d = await r.json();
  return (d.results || []).slice(0, 8).map(s => ({
    tmdb_id:     s.id,
    title:       s.name,
    year:        s.first_air_date ? s.first_air_date.slice(0,4) : null,
    description: s.overview ? s.overview.slice(0, 120) + (s.overview.length > 120 ? "..." : "") : null,
    poster_url:  s.poster_path ? "https://image.tmdb.org/t/p/w92" + s.poster_path : null,
    popularity:  s.popularity,
  }));
}

// --- TMDB multi-result search (Movies) ----------------------------------
async function tmdbMovieSearchResults(query) {
  const key = getTmdbKey();
  if (!key) return [];
  const r = await fetch(
    "https://api.themoviedb.org/3/search/movie?query=" + encodeURIComponent(query) +
    "&language=en-US&page=1",
    { headers: { Authorization: "Bearer " + key, accept: "application/json" } }
  );
  const d = await r.json();
  return (d.results || []).slice(0, 8).map(m => ({
    tmdb_id:     m.id,
    title:       m.title,
    year:        m.release_date ? m.release_date.slice(0,4) : null,
    description: m.overview ? m.overview.slice(0, 120) + (m.overview.length > 120 ? "..." : "") : null,
    poster_url:  m.poster_path ? "https://image.tmdb.org/t/p/w92" + m.poster_path : null,
  }));
}

// --- Full TV series details + NL provider --------------------------------
async function tmdbFetchFull(tmdbId) {
  const key = getTmdbKey();
  if (!key) throw new Error("Geen TMDB API-sleutel ingesteld");
  const headers = { Authorization: "Bearer " + key, accept: "application/json" };
  const base = "https://api.themoviedb.org/3/tv/" + tmdbId;
  const [det, ext, prov] = await Promise.all([
    fetch(base + "?language=en-US", { headers }).then(r => r.json()),
    fetch(base + "/external_ids",   { headers }).then(r => r.json()),
    fetchNLProvider("tv", tmdbId),
  ]);
  const imdbId  = ext.imdb_id || null;
  const year    = det.first_air_date ? det.first_air_date.slice(0,4) : null;
  const endYear = det.last_air_date  ? det.last_air_date.slice(0,4)  : null;
  const yearStr = year && endYear && endYear !== year ? year + "-" + endYear : year;
  const vote    = det.vote_average || null;
  return {
    title:             det.name,
    year:              yearStr,
    genres:            (det.genres || []).map(g => g.name),
    description:       det.overview || null,
    tmdb_rating:       vote ? parseFloat(vote).toFixed(1) + "/10" : null,
    imdb_rating:       null,
    imdb_url:          imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null,
    poster_url:        det.poster_path ? "https://image.tmdb.org/t/p/w342" + det.poster_path : null,
    streaming_service: prov ? prov.name : null,
    streaming_url:     prov ? prov.url  : null,
    streaming_logo:    prov ? prov.logo : null,
    season_count:      det.number_of_seasons || null,
  };
}

// --- Service kleuren ------------------------------------------------------
const SVC_COLORS = {
  netflix: "#e50914", "apple tv": "#1c1c1e", max: "#002be0", hbo: "#002be0",
  "prime video": "#00a8e1", amazon: "#00a8e1", disney: "#113ccf",
  skyshowtime: "#8b45ff", npo: "#f07d00",
};
const svcColor = (s = "") => {
  if (!s) return "#888";
  const k = s.toLowerCase();
  for (const [key, c] of Object.entries(SVC_COLORS)) if (k.includes(key)) return c;
  return "#888";
};

// --- Season-based watched helpers ----------------------------------------
// A series with season_count tracks per-season progress in watched_seasons.
// Without season_count (legacy items, films) it falls back to the old
// single `watched` boolean.
function isFullyWatched(item) {
  // Only use per-season tracking for multi-season series (>1).
  // Single-season series and legacy items use the simple `watched` boolean,
  // matching the checkbox toggle logic.
  if (item.season_count && item.season_count > 1) {
    return (item.watched_seasons || []).length >= item.season_count;
  }
  return !!item.watched;
}
function watchedSeasonCount(item) {
  return (item.watched_seasons || []).length;
}

// --- Duplicate detection & merging ---------------------------------------
function normalizeTitle(t) {
  return (t || "").toLowerCase().trim().replace(/\s+/g, " ");
}

// Higher score = more complete data
function detailScore(item) {
  let score = 0;
  if (item.year) score++;
  if (item.genres && item.genres.length) score += item.genres.length;
  if (item.description) score += item.description.length > 20 ? 2 : 1;
  if (item.tmdb_rating) score++;
  if (item.imdb_rating) score++;
  if (item.imdb_url) score++;
  if (item.poster_url) score++;
  if (item.season_count) score++;
  if (item.streaming_service) score++;
  if (item.streaming_url) score++;
  if (item.enriched) score++;
  return score;
}

// Find groups of items sharing the same normalized title (only groups with 2+)
function findDuplicateGroups(library) {
  const byTitle = {};
  library.forEach(item => {
    const key = normalizeTitle(item.title);
    if (!key) return;
    if (!byTitle[key]) byTitle[key] = [];
    byTitle[key].push(item);
  });
  return Object.values(byTitle)
    .filter(group => group.length > 1)
    .map(group => [...group].sort((a, b) => detailScore(b) - detailScore(a)));
}

// Merge a duplicate group into one item: best available field per slot,
// watched status is OR-merged (union) so progress is never lost.
function mergeDuplicateGroup(sortedGroup) {
  const base = { ...sortedGroup[0] }; // highest-scoring item as primary identity
  for (const it of sortedGroup) {
    if (!base.year && it.year) base.year = it.year;
    if ((!base.genres || !base.genres.length) && it.genres && it.genres.length) base.genres = it.genres;
    if (!base.description || (it.description && it.description.length > base.description.length)) base.description = it.description || base.description;
    if (!base.tmdb_rating && it.tmdb_rating) base.tmdb_rating = it.tmdb_rating;
    if (!base.imdb_rating && it.imdb_rating) base.imdb_rating = it.imdb_rating;
    if (!base.imdb_url && it.imdb_url) base.imdb_url = it.imdb_url;
    if (!base.poster_url && it.poster_url) base.poster_url = it.poster_url;
    if (!base.season_count && it.season_count) base.season_count = it.season_count;
    if (!base.streaming_service && it.streaming_service) base.streaming_service = it.streaming_service;
    if (!base.streaming_url && it.streaming_url) base.streaming_url = it.streaming_url;
  }
  base.watched_seasons = [...new Set(sortedGroup.flatMap(i => i.watched_seasons || []))].sort((a, b) => a - b);
  base.watched = sortedGroup.some(i => i.watched) || base.watched;
  return base;
}

function parseJsonArray(text) {
  const s = text.indexOf("["), e = text.lastIndexOf("]");
  if (s === -1 || e === -1) throw new Error("Geen JSON array gevonden");
  return JSON.parse(text.slice(s, e + 1));
}
function parseJsonObject(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("Geen JSON object gevonden");
  return JSON.parse(text.slice(s, e + 1));
}

// --- Import lijst ---------------------------------------------------------
const IMPORT_LIST = [
  ["Unfamiliar","Netflix","https://www.netflix.com"],
  ["Your Friends & Neighbors","Apple TV+","https://tv.apple.com"],
  ["Dept Q Season 2","Netflix","https://www.netflix.com"],
  ["Ballard","Prime Video","https://www.primevideo.com"],
  ["The Assassin","Prime Video","https://www.primevideo.com"],
  ["Under Salt Marsh","SkyShowtime","https://www.skyshowtime.com"],
  ["Salvador","Netflix","https://www.netflix.com"],
  ["Imperfect Women","Apple TV+","https://tv.apple.com"],
  ["A Knight of the Seven Kingdoms: The Hedge Knight","Max","https://www.max.com"],
  ["The Madison","SkyShowtime","https://www.skyshowtime.com"],
  ["Slow Horses Season 5","Apple TV+","https://tv.apple.com"],
  ["Mobland Season 2","SkyShowtime","https://www.skyshowtime.com"],
  ["The Night Manager","Prime Video","https://www.primevideo.com"],
  ["Unconditional","Apple TV+","https://tv.apple.com"],
  ["The Excavation","NPO","https://www.npo.nl"],
  ["Drops of God Season 2","Apple TV+","https://tv.apple.com"],
  ["The Diplomat Season 3","Netflix","https://www.netflix.com"],
  ["American Primeval","Netflix","https://www.netflix.com"],
  ["Dark Winds","SkyShowtime","https://www.skyshowtime.com"],
  ["The Chair Company","Max","https://www.max.com"],
  ["Fire Country","Prime Video","https://www.primevideo.com"],
  ["The Secret Agent","Netflix","https://www.netflix.com"],
  ["Cry Wolf","Apple TV+","https://tv.apple.com"],
  ["Mr Mercedes Season 2","SkyShowtime","https://www.skyshowtime.com"],
  ["All Her Fault","SkyShowtime","https://www.skyshowtime.com"],
  ["We Own This City","Max","https://www.max.com"],
  ["Deadloch","Prime Video","https://www.primevideo.com"],
  ["Vaka","Prime Video","https://www.primevideo.com"],
  ["The Night Agent","Netflix","https://www.netflix.com"],
  ["This Town","NPO","https://www.npo.nl"],
  ["How to Get to Heaven from Belfast","Netflix","https://www.netflix.com"],
  ["His & Hers","Netflix","https://www.netflix.com"],
  ["Black Snow","Netflix","https://www.netflix.com"],
  ["Deadwind","Netflix","https://www.netflix.com"],
  ["Nero the Assassin","Netflix","https://www.netflix.com"],
  ["Chief of War","Apple TV+","https://tv.apple.com"],
  ["DTF St Louis","Max","https://www.max.com"],
  ["Patience","NPO","https://www.npo.nl"],
  ["Harry Hole","Netflix","https://www.netflix.com"],
  ["Industry","Max","https://www.max.com"],
  ["Parish","Netflix","https://www.netflix.com"],
  ["I Jack Wright","Max","https://www.max.com"],
  ["Last Frontier","Apple TV+","https://tv.apple.com"],
  ["Allegiance","Netflix","https://www.netflix.com"],
  ["Day One","Prime Video","https://www.primevideo.com"],
  ["Fallen","NPO","https://www.npo.nl"],
  ["Widow Bay","Apple TV+","https://tv.apple.com"],
  ["Rooster","Max","https://www.max.com"],
  ["Steal","Prime Video","https://www.primevideo.com"],
  ["Memory of a Killer","Prime Video","https://www.primevideo.com"],
  ["Land of Sin","Netflix","https://www.netflix.com"],
  ["The Enemy Within","Netflix","https://www.netflix.com"],
  ["Untamed","Netflix","https://www.netflix.com"],
  ["The Survivors","Netflix","https://www.netflix.com"],
  ["Sara","Netflix","https://www.netflix.com"],
  ["Seven Dials Mystery","Netflix","https://www.netflix.com"],
  ["The Last Thing He Told Me","Apple TV+","https://tv.apple.com"],
  ["After the Flood","NPO","https://www.npo.nl"],
  ["The Waterfront","Netflix","https://www.netflix.com"],
  ["The Madness","Netflix","https://www.netflix.com"],
  ["The Asset","Netflix","https://www.netflix.com"],
  ["The Huntsman","Netflix","https://www.netflix.com"],
  ["The Crystal Cuckoo","Netflix","https://www.netflix.com"],
  ["Scarpetta","Prime Video","https://www.primevideo.com"],
  ["Under a Dark Sun","Netflix","https://www.netflix.com"],
  ["Breaking Bad","Netflix","https://www.netflix.com"],
  ["House of David","Prime Video","https://www.primevideo.com"],
  ["Halfman","Max","https://www.max.com"],
  ["The Marshalls","SkyShowtime","https://www.skyshowtime.com"],
  ["Dutton Ranch","SkyShowtime","https://www.skyshowtime.com"],
  ["Made with Love","Netflix","https://www.netflix.com"],
  ["SkyMed","Netflix","https://www.netflix.com"],
  ["Paradise","Disney+","https://www.disneyplus.com"],
  ["The House of Spirits","Prime Video","https://www.primevideo.com"],
  ["The Affair","Prime Video","https://www.primevideo.com"],
  ["The Lowdown","Disney+","https://www.disneyplus.com"],
  ["A Thousand Blows","Disney+","https://www.disneyplus.com"],
  ["Legends","Netflix","https://www.netflix.com"],
  ["Triggerpoint","NPO","https://www.npo.nl"],
  ["Servant","Apple TV+","https://tv.apple.com"],
  ["City of Fire","Apple TV+","https://tv.apple.com"],
  ["Beef","Netflix","https://www.netflix.com"],
].map(([title, svc, url]) => ({ title, streaming_service: svc, streaming_url: url }));

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
const BATCHES = chunk(IMPORT_LIST, 5);

// --- CSS ------------------------------------------------------------------



// --- PIN storage ----------------------------------------------------------
const PIN_KEY = "serieinfo-pin";
const getPin = () => { try { return localStorage.getItem(PIN_KEY) || ""; } catch { return ""; } };
const savePin = (p) => { try { localStorage.setItem(PIN_KEY, p); } catch {} };

// --- usePinGuard hook -----------------------------------------------------
// Returns { guard, PinGate }  -  call guard(callback) to require PIN first
function usePinGuard() {
  const [pending, setPending] = useState(null); // { cb }
  const [setting, setSetting] = useState(false);

  function guard(cb) {
    const pin = getPin();
    if (!pin) { setSetting(true); setPending({ cb }); return; }
    setPending({ cb });
  }

  function PinGate() {
    const pin = getPin();

    // Setup: no PIN yet
    if (setting) return (
      <PinSetup onDone={(p) => { savePin(p); setSetting(false); if (pending) { pending.cb(); setPending(null); } }} onCancel={() => { setSetting(false); setPending(null); }} />
    );

    if (!pending) return null;

    return (
      <PinVerify pin={pin} onSuccess={() => { pending.cb(); setPending(null); }} onCancel={() => setPending(null)} />
    );
  }

  return { guard, PinGate };
}

// --- PIN Setup modal ------------------------------------------------------
function PinSetup({ onDone, onCancel }) {
  const [step, setStep] = useState(1); // 1=enter, 2=confirm
  const [first, setFirst] = useState("");
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");

  function submit() {
    if (val.length < 4) { setErr("Minimaal 4 cijfers"); return; }
    if (step === 1) { setFirst(val); setVal(""); setStep(2); setErr(""); return; }
    if (val !== first) { setErr("Pincode komt niet overeen"); setVal(""); return; }
    onDone(val);
  }

  const content = (
    <div className="pin-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="pin-modal">
        <div className="pin-title">[PIN] Pincode instellen</div>
        <div className="pin-sub">{step === 1 ? "Kies een pincode van minimaal 4 cijfers." : "Bevestig de pincode."}</div>
        <input className="pin-setup-input" type="password" inputMode="numeric" maxLength={8}
          placeholder="****" value={val} autoFocus
          onChange={e => { setVal(e.target.value.replace(/\D/g, "")); setErr(""); }}
          onKeyDown={e => e.key === "Enter" && submit()} />
        {err && <div className="pin-err">{err}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-primary" style={{ flex: 1 }} onClick={submit}>{step === 1 ? "Volgende" : "Opslaan"}</button>
          <button className="btn-secondary" onClick={onCancel}>Annuleer</button>
        </div>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}

// --- PIN Verify modal -----------------------------------------------------
function PinVerify({ pin, onSuccess, onCancel }) {
  const [input, setInput] = useState("");
  const [err, setErr] = useState(false);

  function press(d) {
    if (input.length >= pin.length) return;
    const next = input + d;
    setInput(next);
    setErr(false);
    if (next.length === pin.length) {
      if (next === pin) { setTimeout(onSuccess, 120); }
      else { setTimeout(() => { setInput(""); setErr(true); }, 300); }
    }
  }

  const dots = Array.from({ length: pin.length }, (_, i) => (
    <div key={i} className={"pin-dot" + (input.length > i ? (err ? " error" : " filled") : "")} />
  ));

  const content = (
    <div className="pin-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="pin-modal">
        <div className="pin-title">[PIN] Pincode vereist</div>
        <div className="pin-sub">Voer de pincode in om door te gaan.</div>
        <div className="pin-dots">{dots}</div>
        <div className="pin-grid">
          {[1,2,3,4,5,6,7,8,9].map(n => <button key={n} className="pin-btn" onClick={() => press(String(n))}>{n}</button>)}
          <div />
          <button className="pin-btn" onClick={() => press("0")}>0</button>
          <button className="pin-btn" onClick={() => setInput(i => i.slice(0,-1))}>Del</button>
        </div>
        {err && <div className="pin-err">Onjuiste pincode, probeer opnieuw.</div>}
        <button className="pin-clear" onClick={onCancel}>Annuleer</button>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}

// --- Detail Modal (via Portal  -  altijd zichtbaar in viewport) -------------
function DetailModal({ item, onClose, onDelete }) {
  const { guard, PinGate } = usePinGuard();

  // Vergrendel scrollen en scroll naar boven zodra modal opent
  useEffect(() => {
    window.scrollTo({ top: 0 });
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const content = (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>x</button>
        <div className="modal-header">
          <div className="modal-title">{item.title}</div>
          <div className="svc-chip">
            {item.streaming_logo
              ? <img src={item.streaming_logo} alt={item.streaming_service || ""} className="svc-logo" />
              : <div className="svc-dot" style={{ background: svcColor(item.streaming_service) }} />}
            <span className="svc-name">{item.streaming_service}</span>
          </div>
        </div>
        <div className="modal-body">
          <div className="rmeta">
            {item.year && <span className="ytag">{item.year}</span>}
            {item.season_count && <span className="ytag">{item.season_count} seizoen{item.season_count > 1 ? "en" : ""}</span>}
            {(item.genres || []).map(g => <span key={g} className="tag">{g}</span>)}
          </div>
          {item.description && <p className="rdesc">{item.description}</p>}
          {item.season_count > 1 && (
            <div style={{ fontSize:13, color:"#57534e" }}>
              {watchedSeasonCount(item)} van {item.season_count} seizoenen bekeken
            </div>
          )}
          <div className="rratings">
            <div className="rbox"><div><div className="rl">TMDB</div><div className={"rv " + (item.tmdb_rating ? "tmdb" : "none")}>{item.tmdb_rating || "N/B"}</div></div></div>
              {/* RT verwijderd */}
          </div>
          <div className="rlinks">
            {item.streaming_url && <a href={item.streaming_url} target="_blank" rel="noopener noreferrer" className="lb primary">Bekijk op {item.streaming_service}</a>}
            {item.imdb_url && <a href={item.imdb_url} target="_blank" rel="noopener noreferrer" className="lb sec">IMDb</a>}
              {/* RT link verwijderd */}
            <button className="lb sec" style={{ color: "#dc3545", borderColor: "#f5a0a8" }} onClick={() => guard(() => { onDelete(item.id); onClose(); })}>[del] Verwijder</button>
          </div>
        </div>
        <div className="modal-footer">Opgeslagen op {new Date(item.savedAt).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })}</div>
      </div>
    </div>
  );

  // Render buiten de DOM-boom  -  altijd boven alles, ongeacht scrollpositie
  return <>
    {createPortal(content, document.body)}
    <PinGate />
  </>;
}


// --- Extract IMDb title ID from URL --------------------------------------
function extractImdbId(url) {
  const m = (url || "").match(/tt\d{7,}/);
  return m ? m[0] : null;
}

// --- Extract TMDB TV ID from URL ------------------------------------------
function extractTmdbId(url) {
  const m = (url || "").match(/\/tv\/([0-9]+)/);
  return m ? m[1] : null;
}


// Detect TV or movie from TMDB URL
function parseTmdbUrl(url) {
  const tv = (url || "").match(/\/tv\/([0-9]+)/);
  if (tv) return { id: tv[1], type: "tv" };
  const mv = (url || "").match(/\/movie\/([0-9]+)/);
  if (mv) return { id: mv[1], type: "movie" };
  return { id: null, type: null };
}
// --- Fetch from specific TMDB ID -----------------------------------------
async function fetchFromTmdbId(tmdbId) {
  const key = getTmdbKey();
  if (!key) throw new Error("Geen TMDB API-sleutel ingesteld");

  const headers = { Authorization: "Bearer " + key, accept: "application/json" };
  const base = "https://api.themoviedb.org/3/tv/" + tmdbId;

  const [det, ext, prov] = await Promise.all([
    fetch(base + "?language=en-US", { headers }).then(r => r.json()),
    fetch(base + "/external_ids",   { headers }).then(r => r.json()),
    fetchNLProvider("tv", tmdbId),
  ]);

  if (det.success === false) throw new Error("Serie niet gevonden op TMDB (ID " + tmdbId + ")");

  const year    = det.first_air_date ? det.first_air_date.slice(0, 4) : null;
  const endYear = det.last_air_date  ? det.last_air_date.slice(0, 4)  : null;
  const yearStr = year && endYear && endYear !== year ? year + "-" + endYear : year;
  const imdbId  = ext.imdb_id || null;

  const voteAvg = det.vote_average || null;
  return {
    title:             det.name || null,
    year:              yearStr,
    genres:            (det.genres || []).map(g => g.name),
    description:       det.overview || null,
    imdb_rating:       null,
    tmdb_rating:       voteAvg ? voteAvg.toFixed(1) + "/10" : null,
    imdb_url:          imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null,
    poster_url:        det.poster_path ? "https://image.tmdb.org/t/p/w342" + det.poster_path : null,
    season_count:      det.number_of_seasons || null,
    streaming_service: prov ? prov.name : null,
    streaming_url:     prov ? prov.url  : null,
    streaming_logo:    prov ? prov.logo : null,
    source:            "tmdb",
  };
}

// --- Fetch series data using IMDb URL -------------------------------------
async function fetchFromImdbUrl(imdbUrl, fallbackTitle) {
  const imdbId = extractImdbId(imdbUrl);

  const userMsg = imdbId
    ? 'Find the TV series with IMDb ID ' + imdbId + '.' + (fallbackTitle ? ' Title hint: "' + fallbackTitle + '".' : '')
    : 'Find the TV series at IMDb URL: ' + imdbUrl + '.' + (fallbackTitle ? ' Title hint: "' + fallbackTitle + '".' : '');

  const system =
    'You are a JSON-only API. You MUST respond with a single raw JSON object and nothing else. ' +
    'No explanation, no markdown, no code fences. Just the JSON object starting with { and ending with }.';

  const prompt =
    userMsg + '\n\n' +
    'Return this JSON object with accurate data:\n' +
    '{ "title": "...", "year": "YYYY or YYYY-YYYY or null", "genres": ["..."], ' +
    '"desc": "2-3 sentence English plot description", ' +
    '"imdb": "X.X/10 or null", "imdb_url": "' + imdbUrl + '" }';

  const text = await claude([{ role: "user", content: prompt }], 500, system);

  // Try to extract JSON even if there's surrounding text
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) {
    throw new Error("AI gaf geen JSON terug. Antwoord: " + text.slice(0, 100));
  }
  return JSON.parse(text.slice(s, e + 1));
}

// --- Single series AI re-search -------------------------------------------
async function researchSeries(title, streamingService) {
  const prompt =
    'You are a TV series expert. Find accurate information for the TV series "' + title + '" available on ' + streamingService + '.\n\n' +
    'Return ONLY a raw JSON object:\n' +
    '{"year":"YYYY or YYYY-YYYY or null","genres":["string"],' +
    '"desc":"2-3 sentences English description of the actual plot","imdb":"X.X/10 or null",' +
    '"imdb_url":"https://www.imdb.com/title/ttXXXXXXX/ or null"}\n\n' +
    'Be accurate. If uncertain about a field return null. Start with { and end with }.';

  const text = await claude([{ role: "user", content: prompt }], 600, "You are a JSON-only API. Respond with raw JSON only. No explanation, no markdown, no code fences.");
  return parseJsonObject(text);
}

// --- Edit Modal ------------------------------------------------------------
// --- Duplicates Modal ------------------------------------------------------
function DuplicatesModal({ library, onResolve, onClose }) {
  const groups = useMemo(() => findDuplicateGroups(library), [library]);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  const totalToRemove = groups.reduce((sum, g) => sum + (g.length - 1), 0);

  function handleConfirm() {
    const plan = groups.map(group => ({
      merged:    mergeDuplicateGroup(group),
      removeIds: group.slice(1).map(i => i.id),
      keepId:    group[0].id,
    }));
    onResolve(plan);
    setResolved(true);
  }

  const content = (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>x</button>
        <div className="modal-header">
          <div className="modal-title">Duplicaten controleren</div>
        </div>
        <div className="modal-body">
          {groups.length === 0 ? (
            <p style={{ fontSize:14, color:"#78716c" }}>Geen duplicaten gevonden. Elke titel komt maar 1 keer voor.</p>
          ) : resolved ? (
            <p style={{ fontSize:14, color:"#16a34a" }}>v {totalToRemove} duplicaten verwijderd en samengevoegd.</p>
          ) : (
            <>
              <p style={{ fontSize:13, color:"#78716c", lineHeight:1.6 }}>
                <strong>{groups.length}</strong> titel{groups.length !== 1 ? "s" : ""} met duplicaten gevonden ({totalToRemove} te verwijderen).
                De meest volledige versie wordt behouden; bekeken-status van alle versies wordt samengevoegd.
              </p>
              <div style={{ display:"flex", flexDirection:"column", gap:14, maxHeight:"50vh", overflowY:"auto" }}>
                {groups.map((group, gi) => (
                  <div key={gi} style={{ border:"1.5px solid #f3f2f0", borderRadius:12, padding:12 }}>
                    <div style={{ fontFamily:"Playfair Display,serif", fontWeight:700, fontSize:15, marginBottom:8 }}>
                      {group[0].title}
                    </div>
                    {group.map((item, idx) => (
                      <div key={item.id} style={{
                        display:"flex", alignItems:"center", gap:8, padding:"6px 0",
                        opacity: idx === 0 ? 1 : .55,
                      }}>
                        <span style={{
                          fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:5,
                          background: idx === 0 ? "#dcfce7" : "#fef2f2",
                          color:      idx === 0 ? "#16a34a" : "#dc2626",
                          flexShrink:0,
                        }}>
                          {idx === 0 ? "BEHOUDEN" : "VERWIJDEREN"}
                        </span>
                        <span style={{ fontSize:12, color:"#57534e" }}>
                          {item.year || "geen jaar"} - score {detailScore(item)}
                          {item.streaming_service ? " - " + item.streaming_service : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          {groups.length > 0 && !resolved && (
            <button className="btn-primary" style={{ flex:1 }} onClick={handleConfirm}>
              Verwijder {totalToRemove} duplicaten
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            {resolved || groups.length === 0 ? "Sluiten" : "Annuleren"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

function EditModal({ item, onSave, onClose }) {
  const { guard, PinGate } = usePinGuard();
  const [form, setForm] = useState({
    year:         item.year         || "",
    genres:       (item.genres || []).join(", "),
    description:  item.description  || "",
    imdb_rating:  item.imdb_rating  || "",
    tmdb_rating:  item.tmdb_rating  || "",
    imdb_url:     item.imdb_url     || "",
    season_count: item.season_count || "",
  });
  const [searching,     setSearching]     = useState(false);
  const [searchErr,     setSearchErr]     = useState("");
  const [searchOk,      setSearchOk]      = useState(false);
  const [imdbFetching,  setImdbFetching]  = useState(false);
  const [imdbFetchErr,  setImdbFetchErr]  = useState("");
  const [imdbFetchOk,   setImdbFetchOk]   = useState(false);
  const [tmdbUrl,       setTmdbUrl]       = useState("");
  const [tmdbFetching,  setTmdbFetching]  = useState(false);
  const [tmdbFetchErr,  setTmdbFetchErr]  = useState("");
  const [tmdbFetchOk,   setTmdbFetchOk]   = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  async function doResearch() {
    setSearching(true); setSearchErr(""); setSearchOk(false);
    try {
      const data = await enrichOne(item.title, item.streaming_service);
      setForm(f => ({
        ...f,
        year:         data.year         || f.year,
        genres:       data.genres?.length ? data.genres.join(", ") : f.genres,
        description:  data.description  || f.description,
        tmdb_rating:  data.tmdb_rating  || f.tmdb_rating,
        imdb_url:     data.imdb_url     || f.imdb_url,
        season_count: data.season_count || f.season_count,
      }));
      const src = data.source === "tmdb" ? "v Gevonden via TMDB" : "v Gevonden via AI";
      setSearchOk(src);
    } catch (e) {
      setSearchErr(e.message || "Zoeken mislukt");
    } finally {
      setSearching(false);
    }
  }

  async function doImdbFetch() {
    if (!form.imdb_url.trim()) return;
    setImdbFetching(true); setImdbFetchErr(""); setImdbFetchOk(false);
    try {
      const ai = await fetchFromImdbUrl(form.imdb_url.trim(), item.title);
      setForm(f => ({
        ...f,
        year:        ai.year  || f.year,
        genres:      Array.isArray(ai.genres) && ai.genres.length ? ai.genres.join(", ") : f.genres,
        description: ai.desc  || f.description,
        imdb_rating: ai.imdb  || f.imdb_rating,
        imdb_url:    form.imdb_url.trim(),
      }));
      setImdbFetchOk(true);
    } catch (e) { setImdbFetchErr(e.message || "Ophalen mislukt"); }
    finally { setImdbFetching(false); }
  }

  async function doTmdbFetch() {
    const id = extractTmdbId(tmdbUrl.trim());
    if (!id) { setTmdbFetchErr("Geen geldig TMDB-ID in de URL"); return; }
    setTmdbFetching(true); setTmdbFetchErr(""); setTmdbFetchOk(false);
    try {
      const data = await fetchFromTmdbId(id);
      setForm(f => ({
        ...f,
        year:        data.year        || f.year,
        genres:      data.genres?.length ? data.genres.join(", ") : f.genres,
        description: data.description || f.description,
        imdb_url:    data.imdb_url    || f.imdb_url,
        tmdb_rating: data.tmdb_rating || f.tmdb_rating,
      }));
      setTmdbFetchOk("v Gevonden: " + (data.title || "onbekend") + (data.year ? " (" + data.year + ")" : ""));
    } catch (e) { setTmdbFetchErr(e.message || "Ophalen mislukt"); }
    finally { setTmdbFetching(false); }
  }

  function handleSave() {
    guard(() => {
      onSave({
        ...item,
        year:         form.year         || null,
        genres:       form.genres ? form.genres.split(",").map(g => g.trim()).filter(Boolean) : [],
        description:  form.description  || null,
        imdb_rating:  form.imdb_rating  || null,
        imdb_url:     form.imdb_url     || null,
        tmdb_rating:  form.tmdb_rating  || null,
        season_count: form.season_count ? parseInt(form.season_count, 10) || null : null,
        enriched:     true,
      });
      onClose();
    });
  }

  const inp = (label, key) => (
    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
      <label style={{ fontSize:11, letterSpacing:".15em", textTransform:"uppercase", color:"#6e6e73", fontWeight:600 }}>{label}</label>
      <input
        style={{ background:"#f5f5f7", border:"1.5px solid #e5e5ea", borderRadius:8,
                 color:"#1a1a2e", fontFamily:"Inter,sans-serif", fontSize:14,
                 padding:"9px 12px", outline:"none", width:"100%" }}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
      />
    </div>
  );

  const content = (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth:660, display:"flex", flexDirection:"column", gap:0 }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between",
                      gap:12, marginBottom:16, paddingRight:36 }}>
          <div style={{ fontFamily:"'Bebas Neue',sans-serif", fontSize:"clamp(22px,3vw,32px)",
                        letterSpacing:".03em", color:"#1a1a2e", lineHeight:1.05 }}>
            {item.title}
          </div>
          <div className="svc-chip">
            <div className="svc-dot" style={{ background: svcColor(item.streaming_service) }} />
            <span className="svc-name">{item.streaming_service}</span>
          </div>
        </div>
        <button className="modal-close" onClick={onClose}>x</button>

        {/* AI re-search  -  always visible at top */}
        <div style={{ background:"#f0f7ff", border:"1.5px solid #b8d4f0", borderRadius:10,
                      padding:"14px 16px", marginBottom:18,
                      display:"flex", alignItems:"center", justifyContent:"space-between",
                      gap:12, flexWrap:"wrap" }}>
          <div>
            <div style={{ fontSize:14, fontWeight:600, color:"#1a1a2e", marginBottom:3 }}>
              [zoek] AI Herzoeken
            </div>
            <div style={{ fontSize:12, color:"#6e6e73" }}>
              Haal automatisch nieuwe gegevens op voor deze serie
            </div>
            {searchErr && <div style={{ fontSize:12, color:"#c82333", marginTop:4 }}>! {searchErr}</div>}
            {searchOk  && <div style={{ fontSize:12, color:"#28a745", marginTop:4 }}>{searchOk}</div>}
          </div>
          <button
            onClick={doResearch}
            disabled={searching}
            style={{ background: searching ? "#b8d4f0" : "#0066cc", border:"none", borderRadius:7,
                     color:"#fff", fontFamily:"Inter,sans-serif", fontSize:13, fontWeight:600,
                     padding:"9px 18px", cursor: searching ? "not-allowed" : "pointer",
                     display:"flex", alignItems:"center", gap:6, flexShrink:0 }}
          >
            {searching ? <><span className="spin" style={{ borderTopColor:"#fff" }} />Zoeken...</> : "Zoek opnieuw"}
          </button>
        </div>

        {/* Editable fields */}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

          {/* TMDB URL lookup */}
          <div style={{ background:"#f0f7ff", border:"1.5px solid #b8d4f0", borderRadius:9, padding:"12px 14px" }}>
            <div style={{ fontSize:12, fontWeight:600, color:"#1a1a2e", marginBottom:6 }}>
              [film] TMDB URL <span style={{ fontWeight:400, color:"#6e6e73" }}> -  plak de themoviedb.org URL om gegevens op te halen</span>
            </div>
            <div style={{ display:"flex", gap:7, alignItems:"center", flexWrap:"wrap" }}>
              <input
                style={{ flex:1, minWidth:200, background:"#fff", border:"1.5px solid #b8d4f0",
                         borderRadius:7, color:"#1a1a2e", fontFamily:"Inter,sans-serif",
                         fontSize:13, padding:"8px 11px", outline:"none" }}
                placeholder="https://www.themoviedb.org/tv/262262-under-salt-marsh"
                value={tmdbUrl}
                onChange={e => { setTmdbUrl(e.target.value); setTmdbFetchErr(""); setTmdbFetchOk(false); }}
                onKeyDown={e => e.key === "Enter" && doTmdbFetch()}
              />
              <button onClick={doTmdbFetch} disabled={tmdbFetching || !tmdbUrl}
                style={{ background: !tmdbUrl ? "#ccc" : tmdbFetching ? "#7bb3e0" : "#0066cc",
                         border:"none", borderRadius:7, color:"#fff", fontFamily:"Inter,sans-serif",
                         fontSize:13, fontWeight:600, padding:"8px 16px",
                         cursor: !tmdbUrl || tmdbFetching ? "not-allowed" : "pointer",
                         display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
                {tmdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff", width:11, height:11 }} />Ophalen...</> : "[film] Haal op via TMDB"}
              </button>
            </div>
            {tmdbFetchErr && <div style={{ fontSize:11, color:"#c82333", marginTop:5 }}>! {tmdbFetchErr}</div>}
            {tmdbFetchOk  && <div style={{ fontSize:11, color:"#28a745", marginTop:5 }}>{tmdbFetchOk}</div>}
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12 }}>
            {inp("Jaar", "year")}
            {inp("Genres (komma-gescheiden)", "genres")}
            {inp("Aantal seizoenen", "season_count")}
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
            <label style={{ fontSize:11, letterSpacing:".15em", textTransform:"uppercase", color:"#6e6e73", fontWeight:600 }}>Omschrijving</label>
            <textarea rows={3}
              style={{ background:"#f5f5f7", border:"1.5px solid #e5e5ea", borderRadius:8,
                       color:"#1a1a2e", fontFamily:"Inter,sans-serif", fontSize:14,
                       padding:"9px 12px", outline:"none", resize:"vertical", lineHeight:1.6, width:"100%" }}
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {inp("TMDB score (bv. 7.4/10)", "tmdb_rating")}
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              <label style={{ fontSize:11, letterSpacing:".15em", textTransform:"uppercase",
                              color: form.imdb_url ? "#6e6e73" : "#dc3545", fontWeight:600 }}>
                IMDb URL{!form.imdb_url && " ! ontbreekt"}
              </label>
              <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                <input
                  style={{ background: form.imdb_url ? "#f5f5f7" : "#fff8f8",
                           border: "1.5px solid " + (form.imdb_url ? "#e5e5ea" : "#f5a0a8"),
                           borderRadius:8, color:"#1a1a2e", fontFamily:"Inter,sans-serif",
                           fontSize:13, padding:"9px 12px", outline:"none", flex:1, minWidth:160 }}
                  placeholder="https://www.imdb.com/title/tt..."
                  value={form.imdb_url}
                  onChange={e => { setForm(f => ({ ...f, imdb_url: e.target.value })); setImdbFetchErr(""); setImdbFetchOk(false); }}
                  onKeyDown={e => e.key === "Enter" && doImdbFetch()}
                />
                {form.imdb_url && (
                  <button onClick={doImdbFetch} disabled={imdbFetching}
                    style={{ background: imdbFetching ? "#bbb" : "#f5a623", border:"none",
                             borderRadius:6, color:"#fff", fontFamily:"Inter,sans-serif",
                             fontSize:12, fontWeight:600, padding:"9px 13px",
                             cursor: imdbFetching ? "not-allowed" : "pointer",
                             display:"flex", alignItems:"center", gap:4, flexShrink:0 }}>
                    {imdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff", width:11, height:11 }} />Ophalen...</> : "* Haal op"}
                  </button>
                )}
                {form.imdb_url && (
                  <a href={form.imdb_url} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize:12, color:"#0066cc", whiteSpace:"nowrap", textDecoration:"none", padding:"9px 4px" }}>^</a>
                )}
              </div>
              {imdbFetchErr && <div style={{ fontSize:11, color:"#c82333" }}>! {imdbFetchErr}</div>}
              {imdbFetchOk  && <div style={{ fontSize:11, color:"#28a745" }}>v Gegevens opgehaald via IMDb ID</div>}
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display:"flex", gap:8, marginTop:20 }}>
          <button className="btn-primary" style={{ flex:1 }} onClick={handleSave}>
            [PIN] Opslaan
          </button>
          <button className="btn-secondary" onClick={onClose}>Annuleer</button>
        </div>

      </div>
    </div>
  );

  return <>
    {createPortal(content, document.body)}
    <PinGate />
  </>;
}


// --- Library ---------------------------------------------------------------
function LibraryPage({ library, enrichingIds, onDelete, onToggleWatched, onToggleSeason, onMarkAllSeasons, onUpdate, onGo, onDeduplicate }) {
  const { guard, PinGate } = usePinGuard();
  const [q, setQ] = useState("");
  const [svc, setSvc] = useState("");
  const [sort, setSort] = useState("recent");
  const [hideWatched, setHideWatched] = useState(false);
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showDupes, setShowDupes] = useState(false);

  useEffect(() => { if (sel) setSel(library.find(i => i.id === sel.id) || null); }, [library]);

  const watchedCount = library.filter(isFullyWatched).length;
  const svcs = [...new Set(library.map(i => i.streaming_service).filter(Boolean))].sort();
  let list = library.filter(item => {
    const lq = q.toLowerCase();
    return (!lq || item.title?.toLowerCase().includes(lq) || (item.genres || []).some(g => g.toLowerCase().includes(lq)) || item.description?.toLowerCase().includes(lq))
      && (!svc || item.streaming_service === svc)
      && (!hideWatched || !isFullyWatched(item));
  });
  if (sort === "az") list = [...list].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  if (sort === "imdb") list = [...list].sort((a, b) => (parseFloat(b.tmdb_rating) || 0) - (parseFloat(a.tmdb_rating) || 0));

  return (
    <div className="page">
      <div className="lhdr">
        <div>
          <p className="eyebrow">Jouw collectie</p>
          <h2 className="ltitle">Mijn <em>Bibliotheek</em></h2>
          <p className="lcount">
            {library.length} series
            {watchedCount > 0 && <span style={{ color: "#28a745", marginLeft: 8 }}>. {watchedCount} bekeken</span>}
            {enrichingIds.size > 0 && <span style={{ color: "#f5a623", marginLeft: 8 }}>. AI verrijkt {enrichingIds.size}...</span>}
          </p>
        </div>
        <div className="controls">
          <input className="si" placeholder="Zoek naam, genre of omschrijving..." value={q} onChange={e => setQ(e.target.value)} />
          {svcs.map(s => <button key={s} className={"fb " + (svc === s ? "on" : "")} onClick={() => setSvc(svc === s ? "" : s)}>{s}</button>)}
          {[["recent", "Nieuwste"], ["az", "A-Z"], ["imdb", "TMDB v"]].map(([v, l]) =>
            <button key={v} className={"fb " + (sort === v ? "on" : "")} onClick={() => setSort(v)}>{l}</button>)}
          <button
            className={"fb watched-filter " + (hideWatched ? "on" : "")}
            onClick={() => setHideWatched(h => !h)}
            title="Bekeken series verbergen"
          >
            {hideWatched ? "v Bekeken verborgen" : "[oog] Verberg bekeken"}
          </button>
          <button className="fb" onClick={() => setShowDupes(true)} title="Zoek series met dezelfde titel">
            Check duplicaten
          </button>
        </div>
      </div>
      {showDupes && (
        <DuplicatesModal
          library={library}
          onResolve={onDeduplicate}
          onClose={() => setShowDupes(false)}
        />
      )}
      <div className="lbody">
        {library.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">[film]</div>
            <h3>Bibliotheek is leeg</h3>
            <p>Gebruik Import om alle series te laden,<br />of voeg ze toe via Zoeken.</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 18, flexWrap: "wrap" }}>
              <button className="btn-primary" onClick={() => onGo("import")}>[in] Importeer lijst</button>
              <button className="btn-secondary" onClick={() => onGo("search")}>[zoek] Zoek serie</button>
            </div>
          </div>
        ) : list.length === 0 ? (
          <div className="empty"><div className="empty-ico">[zoek]</div><h3>Geen resultaten</h3>
            {hideWatched && <p style={{ marginTop: 8 }}>Alle series zijn gemarkeerd als bekeken.<br /><button className="btn-secondary" style={{ marginTop: 12, fontSize: 13 }} onClick={() => setHideWatched(false)}>Toon bekeken series</button></p>}
          </div>
        ) : (
          <div className="lib-list">
            {list.map(item => {
              const isEnriching = enrichingIds.has(item.id);
              return (
                <div key={item.id} className={"lrow " + (isFullyWatched(item) ? "watched" : "")} onClick={() => setSel(item)}>
                  <div className="lrow-accent" style={{ background: svcColor(item.streaming_service) }} />
                  {/* Checkbox bekeken */}
                  <input
                    type="checkbox"
                    className="watched-cb"
                    checked={isFullyWatched(item)}
                    title={isFullyWatched(item) ? "Markeer als onbekeken" : "Markeer als volledig bekeken"}
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                      e.stopPropagation();
                      guard(() => {
                        if (item.season_count && item.season_count > 1) onMarkAllSeasons(item.id);
                        else onToggleWatched(item.id);
                      });
                    }}
                  />
                  <div className="lrow-main">
                    <div className="lrow-top">
                      <div className="lrow-title">{item.title}</div>
                      <div className="lrow-meta">
                        {item.year && <span className="lrow-year">{item.year}</span>}
                        {(item.genres || []).slice(0, 2).map(g => <span key={g} className="lrow-genre">{g}</span>)}
                      </div>
                    </div>
                    {item.season_count > 1 && (
                      <div className="season-pills" onClick={e => e.stopPropagation()}>
                        {Array.from({ length: item.season_count }, (_, i) => i + 1).map(num => {
                          const seasonWatched = (item.watched_seasons || []).includes(num);
                          return (
                            <button key={num}
                              className={"season-pill" + (seasonWatched ? " watched" : "")}
                              title={"Seizoen " + num + (seasonWatched ? " - bekeken" : " - nog niet bekeken")}
                              onClick={() => guard(() => onToggleSeason(item.id, num))}>
                              {num}
                            </button>
                          );
                        })}
                        <span className="season-pills-label">
                          {watchedSeasonCount(item)}/{item.season_count}
                        </span>
                      </div>
                    )}
                    {isEnriching ? <div className="lrow-enr">... AI verrijkt...</div>
                      : item.description ? <div className="lrow-desc">{item.description}</div>
                      : null}
                  </div>
                  <div className="lrow-right">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button className="lrow-del" title="Verwijder" onClick={e => { e.stopPropagation(); guard(() => onDelete(item.id)); }}>x</button>
                      <button className="lrow-del" title="Bewerken" style={{ color: "#6e6e73", fontSize: 13 }} onClick={e => { e.stopPropagation(); setSel(null); setEditing(item); }}>/</button>
                    </div>
                    <div className="lrow-btns">
                      {!isEnriching && <>{item.tmdb_rating && (
                        <span className="lrow-r imdb" style={{ color:"#0066cc" }}>
                          {item.streaming_logo
                            ? <img src={item.streaming_logo} alt={item.streaming_service || ""} className="svc-logo" title={item.streaming_service || ""} />
                            : item.streaming_service
                              ? <span className="svc-dot" style={{ background: svcColor(item.streaming_service) }} title={item.streaming_service} />
                              : null}
                          TMDB {item.tmdb_rating}
                        </span>
                      )}</>}
                      {item.streaming_url && <a href={item.streaming_url} target="_blank" rel="noopener noreferrer" className="lrow-watch" onClick={e => e.stopPropagation()}>Bekijk</a>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {sel && <DetailModal item={sel} onClose={() => setSel(null)} onDelete={id => { onDelete(id); setSel(null); }} />}
      {editing && <EditModal item={editing} onSave={onUpdate} onClose={() => setEditing(null)} />}
      <PinGate />
    </div>
  );
}


// --- Film Card ----------------------------------------------------------
// Cinema links in Dordrecht (correct locations)
const CINEMA_DORDRECHT = [
  {
    name: "Kinepolis Dordrecht",
    url:  "https://kinepolis.nl/bioscopen/kinepolis-dordrecht/",
    hint: "Lijnbaan 200 - blockbusters & mainstream",
  },
  {
    name: "Filmtheater De Witt",
    url:  "https://www.dewittdordrecht.nl/",
    hint: "Nieuwstraat 60-62 - art house & kwaliteitsfilm",
  },
];

function FilmCard({ film, onDelete, onToggleWatched }) {
  const { guard, PinGate } = usePinGuard();
  const [avail,        setAvail]        = useState(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [availErr,     setAvailErr]     = useState("");
  const [showAvail,    setShowAvail]    = useState(false);

  function handleDelete()  { guard(() => onDelete(film.id)); }
  function handleWatched() { guard(() => onToggleWatched(film.id)); }

  async function checkAvailability() {
    if (showAvail && avail) { setShowAvail(false); return; } // toggle
    if (!film.tmdb_id) { setAvailErr("Geen TMDB ID  -  gebruik bewerken om het toe te voegen"); setShowAvail(true); return; }
    setShowAvail(true);
    if (avail) return; // already loaded
    setAvailLoading(true); setAvailErr("");
    try {
      const data = await fetchAllNLProviders(film.tmdb_id);
      setAvail(data);
    } catch (e) { setAvailErr(e.message || "Ophalen mislukt"); }
    finally { setAvailLoading(false); }
  }

  function ProviderList({ items, label }) {
    if (!items || !items.length) return null;
    return (
      <div className="avail-section">
        <div className="avail-label">{label}</div>
        <div className="avail-providers">
          {items.map((p, i) => (
            <a key={i} href={p.url} target="_blank" rel="noopener noreferrer" className="avail-provider">
              {p.logo && <img src={p.logo} alt={p.name} />}
              {p.name}
            </a>
          ))}
        </div>
      </div>
    );
  }

  const hasStreaming = avail && (
    avail.flatrate?.length || avail.free?.length || avail.rent?.length || avail.buy?.length
  );

  return (
    <div className={"film-card" + (film.watched ? " watched" : "")}>
      {film.poster_url
        ? <img src={film.poster_url} alt={film.title} className="film-poster" loading="lazy" />
        : <div className="film-poster-placeholder">[film]</div>
      }
      <div className="film-info">
        <div className="film-title">{film.title}</div>
        <div className="film-year">{film.year || ""}</div>
        <div className="film-genres">
          {(film.genres || []).slice(0, 2).map(g => (
            <span key={g} className="film-genre">{g}</span>
          ))}
        </div>
        <div className="film-ratings">
          {film.tmdb_rating && <span className="film-rating tmdb">* {film.tmdb_rating}</span>}
          {film.imdb_rating && <span className="film-rating imdb">IMDb {film.imdb_rating}</span>}
        </div>
        {film.description && <div className="film-desc">{film.description}</div>}
      </div>

      <div className="film-actions">
        <input type="checkbox" className="film-cb" checked={!!film.watched}
          title={film.watched ? "Markeer als onbekeken" : "Markeer als bekeken"}
          onChange={handleWatched} />
        <button className="avail-btn" onClick={checkAvailability} disabled={availLoading}>
          {availLoading ? "..." : showAvail ? "Verberg" : "Waar te zien?"}
        </button>
        {film.imdb_url && (
          <a href={film.imdb_url} target="_blank" rel="noopener noreferrer" className="film-imdb-link">IMDb</a>
        )}
        <button className="film-del" title="Verwijder" onClick={handleDelete}>x</button>
      </div>

      {/* Availability panel */}
      {showAvail && (
        <div className="avail-panel">
          {availLoading && <div className="avail-empty"><span className="spin" />Opzoeken...</div>}
          {availErr    && <div className="avail-empty" style={{ color:"#dc2626" }}>{availErr}</div>}
          {avail && (
            <>
              {hasStreaming ? (
                <>
                  <ProviderList items={avail.flatrate} label="Inbegrepen bij abonnement" />
                  <ProviderList items={avail.free}     label="Gratis te zien" />
                  <ProviderList items={avail.rent}     label="Te huren" />
                  <ProviderList items={avail.buy}      label="Te kopen" />
                </>
              ) : (
                <div className="avail-empty">Niet beschikbaar op Nederlandse streamingdiensten.</div>
              )}
              {avail.link && (
                <a href={avail.link} target="_blank" rel="noopener noreferrer" className="avail-tmdb-link">
                  Alle opties op TMDB
                </a>
              )}
            </>
          )}

          {/* Cinema links near Dordrecht */}
          <div className="avail-section" style={{ marginTop: avail ? 12 : 0 }}>
            <div className="avail-label">Bioscoop bij Dordrecht</div>
            <div className="avail-cinema-links">
              {CINEMA_DORDRECHT.map(c => (
                <a key={c.name}
                  href={c.url}
                  target="_blank" rel="noopener noreferrer" className="avail-cinema">
                  <span>
                    <span style={{ display:"block" }}>{c.name}</span>
                    {c.hint && <span style={{ fontSize:10, opacity:.7, fontWeight:400 }}>{c.hint}</span>}
                  </span>
                  <span>{">"}</span>
                </a>
              ))}
              <a href={"https://www.google.com/search?q=" + encodeURIComponent((film.title || "") + " film bioscoop Dordrecht 2025")}
                target="_blank" rel="noopener noreferrer" className="avail-cinema">
                Google: bioscoop Dordrecht
                <span>{">"}</span>
              </a>
            </div>
          </div>
        </div>
      )}

      <PinGate />
    </div>
  );
}

// --- Film Library Page --------------------------------------------------
function FilmLibraryPage({ films, onDelete, onToggleWatched, onGo, onDeduplicate }) {
  const [q, setQ]                     = useState("");
  const [sort, setSort]               = useState("recent");
  const [hideWatched, setHideWatched] = useState(false);
  const [showDupes, setShowDupes]     = useState(false);

  const watchedCount = films.filter(f => f.watched).length;

  let list = films.filter(film => {
    const lq = q.toLowerCase();
    return (
      (!lq || film.title?.toLowerCase().includes(lq) ||
       (film.genres || []).some(g => g.toLowerCase().includes(lq)) ||
       film.description?.toLowerCase().includes(lq)) &&
      (!hideWatched || !film.watched)
    );
  });
  if (sort === "az")   list = [...list].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  if (sort === "tmdb") list = [...list].sort((a, b) => (parseFloat(b.tmdb_rating) || 0) - (parseFloat(a.tmdb_rating) || 0));

  return (
    <div className="page">
      <div className="film-lhdr">
        <div>
          <h2 className="film-ltitle">Film<em>Bibliotheek</em></h2>
          <p className="lcount">
            {films.length} films
            {watchedCount > 0 && <span style={{ color:"#16a34a", marginLeft:8 }}>{watchedCount} bekeken</span>}
          </p>
        </div>
        <div className="controls">
          <input className="si" placeholder="Zoek film, genre..."
            value={q} onChange={e => setQ(e.target.value)} />
          {[["recent","Nieuwste"],["az","A-Z"],["tmdb","TMDB"]].map(([v, l]) => (
            <button key={v} className={"fb" + (sort === v ? " on" : "")} onClick={() => setSort(v)}>{l}</button>
          ))}
          <button
            className={"fb watched-filter" + (hideWatched ? " on" : "")}
            onClick={() => setHideWatched(h => !h)}>
            {hideWatched ? "v Verborgen" : "[oog] Verberg bekeken"}
          </button>
          <button className="fb" onClick={() => setShowDupes(true)} title="Zoek films met dezelfde titel">
            Check duplicaten
          </button>
        </div>
      </div>
      {showDupes && (
        <DuplicatesModal
          library={films}
          onResolve={onDeduplicate}
          onClose={() => setShowDupes(false)}
        />
      )}

      {films.length === 0 ? (
        <div className="film-empty">
          <div style={{ fontSize:52, marginBottom:18, opacity:.35 }}>[film]</div>
          <h3 style={{ fontFamily:"Playfair Display,serif", fontSize:24, color:"#a8a29e", marginBottom:8 }}>
            Nog geen films
          </h3>
          <p style={{ fontSize:14, color:"#c7c3bf", lineHeight:1.65 }}>
            Ga naar Zoeken en zoek een film op om te beginnen.
          </p>
          <div style={{ marginTop:20 }}>
            <button className="btn-primary" onClick={() => onGo("search")}>Film zoeken</button>
          </div>
        </div>
      ) : list.length === 0 ? (
        <div className="film-empty">
          <div style={{ fontSize:36, marginBottom:12, opacity:.4 }}>[zoek]</div>
          <h3 style={{ fontFamily:"Playfair Display,serif", fontSize:20, color:"#a8a29e" }}>Geen resultaten</h3>
          {hideWatched && (
            <button className="btn-secondary" style={{ marginTop:14 }} onClick={() => setHideWatched(false)}>
              Toon bekeken films
            </button>
          )}
        </div>
      ) : (
        <div className="film-grid">
          {list.map(film => (
            <FilmCard key={film.id} film={film}
              onDelete={onDelete} onToggleWatched={onToggleWatched} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Search ----------------------------------------------------------------
function SearchPage({ library, films, onSave, onSaveFilm, sharedPayload, onClearShared }) {
  const [mode, setMode] = useState("series"); // "series" | "film"

  // Handle shared URL/title from phone
  useEffect(() => {
    if (!sharedPayload) return;
    const { url, title, text } = sharedPayload;
    onClearShared();

    const combined = url || text || title || "";

    // Detect TMDB movie URL
    if (combined.includes("themoviedb.org/movie")) {
      setMode("film");
      return;
    }
    // Detect TMDB TV URL
    if (combined.includes("themoviedb.org/tv")) {
      setMode("series");
      setTmdbUrlInput(combined);
      return;
    }
    // IMDb URL  -  put in IMDb field
    if (combined.includes("imdb.com")) {
      setMode("series");
      setImdbUrlOverride(combined);
      return;
    }
    // Plain title text  -  pre-fill search
    const guessTitle = title || text || "";
    if (guessTitle) {
      setMode("series");
      setSeries(guessTitle);
    }
  }, [sharedPayload]);
  const { guard, PinGate } = usePinGuard();
  const [series, setSeries]           = useState("");
  const [loading, setLoading]         = useState(false);
  const [searchResults, setSearchResults] = useState([]); // list to pick from
  const [selecting, setSelecting]     = useState(false);  // loading full detail
  const [result, setResult]           = useState(null);
  const [selectedId, setSelectedId]   = useState(null);
  const [error, setError]             = useState("");
  const [saved, setSaved]             = useState(false);
  const [imdbUrlOverride, setImdbUrlOverride] = useState("");
  const [imdbFetching,   setImdbFetching]     = useState(false);
  const [imdbFetchErr,   setImdbFetchErr]     = useState("");
  const [tmdbUrlInput,   setTmdbUrlInput]     = useState("");
  const [tmdbFetching,   setTmdbFetching]     = useState(false);
  const [tmdbFetchErr,   setTmdbFetchErr]     = useState("");
  const [tmdbFetchOk,    setTmdbFetchOk]      = useState("");

  async function fetchFromTmdbUrl() {
    const { id, type } = parseTmdbUrl(tmdbUrlInput.trim());
    if (!id) { setTmdbFetchErr("Geen geldig TMDB-ID in de URL (gebruik een themoviedb.org/tv/... URL)"); return; }
    setTmdbFetching(true); setTmdbFetchErr(""); setTmdbFetchOk("");
    try {
      // Use TV fetch for /tv/ URLs, movie fetch for /movie/ URLs
      const data = type === "movie"
        ? await fetchMovieFromTmdbId(id)
        : await fetchFromTmdbId(id);           // default: TV series
      const prov = await fetchNLProvider(type === "movie" ? "movie" : "tv", id);
      setResult(prev => ({
        ...(prev || {}),
        title:             data.title             || prev?.title  || series,
        year:              data.year              || prev?.year   || null,
        genres:            data.genres?.length    ? data.genres   : (prev?.genres || []),
        description:       data.description       || prev?.description || null,
        tmdb_rating:       data.tmdb_rating       || prev?.tmdb_rating || null,
        imdb_url:          data.imdb_url          || prev?.imdb_url    || null,
        poster_url:        data.poster_url        || prev?.poster_url  || null,
        streaming_service: prov?.name             || prev?.streaming_service || null,
        streaming_url:     prov?.url              || prev?.streaming_url     || null,
        streaming_logo:    prov?.logo             || prev?.streaming_logo    || null,
      }));
      const typeLabel = type === "movie" ? "Film" : "Serie";
      setTmdbFetchOk("v " + typeLabel + ": " + (data.title || "Gevonden") + (data.year ? " (" + data.year + ")" : ""));
    } catch (e) { setTmdbFetchErr(e.message || "Ophalen mislukt"); }
    finally { setTmdbFetching(false); }
  }

  async function fetchFromUrl() {
    if (!imdbUrlOverride.trim()) return;
    setImdbFetching(true); setImdbFetchErr("");
    try {
      const ai = await fetchFromImdbUrl(imdbUrlOverride.trim(), result?.title || series);
      setResult(prev => ({
        ...(prev || {}),
        title:          ai.title       || prev?.title || series,
        year:           ai.year        || prev?.year  || null,
        genres:         Array.isArray(ai.genres) && ai.genres.length ? ai.genres : (prev?.genres || []),
        description:    ai.desc        || prev?.description || null,
        imdb_rating:    ai.imdb        || prev?.imdb_rating || null,
        imdb_url:       imdbUrlOverride.trim(),
        streaming_service: prev?.streaming_service || null,
        streaming_url:  prev?.streaming_url || null,
      }));
    } catch (e) { setImdbFetchErr(e.message || "Ophalen mislukt"); }
    finally { setImdbFetching(false); }
  }

  const alreadySaved = result ? library.some(i => i.title?.toLowerCase() === result.title?.toLowerCase()) : false;

  function handleSaveToLibrary() {
    if (alreadySaved) return;
    const item = {
      ...result,
      imdb_url:        imdbUrlOverride || (result ? result.imdb_url : null) || null,
      tmdb_rating:      result ? result.tmdb_rating : null,
      watched_seasons:  [],
      watched:          false,
      id: "s" + Date.now(),
      savedAt: new Date().toISOString(),
    };
    guard(() => { onSave(item); setSaved(true); });
  }

  async function doSearch() {
    if (!series.trim()) return;
    setLoading(true); setError(""); setSearchResults([]); setResult(null);
    setSaved(false); setSelectedId(null); setImdbUrlOverride(""); setTmdbFetchOk("");
    try {
      const results = await tmdbSearchResults(series.trim());
      if (!results.length) {
        setError("Geen resultaten gevonden. Probeer een andere zoekterm.");
      } else {
        setSearchResults(results);
      }
    } catch (e) { setError(e.message || "Zoeken mislukt"); }
    finally { setLoading(false); }
  }

  async function selectSeries(item) {
    setSelectedId(item.tmdb_id); setSelecting(true); setResult(null);
    setSaved(false); setImdbUrlOverride(""); setTmdbFetchOk("");
    try {
      const full = await tmdbFetchFull(item.tmdb_id);
      setResult(full);
    } catch (e) { setError(e.message || "Details ophalen mislukt"); setSelecting(false); }
    finally { setSelecting(false); }
  }

  return (
    <div className="page">
      <div className="s-hero">
        <div className="s-eyebrow">AI-Powered . TMDB . Gratis</div>
        <h1 className="s-title">
          {mode === "series" ? "Ontdek je favoriete series" : "Ontdek je favoriete films"}
        </h1>
        <p className="s-sub">
          {mode === "series"
            ? "Zoek een tv-serie op en sla op in je persoonlijke bibliotheek."
            : "Zoek een film op via TMDB en sla op in je filmbibiotheek."}
        </p>
        <div className="mode-toggle">
          <button className={"mode-btn" + (mode === "series" ? " on" : "")} onClick={() => setMode("series")}>
            Series
          </button>
          <button className={"mode-btn" + (mode === "film" ? " on" : "")} onClick={() => setMode("film")}>
            Films
          </button>
        </div>
      </div>
      {mode === "series" && (
      <>
      <div className="s-form">
        <div className="field">
          <label className="flabel">TV Serie</label>
          <input className="finput" placeholder="bv. Breaking Bad, Succession, The Bear..."
            value={series}
            onChange={e => { setSeries(e.target.value); setSearchResults([]); setResult(null); setSaved(false); setImdbUrlOverride(""); setTmdbUrlInput(""); setTmdbFetchOk(""); setTmdbFetchErr(""); }}
            onKeyDown={e => e.key === "Enter" && !loading && doSearch()} />
        </div>
        <button className="btn-primary" onClick={doSearch} disabled={loading || !series.trim()}>
          {loading ? <><span className="spin" />Zoeken...</> : "Zoek series op"}
        </button>
        {error && <div className="err-bar">! {error}</div>}
      </div>

      {/* Results list */}
      {searchResults.length > 0 && !result && (
        <div className="search-results">
          <div className="search-results-label">{searchResults.length} resultaten - kies een serie</div>
          {searchResults.map(item => (
            <div key={item.tmdb_id}
              className={"result-row" + (selectedId === item.tmdb_id ? " selected" : "")}
              onClick={() => selectSeries(item)}>
              {item.poster_url
                ? <img src={item.poster_url} alt={item.title} className="result-thumb" />
                : <div className="result-thumb-ph">[film]</div>}
              <div className="result-info">
                <div className="result-title">{item.title}</div>
                {item.year && <div className="result-year">{item.year}</div>}
                {item.description && <div className="result-desc">{item.description}</div>}
              </div>
              {selecting && selectedId === item.tmdb_id
                ? <span className="spin" style={{ flexShrink:0 }} />
                : <span className="result-arrow">{">"}</span>}
            </div>
          ))}
        </div>
      )}
      {result && (
        <div className="result">
          <div className="rcard card">
            <div className="rcard-header">
              <div className="rtitle">{result.title}</div>
              <div className="svc-chip">{result.streaming_logo ? <img src={result.streaming_logo} alt={result.streaming_service || ""} className="svc-logo" /> : <div className="svc-dot" style={{ background: svcColor(result.streaming_service) }} />}<span className="svc-name">{result.streaming_service}</span></div>
            </div>
            <div className="rmeta">
              {result.year && <span className="ytag">{result.year}</span>}
              {(result.genres || []).map(g => <span key={g} className="tag">{g}</span>)}
            </div>
            {result.description && <p className="rdesc">{result.description}</p>}
            <div className="rratings">
              <div className="rbox"><div><div className="rl">TMDB</div><div className={"rv " + (result.tmdb_rating ? "tmdb" : "none")}>{result.tmdb_rating || "N/B"}</div></div></div>
            </div>

            {/* TMDB URL ophalen */}
            <div className="tmdb-block">
              <div className="tmdb-block-title">[film] TMDB URL</div>
              <div className="tmdb-block-sub">Plak de themoviedb.org URL om gegevens op te halen</div>
              <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                <input
                  className="finput"
                  style={{ flex:1, minWidth:200, fontSize:13, padding:"9px 12px", background:"#fff", borderColor:"#b8d4f0" }}
                  placeholder="https://www.themoviedb.org/tv/12345-serie-naam"
                  value={tmdbUrlInput}
                  onChange={e => { setTmdbUrlInput(e.target.value); setTmdbFetchErr(""); setTmdbFetchOk(""); }}
                  onKeyDown={e => e.key === "Enter" && fetchFromTmdbUrl()}
                />
                {tmdbUrlInput && (
                  <button onClick={fetchFromTmdbUrl} disabled={tmdbFetching}
                    style={{ background: tmdbFetching ? "#7bb3e0" : "#0066cc", border:"none", borderRadius:7,
                             color:"#fff", fontFamily:"Inter,sans-serif", fontSize:13, fontWeight:600,
                             padding:"9px 16px", cursor: tmdbFetching ? "not-allowed" : "pointer",
                             display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
                    {tmdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff" }} />Ophalen...</> : "[film] Haal op via TMDB"}
                  </button>
                )}
              </div>
              {tmdbFetchErr && <div style={{ fontSize:12, color:"#c82333", marginTop:5 }}>! {tmdbFetchErr}</div>}
              {tmdbFetchOk  && <div style={{ fontSize:12, color:"#28a745", marginTop:5 }}>v {tmdbFetchOk}</div>}
            </div>

            {/* Bewerkbaar IMDb URL veld met ophalen-knop */}
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <label className="flabel">IMDb URL
                {!result.imdb_url && !imdbUrlOverride && (
                  <span style={{ color:"#dc3545", fontWeight:400, letterSpacing:0, textTransform:"none", marginLeft:6 }}>
                     -  niet gevonden, voer handmatig in
                  </span>
                )}
              </label>
              <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                <input
                  className="finput"
                  style={{ flex:1, minWidth:200, fontSize:13, padding:"9px 12px",
                    borderColor: imdbUrlOverride && !imdbUrlOverride.includes("imdb.com") ? "#f5a0a8" : undefined }}
                  placeholder="https://www.imdb.com/title/tt..."
                  value={imdbUrlOverride}
                  onChange={e => { setImdbUrlOverride(e.target.value); setImdbFetchErr(""); }}
                  onKeyDown={e => e.key === "Enter" && fetchFromUrl()}
                />
                {imdbUrlOverride && (
                  <button
                    onClick={fetchFromUrl}
                    disabled={imdbFetching}
                    style={{ background: imdbFetching ? "#bbb" : "#f5a623", border:"none", borderRadius:7,
                             color:"#fff", fontFamily:"Inter,sans-serif", fontSize:13, fontWeight:600,
                             padding:"9px 16px", cursor: imdbFetching ? "not-allowed" : "pointer",
                             display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
                    {imdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff" }} />Ophalen...</> : "* Haal gegevens op"}
                  </button>
                )}
                {imdbUrlOverride && !imdbFetching && (
                  <a href={imdbUrlOverride} target="_blank" rel="noopener noreferrer"
                    className="lb sec" style={{ whiteSpace:"nowrap", flexShrink:0, padding:"9px 14px" }}>
                    Bekijk ^
                  </a>
                )}
              </div>
              {imdbFetchErr && <div style={{ fontSize:12, color:"#c82333" }}>! {imdbFetchErr}</div>}
            </div>

            <div className="rlinks">
              {result.streaming_url && <a href={result.streaming_url} target="_blank" rel="noopener noreferrer" className="lb primary">Bekijk op {result.streaming_service}</a>}
              <button className={"lb " + (saved || alreadySaved ? "saved" : "save")}
                onClick={handleSaveToLibrary}
                disabled={saved || alreadySaved}>
                {saved || alreadySaved ? "v Opgeslagen" : "+ Opslaan in bibliotheek"}
              </button>
            </div>
            <div className="rfooter">Informatie via Claude AI . IMDb</div>
          </div>
        </div>
      )}
      </> )} {/* end mode === series */}

      {mode === "film" && (
        <FilmSearchSection films={films} onSaveFilm={onSaveFilm} guard={guard} sharedPayload={sharedPayload} onClearShared={onClearShared} />
      )}

      <PinGate />
    </div>
  );
}

// --- Film Search Section -------------------------------------------------
function FilmSearchSection({ films, onSaveFilm, guard, sharedPayload, onClearShared }) {
  const [filmTitle, setFilmTitle]         = useState("");
  const [filmResults, setFilmResults]     = useState([]);
  const [filmResult, setFilmResult]       = useState(null);
  const [selectedId, setSelectedId]       = useState(null);
  const [searching, setSearching]         = useState(false);
  const [selecting, setSelecting]         = useState(false);
  const [searchErr, setSearchErr]         = useState("");
  const [saved, setSaved]                 = useState(false);
  const [imdbRating, setImdbRating]       = useState("");
  const [tmdbUrlInput, setTmdbUrlInput]   = useState("");
  const [tmdbFetching, setTmdbFetching]   = useState(false);
  const [tmdbFetchErr, setTmdbFetchErr]   = useState("");

  useEffect(() => {
    if (!sharedPayload) return;
    const { url, text, title } = sharedPayload;
    onClearShared();
    const combined = url || text || "";
    if (combined.includes("themoviedb.org/movie")) {
      setTmdbUrlInput(combined);
    } else if (title || text) {
      setFilmTitle(title || text);
    }
  }, [sharedPayload]);

  const alreadySaved = filmResult
    ? films.some(f => f.title?.toLowerCase() === filmResult.title?.toLowerCase())
    : false;

  async function doSearch() {
    if (!filmTitle.trim()) return;
    setSearching(true); setSearchErr(""); setFilmResults([]); setFilmResult(null);
    setSaved(false); setSelectedId(null); setImdbRating("");
    try {
      const results = await tmdbMovieSearchResults(filmTitle.trim());
      if (!results.length) throw new Error("Geen films gevonden. Probeer een andere zoekterm.");
      setFilmResults(results);
    } catch (e) { setSearchErr(e.message || "Zoeken mislukt"); }
    finally { setSearching(false); }
  }

  async function selectFilm(item) {
    setSelectedId(item.tmdb_id); setSelecting(true); setFilmResult(null); setSaved(false); setImdbRating("");
    try {
      const data = await fetchMovieFromTmdbId(item.tmdb_id);
      // Also get NL streaming provider
      const prov = await fetchNLProvider("movie", item.tmdb_id);
      setFilmResult({ ...data, streaming_service: prov?.name || null, streaming_url: prov?.url || null, streaming_logo: prov?.logo || null });
    } catch (e) { setSearchErr(e.message || "Details ophalen mislukt"); }
    finally { setSelecting(false); }
  }

  async function doTmdbFetch() {
    const id = extractTmdbMovieId(tmdbUrlInput.trim());
    if (!id) { setTmdbFetchErr("Geen geldig TMDB-ID in de URL (gebruik een themoviedb.org/movie/... URL)"); return; }
    setTmdbFetching(true); setTmdbFetchErr("");
    try {
      const [data, prov] = await Promise.all([
        fetchMovieFromTmdbId(id),
        fetchNLProvider("movie", id),
      ]);
      setFilmResult({ ...data, streaming_service: prov?.name || null, streaming_url: prov?.url || null, streaming_logo: prov?.logo || null });
      setSaved(false);
    } catch (e) { setTmdbFetchErr(e.message || "Ophalen mislukt"); }
    finally { setTmdbFetching(false); }
  }

  function handleSave() {
    if (alreadySaved || !filmResult) return;
    const item = {
      ...filmResult,
      imdb_rating: imdbRating.trim() || null,
      id: "film" + Date.now(),
      savedAt: new Date().toISOString(),
      watched: false,
    };
    guard(() => { onSaveFilm(item); setSaved(true); });
  }

  return (
    <>
      <div className="s-form">
        <div className="field">
          <label className="flabel">Filmtitel</label>
          <input className="finput" placeholder="bv. Inception, Oppenheimer, Her..."
            value={filmTitle}
            onChange={e => { setFilmTitle(e.target.value); setFilmResults([]); setFilmResult(null); setSaved(false); }}
            onKeyDown={e => e.key === "Enter" && !searching && doSearch()} />
        </div>
        <button className="btn-primary" onClick={doSearch} disabled={searching || !filmTitle.trim()}>
          {searching ? <><span className="spin" />Zoeken...</> : "Zoek film op"}
        </button>
        {searchErr && <div className="err-bar">{searchErr}</div>}
      </div>

      {/* Film results list */}
      {filmResults.length > 0 && !filmResult && (
        <div className="search-results">
          <div className="search-results-label">{filmResults.length} resultaten - kies een film</div>
          {filmResults.map(item => (
            <div key={item.tmdb_id}
              className={"result-row" + (selectedId === item.tmdb_id ? " selected" : "")}
              onClick={() => selectFilm(item)}>
              {item.poster_url
                ? <img src={item.poster_url} alt={item.title} className="result-thumb" />
                : <div className="result-thumb-ph">[film]</div>}
              <div className="result-info">
                <div className="result-title">{item.title}</div>
                {item.year && <div className="result-year">{item.year}</div>}
                {item.description && <div className="result-desc">{item.description}</div>}
              </div>
              {selecting && selectedId === item.tmdb_id
                ? <span className="spin" style={{ flexShrink:0 }} />
                : <span className="result-arrow">{">"}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Original s-form continues for TMDB URL fallback only */}
      {!filmResult && (
      <div className="s-form" style={{ marginTop: filmResults.length ? 8 : 0 }}>
        {searchErr && <div className="err-bar">{searchErr}</div>}

        {/* TMDB URL fallback */}
        <div className="tmdb-block" style={{ marginTop:8 }}>
          <div className="tmdb-block-title">[film] TMDB URL</div>
          <div className="tmdb-block-sub">Niet gevonden? Plak de themoviedb.org/movie URL</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <input className="finput" style={{ flex:1, fontSize:13, padding:"9px 12px", background:"#fff", borderColor:"#b8d4f0" }}
              placeholder="https://www.themoviedb.org/movie/27205"
              value={tmdbUrlInput}
              onChange={e => { setTmdbUrlInput(e.target.value); setTmdbFetchErr(""); }}
              onKeyDown={e => e.key === "Enter" && doTmdbFetch()} />
            {tmdbUrlInput && (
              <button onClick={doTmdbFetch} disabled={tmdbFetching}
                style={{ background: tmdbFetching ? "#7bb3e0" : "#0066cc", border:"none", borderRadius:7,
                         color:"#fff", fontFamily:"Inter,sans-serif", fontSize:13, fontWeight:600,
                         padding:"9px 16px", cursor: tmdbFetching ? "not-allowed" : "pointer" }}>
                {tmdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff" }} />Ophalen...</> : "Haal op"}
              </button>
            )}
          </div>
          {tmdbFetchErr && <div style={{ fontSize:11, color:"#c82333", marginTop:5 }}>! {tmdbFetchErr}</div>}
        </div>
      </div>
      )} {/* end !filmResult TMDB fallback */}

      {filmResult && (
        <div className="film-result">
          <div className="film-result-card">
            {filmResult.poster_url
              ? <img src={filmResult.poster_url} alt={filmResult.title} className="film-result-poster" />
              : <div className="film-result-poster-ph">[film]</div>}
            <div className="film-result-body">
              <div className="film-result-title">{filmResult.title}</div>
              <div className="film-result-meta">
                {filmResult.year && <span className="ytag">{filmResult.year}</span>}
                {(filmResult.genres || []).map(g => <span key={g} className="tag">{g}</span>)}
              </div>
              {filmResult.description && <p className="film-result-desc">{filmResult.description}</p>}
              <div className="film-result-ratings">
                <div className="film-result-rating">
                  <div><div className="rl">TMDB</div><div className={"rv " + (filmResult.tmdb_rating ? "tmdb" : "none")}>{filmResult.tmdb_rating || "N/B"}</div></div>
                </div>
                <div className="film-result-rating">
                  <div><div className="rl">IMDb</div><div className={"rv " + (imdbRating ? "imdb" : "none")}>{imdbRating || "N/B"}</div></div>
                </div>
              </div>
              {/* Manual IMDb fields */}
              <div className="film-imdb-input">
                <label className="flabel">IMDb score (optioneel)</label>
                <div className="film-imdb-row">
                  <input className="finput" style={{ fontSize:13, padding:"8px 12px" }}
                    placeholder="bv. 8.8/10"
                    value={imdbRating}
                    onChange={e => setImdbRating(e.target.value)} />
                  {filmResult.imdb_url && (
                    <a href={filmResult.imdb_url} target="_blank" rel="noopener noreferrer"
                      className="lb sec" style={{ whiteSpace:"nowrap", padding:"8px 14px" }}>IMDb</a>
                  )}
                </div>
              </div>
              <button
                className={"lb " + (saved || alreadySaved ? "saved" : "save")}
                onClick={handleSave}
                disabled={saved || alreadySaved}>
                {saved || alreadySaved ? "v Opgeslagen in filmbib." : "[PIN] Opslaan in filmbib."}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --- Import ----------------------------------------------------------------
function ImportPage({ currentLibrary, onLibraryUpdate, onResetLibrary }) {
  const [phase,      setPhase]      = useState("idle");
  const [savedCount, setSavedCount] = useState(0);
  const [enriched,   setEnriched]   = useState(0);
  const [current,    setCurrent]    = useState("");
  const [errors,     setErrors]     = useState([]);
  const [tmdbKey,    setTmdbKeyState] = useState(getTmdbKey);
  const [cloudList,  setCloudList]  = useState(null); // null = not loaded, [] = loaded
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudErr,   setCloudErr]   = useState("");
  const running = useRef(false);

  // Use cloud list if available, else fall back to hardcoded IMPORT_LIST
  const sourceList = cloudList && cloudList.length > 0 ? cloudList : IMPORT_LIST;
  const pct = phase === "step2" ? Math.round((enriched / sourceList.length) * 100) : phase === "done" ? 100 : 0;

  // Load import list from cloud on mount
  useEffect(() => {
    async function loadCloudList() {
      setCloudLoading(true); setCloudErr("");
      try {
        const d = await cloudGet();
        if (d && Array.isArray(d.library) && d.library.length > 0) {
          // Extract just the fields needed for import
          const list = d.library.map(item => ({
            title:             item.title,
            streaming_service: item.streaming_service || "",
            streaming_url:     item.streaming_url     || "",
          })).filter(s => s.title);
          setCloudList(list);
        } else {
          setCloudList([]); // cloud empty, use hardcoded list
        }
      } catch {
        setCloudList([]); // error, use hardcoded list
        setCloudErr("Cloud niet bereikbaar - vaste lijst wordt gebruikt");
      } finally {
        setCloudLoading(false);
      }
    }
    loadCloudList();
  }, []);

  function saveTmdbKey(k) { setTmdbKey(k); setTmdbKeyState(k); }

  function handleReset() {
    if (window.confirm("Alle AI-gegevens verwijderen en opnieuw importeren? Titels blijven bewaard.")) {
      onResetLibrary();
    }
  }

  async function start() {
    running.current = true;
    setPhase("step1"); setErrors([]); setSavedCount(0); setEnriched(0); setCurrent("");

    const existingTitles = new Set(currentLibrary.map(e => (e.title || "").toLowerCase()));
    const basic = sourceList.filter(s => !existingTitles.has(s.title.toLowerCase()))
      .map((s, i) => ({
        id: "imp" + Date.now() + i, title: s.title,
        streaming_service: s.streaming_service, streaming_url: s.streaming_url,
        genres: [], year: null, description: null, imdb_rating: null, imdb_url: null,
        rt_rating: null, rt_url: null, savedAt: new Date().toISOString(), enriched: false,
      }));

    const merged = [...basic, ...currentLibrary];
    setSavedCount(basic.length);
    saveLib(merged); onLibraryUpdate([...merged]);
    setPhase("step2");

    let working = [...merged];

    // Process each series individually  -  TMDB first, Claude as fallback
    const toEnrich = sourceList.filter(s => {
      const found = working.find(w => w.title.toLowerCase() === s.title.toLowerCase());
      return found && !found.enriched;
    });

    for (const series of toEnrich) {
      if (!running.current) break;
      setCurrent(series.title);
      try {
        const data = await enrichOne(series.title, series.streaming_service);
        const idx = working.findIndex(w => w.title.toLowerCase() === series.title.toLowerCase());
        if (idx !== -1) {
          working[idx] = {
            ...working[idx],
            title:        data.title        || working[idx].title,
            year:         data.year         || working[idx].year,
            genres:       data.genres?.length ? data.genres : working[idx].genres,
            description:  data.description  || working[idx].description,
            imdb_rating:  data.imdb_rating  || working[idx].imdb_rating,
            tmdb_rating:  data.tmdb_rating  || working[idx].tmdb_rating  || null,
            imdb_url:     data.imdb_url     || working[idx].imdb_url,
            poster_url:        data.poster_url        || working[idx].poster_url,
            season_count:      data.season_count       || working[idx].season_count      || null,
            streaming_service: data.streaming_service  || working[idx].streaming_service  || null,
            streaming_url:     data.streaming_url      || working[idx].streaming_url      || null,
            streaming_logo:    data.streaming_logo     || working[idx].streaming_logo     || null,
            enriched: true,
          };
        }
      } catch (err) {
        setErrors(p => [...p, series.title + ": " + err.message]);
      }
      setEnriched(n => n + 1);
      // Save every 5 series so progress is preserved
      if ((toEnrich.indexOf(series) + 1) % 5 === 0) {
        saveLib(working); onLibraryUpdate([...working]);
      }
      await new Promise(r => setTimeout(r, 300)); // small delay between requests
    }

    saveLib(working); onLibraryUpdate([...working]);
    running.current = false; setCurrent(""); setPhase("done");
  }

  return (
    <div className="page">
      <div className="ip">
        <div className="ip-hero">
          <h1 className="ip-title">Serie<em>Import</em></h1>
          <p className="ip-sub">Stap 1: alle series direct opslaan. Stap 2: TMDB verrijkt elk item met genre, omschrijving en score.</p>
        </div>
        {/* TMDB key invoer */}
        <div className="imp-card" style={{ marginBottom: 14 }}>
          <div style={{ display:"flex", alignItems:"flex-start", gap:16, flexWrap:"wrap" }}>
            <div style={{ flex:1, minWidth:240 }}>
              <div style={{ fontSize:13, fontWeight:600, color:"#1a1a2e", marginBottom:4 }}>
                [film] TMDB API-sleutel
                {tmdbKey && <span style={{ color:"#28a745", marginLeft:8, fontWeight:400 }}>v Ingesteld</span>}
              </div>
              <div style={{ fontSize:12, color:"#6e6e73", marginBottom:8, lineHeight:1.5 }}>
                Gratis sleutel via <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" style={{ color:"#0066cc" }}>themoviedb.org</a>, Settings, API, Read Access Token.<br />
                Met TMDB worden vrijwel alle series gevonden. Zonder TMDB gebruikt de app alleen AI als fallback.
              </div>
              <input
                className="finput"
                style={{ fontSize:12, padding:"8px 12px" }}
                type="password"
                placeholder="eyJhbGciOiJIUzI1NiJ9..."
                defaultValue={tmdbKey}
                onBlur={e => saveTmdbKey(e.target.value.trim())}
                onKeyDown={e => e.key === "Enter" && saveTmdbKey(e.target.value.trim())}
              />
            </div>
          </div>
        </div>

        {phase === "idle" && (
          <div className="imp-card">
            {cloudLoading && <p style={{ fontSize:12, color:"#a8a29e", marginBottom:8 }}><span className="spin"/>Importlijst ophalen uit cloud...</p>}
            {cloudErr    && <p style={{ fontSize:12, color:"#f59e0b", marginBottom:8 }}>! {cloudErr}</p>}
            <p style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.7, marginBottom: 14 }}>
              <strong>{sourceList.length} series</strong>
              {" "}{cloudList && cloudList.length > 0
                ? <span style={{ color:"#16a34a", fontSize:12 }}>v uit cloud geladen</span>
                : <span style={{ color:"#a8a29e", fontSize:12 }}>(vaste lijst)</span>
              }<br />
              {tmdbKey ? "v TMDB actief." : "! Geen TMDB-sleutel - alleen AI als fallback."}<br />
              Bibliotheek is direct zichtbaar, verrijking loopt op de achtergrond.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn-primary" onClick={start}>Start import</button>
              <button className="btn-secondary" onClick={handleReset}>Reset herstart</button>
            </div>
          </div>
        )}

        {(phase === "step1" || phase === "step2") && (
          <div className="imp-card">
            {phase === "step1" && (
              <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                <span className="spin" />
                <span style={{ fontSize:14, color:"#6e6e73" }}>Basisdata opslaan...</span>
              </div>
            )}
            {phase === "step2" && (
              <>
                <div className="prog-row">
                  <div className="prog-lbl"><span className="spin" />Verrijken via TMDB + AI</div>
                  <div className="prog-n">{pct}%</div>
                </div>
                <div className="bar-bg"><div className="bar" style={{ width: pct + "%" }} /></div>
                <div className="prog-sub">
                  {enriched} van {sourceList.length} verwerkt
                  {current && <span style={{ marginLeft:8, color:"#aaa" }}>. {current}</span>}
                </div>
              </>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="done-card">
            <div className="done-ico">v</div>
            <div className="done-title">{savedCount} SERIES OPGESLAGEN</div>
            <div className="done-sub">
              {enriched} series verwerkt.
              {errors.length > 0 && " . " + errors.length + " serie(s) deels mislukt."}
              <br />Open de <strong style={{ color:"#28a745" }}>Bibliotheek</strong>.
            </div>
            <div style={{ marginTop:14 }}>
              <button className="btn-secondary" onClick={() => { setPhase("idle"); setEnriched(0); setSavedCount(0); setErrors([]); setCurrent(""); }}>
                Opnieuw importeren
              </button>
            </div>
          </div>
        )}
        {errors.length > 0 && <div className="errs">{errors.map((e, i) => <div key={i} className="ei">{e}</div>)}</div>}
      </div>
    </div>
  );
}

// --- Root ------------------------------------------------------------------
export default function App() {
  const [page, setPage] = useState("search");
  const [library, setLibrary] = useState([]);
  const [films, setFilms]         = useState([]);
  const [sharedPayload, setSharedPayload] = useState(null);
  const [enrichingIds, setEnrichingIds] = useState(new Set());

  useEffect(() => {
    // Inject Google Fonts
    if (!document.getElementById("gfonts")) {
      const link = document.createElement("link");
      link.id   = "gfonts";
      link.rel  = "stylesheet";
      link.href = "https://fonts.bunny.net/css?family=inter:400,500,600,700|playfair-display:600,600i,700,700i&display=swap";
      document.head.appendChild(link);
    }

    // Register service worker (needed for PWA + Share Target)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    setLibrary(loadLib());
    setFilms(loadFilms());

    // Handle incoming share from phone (Web Share Target API)
    const params = new URLSearchParams(window.location.search);
    const sharedUrl   = params.get("url")   || "";
    const sharedTitle = params.get("title") || "";
    const sharedText  = params.get("text")  || "";

    if (sharedUrl || sharedTitle || sharedText) {
      // Clean URL so refresh doesn't re-trigger
      window.history.replaceState({}, "", window.location.pathname);
      setSharedPayload({ url: sharedUrl, title: sharedTitle, text: sharedText });
      setPage("search");
    }
  }, []);

  function updateLibrary(items) {
    setLibrary([...items]);
    setEnrichingIds(new Set(items.filter(i => i.enriched === false).map(i => i.id)));
  }
  function addItem(item) { const u = [item, ...library]; setLibrary(u); saveLib(u); }
  function addFilm(film) { const u = [film, ...films]; setFilms(u); saveFilms(u); }

  function importFromCloud(newLibrary, newFilms) {
    // TRUE union merge: cloud content wins on conflicts, watched is OR-merged,
    // but items that exist ONLY locally (not yet pushed) are always kept.
    // This guarantees a pull can never silently delete un-synced local additions.
    function mergeArrays(cloudItems, localItems) {
      const localById = {};
      localItems.forEach(i => { localById[i.id] = i; });
      const cloudIds = new Set(cloudItems.map(i => i.id));

      const fromCloud = cloudItems.map(item => {
        const local = localById[item.id];
        const cloudSeasons  = item.watched_seasons || [];
        const localSeasons  = local?.watched_seasons || [];
        const mergedSeasons = [...new Set([...cloudSeasons, ...localSeasons])].sort((a,b)=>a-b);
        return {
          ...item,
          watched:         !!(item.watched || local?.watched),
          watched_seasons: mergedSeasons,
        };
      });

      // Local items not yet present in the cloud - keep them, next auto-sync will push them up
      const localOnly = localItems.filter(i => !cloudIds.has(i.id));

      return [...fromCloud, ...localOnly];
    }

    if (Array.isArray(newLibrary)) {
      setLibrary(prev => {
        const merged = mergeArrays(newLibrary, prev);
        saveLib(merged);
        return merged;
      });
    }
    if (Array.isArray(newFilms)) {
      setFilms(prev => {
        const merged = mergeArrays(newFilms, prev);
        saveFilms(merged);
        return merged;
      });
    }
  }
  function deleteFilm(id) { const u = films.filter(f => f.id !== id); setFilms(u); saveFilms(u); }
  function toggleFilmWatched(id) {
    const u = films.map(f => f.id === id ? { ...f, watched: !f.watched } : f);
    setFilms(u); saveFilms(u);
  }
  function updateItem(item) { const u = library.map(i => i.id === item.id ? item : i); setLibrary(u); saveLib(u); }
  function resetLibrary() {
    // Keep titles/streaming but wipe all AI data so import starts fresh
    const reset = library.map(i => ({
      ...i,
      genres: [], year: null, description: null,
      imdb_rating: null, imdb_url: null,
      rt_rating: null, rt_url: null,
      enriched: false,
    }));
    setLibrary(reset);
    saveLib(reset);
    setEnrichingIds(new Set(reset.map(i => i.id)));
  }
  function deleteItem(id) { const u = library.filter(i => i.id !== id); setLibrary(u); saveLib(u); }
  function toggleWatched(id) { const u = library.map(i => i.id === id ? { ...i, watched: !i.watched } : i); setLibrary(u); saveLib(u); }
  function toggleSeasonWatched(id, seasonNum) {
    const u = library.map(i => {
      if (i.id !== id) return i;
      const current = i.watched_seasons || [];
      const has     = current.includes(seasonNum);
      const next    = has ? current.filter(s => s !== seasonNum) : [...current, seasonNum].sort((a,b)=>a-b);
      return { ...i, watched_seasons: next };
    });
    setLibrary(u); saveLib(u);
  }
  function markAllSeasonsWatched(id) {
    const u = library.map(i => {
      if (i.id !== id) return i;
      const total = i.season_count || 1;
      const allSeasons = Array.from({ length: total }, (_, idx) => idx + 1);
      const fully = (i.watched_seasons || []).length >= total;
      return { ...i, watched_seasons: fully ? [] : allSeasons };
    });
    setLibrary(u); saveLib(u);
  }

  // Apply a duplicate-resolution plan: replace the keeper with merged data,
  // remove all other items in each group
  function deduplicateLibrary(plan) {
    const removeIds = new Set(plan.flatMap(p => p.removeIds));
    const mergedById = {};
    plan.forEach(p => { mergedById[p.keepId] = p.merged; });

    const u = library
      .filter(i => !removeIds.has(i.id))
      .map(i => mergedById[i.id] ? mergedById[i.id] : i);

    setLibrary(u); saveLib(u);
  }

  // Same duplicate-resolution logic, applied to the films array
  function deduplicateFilms(plan) {
    const removeIds = new Set(plan.flatMap(p => p.removeIds));
    const mergedById = {};
    plan.forEach(p => { mergedById[p.keepId] = p.merged; });

    const u = films
      .filter(f => !removeIds.has(f.id))
      .map(f => mergedById[f.id] ? mergedById[f.id] : f);

    setFilms(u); saveFilms(u);
  }

  return (
    <>
      <div style={{ minHeight: "100vh", background: "#f8f7f5" }}>
        <nav className="nav">
          <div className="logo" onClick={() => setPage("search")}><span className="logo-dot"></span>Serie<em>Info</em></div>
          <div className="tabs">
            <button className={"tab " + (page === "search" ? "on" : "")} onClick={() => setPage("search")}>[zoek] Zoeken</button>
            <button className={"tab " + (page === "library" ? "on" : "")} onClick={() => setPage("library")}>
              [lib] Series{library.length > 0 && <span className="badge">{library.length}</span>}
            </button>
            <button className={"tab " + (page === "films" ? "on" : "")} onClick={() => setPage("films")}>
              [film] Films{films.length > 0 && <span className="badge">{films.length}</span>}
            </button>
            <button className={"tab " + (page === "import" ? "on" : "")} onClick={() => setPage("import")}>[in] Import</button>
          </div>
        </nav>
        {page === "search" && <SearchPage library={library} films={films} onSave={addItem} onSaveFilm={addFilm} sharedPayload={sharedPayload} onClearShared={() => setSharedPayload(null)} />}
        {page === "films" && (
          <FilmLibraryPage films={films} onDelete={deleteFilm}
            onToggleWatched={toggleFilmWatched} onGo={setPage} onDeduplicate={deduplicateFilms} />
        )}
        {page === "library" && <LibraryPage library={library} enrichingIds={enrichingIds} onDelete={deleteItem} onToggleWatched={toggleWatched} onToggleSeason={toggleSeasonWatched} onMarkAllSeasons={markAllSeasonsWatched} onUpdate={updateItem} onGo={setPage} onDeduplicate={deduplicateLibrary} />}
        {page === "import" && <ImportPage currentLibrary={library} onLibraryUpdate={updateLibrary} onResetLibrary={resetLibrary} />}
      </div>
      <SyncBar library={library} films={films} onImport={importFromCloud} />
    </>
  );
}
