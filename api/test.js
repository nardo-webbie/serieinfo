export default function handler(req, res) {
  res.status(200).json({
    ok:         true,
    method:     req.method,
    hasApiKey:  !!process.env.ANTHROPIC_API_KEY,
    nodeVersion: process.version,
  });
}
