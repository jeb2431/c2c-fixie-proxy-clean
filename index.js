// index.js
import express from "express";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const app = express();
app.use(express.json({ limit: "2mb" }));

const UA = "Credit2Credit/1.0 (Render Proxy; Fixie; Server-to-Server)";

const FIXIE_URL = process.env.FIXIE_URL || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";
const dispatcher = FIXIE_URL ? new ProxyAgent(FIXIE_URL) : undefined;

const CONSUMERDIRECT_BASE_URL =
  (process.env.CONSUMERDIRECT_BASE_URL || "https://api.consumerdirect.io").replace(/\/+$/, "");

const SMARTCREDIT_BASE_URL =
  (process.env.CD_SMARTCREDIT_BASE_URL || process.env.CD_SMARTCREDIT_BASE || "https://api.smartcredit.com").replace(
    /\/+$/,
    "",
  );

// Your proxy should accept either of these as the shared secret.
// (Use whichever is easiest while Base44 secrets UI is broken.)
const VALID_SECRETS = new Set(
  [process.env.PROXY_API_KEY, process.env.CD_PROXY_INTERNAL_SHARED_SECRET].filter(Boolean),
);

function requireProxySecret(req, res, next) {
  const provided = req.header("x-cd-proxy-secret") || "";
  if (!provided || !VALID_SECRETS.size) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized (missing/invalid x-cd-proxy-secret)",
      hasProvided: !!provided,
      hasAnyValidSecretsConfigured: VALID_SECRETS.size > 0,
    });
  }
  if (!VALID_SECRETS.has(provided)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized (missing/invalid x-cd-proxy-secret)",
      hint: "Proxy secret mismatch. Make sure Base44 is sending exactly PROXY_API_KEY (or CD_PROXY_INTERNAL_SHARED_SECRET) from Render.",
    });
  }
  next();
}

function buildUpstreamHeaders(req) {
  const h = { ...req.headers };

  // Never forward the proxy secret upstream
  delete h["x-cd-proxy-secret"];

  // IMPORTANT:
  // Base44 should send the OAuth token as x-cd-authorization.
  // We map it to Authorization for ConsumerDirect/SmartCredit.
  if (h["x-cd-authorization"]) {
    h["authorization"] = h["x-cd-authorization"];
    delete h["x-cd-authorization"];
  }

  // Remove hop-by-hop / problematic headers
  delete h["host"];
  delete h["connection"];
  delete h["content-length"];

  // Enforce UA
  h["user-agent"] = UA;

  return h;
}

async function forward(req, res, upstreamUrl) {
  const headers = buildUpstreamHeaders(req);

  // Don’t send body on GET/HEAD
  const method = req.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : req.body === undefined
        ? undefined
        : JSON.stringify(req.body);

  const upstreamResp = await undiciFetch(upstreamUrl, {
    method,
    headers,
    body,
    dispatcher,
    redirect: "manual",
  });

  const text = await upstreamResp.text();

  // Forward content-type
  const ct = upstreamResp.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);

  return res.status(upstreamResp.status).send(text);
}

// -------------------- DEBUG --------------------
app.get("/debug/proxy", (req, res) => {
  res.json({
    ok: true,
    hasFixieUrl: !!FIXIE_URL,
    usingProxy: !!dispatcher,
    consumerDirectBase: CONSUMERDIRECT_BASE_URL,
    smartCreditBase: SMARTCREDIT_BASE_URL,
    hasProxyApiKey: !!process.env.PROXY_API_KEY,
    hasInternalSharedSecret: !!process.env.CD_PROXY_INTERNAL_SHARED_SECRET,
  });
});

app.get("/debug/ip", async (req, res) => {
  try {
    const r = await undiciFetch("https://api.ipify.org?format=json", {
      headers: { accept: "application/json", "user-agent": UA },
      dispatcher,
    });
    const j = await r.json().catch(() => ({}));
    res.json({ ok: r.ok, status: r.status, viaFixie: !!dispatcher, ip: j.ip || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- ROUTES --------------------
// ConsumerDirect
app.all("/cd/*", requireProxySecret, async (req, res) => {
  try {
    const path = req.originalUrl.replace(/^\/cd/, ""); // keep querystring
    const upstreamUrl = `${CONSUMERDIRECT_BASE_URL}${path}`;
    return await forward(req, res, upstreamUrl);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// SmartCredit
app.all("/smartcredit/*", requireProxySecret, async (req, res) => {
  try {
    const path = req.originalUrl.replace(/^\/smartcredit/, "");
    const upstreamUrl = `${SMARTCREDIT_BASE_URL}${path}`;
    return await forward(req, res, upstreamUrl);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`[proxy] listening on :${port}`));
