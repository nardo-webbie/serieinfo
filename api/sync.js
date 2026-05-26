// Cloud sync via jsonblob.com
// Geen API-sleutel vereist — alleen JSONBLOB_ID als env var
// Create:  POST https://jsonblob.com/api/jsonBlob          → 201, Location header bevat ID
// Read:    GET  https://jsonblob.com/api/jsonBlob/{id}     → 200, JSON body
// Update:  PUT  https://jsonblob.com/api/jsonBlob/{id}     → 200, geen auth vereist

const BASE = "https://jsonblob.com/api/jsonBlob";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const blobId = process.env.JSONBLOB_ID;

  async function safeJson(r) {
    const text = await r.text();
    try {
      return { ok: r.ok, status: r.status, data: JSON.parse(text) };
    } catch {
      const preview = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error("jsonblob gaf geen JSON (status " + r.status + "): " + preview);
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

  try {

    // GET — haal bibliotheek op
    if (req.method === "GET") {
      if (!blobId) return res.status(404).json({ error: "JSONBLOB_ID niet ingesteld in Vercel" });
      const { ok, status, data } = await safeJson(
        await fetch(BASE + "/" + blobId, {
          headers: { "Accept": "application/json" },
        })
      );
      if (!ok) return res.status(status).json({ error: "jsonblob GET fout " + status });
      return res.status(200).json(data);
    }

    // PUT — bibliotheek bijwerken
    if (req.method === "PUT") {
      if (!blobId) return res.status(400).json({ error: "JSONBLOB_ID niet ingesteld in Vercel" });
      const body = await readBody();
      if (!body || (!body.library && !body.films)) {
        return res.status(400).json({ error: "Leeg of ongeldig request body" });
      }
      const { ok, status } = await safeJson(
        await fetch(BASE + "/" + blobId, {
          method:  "PUT",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body:    JSON.stringify(body),
        })
      );
      if (!ok) return res.status(status).json({ error: "jsonblob PUT fout " + status });
      return res.status(200).json({ ok: true });
    }

    // POST — eerste keer blob aanmaken
    if (req.method === "POST") {
      const body = await readBody();
      const r = await fetch(BASE, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body:    JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({ error: "jsonblob aanmaken fout: " + text.slice(0, 120) });
      }
      // ID zit in de Location header: https://jsonblob.com/api/jsonBlob/123456789
      const location = r.headers.get("location") || "";
      const id = location.split("/").pop();
      return res.status(200).json({ id, location });
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
