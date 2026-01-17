/**
 * index.cjs — C2C Fixie Proxy (CommonJS)
 *
 * REQUIRED env:
 *   PORT
 *   PROXY_API_KEY
 *
 * OPTIONAL env:
 *   FIXIE_URL
 */

const express = require("express");
const { ProxyAgent, setGlobalDispatcher, fetch, Headers } = require("undici");

const app = express();

// --- Fixie support (optional) ---
const FIXIE_URL = process.env.FIXIE_URL;
if (FIXIE_URL) {
  try {
    const agent = new ProxyAgent(FIXIE_URL);
    setGlobalDispatcher(agent);
    console.log("[proxy] FIXIE_URL enabled");
  } catch (e) {
    console.log("[proxy] FIXIE_URL failed to initialize:", e?.message || e);
  }
}

// --- Config ---
const PORT = process.env.PORT || 10000;
const PROXY_API_KEY = process.env.PROXY_API_KEY;

if (!PROXY_API_KEY) {
  console.log("[proxy] WARNING: PROXY_API_KEY is not set");
}

// body parsers
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// --- auth middleware ---
function requireProxyKey(req, res, next) {
  const key = req.headers["x-proxy-api-key"];
  if (!PROXY_API_KEY) {
    return res.status(500).json({ ok: false, error: "PROXY_API_KEY_NOT_SET_ON_SERVER" });
  }
  if (!key || key !== PROXY_API_KEY) {
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED_PROXY_KEY" });
  }
  next();
}

// --- helpers ---
async function readTextSafe(r) {
  try {
    return await r.text();
  } catch {
    return "";
  }
}

function pickHeaders(incomingHeaders) {
  // Start with incoming headers, but strip hop-by-hop + proxy secret header
  const h = new Headers();
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    const key = k.toLowerCase();
    if (
      key === "host" ||
      key === "connection" ||
      key === "content-length" ||
      key === "accept-encoding" ||
      key === "x-proxy-api-key"
    ) {
      continue;
    }
    if (typeof v !== "undefined") h.set(key, v);
  }
  // always set a UA so upstream doesn’t block “unknown”
  if (!h.get("user-agent")) h.set("user-agent", "Credit2Credit/1.0 (Render Proxy)");
  return h;
}

async function forward({ method, url, headers, body }) {
  const h = pickHeaders(headers);

  const opts = { method, headers: h };

  // Only attach body for methods that allow it
  if (body != null && !["GET", "HEAD"].includes(method.toUpperCase())) {
    opts.body = body;
  }

  const t0 = Date.now();
  const r = await fetch(url, opts);
  const ms = Date.now() - t0;

  const text = await readTextSafe(r);

  return {
    ok: r.ok,
    status: r.status,
    ms,
    headers: Object.fromEntries(r.headers.entries()),
    body: text,
  };
}

// --- routes ---

// Health endpoint so you can validate proxy is alive.
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "c2c-fixie-proxy-clean", hasFixie: !!FIXIE_URL });
});

// Your existing token passthrough (kept simple)
app.post("/oauth/token", requireProxyKey, async (req, res) => {
  try {
    // You’re currently using this as a “smoke test”.
    // If you want this to always target auth.consumerdirect.io, do it here.
    // Otherwise leave as-is and let Base44 call auth directly (but through proxy).
    const targetUrl = "https://auth.consumerdirect.io/oauth2/token";

    // If caller sent x-www-form-urlencoded, keep it.
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    let body;
    let headers = req.headers;

    if (contentType.includes("application/x-www-form-urlencoded")) {
      body = req.body && typeof req.body === "object" ? new URLSearchParams(req.body).toString() : "";
    } else if (typeof req.body === "string") {
      body = req.body;
    } else {
      // default minimal
      body = "grant_type=client_credentials";
      headers = { ...headers, "content-type": "application/x-www-form-urlencoded" };
    }

    const out = await forward({
      method: "POST",
      url: targetUrl,
      headers,
      body,
    });

    res.status(out.status);
    // pass-through content-type if present
    const ct = out.headers["content-type"];
    if (ct) res.setHeader("content-type", ct);
    return res.send(out.body);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "OAUTH_PROXY_ERROR", message: String(e?.message || e) });
  }
});

/**
 * Generic forwarder:
 * POST /raw
 * Headers: x-proxy-api-key: <PROXY_API_KEY>
 * Body JSON:
 * {
 *   "method": "GET|POST|PUT|DELETE|PATCH|OPTIONS",
 *   "url": "https://whatever.host/path",
 *   "headers": { ...optional headers... },
 *   "body": "string body"  // optional
 * }
 */
app.post("/raw", requireProxyKey, async (req, res) => {
  try {
    const { method, url, headers, body } = req.body || {};
    if (!method || !url) {
      return res.status(400).json({ ok: false, error: "MISSING_METHOD_OR_URL" });
    }

    const out = await forward({
      method,
      url,
      headers: headers || req.headers,
      body: body ?? null,
    });

    // Return upstream response as JSON so Base44 can parse it reliably.
    return res.status(200).json({
      ok: true,
      upstream: {
        ok: out.ok,
        status: out.status,
        ms: out.ms,
        content_type: out.headers["content-type"] || null,
        // body can be huge; Base44 preview is enough
        body_preview: out.body ? out.body.slice(0, 2000) : "",
        headers: out.headers,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "RAW_PROXY_ERROR", message: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[proxy] listening on ${PORT}`);
});
