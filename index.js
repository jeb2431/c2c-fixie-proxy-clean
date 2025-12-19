import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";

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

    // Use Fixie as an HTTP/HTTPS proxy (matches Fixie dashboard outbound IPs)
    const agent = new HttpsProxyAgent(fixieUrl);

    const r = await fetch("https://api.ipify.org?format=json", { agent });
    const data = await r.json();

    res.json({ via: "fixie-http", ip: data.ip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Proxy running on port ${port}`);
});
