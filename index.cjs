/**
 * index.cjs — C2C Fixie Proxy (CommonJS)
 *
 * PURPOSE
 * - Secure proxy for ConsumerDirect / SmartCredit APIs
 * - Uses Fixie (static IP) if FIXIE_URL is set
 * - Protects with x-proxy-api-key
 * - FIXES core bug: incoming /papi/... → upstream /v1/... (strips /papi)
 *
 * REQUIRED ENV VARS (Render):
 *   PORT
 *   PROXY_API_KEY
 *   CD_PAPI_PROD_CLIENT_ID
 *   CD_PAPI_PROD_CLIENT_SECRET
 *
 * OPTIONAL:
 *   FIXIE_URL
 *   CD_AUTH_BASE_URL (default https://auth.consumerdirect.io)
 *   CD_PAPI_BASE_URL (default https://papi.consumerdirect.io)
 */

const express = require("express");
const { ProxyAgent, setGlobalDispatcher, fetch } = require("undici");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

/* =========================
   ENV
========================= */
const PORT = process.env.PORT || 10000;
const PROXY_API_KEY = process.env.PROXY_API_KEY;

const AUTH_BASE =
  process.env.CD_AUTH_BASE_URL || "https://auth.consumerdirect.io";
const PAPI_BASE =
  process.env.CD_PAPI_BASE_URL || "https://papi.consumerdirect.io";

const CLIENT_ID = process.env.CD_PAPI_PROD_CLIENT_ID;
const CLIENT_SECRET = process.env.CD_PAPI_PROD_CLIENT_SECRET;

/* =========================
   FIXIE SUPPORT
========================= */
if (process.env.FIXIE_URL) {
  const agent = new ProxyAgent(process.env.FIXIE_URL);
  setGlobalDispatcher(agent);
  console.log("[proxy] FIXIE enabled");
}

/* =========================
   SECURITY MIDDLEWARE
========================= */
app.use((req, res, next) => {
  if (!PROXY_API_KEY) {
    return res.status(500).json({ error: "PROXY_API_KEY not set on server" });
  }

  const key = req.headers["x-proxy-api-key"];
  if (key !== PROXY_API_KEY) {
    return res.status(401).json({ error: "Invalid proxy API key" });
  }

  next();
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (_req, res) => {
  res.status(200).send("ok");
});

/* =========================
   OAUTH TOKEN ENDPOINT
   POST /oauth/token
========================= */
app.post("/oauth/token", async (_req, res) => {
  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).json({
        error: "Missing CD_PAPI_PROD_CLIENT_ID or CD_PAPI_PROD_CLIENT_SECRET",
      });
    }

    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");

    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString(
      "base64"
    );

    const r = await fetch(`${AUTH_BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const text = await r.text();
    res.status(r.status).send(text);
  } catch (err) {
    console.error("[oauth/token]", err);
    res.status(500).json({ error: "OAuth token error" });
  }
});

/* =========================
   PAPI PROXY
   /papi/...  →  upstream /v1/...
========================= */
app.use("/papi", async (req, res) => {
  try {
    // STRIP /papi from path
    const upstreamPath = req.originalUrl.replace(/^\/papi/, "");
    const upstreamUrl = `${PAPI_BASE}${upstreamPath}`;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (
        k.toLowerCase() === "host" ||
        k.toLowerCase() === "x-proxy-api-key" ||
        k.toLowerCase() === "content-length"
      ) {
        continue;
      }
      headers[k] = v;
    }

    const r = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : JSON.stringify(req.body),
    });

    res.status(r.status);
    r.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error("[papi proxy]", err);
    res.status(500).json({ error: "Proxy error" });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT}`);
});
