// Cloud sync via npoint.io — geen API-sleutel vereist
// Env var: NPOINT_BIN_ID (het ID van je npoint.io endpoint)

const BASE = "https://api.npoint.io";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const binId = process.env.NPOINT_BIN_ID;

  // Safe JSON parse — handles HTML error pages gracefully
  async function safeJson(response) {
    const text = await response.text();
    try {
      return { ok: response.ok, status: response.status, data: JSON.parse(text) };
    } catch {
      const preview = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error("npoint gaf geen JSON (status " + response.status + "): " + preview);
    }
  }

  // Robust body reader
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

    // GET — haal bibliotheek op
    if (req.method === "GET") {
      if (!binId) return res.status(404).json({ error: "NPOINT_BIN_ID niet ingesteld in Vercel" });
      const { ok, status, data } = await safeJson(await fetch(BASE + "/" + binId));
      if (!ok) return res.status(status).json({ error: data.message || "npoint GET fout " + status });
      return res.status(200).json(data);
    }

    // PUT — bibliotheek bijwerken
    if (req.method === "PUT") {
      if (!binId) return res.status(400).json({ error: "NPOINT_BIN_ID niet ingesteld in Vercel" });
      const body = await readBody();
      if (!body || (!body.library && !body.films)) {
        return res.status(400).json({ error: "Leeg of ongeldig request body" });
      }
      const { ok, status, data } = await safeJson(
        await fetch(BASE + "/" + binId, {
          method:  "POST",             // npoint gebruikt POST voor updates
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        })
      );
      if (!ok) return res.status(status).json({ error: data.message || "npoint PUT fout " + status });
      return res.status(200).json({ ok: true });
    }

    // POST — eerste keer aanmaken (wordt eenmalig gebruikt)
    if (req.method === "POST") {
      const body = await readBody();
      const { ok, status, data } = await safeJson(
        await fetch(BASE + "/", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        })
      );
      if (!ok) return res.status(status).json({ error: data.message || "npoint aanmaken fout" });
      return res.status(200).json(data); // bevat het nieuwe { id, ... }
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
