// ============================================================
// fetch-html.js
//
// Drop-in replacement for the inline fetchHTML() in server.js.
//
// Adds:
//   - a hard timeout (the original had none, so a hung socket
//     would stall a poll forever)
//   - retry with exponential backoff, but ONLY for errors that
//     are actually worth retrying
//   - an optional proxy, switched on via an env var, so you can
//     test the "PRC is blocking Render's IPs" theory without a
//     code change or redeploy
//
// Usage in server.js:
//
//   const { fetchHTML } = require("./fetch-html");
//
// ...and delete the old fetchHTML function AND any retry wrapper
// you already have around it, or you'll get retries of retries
// (3 x 3 = 9 requests per poll, which is a good way to get
// yourself blocked for real).
// ============================================================

// ------------------------------------------------------------
// Config, all via env vars so Render's dashboard can change it
// ------------------------------------------------------------

// Milliseconds before a single attempt is aborted.
const TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10);

// How many total attempts per URL (1 = no retrying).
const MAX_ATTEMPTS = parseInt(process.env.FETCH_RETRIES || "3", 10);

// Base delay for backoff; doubles each retry.
const BACKOFF_BASE_MS = parseInt(process.env.FETCH_BACKOFF_MS || "3000", 10);

// Proxy template. Leave unset for direct connections.
//
// Must contain either {url} or {encodedUrl}. Examples:
//
//   https://api.allorigins.win/raw?url={encodedUrl}
//   https://corsproxy.io/?{encodedUrl}
//   https://r.jina.ai/{url}
//
// Note on r.jina.ai: by default it returns Markdown, not HTML,
// which cheerio will happily parse into nothing useful. If you
// use it, also set FETCH_PROXY_HEADERS to:
//   {"X-Return-Format":"html"}
// I have not verified that against your parser — check the
// output before trusting it.
const PROXY_TEMPLATE = process.env.FETCH_PROXY || "";

// Optional extra headers, as a JSON object string.
const EXTRA_HEADERS = parseHeaders(process.env.FETCH_PROXY_HEADERS);

// ------------------------------------------------------------

function parseHeaders(raw) {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }

    console.warn("[FETCH] FETCH_PROXY_HEADERS is not a JSON object, ignoring");
    return {};
  } catch (error) {
    console.warn(
      "[FETCH] Could not parse FETCH_PROXY_HEADERS:",
      error.message
    );
    return {};
  }
}

function applyProxy(url) {
  if (!PROXY_TEMPLATE) return url;

  if (PROXY_TEMPLATE.includes("{encodedUrl}")) {
    return PROXY_TEMPLATE.replace("{encodedUrl}", encodeURIComponent(url));
  }

  if (PROXY_TEMPLATE.includes("{url}")) {
    return PROXY_TEMPLATE.replace("{url}", url);
  }

  // No placeholder given: assume it's a plain prefix.
  return PROXY_TEMPLATE + url;
}

// Decide whether another attempt could plausibly succeed.
//
// ECONNREFUSED is the interesting case for your situation. If PRC
// is refusing your datacenter IP, retrying is pointless — it will
// be refused identically every time, which is exactly what your
// logs show. But if their origin is just overloaded, a retry does
// help. We can't tell the two apart from here, so we retry it but
// let the backoff keep the request rate low.
function isRetryable(error, status) {
  if (status !== undefined) {
    // Rate limited or server-side failure: worth another go.
    return status === 408 || status === 429 || status >= 500;
  }

  const code = error?.cause?.code || error?.code;

  const retryableCodes = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET"
  ];

  if (error?.name === "AbortError") return true;

  return retryableCodes.includes(code);
}

function describeError(error) {
  const parts = [`name=${error?.name}`, `message=${error?.message}`];

  if (error?.cause?.code) parts.push(`cause.code=${error.cause.code}`);
  if (error?.cause?.message) {
    parts.push(`cause.message=${error.cause.message}`);
  }

  return parts.join(" | ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(url) {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-PH,en;q=0.9",
        // Some origins reject requests that ask for no compression.
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        ...EXTRA_HEADERS
      }
    });

    if (!response.ok) {
      const httpError = new Error(
        `HTTP ${response.status} ${response.statusText}`
      );

      httpError.status = response.status;
      throw httpError;
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a URL and return its body as text.
 *
 * Throws if every attempt fails. The thrown error carries the
 * final underlying cause so your existing [SCHEDULE] / [RESULTS]
 * error logging still has something useful to print.
 */
async function fetchHTML(url) {
  const target = applyProxy(url);

  if (target !== url) {
    console.log(`[FETCH] Using proxy for ${url}`);
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[FETCH] Attempt ${attempt}/${MAX_ATTEMPTS}: ${url}`);

    try {
      const html = await fetchOnce(target);

      // A proxy that silently returns an error page will produce
      // a 200 with a tiny body. Better to fail loudly than to feed
      // cheerio something meaningless and detect zero results.
      if (!html || html.length < 200) {
        const thinError = new Error(
          `Response body suspiciously short (${html ? html.length : 0} bytes)`
        );

        thinError.status = 200;
        throw thinError;
      }

      console.log(
        `[FETCH] OK attempt ${attempt}/${MAX_ATTEMPTS}: ` +
          `${url} (${html.length} bytes)`
      );

      return html;
    } catch (error) {
      lastError = error;

      console.warn(
        `[FETCH] Failed attempt ${attempt}/${MAX_ATTEMPTS}: ${url}`
      );
      console.warn(`[FETCH] ${describeError(error)}`);

      const canRetry =
        attempt < MAX_ATTEMPTS && isRetryable(error, error.status);

      if (!canRetry) break;

      const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);

      console.log(`[FETCH] Retrying in ${Math.round(delay / 1000)}s...`);

      await sleep(delay);
    }
  }

  const failure = new Error(
    `Unable to fetch ${url} after ${MAX_ATTEMPTS} attempts. ` +
      describeError(lastError)
  );

  failure.cause = lastError;

  throw failure;
}

module.exports = { fetchHTML };
