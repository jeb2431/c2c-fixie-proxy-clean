import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.raw({ type: "*/*", limit: "5mb" }));

// ------------------ Public health check (no secret required) ------------------
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ------------------ Require internal secret for proxy routes ------------------
function requireInternalSecret(req, res, next) {
  const expected = process.env.CD_PROXY_INTERNAL_SHARED_SECRET;
  if (!expected) {
    return res.status(500).json({
      error: "Server misconfigured: CD_PROXY_INTERNAL_SHARED_SECRET not set",
    });
  }

  const provided = req.headers["x-cd-proxy-secret"];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

// Everything below requires the shared secret
app.use(requireInternalSecret);

// ------------------ Fixie agent ------------------
function getHttpsAgent() {
  const fixieUrl = process.env.FIXIE_URL;
  if (!fixieUrl) throw new Error("FIXIE_URL is not set");
  return new HttpsProxyAgent(fixieUrl);
}

// Utility: copy request headers safely
function buildForwardHeaders(req) {
  const headers = {};

  // Pass-through auth if present
  if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];

  // Accept + content-type
  headers["accept"] = req.headers["accept"] || "application/json";
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];

  // Optional pass-through for keys if you ever need them
  if (req.headers["x-api-key"]) headers["x-api-key"] = req.headers["x-api-key"];

  return headers;
}

async function forward(req, res, baseUrl, stripPrefix) {
  const httpsAgent = getHttpsAgent();

  const targetPath = req.originalUrl.replace(stripPrefix, ""); // keeps querystring
  const url = new URL(targetPath, baseUrl);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  const upstream = await axios.request({
    url: url.toString(),
    method: req.method,
    httpsAgent,
    timeout: 30000,
    headers: buildForwardHeaders(req),
    data: hasBody ? req.body : undefined,
    validateStatus: () => true,
    responseType: "arraybuffer",
  });

  // Return upstream status + body
  res
    .status(upstream.status)
    .set("content-type", upstream.headers["content-type"] || "application/octet-stream")
    .send(Buffer.from(upstream.data));
}

// ------------------ ConsumerDirect PAPI passthrough: /cd/* ------------------
// IMPORTANT: This does NOT fetch tokens. It simply forwards Authorization: Bearer <token>
app.all("/cd/*", async (req, res) => {
  try {
    const baseUrl = "https://papi.consumerdirect.io";
    await forward(req, res, baseUrl, /^\/cd/);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------------ SmartCredit passthrough: /smartcredit/* ------------------
app.all("/smartcredit/*", async (req, res) => {
  try {
    const baseUrl = "https://api.smartcredit.com";
    await forward(req, res, baseUrl, /^\/smartcredit/);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------------ Start server ------------------
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`C2C proxy running on port ${port}`));
