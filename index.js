import express from "express";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const app = express();

// Health check (Render)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Prove outbound traffic is going through Fixie HTTP proxy by fetching our public IP
app.get("/ip", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    if (!fixieUrl) {
      return res.status(500).json({ error: "FIXIE_URL is not set" });
    }

    // Undici (Node 22 fetch) uses "dispatcher", not "agent"
    const dispatcher = new ProxyAgent(fixieUrl);

    const r = await undiciFetch("https://api.ipify.org?format=json", { dispatcher });
    const data = await r.json();

    res.json({ via: "fixie-http-undici", ip: data.ip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Proxy running on port ${port}`);
});
