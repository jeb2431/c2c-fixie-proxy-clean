import express from "express";
import { SocksProxyAgent } from "socks-proxy-agent";

const app = express();

// Health check (Render)
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Prove outbound traffic is going through Fixie by fetching our public IP
app.get("/ip", async (req, res) => {
  try {
    const fixieUrl = process.env.FIXIE_URL;
    if (!fixieUrl) {
      return res.status(500).json({ error: "FIXIE_URL is not set" });
    }

    // Fixie provides an HTTP proxy. Convert it to a socks proxy via their gateway.
    // Most Fixie accounts support SOCKS at: socks://<user>:<pass>@<host>:1080
    const u = new URL(fixieUrl);
    const socksUrl = `socks://${u.username}:${u.password}@${u.hostname}:1080`;

    const agent = new SocksProxyAgent(socksUrl);

    const r = await fetch("https://api.ipify.org?format=json", { agent });
    const data = await r.json();

    res.json({ via: "fixie", ip: data.ip });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Proxy running on port ${port}`);
});
