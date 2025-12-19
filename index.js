import express from "express";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const app = express();
app.use(express.raw({ type: "*/*", limit: "5mb" }));

// ===== BASIC =====
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/ip", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);
    const r = await undiciFetch("https://api.ipify.org?format=json", { dispatcher });
    const data = await r.json();
    res.json({ via: "fixie-http-undici", ip: data.ip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== CONSUMERDIRECT OAUTH TOKEN (SERVER SIDE) =====
app.get("/cd-token", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const clientId = process.env.CONSUMERDIRECT_CLIENT_ID;
    const clientSecret = process.env.CONSUMERDIRECT_CLIENT_SECRET;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!clientId) return res.status(500).json({ error: "CONSUMERDIRECT_CLIENT_ID is not set" });
    if (!clientSecret) return res.status(500).json({ error: "CONSUMERDIRECT_CLIENT_SECRET is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);

    const tokenUrl = "https://auth.consumerdirect.io/oauth2/token";
    const scope = "target-entity:e6c9113e-48b8-41ef-a87e-87a3c51a5e83";

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("scope", scope);

    const r = await undiciFetch(tokenUrl, {
      method: "POST",
      dispatcher,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "authorization": `Basic ${basic}`
      },
      body: body.toString()
    });

    const text = await r.text();
    res.status(r.status).set("content-type", r.headers.get("content-type") || "text/plain").send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== CONSUMERDIRECT TEST: GET /v1/customers (SERVER SIDE) =====
app.get("/cd-test-customers", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;
    const clientId = process.env.CONSUMERDIRECT_CLIENT_ID;
    const clientSecret = process.env.CONSUMERDIRECT_CLIENT_SECRET;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });
    if (!clientId) return res.status(500).json({ error: "CONSUMERDIRECT_CLIENT_ID is not set" });
    if (!clientSecret) return res.status(500).json({ error: "CONSUMERDIRECT_CLIENT_SECRET is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);

    // 1) Get token
    const tokenUrl = "https://auth.consumerdirect.io/oauth2/token";
    const scope = "target-entity:e6c9113e-48b8-41ef-a87e-87a3c51a5e83";
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const tokenBody = new URLSearchParams();
    tokenBody.set("grant_type", "client_credentials");
    tokenBody.set("scope", scope);

    const tokenResp = await undiciFetch(tokenUrl, {
      method: "POST",
      dispatcher,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "authorization": `Basic ${basic}`
      },
      body: tokenBody.toString()
    });

    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(tokenResp.status).json({ step: "token", tokenJson });
    }

    const accessToken = tokenJson.access_token;
    if (!accessToken) return res.status(500).json({ error: "No access_token returned", tokenJson });

    // 2) Call PAPI
    const url = new URL("/v1/customers", baseUrl);

    const upstream = await undiciFetch(url.toString(), {
      method: "GET",
      dispatcher,
      headers: {
        "authorization": `Bearer ${accessToken}`,
        "accept": "application/json"
      }
    });

    const text = await upstream.text();
    res.status(upstream.status).set("content-type", upstream.headers.get("content-type") || "text/plain").send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== OPTIONAL FORWARDER (kept) =====
app.all("/cd/*", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);

    const targetPath = req.originalUrl.replace(/^\/cd/, "");
    const url = new URL(targetPath, baseUrl);

    const headers = {};
    const passthrough = ["authorization", "content-type", "accept"];
    for (const h of passthrough) {
      const v = req.headers[h];
      if (v) headers[h] = v;
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    if (hasBody && !headers["content-type"]) headers["content-type"] = "application/json";

    const upstream = await undiciFetch(url.toString(), {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      dispatcher
    });

    const text = await upstream.text();
    res.status(upstream.status).set("content-type", upstream.headers.get("content-type") || "text/plain").send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy running on port ${port}`));
