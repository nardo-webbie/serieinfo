// Proxy voor JSONBin.io cloud sync
// Houdt de Master Key server-side zodat die niet zichtbaar is in de browser

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const masterKey = process.env.JSONBIN_KEY;
  if (!masterKey) {
    return res.status(500).json({ error: "JSONBIN_KEY niet ingesteld in Vercel" });
  }

  const binId  = process.env.JSONBIN_BIN_ID;
  const base   = "https://api.jsonbin.io/v3/b";
  const headers = {
    "Content-Type": "application/json",
    "X-Master-Key": masterKey,
    "X-Bin-Private": "false",
  };

  try {
    // GET /api/sync  → haal bibliotheek op
    if (req.method === "GET") {
      if (!binId) return res.status(404).json({ error: "Nog geen bin aangemaakt" });
      const r = await fetch(base + "/" + binId + "/latest", { headers });
      const d = await r.json();
      return res.status(r.status).json(d.record || d);
    }

    // POST /api/sync  → eerste keer: maak bin aan
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const r = await fetch(base, {
        method: "POST",
        headers: { ...headers, "X-Bin-Name": "serieinfo" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    }

    // PUT /api/sync  → bijwerken
    if (req.method === "PUT") {
      if (!binId) return res.status(400).json({ error: "Geen bin ID geconfigureerd" });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const r = await fetch(base + "/" + binId, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      const d = await r.json();
      return res.status(r.status).json(d);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
