// Cloud sync via GitHub Gist
// Env vars: GITHUB_TOKEN + GITHUB_GIST_ID

const GIST_API = "https://api.github.com/gists";
const FILE     = "serieinfo.json";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token  = process.env.GITHUB_TOKEN;
  const gistId = process.env.GITHUB_GIST_ID;

  const headers = {
    "Accept":       "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent":   "SerieInfo-App",
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

  try {

    // GET
    if (req.method === "GET") {
      if (!gistId) return res.status(404).json({ error: "GITHUB_GIST_ID niet ingesteld" });
      const { ok, status, data } = await safeJson(
        await fetch(GIST_API + "/" + gistId, { headers })
      );
      if (!ok) return res.status(status).json({ error: data.message || "GitHub GET fout " + status });
      const content = data.files?.[FILE]?.content;
      if (!content) return res.status(404).json({ error: FILE + " niet gevonden in gist" });
      return res.status(200).json(JSON.parse(content));
    }

    // PUT
    if (req.method === "PUT") {
      if (!gistId)  return res.status(400).json({ error: "GITHUB_GIST_ID niet ingesteld" });
      if (!token)   return res.status(401).json({ error: "GITHUB_TOKEN niet ingesteld" });
      const body = await readBody();
      if (!body || (!body.library && !body.films)) {
        return res.status(400).json({ error: "Leeg of ongeldig request body" });
      }
      const { ok, status, data } = await safeJson(
        await fetch(GIST_API + "/" + gistId, {
          method:  "PATCH",
          headers,
          body:    JSON.stringify({ files: { [FILE]: { content: JSON.stringify(body) } } }),
        })
      );
      if (!ok) return res.status(status).json({ error: data.message || "GitHub PATCH fout " + status });
      return res.status(200).json({ ok: true });
    }

    // POST — gist aanmaken
    if (req.method === "POST") {
      if (!token) return res.status(401).json({ error: "GITHUB_TOKEN vereist" });
      const body = await readBody();
      const { ok, status, data } = await safeJson(
        await fetch(GIST_API, {
          method:  "POST",
          headers,
          body:    JSON.stringify({
            description: "SerieInfo bibliotheek sync",
            public:      false,
            files:       { [FILE]: { content: JSON.stringify(body) } },
          }),
        })
      );
      if (!ok) return res.status(status).json({ error: data.message || "GitHub POST fout " + status });
      return res.status(200).json({ id: data.id, url: data.html_url });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
