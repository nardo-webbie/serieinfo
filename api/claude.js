module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY niet ingesteld" });

  // Zorg dat body altijd een string is
  let bodyStr;
  try {
    const b = req.body;
    bodyStr = b === undefined || b === null
      ? "{}"
      : typeof b === "string" ? b : JSON.stringify(b);
  } catch (e) {
    return res.status(400).json({ error: "Body parse fout: " + e.message });
  }

  // Gebruik https (altijd beschikbaar in Node.js)
  const https = require("https");

  try {
    const result = await new Promise((resolve, reject) => {
      const buf = Buffer.from(bodyStr, "utf8");
      const options = {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": buf.length,
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
      };

      const req2 = https.request(options, (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => resolve({
          status: resp.statusCode,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
        resp.on("error", reject);
      });

      req2.on("error", reject);
      req2.write(buf);
      req2.end();
    });

    let parsed;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return res.status(502).json({ error: "Geen JSON van Anthropic: " + result.text.slice(0, 200) });
    }

    return res.status(result.status).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: "Request fout: " + err.message });
  }
};
