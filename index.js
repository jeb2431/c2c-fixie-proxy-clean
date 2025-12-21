import express from "express";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const app = express();
app.use(express.raw({ type: "*/*", limit: "5mb" }));

/**
 * REQUIRED ENV VARS on Render:
 * FIXIE_URL
 * CONSUMERDIRECT_BASE_URL
 * CONSUMERDIRECT_CLIENT_ID
 * CONSUMERDIRECT_CLIENT_SECRET
 * CD_PROXY_INTERNAL_SHARED_SECRET
 * ALLOWED_ORIGINS (optional but recommended)
 */

// ------------------ Simple browser safety (CORS) ------------------
function corsLockdown(req, res, next) {
  const allow = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin;

  // If no origins are configured, do nothing (server-to-server calls still work)
  if (allow.length === 0) return next();

  if (origin && allow.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-cd-proxy-secret");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  }

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
}

app.use(corsLockdown);

// ------------------ Public health check ------------------
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ------------------ ONE SECRET ONLY (Base44 -> Render) ------------------
function requireInternalSecret(req, res, next) {
  const expected = process.env.CD_PROXY_INTERNAL_SHARED_SECRET;
  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured: CD_PROXY_INTERNAL_SHARED_SECRET not set" });
  }

  // Base44 should send this header
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

// ------------------ ConsumerDirect token (cached) ------------------
let cachedToken = null;
let cachedTokenExpMs = 0;

async function getConsumerDirectToken(httpsAgent) {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpMs - 60_000) return { ok: true, token: cachedToken };

  const clientId = process.env.CONSUMERDIRECT_CLIENT_ID;
  const clientSecret = process.env.CONSUMERDIRECT_CLIENT_SECRET;

  if (!clientId) throw new Error("CONSUMERDIRECT_CLIENT_ID is not set");
  if (!clientSecret) throw new Error("CONSUMERDIRECT_CLIENT_SECRET is not set");

  const tokenUrl = "https://auth.consumerdirect.io/oauth2/token";
  const scope = "target-entity:e6c9113e-48b8-41ef-a87e-87a3c51a5e83";
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("scope", scope);

  const r = await axios.post(tokenUrl, body.toString(), {
    httpsAgent,
    timeout: 30000,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`
    },
    validateStatus: () => true
  });

  if (r.status < 200 || r.status >= 300) {
    return { ok: false, status: r.status, data: r.data };
  }

  const accessToken = r.data?.access_token;
  const expiresIn = Number(r.data?.expires_in || 900);

  if (!accessToken) return { ok: false, status: 500, data: r.data };

  cachedToken = accessToken;
  cachedTokenExpMs = Date.now() + expiresIn * 1000;

  return { ok: true, token: accessToken, expiresIn };
}

// Safe debug route: does NOT expose full token
app.get("/cd-token-preview", async (req, res) => {
  try {
    const httpsAgent = getHttpsAgent();
    const t = await getConsumerDirectToken(httpsAgent);
    if (!t.ok) return res.status(t.status || 500).json({ error: "Token failed", details: t.data });

    res.json({ ok: true, access_token_preview: t.token.slice(0, 25) + "..." });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------------ Main gateway: /cd/* forwards to ConsumerDirect ------------------
app.all("/cd/*", async (req, res) => {
  try {
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const httpsAgent = getHttpsAgent();
    const tokenResp = await getConsumerDirectToken(httpsAgent);
    if (!tokenResp.ok) return res.status(tokenResp.status || 500).json({ error: "Token failed", details: tokenResp.data });

    const targetPath = req.originalUrl.replace(/^\/cd/, ""); // keeps query string
    const url = new URL(targetPath, baseUrl);

    const headers = {
      authorization: `Bearer ${tokenResp.token}`,
      accept: req.headers["accept"] || "application/json"
    };

    const ct = req.headers["content-type"];
    if (ct) headers["content-type"] = ct;

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    const upstream = await axios.request({
      url: url.toString(),
      method: req.method,
      httpsAgent,
      timeout: 30000,
      headers,
      data: hasBody ? req.body : undefined,
      validateStatus: () => true,
      responseType: "arraybuffer"
    });

    res
      .status(upstream.status)
      .set("content-type", upstream.headers["content-type"] || "application/octet-stream")
      .send(Buffer.from(upstream.data));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`C2C gateway running on port ${port}`));
