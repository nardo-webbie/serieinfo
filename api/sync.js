export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const masterKey = process.env.JSONBIN_KEY;
  const binId     = process.env.JSONBIN_BIN_ID;

  if (!masterKey) return res.status(500).json({ error: "JSONBIN_KEY niet ingesteld in Vercel" });

  const headers = {
    "Content-Type":  "application/json",
    "X-Master-Key":  masterKey,
    "X-Bin-Private": "false",
  };

  // Body parsing — zelfde fix als claude.js
  async function readBody() {
    if (req.body !== undefined) {
      return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  try {
    if (req.method === "GET") {
      if (!binId) return res.status(404).json({ error: "JSONBIN_BIN_ID niet ingesteld in Vercel" });
      const r = await fetch("https://api.jsonbin.io/v3/b/" + binId + "/latest", { headers });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.message || "JSONBin fout" });
      return res.status(200).json(d.record || {});
    }

    if (req.method === "PUT") {
      if (!binId) return res.status(400).json({ error: "JSONBIN_BIN_ID niet ingesteld in Vercel" });
      const body = await readBody();
      const r = await fetch("https://api.jsonbin.io/v3/b/" + binId, {
        method:  "PUT",
        headers,
        body:    JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.message || "JSONBin PUT fout" });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "POST") {
      const body = await readBody();
      const r = await fetch("https://api.jsonbin.io/v3/b", {
        method:  "POST",
        headers: { ...headers, "X-Bin-Name": "serieinfo" },
        body:    JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: d.message || "JSONBin POST fout" });
      return res.status(200).json(d);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
