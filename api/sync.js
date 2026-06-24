// Cloud sync via JSONBin v3 — library en films in APARTE bins
// zodat grote bibliotheken de 100KB limiet niet overschrijden.
//
// Env vars:
//   JSONBIN_KEY          Master Key (begint met $2a$...)
//   JSONBIN_BIN_ID       Bin voor de seriesbibliotheek
//   JSONBIN_FILMS_BIN_ID Bin voor de filmsbibliotheek

const BASE = "https://api.jsonbin.io/v3/b";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const masterKey  = process.env.JSONBIN_KEY;
  const seriesBin  = process.env.JSONBIN_BIN_ID;
  const filmsBin   = process.env.JSONBIN_FILMS_BIN_ID;

  if (!masterKey) return res.status(500).json({ error: "JSONBIN_KEY niet ingesteld" });

  const jbHeaders = {
    "Content-Type":  "application/json",
    "X-Master-Key":  masterKey,
    "X-Bin-Private": "false",
  };

  async function safeJson(r) {
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, data: JSON.parse(text) }; }
    catch {
      const preview = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error("JSONBin gaf geen JSON (status " + r.status + "): " + preview);
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

  async function getBin(binId) {
    if (!binId) return null;
    const { ok, data } = await safeJson(
      await fetch(BASE + "/" + binId + "/latest", { headers: jbHeaders })
    );
    if (!ok) return null;
    return data.record || null;
  }

  async function putBin(binId, payload) {
    if (!binId) throw new Error("Bin ID ontbreekt");
    const { ok, status, data } = await safeJson(
      await fetch(BASE + "/" + binId, {
        method: "PUT", headers: jbHeaders, body: JSON.stringify(payload),
      })
    );
    if (!ok) throw new Error(data.message || "JSONBin PUT fout " + status);
    return true;
  }

  try {
    // GET — haal library en films op uit hun eigen bins
    if (req.method === "GET") {
      if (!seriesBin && !filmsBin) {
        return res.status(404).json({ error: "Geen bin IDs ingesteld" });
      }
      const [seriesData, filmsData] = await Promise.all([
        getBin(seriesBin),
        getBin(filmsBin),
      ]);
      const library = Array.isArray(seriesData?.library) ? seriesData.library
                    : Array.isArray(seriesData)          ? seriesData
                    : [];
      const films   = Array.isArray(filmsData?.films)    ? filmsData.films
                    : Array.isArray(filmsData)            ? filmsData
                    : [];
      return res.status(200).json({ library, films });
    }

    // PUT — sla library en films op in hun eigen bins
    if (req.method === "PUT") {
      const body = await readBody();
      const errors = [];

      if (Array.isArray(body.library) && seriesBin) {
        try { await putBin(seriesBin, { library: body.library }); }
        catch (e) { errors.push("series: " + e.message); }
      } else if (!seriesBin) {
        errors.push("JSONBIN_BIN_ID niet ingesteld");
      }

      if (Array.isArray(body.films) && filmsBin) {
        try { await putBin(filmsBin, { films: body.films }); }
        catch (e) { errors.push("films: " + e.message); }
      } else if (!filmsBin) {
        errors.push("JSONBIN_FILMS_BIN_ID niet ingesteld");
      }

      if (errors.length > 0) return res.status(500).json({ error: errors.join(" | ") });
      return res.status(200).json({ ok: true });
    }

    // POST — maak een nieuwe bin aan (voor initial setup)
    if (req.method === "POST") {
      const body = await readBody();
      const name  = body.name || "serieinfo";
      const data  = body.data || {};
      const { ok, status, data: d } = await safeJson(
        await fetch(BASE, {
          method: "POST",
          headers: { ...jbHeaders, "X-Bin-Name": name },
          body:    JSON.stringify(data),
        })
      );
      if (!ok) return res.status(status).json({ error: d.message || "Aanmaken mislukt" });
      return res.status(200).json({ id: d.metadata?.id });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
