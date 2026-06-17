// Cloud sync via JSONBin v3
// Env vars: JSONBIN_KEY (Master Key) + JSONBIN_BIN_ID

const BASE = "https://api.jsonbin.io/v3/b";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const masterKey = process.env.JSONBIN_KEY;
  const binId     = process.env.JSONBIN_BIN_ID;

  if (!masterKey) return res.status(500).json({ error: "JSONBIN_KEY niet ingesteld in Vercel" });

  const jbHeaders = {
    "Content-Type":  "application/json",
    "X-Master-Key":  masterKey,
    "X-Bin-Private": "false",
  };

  // Safe JSON parse - handles HTML error pages from JSONBin gracefully
  async function safeJson(r) {
    const text = await r.text();
    try {
      return { ok: r.ok, status: r.status, data: JSON.parse(text) };
    } catch {
      const preview = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error("JSONBin gaf geen JSON (status " + r.status + "): " + preview);
    }
  }

  // Robust body reader - handles pre-parsed, string, and raw stream cases
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

  try {

    // GET - haal bibliotheek op
    if (req.method === "GET") {
      if (!binId) return res.status(404).json({ error: "JSONBIN_BIN_ID niet ingesteld in Vercel" });
      const { ok, status, data } = await safeJson(
        await fetch(BASE + "/" + binId + "/latest", { headers: jbHeaders })
      );
      if (!ok) return res.status(status).json({ error: data.message || "JSONBin GET fout " + status });
      return res.status(200).json(data.record || {});
    }

    // PUT - bibliotheek bijwerken
    if (req.method === "PUT") {
      if (!binId) return res.status(400).json({ error: "JSONBIN_BIN_ID niet ingesteld in Vercel" });
      const body = await readBody();
      if (!body || (!body.library && !body.films)) {
        return res.status(400).json({ error: "Leeg of ongeldig request body" });
      }
      const { ok, status, data } = await safeJson(
        await fetch(BASE + "/" + binId, {
          method:  "PUT",
          headers: jbHeaders,
          body:    JSON.stringify(body),
        })
      );
      if (!ok) return res.status(status).json({ error: data.message || "JSONBin PUT fout " + status });
      return res.status(200).json({ ok: true });
    }

    // POST - nieuwe bin aanmaken (eenmalig)
    if (req.method === "POST") {
      const body = await readBody();
      const { ok, status, data } = await safeJson(
        await fetch(BASE, {
          method:  "POST",
          headers: { ...jbHeaders, "X-Bin-Name": "serieinfo" },
          body:    JSON.stringify(body),
        })
      );
      if (!ok) return res.status(status).json({ error: data.message || "JSONBin POST fout " + status });
      return res.status(200).json({ id: data.metadata?.id, record: data.record });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
