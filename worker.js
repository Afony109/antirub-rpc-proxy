export default {
  async fetch(request, env, ctx) {
    // -------------------------------
    // CORS (строго для ваших доменов)
    // -------------------------------
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
        request.headers.get("Access-Control-Request-Headers") || "content-type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: cors });
    }

    const requiredKey = env?.ANTIRUB_RPC_KEY;
if (requiredKey) {
  const providedKey = request.headers.get("x-antirub-key") || "";
  if (providedKey !== requiredKey) {
    return new Response("Forbidden", { status: 403, headers: cors });
  }
}

    const ct = request.headers.get("Content-Type") || "";
    if (!ct.toLowerCase().includes("application/json")) {
      return new Response("Unsupported Content-Type", { status: 415, headers: cors });
    }

    let payload;
    const rawBody = await request.text();
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
        cors
      );
    }

    // ---------------------------------------
    // Upstreams / retries / timeout параметры
    // ---------------------------------------
    const upstreams = parseUpstreams(env);
    const timeoutMs = toInt(env?.UPSTREAM_TIMEOUT_MS, 8000);
    const retries = toInt(env?.UPSTREAM_RETRIES, 1); // 1 = один повтор (итого 2 попытки на upstream)
    const maxLogRange = toInt(env?.MAX_LOG_RANGE, 49000); // запас под 50k лимит

    // Batch запросы (массив) не чанкуем — просто проксируем с fallback
    const isBatch = Array.isArray(payload);

    // -------------------------------------------------
    // Спец-обработка: eth_getLogs с чанкингом диапазона
    // -------------------------------------------------
    if (!isBatch && payload?.method === "eth_getLogs" && payload?.params?.[0]) {
      const filter = payload.params[0];
      const from = parseBlockTag(filter.fromBlock);
      const to = parseBlockTag(filter.toBlock);

      // Чанкуем только если from/to оба числа (hex) и диапазон большой
      if (from != null && to != null && to >= from && (to - from) > maxLogRange) {
        const merged = await getLogsChunked({
          payload,
          filter,
          from,
          to,
          maxLogRange,
          upstreams,
          timeoutMs,
          retries,
        });
        return jsonResponse(merged, cors);
      }
    }

    // ------------------------
    // Обычный proxy с fallback
    // ------------------------
    const result = await proxyWithFallback({
      payload,
      upstreams,
      timeoutMs,
      retries,
    });

    return jsonResponse(result, cors);
  },
};

// -------------------- helpers --------------------

function parseUpstreams(env) {
  // Варианты задания:
  // 1) UPSTREAM_RPC (один)
  // 2) UPSTREAM_RPCS (несколько, через запятую)
  const list = (env?.UPSTREAM_RPCS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (list.length > 0) return list;

  const single = (env?.UPSTREAM_RPC || "").trim();
  if (single) return [single];

  // дефолт — без переменных
  return ["https://arbitrum-one-rpc.publicnode.com"];
}

function toInt(v, def) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

function jsonResponse(obj, cors) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function proxyWithFallback({ payload, upstreams, timeoutMs, retries }) {
  let lastErr = null;

  for (const url of upstreams) {
    const res = await fetchJsonRpcWithRetry(url, payload, timeoutMs, retries);
    if (!res.__network_error) return res;

    lastErr = res.__network_error;
  }

  return {
    jsonrpc: "2.0",
    id: payload?.id ?? null,
    error: {
      code: -32000,
      message: `All upstreams failed: ${lastErr?.message || String(lastErr)}`,
    },
  };
}

async function fetchJsonRpcWithRetry(url, payload, timeoutMs, retries) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, timeoutMs);

      const text = await r.text();

      // Upstream может вернуть JSON-RPC error — это валидный ответ, не считаем сетевой ошибкой
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // не JSON — считаем сетевой/апстрим проблемой
        lastError = new Error(`Upstream non-JSON response: ${text.slice(0, 200)}`);
        continue;
      }

      return parsed;
    } catch (e) {
      lastError = e;
    }
  }

  return { __network_error: lastError || new Error("Unknown upstream error") };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ------------- eth_getLogs chunking -------------

async function getLogsChunked({
  payload,
  filter,
  from,
  to,
  maxLogRange,
  upstreams,
  timeoutMs,
  retries,
}) {
  let all = [];

  // шаг: maxLogRange блоков, включительно (поэтому +1 при переходе)
  for (let start = from; start <= to; start += (maxLogRange + 1)) {
    const end = Math.min(to, start + maxLogRange);

    const chunkPayload = {
      ...payload,
      params: [
        {
          ...filter,
          fromBlock: toHex(start),
          toBlock: toHex(end),
        },
      ],
    };

    const chunkRes = await proxyWithFallback({
      payload: chunkPayload,
      upstreams,
      timeoutMs,
      retries,
    });

    // Если вернули JSON-RPC error — отдаём ошибку сразу (не маскируем)
    if (chunkRes?.error) {
      return chunkRes;
    }

    if (!Array.isArray(chunkRes?.result)) {
      // неожиданный формат — отдаём как есть
      return chunkRes;
    }

    all = all.concat(chunkRes.result);
  }

  return { jsonrpc: "2.0", id: payload?.id ?? null, result: all };
}

function parseBlockTag(tag) {
  if (tag == null) return null;
  if (typeof tag !== "string") return null;
  // latest/pending/earliest не чанкуем — там нельзя рассчитать диапазон
  if (tag === "latest" || tag === "pending" || tag === "earliest") return null;
  if (!tag.startsWith("0x")) return null;
  const n = parseInt(tag, 16);
  return Number.isFinite(n) ? n : null;
}

function toHex(n) {
  return "0x" + n.toString(16);
}
