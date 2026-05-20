const https = require("https");

// Promisified https request
function httpsPost(body, apiKey) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path:     "/v1/messages",
        method:   "POST",
        headers: {
          "Content-Type":      "application/json",
          "Content-Length":    Buffer.byteLength(bodyStr),
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end",  () => resolve({ status: res.statusCode, body: data }));
        res.on("error", reject);
      }
    );

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY niet ingesteld in Vercel" });

  try {
    const { status, body } = await httpsPost(req.body, apiKey);

    let parsed;
    try   { parsed = JSON.parse(body); }
    catch { return res.status(502).json({ error: "Ongeldige JSON van Anthropic: " + body.slice(0, 200) }); }

    return res.status(status).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
