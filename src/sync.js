// Cloud sync via GitHub Gist - series en films in aparte Gists
// Env vars:
//   GITHUB_TOKEN          Personal Access Token (gist scope)
//   GH_GIST_ID        Gist ID voor series bibliotheek
//   GH_FILMS_GIST_ID  Gist ID voor films bibliotheek

const GIST_API    = "https://api.github.com/gists";
const SERIES_FILE = "serieinfo-series.json";
const FILMS_FILE  = "serieinfo-films.json";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token       = process.env.GITHUB_TOKEN;
  const seriesGist  = process.env.GH_GIST_ID;
  const filmsGist   = process.env.GH_FILMS_GIST_ID;

  const ghHeaders = {
    "Accept":        "application/vnd.github+json",
    "Content-Type":  "application/json",
    "User-Agent":    "SerieInfo-App",
    ...(token ? { "Authorization": "Bearer " + token } : {}),
  };

  async function safeJson(r) {
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch {
      const preview = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error("GitHub gaf geen JSON (status " + r.status + "): " + preview);
    }
  }

  async function readBody() {
    if (req.body !== null && req.body !== undefined) {
      if (typeof req.body === "object") return req.body;
      if (typeof req.body === "string" && req.body.length > 0) return JSON.parse(req.body);
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length > 0) return JSON.parse(raw);
    } catch (_) {}
    return {};
  }

  async function getGist(gistId, filename) {
    if (!gistId) return null;
    const { ok, data } = await safeJson(await fetch(GIST_API + "/" + gistId, { headers: ghHeaders }));
    if (!ok) return null;
    const content = data.files?.[filename]?.content;
    if (!content) return null;
    try { return JSON.parse(content); } catch { return null; }
  }

  async function patchGist(gistId, filename, payload) {
    if (!gistId) throw new Error("Gist ID ontbreekt");
    if (!token)  throw new Error("GITHUB_TOKEN niet ingesteld");
    const { ok, status, data } = await safeJson(
      await fetch(GIST_API + "/" + gistId, {
        method:  "PATCH",
        headers: ghHeaders,
        body:    JSON.stringify({ files: { [filename]: { content: JSON.stringify(payload) } } }),
      })
    );
    if (!ok) throw new Error(data.message || "GitHub PATCH fout " + status);
    return true;
  }

  async function createGist(filename, description, payload) {
    if (!token) throw new Error("GITHUB_TOKEN vereist");
    const { ok, status, data } = await safeJson(
      await fetch(GIST_API, {
        method:  "POST",
        headers: ghHeaders,
        body:    JSON.stringify({
          description,
          public: false,
          files:  { [filename]: { content: JSON.stringify(payload) } },
        }),
      })
    );
    if (!ok) throw new Error(data.message || "GitHub POST fout " + status);
    return { id: data.id, url: data.html_url };
  }

  try {
    // GET — haal series en films op uit hun eigen Gist
    if (req.method === "GET") {
      const [seriesData, filmsData] = await Promise.all([
        getGist(seriesGist, SERIES_FILE),
        getGist(filmsGist,  FILMS_FILE),
      ]);
      const library = Array.isArray(seriesData?.library) ? seriesData.library
                    : Array.isArray(seriesData)          ? seriesData : [];
      const films   = Array.isArray(filmsData?.films)    ? filmsData.films
                    : Array.isArray(filmsData)            ? filmsData : [];
      const updatedAt = seriesData?.updatedAt || filmsData?.updatedAt || null;
      return res.status(200).json({ library, films, updatedAt });
    }

    // PUT — sla series en films op in hun eigen Gist (parallel)
    if (req.method === "PUT") {
      const body      = await readBody();
      const updatedAt = new Date().toISOString();
      const errors    = [];
      await Promise.all([
        Array.isArray(body.library) && seriesGist
          ? patchGist(seriesGist, SERIES_FILE, { library: body.library, updatedAt }).catch(e => errors.push("series: " + e.message))
          : Promise.resolve(),
        Array.isArray(body.films) && filmsGist
          ? patchGist(filmsGist, FILMS_FILE,  { films: body.films, updatedAt }).catch(e => errors.push("films: " + e.message))
          : Promise.resolve(),
      ]);
      if (errors.length) return res.status(500).json({ error: errors.join(" | ") });
      return res.status(200).json({ ok: true, updatedAt });
    }

    // POST — maak een nieuwe Gist aan (eenmalige setup)
    if (req.method === "POST") {
      const body = await readBody();
      const type = body.type || "series"; // "series" or "films"
      const result = type === "films"
        ? await createGist(FILMS_FILE,  "SerieInfo films sync",   { films:   body.films   || [] })
        : await createGist(SERIES_FILE, "SerieInfo series sync",  { library: body.library || [] });
      return res.status(200).json(result);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
