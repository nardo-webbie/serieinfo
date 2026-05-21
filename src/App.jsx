import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// ─── API via Vercel proxy (geen directe Anthropic calls) ──────────────────
async function claude(messages, maxTokens = 1000, system = null) {
  const body = { model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages };
  if (system) body.system = system;
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Lees ruwe tekst eerst — voorkomt crash als het geen JSON is
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

// ─── Library (localStorage) ───────────────────────────────────────────────
const LIB_KEY = "serieinfo-lib";
const loadLib = () => {
  try { const v = localStorage.getItem(LIB_KEY); return v ? JSON.parse(v) : []; }
  catch { return []; }
};
const saveLib = (items) => {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(items)); } catch {}
};

// ─── TMDB API ─────────────────────────────────────────────────────────────
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

  // 2. Details + external IDs in parallel
  const [det, ext] = await Promise.all([
    fetch("https://api.themoviedb.org/3/tv/" + id + "?language=en-US",
      { headers: { Authorization: "Bearer " + key, accept: "application/json" } }).then(r => r.json()),
    fetch("https://api.themoviedb.org/3/tv/" + id + "/external_ids",
      { headers: { Authorization: "Bearer " + key, accept: "application/json" } }).then(r => r.json()),
  ]);

  const imdbId  = ext.imdb_id || null;
  const year    = show.first_air_date ? show.first_air_date.slice(0, 4) : null;
  const endYear = det.last_air_date   ? det.last_air_date.slice(0, 4)   : null;
  const yearStr = year && endYear && endYear !== year ? year + "–" + endYear : year;

  const voteAvg = det.vote_average || show.vote_average || null;
  return {
    title:       det.name || show.name,
    year:        yearStr,
    genres:      (det.genres || []).map(g => g.name),
    description: show.overview || det.overview || null,
    imdb_rating: null,
    tmdb_rating: voteAvg ? voteAvg.toFixed(1) + "/10" : null,
    imdb_url:    imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null,
    poster_url:  show.poster_path ? "https://image.tmdb.org/t/p/w342" + show.poster_path : null,
  };
}

// ─── Enrich one series: TMDB first, Claude as fallback ────────────────────
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

// ─── Service kleuren ──────────────────────────────────────────────────────
const SVC_COLORS = {
  netflix: "#e50914", "apple tv": "#1c1c1e", max: "#002be0", hbo: "#002be0",
  "prime video": "#00a8e1", amazon: "#00a8e1", disney: "#113ccf",
  skyshowtime: "#8b45ff", npo: "#f07d00",
};
const svcColor = (s = "") => {
  const k = s.toLowerCase();
  for (const [key, c] of Object.entries(SVC_COLORS)) if (k.includes(key)) return c;
  return "#888";
};

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

// ─── Import lijst ─────────────────────────────────────────────────────────
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

// ─── CSS ──────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Bebas+Neue&display=swap');
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #f5f5f7; min-height: 100vh; font-family: 'Inter', sans-serif; color: #1a1a2e; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
.spin {
  display: inline-block; width: 14px; height: 14px;
  border: 2px solid rgba(220,53,69,.2); border-top-color: #dc3545;
  border-radius: 50%; animation: spin .7s linear infinite;
  vertical-align: middle; margin-right: 7px;
}
.nav {
  position: sticky; top: 0; z-index: 99;
  background: rgba(255,255,255,.96); backdrop-filter: blur(12px);
  border-bottom: 1px solid #e5e5ea;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 24px; height: 56px; box-shadow: 0 1px 4px rgba(0,0,0,.06);
}
.logo { font-family: 'Bebas Neue', sans-serif; font-size: 24px; letter-spacing: .07em; color: #1a1a2e; cursor: pointer; }
.logo em { color: #dc3545; font-style: normal; }
.tabs { display: flex; gap: 3px; }
.tab {
  background: none; border: none; cursor: pointer;
  font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 500;
  color: #6e6e73; padding: 7px 13px; border-radius: 8px;
  transition: all .15s; display: flex; align-items: center; gap: 6px;
}
.tab:hover { color: #1a1a2e; background: #f0f0f5; }
.tab.on { color: #dc3545; background: #fff0f1; font-weight: 600; }
.badge { background: #dc3545; color: #fff; border-radius: 100px; font-size: 10px; font-weight: 700; padding: 2px 7px; }
.btn-red {
  background: #dc3545; border: none; border-radius: 8px; color: #fff; cursor: pointer;
  font-family: 'Inter', sans-serif; font-size: 15px; font-weight: 600;
  padding: 11px 24px; transition: background .15s;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
}
.btn-red:hover { background: #c82333; }
.btn-red:disabled { background: #f5a0a8; cursor: not-allowed; }
.btn-ghost {
  background: #fff; border: 1.5px solid #e5e5ea; color: #6e6e73;
  font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 500;
  padding: 10px 20px; border-radius: 8px; cursor: pointer;
  transition: all .15s; display: inline-flex; align-items: center; gap: 6px;
}
.btn-ghost:hover { background: #f5f5f7; color: #1a1a2e; }
.page { animation: fadeUp .25s ease both; padding-bottom: 60px; }
.eyebrow { font-size: 11px; letter-spacing: .25em; text-transform: uppercase; color: #dc3545; margin-bottom: 10px; font-weight: 600; }
.big-title { font-family: 'Bebas Neue', sans-serif; font-size: clamp(40px, 7vw, 76px); line-height: .92; color: #1a1a2e; margin-bottom: 8px; }
.big-title em { color: #dc3545; font-style: normal; }
.s-hero { padding: 52px 24px 36px; text-align: center; border-bottom: 1px solid #e5e5ea; background: #fff; }
.s-sub { font-size: 15px; color: #6e6e73; max-width: 380px; margin: 0 auto; line-height: 1.65; }
.s-form { max-width: 560px; margin: 32px auto 0; padding: 0 20px; display: grid; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.flabel { font-size: 11px; letter-spacing: .15em; text-transform: uppercase; color: #6e6e73; font-weight: 600; }
.finput {
  background: #fff; border: 1.5px solid #e5e5ea; border-radius: 8px;
  color: #1a1a2e; font-family: 'Inter', sans-serif; font-size: 15px;
  padding: 11px 14px; outline: none; width: 100%; transition: border-color .15s;
  box-shadow: 0 1px 3px rgba(0,0,0,.04);
}
.finput:focus { border-color: #dc3545; }
.finput::placeholder { color: #bbb; }
.status-bar {
  background: #fff8f8; border: 1px solid #f5a0a8; border-radius: 8px;
  color: #dc3545; font-size: 13px; padding: 10px 14px; text-align: center;
  font-style: italic; animation: pulse 1.5s ease-in-out infinite; margin-top: 10px;
}
.err-bar { background: #fff0f1; border: 1px solid #f5a0a8; border-radius: 8px; color: #c82333; font-size: 13px; padding: 10px 14px; text-align: center; margin-top: 10px; }
.result { max-width: 720px; margin: 28px auto 0; padding: 0 20px; animation: fadeUp .28s ease both; }
.rcard { background: #fff; border: 1px solid #e5e5ea; border-radius: 12px; padding: 24px 28px; display: flex; flex-direction: column; gap: 14px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
.rheader { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
.rtitle { font-family: 'Bebas Neue', sans-serif; font-size: clamp(24px, 4vw, 38px); line-height: 1; letter-spacing: .03em; color: #1a1a2e; }
.svc-chip { display: inline-flex; align-items: center; gap: 6px; border-radius: 100px; padding: 4px 12px 4px 8px; border: 1px solid #e5e5ea; background: #fff; flex-shrink: 0; }
.svc-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.svc-name { font-size: 12px; color: #6e6e73; font-weight: 500; }
.rmeta { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
.tag { background: #fff0f1; border: 1px solid #f5a0a8; border-radius: 4px; color: #dc3545; font-size: 10px; font-weight: 600; letter-spacing: .1em; padding: 3px 8px; text-transform: uppercase; }
.ytag { background: #f5f5f7; border: 1px solid #e5e5ea; border-radius: 4px; color: #6e6e73; font-size: 10px; font-weight: 600; letter-spacing: .1em; padding: 3px 8px; text-transform: uppercase; }
.rdesc { font-size: 14px; line-height: 1.75; color: #444; border-left: 3px solid #dc3545; padding: 10px 14px; background: #fff8f8; border-radius: 0 6px 6px 0; }
.rratings { display: flex; gap: 10px; flex-wrap: wrap; }
.rbox { background: #f5f5f7; border: 1px solid #e5e5ea; border-radius: 8px; padding: 12px 16px; display: flex; align-items: center; gap: 10px; flex: 1; min-width: 120px; }
.ricon { font-size: 22px; line-height: 1; }
.rl { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: #aaa; margin-bottom: 2px; font-weight: 600; }
.rv { font-family: 'Bebas Neue', sans-serif; font-size: 22px; letter-spacing: .04em; line-height: 1; }
.rv.tmdb { color: #0066cc; } .rv.rt { color: #fa320a; } .rv.none { color: #ccc; font-size: 15px; }
.rlinks { display: flex; gap: 8px; flex-wrap: wrap; }
.lb { display: inline-flex; align-items: center; gap: 5px; border-radius: 7px; font-size: 13px; font-weight: 500; padding: 8px 14px; text-decoration: none; transition: all .15s; cursor: pointer; border: none; }
.lb:hover { opacity: .85; }
.lb.primary { background: #dc3545; color: #fff; }
.lb.sec { background: #fff; border: 1.5px solid #e5e5ea; color: #444; }
.lb.save { background: #fff; border: 1.5px solid #e5e5ea; color: #6e6e73; }
.lb.saved { background: #f0fff4; border-color: #c3e6cb; color: #28a745; }
.rfooter { font-size: 11px; color: #bbb; padding-top: 2px; }
.lhdr { padding: 36px 24px 22px; border-bottom: 1px solid #e5e5ea; background: #fff; display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ltitle { font-family: 'Bebas Neue', sans-serif; font-size: clamp(28px, 4vw, 46px); line-height: .92; color: #1a1a2e; }
.lcount { color: #aaa; font-size: 12px; margin-top: 4px; }
.controls { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
.si { background: #fff; border: 1.5px solid #e5e5ea; border-radius: 8px; color: #1a1a2e; font-family: 'Inter', sans-serif; font-size: 13px; padding: 8px 13px; outline: none; width: 195px; }
.si:focus { border-color: #dc3545; }
.si::placeholder { color: #bbb; }
.fb { background: #fff; border: 1.5px solid #e5e5ea; border-radius: 8px; color: #6e6e73; font-family: 'Inter', sans-serif; font-size: 12px; font-weight: 500; padding: 7px 12px; cursor: pointer; transition: all .15s; white-space: nowrap; }
.fb:hover { background: #f5f5f7; color: #1a1a2e; }
.fb.on { background: #fff0f1; border-color: #f5a0a8; color: #dc3545; }
.lbody { padding: 20px 24px 0; }
.empty { text-align: center; padding: 52px 20px; }
.empty-ico { font-size: 44px; margin-bottom: 12px; opacity: .4; }
.empty h3 { font-size: 20px; font-weight: 600; color: #aaa; margin-bottom: 6px; }
.empty p { font-size: 14px; color: #bbb; line-height: 1.6; }
.lib-list { display: flex; flex-direction: column; gap: 8px; }
.lrow { background: #fff; border: 1.5px solid #e5e5ea; border-radius: 10px; padding: 16px 18px; display: flex; gap: 14px; cursor: pointer; transition: box-shadow .15s, border-color .15s; }
.lrow:hover { border-color: #f5a0a8; box-shadow: 0 3px 12px rgba(220,53,69,.08); }
.lrow-accent { width: 4px; border-radius: 3px; align-self: stretch; flex-shrink: 0; min-height: 40px; }
.lrow-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.lrow-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.lrow-title { font-family: 'Bebas Neue', sans-serif; font-size: 20px; letter-spacing: .03em; color: #1a1a2e; line-height: 1; }
.lrow-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.lrow-year { font-size: 11px; color: #aaa; font-weight: 500; }
.lrow-genre { font-size: 10px; color: #dc3545; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; background: #fff0f1; border-radius: 4px; padding: 2px 6px; }
.lrow-desc { font-size: 13px; color: #6e6e73; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lrow-enr { font-size: 12px; color: #f5a623; font-style: italic; animation: pulse 1.5s ease-in-out infinite; }
.lrow-right { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; flex-shrink: 0; gap: 8px; min-width: 130px; }
.lrow-svc { font-size: 10px; color: #6e6e73; letter-spacing: .06em; text-transform: uppercase; background: #f5f5f7; border-radius: 100px; padding: 4px 10px; white-space: nowrap; font-weight: 500; }
.lrow-ratings { display: flex; gap: 8px; align-items: center; }
.lrow-r { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 3px; white-space: nowrap; }
.lrow-r.imdb { color: #f5a623; } .lrow-r.rt { color: #fa320a; }
.lrow-btns { display: flex; align-items: center; gap: 7px; }
.lrow-watch { background: #dc3545; border-radius: 6px; color: #fff; font-size: 12px; font-weight: 600; padding: 6px 12px; text-decoration: none; transition: background .15s; white-space: nowrap; }
.lrow-watch:hover { background: #c82333; }
.lrow-del { background: none; border: none; color: #ccc; font-size: 15px; cursor: pointer; padding: 4px 6px; border-radius: 5px; transition: all .15s; }
.lrow-del:hover { color: #dc3545; background: #fff0f1; }
.lrow.watched { opacity: .55; background: #fafafa; }
.lrow.watched .lrow-title { text-decoration: line-through; color: #aaa; }
.watched-cb { appearance: none; -webkit-appearance: none; width: 20px; height: 20px; border: 2px solid #e5e5ea; border-radius: 5px; cursor: pointer; flex-shrink: 0; transition: all .15s; position: relative; background: #fff; }
.watched-cb:checked { background: #28a745; border-color: #28a745; }
.watched-cb:checked::after { content: ""; position: absolute; color: #fff; font-size: 12px; font-weight: 700; top: 50%; left: 50%; transform: translate(-50%,-50%); }
.watched-cb:hover { border-color: #28a745; }
.fb.watched-filter { border-color: #c3e6cb; color: #28a745; background: #f0fff4; }
.fb.watched-filter.on { background: #28a745; border-color: #28a745; color: #fff; }
.modal-overlay { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,.35); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px; animation: fadeUp .18s ease; }
.modal { background: #fff; border-radius: 14px; padding: 28px; max-width: 620px; width: 100%; max-height: 90vh; overflow-y: auto; position: relative; box-shadow: 0 8px 40px rgba(0,0,0,.14); }
.modal-close { position: absolute; top: 14px; right: 14px; background: #f5f5f7; border: none; border-radius: 100px; color: #6e6e73; font-size: 16px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.modal-close:hover { background: #e5e5ea; }
.modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; padding-right: 36px; }
.modal-title { font-family: 'Bebas Neue', sans-serif; font-size: clamp(24px, 4vw, 34px); letter-spacing: .03em; color: #1a1a2e; line-height: 1.05; }
.modal-body { display: flex; flex-direction: column; gap: 14px; }
.modal-footer { margin-top: 16px; padding-top: 12px; border-top: 1px solid #e5e5ea; font-size: 11px; color: #bbb; }
.ip { padding: 36px 20px 60px; max-width: 860px; margin: 0 auto; }
.imp-card { background: #fff; border: 1.5px solid #e5e5ea; border-radius: 10px; padding: 20px 24px; margin-bottom: 14px; box-shadow: 0 1px 4px rgba(0,0,0,.05); }
.prog-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.prog-lbl { font-size: 16px; font-weight: 600; color: #1a1a2e; display: flex; align-items: center; }
.prog-n { font-family: 'Bebas Neue', sans-serif; font-size: 26px; color: #dc3545; }
.bar-bg { background: #f5f5f7; border-radius: 100px; height: 5px; overflow: hidden; margin-bottom: 8px; }
.bar { height: 100%; background: linear-gradient(90deg, #dc3545, #f5a0a8); border-radius: 100px; transition: width .4s ease; }
.prog-sub { font-size: 12px; color: #aaa; }
.brow { display: flex; gap: 5px; margin-top: 10px; flex-wrap: wrap; }
.bp { font-size: 11px; font-weight: 500; padding: 3px 10px; border-radius: 100px; border: 1.5px solid transparent; display: flex; align-items: center; gap: 3px; }
.bp.pending { background: #f5f5f7; border-color: #e5e5ea; color: #aaa; }
.bp.running { background: #fff0f1; border-color: #f5a0a8; color: #dc3545; animation: pulse 1.2s ease-in-out infinite; }
.bp.done { background: #f0fff4; border-color: #c3e6cb; color: #28a745; }
.bp.error { background: #fff0f1; border-color: #f5a0a8; color: #c82333; }
.done-card { background: #f0fff4; border: 1.5px solid #c3e6cb; border-radius: 10px; padding: 24px; margin-bottom: 14px; text-align: center; }
.done-ico { font-size: 40px; margin-bottom: 8px; }
.done-title { font-family: 'Bebas Neue', sans-serif; font-size: 28px; color: #28a745; margin-bottom: 4px; }
.done-sub { font-size: 13px; color: #6e6e73; line-height: 1.6; }
.errs { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; }
.ei { background: #fff0f1; border: 1px solid #f5a0a8; border-radius: 6px; padding: 8px 12px; font-size: 11px; color: #c82333; font-family: monospace; word-break: break-word; }
.pin-overlay { position: fixed; inset: 0; z-index: 500; background: rgba(0,0,0,.45); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px; animation: fadeUp .15s ease; }
.pin-modal { background: #fff; border-radius: 14px; padding: 28px 24px; max-width: 320px; width: 100%; box-shadow: 0 8px 40px rgba(0,0,0,.16); text-align: center; }
.pin-title { font-size: 17px; font-weight: 600; color: #1a1a2e; margin-bottom: 6px; }
.pin-sub { font-size: 13px; color: #6e6e73; margin-bottom: 20px; line-height: 1.5; }
.pin-dots { display: flex; justify-content: center; gap: 12px; margin-bottom: 20px; }
.pin-dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #e5e5ea; transition: all .15s; }
.pin-dot.filled { background: #dc3545; border-color: #dc3545; }
.pin-dot.error { background: #dc3545; border-color: #dc3545; animation: shake .3s ease; }
.pin-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
.pin-btn { background: #f5f5f7; border: 1.5px solid #e5e5ea; border-radius: 10px; font-size: 20px; font-weight: 600; color: #1a1a2e; padding: 14px; cursor: pointer; transition: all .1s; font-family: 'Inter', sans-serif; }
.pin-btn:hover { background: #e5e5ea; }
.pin-btn:active { transform: scale(.95); background: #dc3545; color: #fff; border-color: #dc3545; }
.pin-clear { background: none; border: none; font-size: 13px; color: #aaa; cursor: pointer; margin-top: 4px; }
.pin-clear:hover { color: #dc3545; }
.pin-err { font-size: 12px; color: #dc3545; margin-top: 6px; min-height: 18px; }
.pin-setup-input { background: #f5f5f7; border: 1.5px solid #e5e5ea; border-radius: 8px; color: #1a1a2e; font-family: 'Inter', sans-serif; font-size: 24px; padding: 12px; outline: none; width: 100%; text-align: center; letter-spacing: .3em; margin-bottom: 12px; transition: border-color .15s; }
.pin-setup-input:focus { border-color: #dc3545; }
@keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)} }
`;


// ─── PIN storage ──────────────────────────────────────────────────────────
const PIN_KEY = "serieinfo-pin";
const getPin = () => { try { return localStorage.getItem(PIN_KEY) || ""; } catch { return ""; } };
const savePin = (p) => { try { localStorage.setItem(PIN_KEY, p); } catch {} };

// ─── usePinGuard hook ─────────────────────────────────────────────────────
// Returns { guard, PinGate } — call guard(callback) to require PIN first
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

// ─── PIN Setup modal ──────────────────────────────────────────────────────
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
        <div className="pin-title">🔒 Pincode instellen</div>
        <div className="pin-sub">{step === 1 ? "Kies een pincode van minimaal 4 cijfers." : "Bevestig de pincode."}</div>
        <input className="pin-setup-input" type="password" inputMode="numeric" maxLength={8}
          placeholder="••••" value={val} autoFocus
          onChange={e => { setVal(e.target.value.replace(/\D/g, "")); setErr(""); }}
          onKeyDown={e => e.key === "Enter" && submit()} />
        {err && <div className="pin-err">{err}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-red" style={{ flex: 1 }} onClick={submit}>{step === 1 ? "Volgende →" : "Opslaan"}</button>
          <button className="btn-ghost" onClick={onCancel}>Annuleer</button>
        </div>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}

// ─── PIN Verify modal ─────────────────────────────────────────────────────
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
        <div className="pin-title">🔒 Pincode vereist</div>
        <div className="pin-sub">Voer de pincode in om door te gaan.</div>
        <div className="pin-dots">{dots}</div>
        <div className="pin-grid">
          {[1,2,3,4,5,6,7,8,9].map(n => <button key={n} className="pin-btn" onClick={() => press(String(n))}>{n}</button>)}
          <div />
          <button className="pin-btn" onClick={() => press("0")}>0</button>
          <button className="pin-btn" onClick={() => setInput(i => i.slice(0,-1))}>⌫</button>
        </div>
        {err && <div className="pin-err">Onjuiste pincode, probeer opnieuw.</div>}
        <button className="pin-clear" onClick={onCancel}>Annuleer</button>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}

// ─── Detail Modal (via Portal — altijd zichtbaar in viewport) ─────────────
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
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="modal-header">
          <div className="modal-title">{item.title}</div>
          <div className="svc-chip">
            <div className="svc-dot" style={{ background: svcColor(item.streaming_service) }} />
            <span className="svc-name">{item.streaming_service}</span>
          </div>
        </div>
        <div className="modal-body">
          <div className="rmeta">
            {item.year && <span className="ytag">{item.year}</span>}
            {(item.genres || []).map(g => <span key={g} className="tag">{g}</span>)}
          </div>
          {item.description && <p className="rdesc">{item.description}</p>}
          <div className="rratings">
            <div className="rbox"><span className="ricon">🎬</span><div><div className="rl">TMDB</div><div className={"rv " + (item.tmdb_rating ? "tmdb" : "none")}>{item.tmdb_rating || "N/B"}</div></div></div>
              {/* RT verwijderd */}
          </div>
          <div className="rlinks">
            {item.streaming_url && <a href={item.streaming_url} target="_blank" rel="noopener noreferrer" className="lb primary">▶ Bekijk op {item.streaming_service}</a>}
            {item.imdb_url && <a href={item.imdb_url} target="_blank" rel="noopener noreferrer" className="lb sec">IMDb</a>}
              {/* RT link verwijderd */}
            <button className="lb sec" style={{ color: "#dc3545", borderColor: "#f5a0a8" }} onClick={() => guard(() => { onDelete(item.id); onClose(); })}>🗑 Verwijder</button>
          </div>
        </div>
        <div className="modal-footer">Opgeslagen op {new Date(item.savedAt).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" })}</div>
      </div>
    </div>
  );

  // Render buiten de DOM-boom — altijd boven alles, ongeacht scrollpositie
  return <>
    {createPortal(content, document.body)}
    <PinGate />
  </>;
}


// ─── Extract IMDb title ID from URL ──────────────────────────────────────
function extractImdbId(url) {
  const m = (url || "").match(/tt\d{7,}/);
  return m ? m[0] : null;
}

// ─── Extract TMDB TV ID from URL ──────────────────────────────────────────
function extractTmdbId(url) {
  const m = (url || "").match(/\/tv\/([0-9]+)/);
  return m ? m[1] : null;
}

// ─── Fetch from specific TMDB ID ─────────────────────────────────────────
async function fetchFromTmdbId(tmdbId) {
  const key = getTmdbKey();
  if (!key) throw new Error("Geen TMDB API-sleutel ingesteld");

  const headers = { Authorization: "Bearer " + key, accept: "application/json" };
  const base = "https://api.themoviedb.org/3/tv/" + tmdbId;

  const [det, ext] = await Promise.all([
    fetch(base + "?language=en-US", { headers }).then(r => r.json()),
    fetch(base + "/external_ids",   { headers }).then(r => r.json()),
  ]);

  if (det.success === false) throw new Error("Serie niet gevonden op TMDB (ID " + tmdbId + ")");

  const year    = det.first_air_date ? det.first_air_date.slice(0, 4) : null;
  const endYear = det.last_air_date  ? det.last_air_date.slice(0, 4)  : null;
  const yearStr = year && endYear && endYear !== year ? year + "–" + endYear : year;
  const imdbId  = ext.imdb_id || null;

  const voteAvg = det.vote_average || null;
  return {
    title:       det.name || null,
    year:        yearStr,
    genres:      (det.genres || []).map(g => g.name),
    description: det.overview || null,
    imdb_rating: null,
    tmdb_rating: voteAvg ? voteAvg.toFixed(1) + "/10" : null,
    imdb_url:    imdbId ? "https://www.imdb.com/title/" + imdbId + "/" : null,
    poster_url:  det.poster_path ? "https://image.tmdb.org/t/p/w342" + det.poster_path : null,
    source:      "tmdb",
  };
}

// ─── Fetch series data using IMDb URL ─────────────────────────────────────
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

// ─── Single series AI re-search ───────────────────────────────────────────
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

// ─── Edit Modal ────────────────────────────────────────────────────────────
function EditModal({ item, onSave, onClose }) {
  const { guard, PinGate } = usePinGuard();
  const [form, setForm] = useState({
    year:        item.year        || "",
    genres:      (item.genres || []).join(", "),
    description: item.description || "",
    imdb_rating: item.imdb_rating || "",
    tmdb_rating: item.tmdb_rating || "",
    imdb_url:    item.imdb_url    || "",
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
        year:        data.year        || f.year,
        genres:      data.genres?.length ? data.genres.join(", ") : f.genres,
        description: data.description || f.description,
        tmdb_rating: data.tmdb_rating || f.tmdb_rating,
        imdb_url:    data.imdb_url    || f.imdb_url,
      }));
      const src = data.source === "tmdb" ? "✓ Gevonden via TMDB" : "✓ Gevonden via AI";
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
      setTmdbFetchOk("✓ Gevonden: " + (data.title || "onbekend") + (data.year ? " (" + data.year + ")" : ""));
    } catch (e) { setTmdbFetchErr(e.message || "Ophalen mislukt"); }
    finally { setTmdbFetching(false); }
  }

  function handleSave() {
    guard(() => {
      onSave({
        ...item,
        year:        form.year        || null,
        genres:      form.genres ? form.genres.split(",").map(g => g.trim()).filter(Boolean) : [],
        description: form.description || null,
        imdb_rating: form.imdb_rating || null,
        imdb_url:    form.imdb_url    || null,
        tmdb_rating: form.tmdb_rating || null,
        enriched:    true,
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
        <button className="modal-close" onClick={onClose}>✕</button>

        {/* AI re-search — always visible at top */}
        <div style={{ background:"#f0f7ff", border:"1.5px solid #b8d4f0", borderRadius:10,
                      padding:"14px 16px", marginBottom:18,
                      display:"flex", alignItems:"center", justifyContent:"space-between",
                      gap:12, flexWrap:"wrap" }}>
          <div>
            <div style={{ fontSize:14, fontWeight:600, color:"#1a1a2e", marginBottom:3 }}>
              🔍 AI Herzoeken
            </div>
            <div style={{ fontSize:12, color:"#6e6e73" }}>
              Haal automatisch nieuwe gegevens op voor deze serie
            </div>
            {searchErr && <div style={{ fontSize:12, color:"#c82333", marginTop:4 }}>⚠️ {searchErr}</div>}
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
            {searching ? <><span className="spin" style={{ borderTopColor:"#fff" }} />Zoeken…</> : "Zoek opnieuw"}
          </button>
        </div>

        {/* Editable fields */}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>

          {/* TMDB URL lookup */}
          <div style={{ background:"#f0f7ff", border:"1.5px solid #b8d4f0", borderRadius:9, padding:"12px 14px" }}>
            <div style={{ fontSize:12, fontWeight:600, color:"#1a1a2e", marginBottom:6 }}>
              🎬 TMDB URL <span style={{ fontWeight:400, color:"#6e6e73" }}>— plak de themoviedb.org URL om gegevens op te halen</span>
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
                {tmdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff", width:11, height:11 }} />Ophalen…</> : "🎬 Haal op via TMDB"}
              </button>
            </div>
            {tmdbFetchErr && <div style={{ fontSize:11, color:"#c82333", marginTop:5 }}>⚠️ {tmdbFetchErr}</div>}
            {tmdbFetchOk  && <div style={{ fontSize:11, color:"#28a745", marginTop:5 }}>{tmdbFetchOk}</div>}
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {inp("Jaar", "year")}
            {inp("Genres (komma-gescheiden)", "genres")}
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
                IMDb URL{!form.imdb_url && " ⚠ ontbreekt"}
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
                    {imdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff", width:11, height:11 }} />Ophalen…</> : "⭐ Haal op"}
                  </button>
                )}
                {form.imdb_url && (
                  <a href={form.imdb_url} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize:12, color:"#0066cc", whiteSpace:"nowrap", textDecoration:"none", padding:"9px 4px" }}>↗</a>
                )}
              </div>
              {imdbFetchErr && <div style={{ fontSize:11, color:"#c82333" }}>⚠️ {imdbFetchErr}</div>}
              {imdbFetchOk  && <div style={{ fontSize:11, color:"#28a745" }}>✓ Gegevens opgehaald via IMDb ID</div>}
            </div>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
          </div>
        </div>

        {/* Buttons */}
        <div style={{ display:"flex", gap:8, marginTop:20 }}>
          <button className="btn-red" style={{ flex:1 }} onClick={handleSave}>
            🔒 Opslaan
          </button>
          <button className="btn-ghost" onClick={onClose}>Annuleer</button>
        </div>

      </div>
    </div>
  );

  return <>
    {createPortal(content, document.body)}
    <PinGate />
  </>;
}


// ─── Library ───────────────────────────────────────────────────────────────
function LibraryPage({ library, enrichingIds, onDelete, onToggleWatched, onUpdate, onGo }) {
  const { guard, PinGate } = usePinGuard();
  const [q, setQ] = useState("");
  const [svc, setSvc] = useState("");
  const [sort, setSort] = useState("recent");
  const [hideWatched, setHideWatched] = useState(false);
  const [sel, setSel] = useState(null);
  const [editing, setEditing] = useState(null);

  useEffect(() => { if (sel) setSel(library.find(i => i.id === sel.id) || null); }, [library]);

  const watchedCount = library.filter(i => i.watched).length;
  const svcs = [...new Set(library.map(i => i.streaming_service).filter(Boolean))].sort();
  let list = library.filter(item => {
    const lq = q.toLowerCase();
    return (!lq || item.title?.toLowerCase().includes(lq) || (item.genres || []).some(g => g.toLowerCase().includes(lq)) || item.description?.toLowerCase().includes(lq))
      && (!svc || item.streaming_service === svc)
      && (!hideWatched || !item.watched);
  });
  if (sort === "az") list = [...list].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  if (sort === "imdb") list = [...list].sort((a, b) => (parseFloat(b.tmdb_rating) || 0) - (parseFloat(a.tmdb_rating) || 0));

  return (
    <div className="page">
      <div className="lhdr">
        <div>
          <p className="eyebrow">Jouw collectie</p>
          <h2 className="ltitle">SERIE<em style={{ color: "#dc3545", fontStyle: "normal" }}>BIBLIOTHEEK</em></h2>
          <p className="lcount">
            {library.length} series
            {watchedCount > 0 && <span style={{ color: "#28a745", marginLeft: 8 }}>· {watchedCount} bekeken</span>}
            {enrichingIds.size > 0 && <span style={{ color: "#f5a623", marginLeft: 8 }}>· AI verrijkt {enrichingIds.size}…</span>}
          </p>
        </div>
        <div className="controls">
          <input className="si" placeholder="Zoek naam, genre of omschrijving…" value={q} onChange={e => setQ(e.target.value)} />
          {svcs.map(s => <button key={s} className={"fb " + (svc === s ? "on" : "")} onClick={() => setSvc(svc === s ? "" : s)}>{s}</button>)}
          {[["recent", "Nieuwste"], ["az", "A–Z"], ["imdb", "TMDB ↓"]].map(([v, l]) =>
            <button key={v} className={"fb " + (sort === v ? "on" : "")} onClick={() => setSort(v)}>{l}</button>)}
          <button
            className={"fb watched-filter " + (hideWatched ? "on" : "")}
            onClick={() => setHideWatched(h => !h)}
            title="Bekeken series verbergen"
          >
            {hideWatched ? "✓ Bekeken verborgen" : "👁 Verberg bekeken"}
          </button>
        </div>
      </div>
      <div className="lbody">
        {library.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">🎬</div>
            <h3>Bibliotheek is leeg</h3>
            <p>Gebruik Import om alle series te laden,<br />of voeg ze toe via Zoeken.</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 18, flexWrap: "wrap" }}>
              <button className="btn-red" onClick={() => onGo("import")}>📥 Importeer lijst</button>
              <button className="btn-ghost" onClick={() => onGo("search")}>🔍 Zoek serie</button>
            </div>
          </div>
        ) : list.length === 0 ? (
          <div className="empty"><div className="empty-ico">🔍</div><h3>Geen resultaten</h3>
            {hideWatched && <p style={{ marginTop: 8 }}>Alle series zijn gemarkeerd als bekeken.<br /><button className="btn-ghost" style={{ marginTop: 12, fontSize: 13 }} onClick={() => setHideWatched(false)}>Toon bekeken series</button></p>}
          </div>
        ) : (
          <div className="lib-list">
            {list.map(item => {
              const isEnriching = enrichingIds.has(item.id);
              return (
                <div key={item.id} className={"lrow " + (item.watched ? "watched" : "")} onClick={() => setSel(item)}>
                  <div className="lrow-accent" style={{ background: svcColor(item.streaming_service) }} />
                  {/* Checkbox bekeken */}
                  <input
                    type="checkbox"
                    className="watched-cb"
                    checked={!!item.watched}
                    title={item.watched ? "Markeer als onbekeken" : "Markeer als bekeken"}
                    onClick={e => e.stopPropagation()}
                    onChange={e => { e.stopPropagation(); guard(() => onToggleWatched(item.id)); }}
                  />
                  <div className="lrow-main">
                    <div className="lrow-top">
                      <div className="lrow-title">{item.title}</div>
                      <div className="lrow-meta">
                        {item.year && <span className="lrow-year">{item.year}</span>}
                        {(item.genres || []).slice(0, 2).map(g => <span key={g} className="lrow-genre">{g}</span>)}
                      </div>
                    </div>
                    {isEnriching ? <div className="lrow-enr">⏳ AI verrijkt…</div>
                      : item.description ? <div className="lrow-desc">{item.description}</div>
                      : null}
                  </div>
                  <div className="lrow-right">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div className="lrow-svc">{item.streaming_service}</div>
                      <button className="lrow-del" title="Verwijder" onClick={e => { e.stopPropagation(); guard(() => onDelete(item.id)); }}>✕</button>
                      <button className="lrow-del" title="Bewerken" style={{ color: "#6e6e73", fontSize: 13 }} onClick={e => { e.stopPropagation(); setSel(null); setEditing(item); }}>✎</button>
                    </div>
                    <div className="lrow-btns">
                      {!isEnriching && <>{item.tmdb_rating && <span className="lrow-r imdb" style={{ color:"#0066cc" }}>🎬 {item.tmdb_rating}</span>}</>}
                      {item.streaming_url && <a href={item.streaming_url} target="_blank" rel="noopener noreferrer" className="lrow-watch" onClick={e => e.stopPropagation()}>▶ Bekijk</a>}
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

// ─── Search ────────────────────────────────────────────────────────────────
function SearchPage({ library, onSave }) {
  const { guard, PinGate } = usePinGuard();
  const [series, setSeries] = useState("");
  const [streaming, setStreaming] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [imdbUrlOverride, setImdbUrlOverride] = useState("");
  const [imdbFetching, setImdbFetching] = useState(false);
  const [imdbFetchErr, setImdbFetchErr] = useState("");

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
        streaming_service: prev?.streaming_service || streaming,
        streaming_url:  prev?.streaming_url || null,
      }));
    } catch (e) { setImdbFetchErr(e.message || "Ophalen mislukt"); }
    finally { setImdbFetching(false); }
  }

  const alreadySaved = result ? library.some(i => i.title?.toLowerCase() === result.title?.toLowerCase()) : false;

  async function doSearch() {
    if (!series.trim()) return;
    setLoading(true); setError(""); setResult(null); setSaved(false); setStatus("AI zoekt op…");
    try {
      const prompt =
        'Geef informatie over de TV serie "' + series.trim() + '" op streamingdienst "' + (streaming.trim() || "onbekend") + '".\n\n' +
        'Geef ALLEEN een raw JSON object terug:\n' +
        '{"title":"string","year":"string of null","genres":["string"],' +
        '"description":"2-3 zinnen Nederlands","imdb_rating":"X.X/10 of null",' +
        '"imdb_url":"full IMDb URL or null",' +
        '"streaming_service":"string","streaming_url":"url of null"}';
      const text = await claude([{ role: "user", content: prompt }], 900, "You are a JSON-only API. Respond with raw JSON only. No explanation, no markdown, no code fences.");
      const parsed = parseJsonObject(text);
      setResult(parsed);
      setImdbUrlOverride(parsed.imdb_url || "");
      setStatus("");
    } catch (e) { setError(e.message || "Probeer opnieuw."); setStatus(""); }
    finally { setLoading(false); }
  }

  return (
    <div className="page">
      <div className="s-hero">
        <p className="eyebrow">AI-Powered</p>
        <h1 className="big-title">SERIE<em>INFO</em></h1>
        <p className="s-sub">Geef een tv-serie en streamingdienst in — AI zoekt alles automatisch op.</p>
      </div>
      <div className="s-form">
        <div className="field">
          <label className="flabel">TV Serie</label>
          <input className="finput" placeholder="bv. Breaking Bad, Succession…" value={series}
            onChange={e => { setSeries(e.target.value); setResult(null); setSaved(false); setImdbUrlOverride(""); }}
            onKeyDown={e => e.key === "Enter" && !loading && doSearch()} />
        </div>
        <div className="field">
          <label className="flabel">Streamingdienst</label>
          <input className="finput" placeholder="bv. Netflix, Disney+, Prime…" value={streaming}
            onChange={e => setStreaming(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !loading && doSearch()} />
        </div>
        <button className="btn-red" onClick={doSearch} disabled={loading || !series.trim()}>
          {loading ? <><span className="spin" />Zoeken…</> : "ZOEK INFORMATIE OP"}
        </button>
        {status && <div className="status-bar">🔍 {status}</div>}
        {error && <div className="err-bar">⚠️ {error}</div>}
      </div>
      {result && (
        <div className="result">
          <div className="rcard">
            <div className="rheader">
              <div className="rtitle">{result.title}</div>
              <div className="svc-chip"><div className="svc-dot" style={{ background: svcColor(result.streaming_service) }} /><span className="svc-name">{result.streaming_service}</span></div>
            </div>
            <div className="rmeta">
              {result.year && <span className="ytag">{result.year}</span>}
              {(result.genres || []).map(g => <span key={g} className="tag">{g}</span>)}
            </div>
            {result.description && <p className="rdesc">{result.description}</p>}
            <div className="rratings">
              <div className="rbox"><span className="ricon">🎬</span><div><div className="rl">TMDB</div><div className={"rv " + (result.tmdb_rating ? "tmdb" : "none")}>{result.tmdb_rating || "N/B"}</div></div></div>
            </div>

            {/* Bewerkbaar IMDb URL veld met ophalen-knop */}
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <label style={{ fontSize:11, letterSpacing:".15em", textTransform:"uppercase", color:"#6e6e73", fontWeight:600 }}>
                IMDb URL
                {!result.imdb_url && !imdbUrlOverride && (
                  <span style={{ color:"#dc3545", fontWeight:400, letterSpacing:0, textTransform:"none", marginLeft:6 }}>
                    — niet gevonden, voer handmatig in
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
                    {imdbFetching ? <><span className="spin" style={{ borderTopColor:"#fff" }} />Ophalen…</> : "⭐ Haal gegevens op"}
                  </button>
                )}
                {imdbUrlOverride && !imdbFetching && (
                  <a href={imdbUrlOverride} target="_blank" rel="noopener noreferrer"
                    className="lb sec" style={{ whiteSpace:"nowrap", flexShrink:0, padding:"9px 14px" }}>
                    Bekijk ↗
                  </a>
                )}
              </div>
              {imdbFetchErr && <div style={{ fontSize:12, color:"#c82333" }}>⚠️ {imdbFetchErr}</div>}
            </div>

            <div className="rlinks">
              {result.streaming_url && <a href={result.streaming_url} target="_blank" rel="noopener noreferrer" className="lb primary">▶ Bekijk op {result.streaming_service}</a>}
              <button className={"lb " + (saved || alreadySaved ? "saved" : "save")}
                onClick={() => {
                  if (alreadySaved) return;
                  guard(() => {
                    onSave({
                      ...result,
                      imdb_url: imdbUrlOverride || result.imdb_url || null,
                      id: "s" + Date.now(),
                      savedAt: new Date().toISOString()
                    });
                    setSaved(true);
                  });
                }}
                disabled={saved || alreadySaved}>
                {saved || alreadySaved ? "✓ Opgeslagen" : "+ Opslaan in bibliotheek"}
              </button>
            </div>
            <div className="rfooter">Informatie via Claude AI · IMDb</div>
          </div>
        </div>
      )}
      <PinGate />
    </div>
  );
}

// ─── Import ────────────────────────────────────────────────────────────────
function ImportPage({ currentLibrary, onLibraryUpdate, onResetLibrary }) {
  const [phase,      setPhase]      = useState("idle");
  const [savedCount, setSavedCount] = useState(0);
  const [enriched,   setEnriched]   = useState(0);
  const [current,    setCurrent]    = useState("");   // title currently being processed
  const [errors,     setErrors]     = useState([]);
  const [tmdbKey,    setTmdbKeyState] = useState(getTmdbKey);
  const running = useRef(false);
  const pct = phase === "step2" ? Math.round((enriched / IMPORT_LIST.length) * 100) : phase === "done" ? 100 : 0;

  function saveTmdbKey(k) { setTmdbKey(k); setTmdbKeyState(k); }

  async function start() {
    running.current = true;
    setPhase("step1"); setErrors([]); setSavedCount(0); setEnriched(0); setCurrent("");

    const existingTitles = new Set(currentLibrary.map(e => (e.title || "").toLowerCase()));
    const basic = IMPORT_LIST.filter(s => !existingTitles.has(s.title.toLowerCase()))
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

    // Process each series individually — TMDB first, Claude as fallback
    const toEnrich = IMPORT_LIST.filter(s => {
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
            title:       data.title       || working[idx].title,
            year:        data.year        || working[idx].year,
            genres:      data.genres?.length ? data.genres : working[idx].genres,
            description: data.description || working[idx].description,
            imdb_rating: data.imdb_rating || working[idx].imdb_rating,
            tmdb_rating: data.tmdb_rating || working[idx].tmdb_rating || null,
            imdb_url:    data.imdb_url    || working[idx].imdb_url,
            poster_url:  data.poster_url  || working[idx].poster_url,
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
        <p className="eyebrow">Bulk Import · {IMPORT_LIST.length} series</p>
        <h1 className="big-title">SERIE<em>IMPORT</em></h1>
        <p style={{ fontSize: 14, color: "#6e6e73", marginBottom: 20, marginTop: 7, lineHeight: 1.6 }}>Stap 1: alle series direct opslaan. Stap 2: AI verrijkt met genre, omschrijving en ratings.</p>
        {/* TMDB key invoer */}
        <div className="imp-card" style={{ marginBottom: 14 }}>
          <div style={{ display:"flex", alignItems:"flex-start", gap:16, flexWrap:"wrap" }}>
            <div style={{ flex:1, minWidth:240 }}>
              <div style={{ fontSize:13, fontWeight:600, color:"#1a1a2e", marginBottom:4 }}>
                🎬 TMDB API-sleutel
                {tmdbKey && <span style={{ color:"#28a745", marginLeft:8, fontWeight:400 }}>✓ Ingesteld</span>}
              </div>
              <div style={{ fontSize:12, color:"#6e6e73", marginBottom:8, lineHeight:1.5 }}>
                Gratis sleutel via <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer" style={{ color:"#0066cc" }}>themoviedb.org</a> → Settings → API → Read Access Token.<br />
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
            <p style={{ fontSize: 13, color: "#6e6e73", lineHeight: 1.7, marginBottom: 14 }}>
              <strong>{IMPORT_LIST.length} series</strong> worden één voor één opgezocht.<br />
              {tmdbKey ? "✓ TMDB actief — hoge nauwkeurigheid." : "⚠ Geen TMDB-sleutel — alleen AI als fallback."}<br />
              Bibliotheek is direct zichtbaar, verrijking loopt op de achtergrond.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn-red" onClick={start}>▶ Start import</button>
              <button className="btn-ghost" onClick={() => {
                if (window.confirm("Alle AI-gegevens verwijderen en opnieuw importeren? Titels en streamingdiensten blijven bewaard.")) {
                  onResetLibrary();
                }
              }}>↺ Reset &amp; herstart</button>
            </div>
          </div>
        )}

        {(phase === "step1" || phase === "step2") && (
          <div className="imp-card">
            {phase === "step1" && (
              <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                <span className="spin" />
                <span style={{ fontSize:14, color:"#6e6e73" }}>Basisdata opslaan…</span>
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
                  {enriched} van {IMPORT_LIST.length} verwerkt
                  {current && <span style={{ marginLeft:8, color:"#aaa" }}>· {current}</span>}
                </div>
              </>
            )}
          </div>
        )}

        {phase === "done" && (
          <div className="done-card">
            <div className="done-ico">✓</div>
            <div className="done-title">{savedCount} SERIES OPGESLAGEN</div>
            <div className="done-sub">
              {enriched} series verwerkt.
              {errors.length > 0 && " · " + errors.length + " serie(s) deels mislukt."}
              <br />Open de <strong style={{ color:"#28a745" }}>Bibliotheek</strong>.
            </div>
            <div style={{ marginTop:14 }}>
              <button className="btn-ghost" onClick={() => { setPhase("idle"); setEnriched(0); setSavedCount(0); setErrors([]); setCurrent(""); }}>
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

// ─── Root ──────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("search");
  const [library, setLibrary] = useState([]);
  const [enrichingIds, setEnrichingIds] = useState(new Set());

  useEffect(() => { setLibrary(loadLib()); }, []);

  function updateLibrary(items) {
    setLibrary([...items]);
    setEnrichingIds(new Set(items.filter(i => i.enriched === false).map(i => i.id)));
  }
  function addItem(item) { const u = [item, ...library]; setLibrary(u); saveLib(u); }
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

  return (
    <>
      <style>{CSS}</style>
      <div style={{ minHeight: "100vh", background: "#f5f5f7" }}>
        <nav className="nav">
          <div className="logo" onClick={() => setPage("search")}>SERIE<em>INFO</em></div>
          <div className="tabs">
            <button className={"tab " + (page === "search" ? "on" : "")} onClick={() => setPage("search")}>🔍 Zoeken</button>
            <button className={"tab " + (page === "library" ? "on" : "")} onClick={() => setPage("library")}>
              📚 Bibliotheek{library.length > 0 && <span className="badge">{library.length}</span>}
            </button>
            <button className={"tab " + (page === "import" ? "on" : "")} onClick={() => setPage("import")}>📥 Import</button>
          </div>
        </nav>
        {page === "search" && <SearchPage library={library} onSave={addItem} />}
        {page === "library" && <LibraryPage library={library} enrichingIds={enrichingIds} onDelete={deleteItem} onToggleWatched={toggleWatched} onUpdate={updateItem} onGo={setPage} />}
        {page === "import" && <ImportPage currentLibrary={library} onLibraryUpdate={updateLibrary} onResetLibrary={resetLibrary} />}
      </div>
    </>
  );
}
