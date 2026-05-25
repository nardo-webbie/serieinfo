export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const masterKey = process.env.JSONBIN_KEY;
  const binId     = process.env.JSONBIN_BIN_ID;

  if (!masterKey) return res.status(500).json({ error: "JSONBIN_KEY niet ingesteld" });

  const jbHeaders = {
    "Content-Type":  "application/json",
    "X-Master-Key":  masterKey,
    "X-Bin-Private": "false",
  };

  // Safe JSON parse from a fetch Response — handles HTML error pages
  async function safeJson(response) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      // JSONBin returned HTML (rate limit, maintenance, etc.)
      const preview = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error("JSONBin gaf geen JSON terug (status " + response.status + "): " + preview);
    }
  }

  // Robust body parsing
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

    if (req.method === "GET") {
      if (!binId) return res.status(404).json({ error: "JSONBIN_BIN_ID niet ingesteld" });
      const r = await fetch("https://api.jsonbin.io/v3/b/" + binId + "/latest", { headers: jbHeaders });
      const d = await safeJson(r);
      if (!r.ok) return res.status(r.status).json({ error: d.message || "JSONBin GET fout" });
      return res.status(200).json(d.record || {});
    }

    if (req.method === "PUT") {
      if (!binId) return res.status(400).json({ error: "JSONBIN_BIN_ID niet ingesteld" });
      const body = await readBody();
      if (!body || (!body.library && !body.films)) {
        return res.status(400).json({ error: "Leeg request body" });
      }
      const r = await fetch("https://api.jsonbin.io/v3/b/" + binId, {
        method: "PUT", headers: jbHeaders, body: JSON.stringify(body),
      });
      const d = await safeJson(r);
      if (!r.ok) return res.status(r.status).json({ error: d.message || "JSONBin PUT fout" });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "POST") {
      const body = await readBody();
      const r = await fetch("https://api.jsonbin.io/v3/b", {
        method: "POST",
        headers: { ...jbHeaders, "X-Bin-Name": "serieinfo" },
        body: JSON.stringify(body),
      });
      const d = await safeJson(r);
      if (!r.ok) return res.status(r.status).json({ error: d.message || "JSONBin POST fout" });
      return res.status(200).json(d);
    }

    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
