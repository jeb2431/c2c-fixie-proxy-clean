import { createClientFromRequest } from "npm:@base44/sdk@0.8.6";

async function readJsonSafe(res) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function preview(val) {
  if (!val || typeof val !== "string") return null;
  if (val.length <= 12) return `${val.slice(0, 4)}…${val.slice(-3)}`;
  return `${val.slice(0, 6)}…************…${val.slice(-6)}`;
}

async function mintPapiAccessToken() {
  const oauthUrl =
    (Deno.env.get("CD_PAPI_OAUTH_URL") || "https://auth.consumerdirect.io/oauth2/token").trim();
  const clientId = (Deno.env.get("CD_PAPI_CLIENT_ID") || "").trim();
  const clientSecret = (Deno.env.get("CD_PAPI_CLIENT_SECRET") || "").trim();
  const scope = (Deno.env.get("CD_PAPI_SCOPE") || "").trim();

  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error: "MISSING_PAPI_CREDENTIALS",
      requiredSecrets: ["CD_PAPI_CLIENT_ID", "CD_PAPI_CLIENT_SECRET", "CD_PAPI_OAUTH_URL", "CD_PAPI_SCOPE"],
    };
  }

  const params = new URLSearchParams();
  params.set("grant_type", "client_credentials");
  if (scope) params.set("scope", scope);

  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const res = await fetch(oauthUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${basicAuth}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });

  const { text, json } = await readJsonSafe(res);
  if (!res.ok) return { ok: false, error: "PAPI_OAUTH_FAILED", status: res.status, raw: text, parsed: json };

  const token = json?.access_token || null;
  if (!token) return { ok: false, error: "NO_ACCESS_TOKEN", raw: text, parsed: json };

  return { ok: true, papiAccessToken: token, expiresIn: json?.expires_in ?? null, scope: json?.scope ?? scope ?? null };
}

Deno.serve(async (req) => {
  createClientFromRequest(req);

  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const customerToken = (body?.customerToken || "").trim();
  const agentId = (body?.agentId || "joelb").trim();

  if (!customerToken) {
    return new Response(
      JSON.stringify({
        ok: false,
        step: "C",
        error: "MISSING_CUSTOMER_TOKEN",
        requiredBody: { customerToken: "3fcc39ca-0678-4f8a-8f09-3b895eaf0e26", agentId: "joelb" },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const proxyUrl = (Deno.env.get("CD_PROXY_URL") || "").trim();
  const sharedSecret = (Deno.env.get("CD_PROXY_INTERNAL_SHARED_SECRET") || "").trim();

  if (!proxyUrl || !sharedSecret) {
    return new Response(
      JSON.stringify({
        ok: false,
        step: "C",
        error: "MISSING_PROXY_SECRETS",
        requiredSecrets: ["CD_PROXY_URL", "CD_PROXY_INTERNAL_SHARED_SECRET"],
        hasProxyUrl: !!proxyUrl,
        hasSharedSecret: !!sharedSecret,
      }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  const tok = await mintPapiAccessToken();
  if (!tok.ok) {
    return new Response(
      JSON.stringify({ ok: false, step: "C", where: "mintPapiAccessToken", ...tok }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  const papiAccessToken = tok.papiAccessToken;

  // ✅ matches the doc: /v1/customers/{customerToken}/otcs/login-as
  // ✅ via your proxy route: /cd + same path
  const url =
    proxyUrl.replace(/\/+$/, "") +
    "/cd/v1/customers/" +
    encodeURIComponent(customerToken) +
    "/otcs/login-as";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shared-Secret": sharedSecret,
      Authorization: `Bearer ${papiAccessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentId }),
  });

  const { text, json } = await readJsonSafe(res);

  if (!res.ok) {
    return new Response(
      JSON.stringify({
        ok: false,
        step: "C",
        error: "OTC_REQUEST_FAILED",
        status: res.status,
        url,
        papiAccessToken_preview: preview(papiAccessToken),
        scope: tok.scope ?? null,
        raw: text?.slice(0, 2000),
        parsed: json,
      }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  const otcCode = json?.code || null;

  if (!otcCode) {
    return new Response(
      JSON.stringify({
        ok: false,
        step: "C",
        error: "NO_OTC_CODE_IN_RESPONSE",
        status: res.status,
        url,
        raw: text?.slice(0, 2000),
        parsed: json,
      }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      step: "C",
      url,
      customerToken_preview: preview(customerToken),
      agentId,
      otcCode,
      otcCode_preview: preview(otcCode),
      expirationDateTime: json?.expirationDateTime ?? null,
      type: json?.type ?? null,
      note: "NEXT: Step D exchange otcCode for SmartCredit customer JWT (GET, no proxy).",
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
});
