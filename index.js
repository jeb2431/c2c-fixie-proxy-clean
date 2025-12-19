import express from "express";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const app = express();
app.use(express.raw({ type: "*/*", limit: "5mb" }));

// BASIC
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

// CONSUMERDIRECT TOKEN
async function getConsumerDirectToken(dispatcher) {
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

  const r = await undiciFetch(tokenUrl, {
    method: "POST",
    dispatcher,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "authorization": `Basic ${basic}`
    },
    body: body.toString()
  });

  const json = await r.json().catch(async () => ({ raw: await r.text() }));
  if (!r.ok) {
    const err = new Error("Token request failed");
    err.status = r.status;
    err.payload = json;
    throw err;
  }

  if (!json.access_token) {
    const err = new Error("No access_token returned");
    err.status = 500;
    err.payload = json;
    throw err;
  }

  return json.access_token;
}

app.get("/cd-token", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);
    const token = await getConsumerDirectToken(dispatcher);

    res.json({ ok: true, access_token_preview: token.slice(0, 25) + "..." });
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e), details: e.payload });
  }
});

// TEST: GET /v1/customers
app.get("/cd-test-customers", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);
    const token = await getConsumerDirectToken(dispatcher);

    const url = new URL("/v1/customers", baseUrl);

    const upstream = await undiciFetch(url.toString(), {
      method: "GET",
      dispatcher,
      headers: {
        "authorization": `Bearer ${token}`,
        "accept": "application/json"
      }
    });

    const text = await upstream.text();
    res.status(upstream.status)
      .set("content-type", upstream.headers.get("content-type") || "text/plain")
      .send(text);
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e), details: e.payload });
  }
});

// TEST: LOGIN-AS (this is what you need to debug 403/WAF)
app.get("/cd-test-login-as", async (req, res) => {
  try {
    const customerToken = req.query.customerToken;
    if (!customerToken) {
      return res.status(400).json({ error: "Missing customerToken. Use: /cd-test-login-as?customerToken=..." });
    }

    const fixieUrl = process.env.FIXIE_URL;
    const baseUrl = process.env.CONSUMERDIRECT_BASE_URL;

    if (!fixieUrl) return res.status(500).json({ error: "FIXIE_URL is not set" });
    if (!baseUrl) return res.status(500).json({ error: "CONSUMERDIRECT_BASE_URL is not set" });

    const dispatcher = new ProxyAgent(fixieUrl);
    const token = await getConsumerDirectToken(dispatcher);

    const url = new URL(`/v1/customers/${customerToken}/otcs/login-as`, baseUrl);

    const upstream = await undiciFetch(url.toString(), {
      method: "POST",
      dispatcher,
      headers: {
        "authorization": `Bearer ${token}`,
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ agentId: "Credit2Credit Support" })
    });

    const text = await upstream.text();
    res.status(upstream.status)
      .set("content-type", upstream.headers.get("content-type") || "text/plain")
      .send(text);
  } catch (e) {
    res.status(e.status || 500).json({ error: String(e.message || e), details: e.payload });
  }
});

// OPTIONAL FORWARDER (kept)
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
    res.status(upstream.status)
      .set("content-type", upstream.headers.get("content-type") || "text/plain")
      .send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy running on port ${port}`));
