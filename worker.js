export default {
  async fetch(request) {
    const ALLOWED_ORIGINS = new Set([
      "https://antirub.com",
      "https://www.antirub.com",
    ]);

    const origin = request.headers.get("Origin") || "";
    const allowOrigin = ALLOWED_ORIGINS.has(origin)
      ? origin
      : "https://antirub.com";

    const cors = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") ||
        "content-type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: cors,
      });
    }

    const body = await request.text();

    const upstream = "https://arbitrum-one-rpc.publicnode.com";
    // ⚠️ В ПРОДЕ замените на RPC с ключом (Alchemy / Ankr / Infura)

    const r = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    return new Response(await r.text(), {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  },
};
