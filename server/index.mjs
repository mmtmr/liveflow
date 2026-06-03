import express from "express";
import { config } from "dotenv";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.LIVEFLOW_SKIP_DOTENV !== "1") {
  config({ path: ".env.local", override: process.env.NODE_ENV !== "production" });
  config();
}

const app = express();
const port = Number(process.env.PORT || 8787);
const isProduction = process.env.NODE_ENV === "production";
const trustProxy = process.env.TRUST_PROXY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distPath = path.join(projectRoot, "dist");
const sessionCookieName = "liveflow_beta_session";
const sessionTtlMs = numberFromEnv("BETA_SESSION_TTL_HOURS", 4) * 60 * 60 * 1000;
const providerTimeoutMs = numberFromEnv("PROVIDER_TIMEOUT_MS", 30000);
const falImageModel = process.env.FAL_IMAGE_MODEL || "fal-ai/flux/schnell";
const falImageEndpoint = `https://fal.run/${falImageModel}`;
const openAIImageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
const openAIImageMinTranscriptWords = numberFromEnv("GPT_IMAGE_MIN_TRANSCRIPT_WORDS", 12);
const openAIImageLockTtlMs = Math.max(providerTimeoutMs * 2, 60000);
const mermaidModel = process.env.OPENAI_MERMAID_MODEL || process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
const openAIResponsesEndpoint = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const openAIImagesEndpoint = process.env.OPENAI_IMAGES_URL || "https://api.openai.com/v1/images/generations";
const openAIRealtimeEndpoint = process.env.OPENAI_REALTIME_CLIENT_SECRETS_URL || "https://api.openai.com/v1/realtime/client_secrets";
const openAIEndpointOverrideEnv = ["OPENAI_RESPONSES_URL", "OPENAI_IMAGES_URL", "OPENAI_REALTIME_CLIENT_SECRETS_URL"];

if (trustProxy) {
  const trustProxyHops = Number(trustProxy);
  app.set("trust proxy", trustProxy === "true" ? true : trustProxy === "false" ? false : Number.isFinite(trustProxyHops) ? trustProxyHops : trustProxy);
}

app.use(express.json({ limit: "2mb" }));

const requiredProductionEnv = [
  "OPENAI_API_KEY",
  "READY_CHECK_TOKEN",
  "SESSION_SIGNING_SECRET",
  "PUBLIC_BETA_REPORT_CONTACT",
  "PUBLIC_BASE_URL",
  "TRUST_PROXY",
  "PROVIDER_TIMEOUT_MS",
  "BETA_ACCESS_ATTEMPTS_PER_IP_PER_HOUR",
  "BETA_REALTIME_TOKENS_PER_SESSION_PER_HOUR",
  "BETA_REALTIME_TOKENS_PER_IP_PER_HOUR",
  "BETA_REALTIME_MAX_SESSION_MINUTES",
  "BETA_REALTIME_MAX_RECONNECTS_PER_SESSION",
  "BETA_GENERATIONS_PER_SESSION_PER_DAY",
  "BETA_GENERATIONS_PER_IP_PER_DAY",
  "BETA_FRAME_ANALYSES_PER_SESSION_PER_HOUR",
  "BETA_FRAME_ANALYSES_PER_IP_PER_HOUR"
];
const positiveProductionNumberEnv = [
  "PROVIDER_TIMEOUT_MS",
  "BETA_ACCESS_ATTEMPTS_PER_IP_PER_HOUR",
  "BETA_REALTIME_TOKENS_PER_SESSION_PER_HOUR",
  "BETA_REALTIME_TOKENS_PER_IP_PER_HOUR",
  "BETA_REALTIME_MAX_SESSION_MINUTES",
  "BETA_GENERATIONS_PER_SESSION_PER_DAY",
  "BETA_GENERATIONS_PER_IP_PER_DAY",
  "BETA_FRAME_ANALYSES_PER_SESSION_PER_HOUR",
  "BETA_FRAME_ANALYSES_PER_IP_PER_HOUR"
];
const quotaStore = new Map();
const openAIImageInFlight = new Map();

function missingProductionConfig() {
  const missing = requiredProductionEnv.filter((name) => !process.env[name]);
  if (!process.env.BETA_INVITE_CODES && !process.env.BETA_ACCESS_SECRET) {
    missing.push("BETA_INVITE_CODES or BETA_ACCESS_SECRET");
  }
  return missing;
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function invalidProductionConfig() {
  const invalid = [];

  for (const name of positiveProductionNumberEnv) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value <= 0) invalid.push(`${name} must be a positive number`);
  }

  const reconnects = Number(process.env.BETA_REALTIME_MAX_RECONNECTS_PER_SESSION);
  if (!Number.isFinite(reconnects) || reconnects < 0) {
    invalid.push("BETA_REALTIME_MAX_RECONNECTS_PER_SESSION must be zero or greater");
  }

  const sessionHours = Number(process.env.BETA_SESSION_TTL_HOURS || 4);
  if (!Number.isFinite(sessionHours) || sessionHours <= 0) {
    invalid.push("BETA_SESSION_TTL_HOURS must be a positive number when set");
  }

  const publicBaseUrls = String(process.env.PUBLIC_BASE_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of publicBaseUrls) {
    try {
      const url = new URL(origin);
      if (url.pathname !== "/" || url.search || url.hash) {
        invalid.push("PUBLIC_BASE_URL must contain origins only");
      }
      if (isProduction && url.protocol !== "https:" && !isLocalHostname(url.hostname)) {
        invalid.push("PUBLIC_BASE_URL must use https for public production hosts");
      }
    } catch {
      invalid.push("PUBLIC_BASE_URL must be a valid URL origin");
    }
  }

  const proxyValue = String(process.env.TRUST_PROXY || "").trim();
  if (proxyValue === "true") {
    invalid.push("TRUST_PROXY=true is too broad for public beta; use false, a hop count, or a trusted proxy range");
  }

  if (isProduction && process.env.ALLOW_PROVIDER_ENDPOINT_OVERRIDES !== "true") {
    for (const name of openAIEndpointOverrideEnv) {
      if (process.env[name]) invalid.push(`${name} requires ALLOW_PROVIDER_ENDPOINT_OVERRIDES=true in production`);
    }
  }

  return invalid;
}

function hashForLog(value) {
  if (!value) return "";
  const secret = getSessionSecret() || "liveflow-log-hash";
  return createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, 16);
}

function writeRequestLog(req, res, startedAt) {
  const entry = {
    ts: new Date().toISOString(),
    requestId: req.id,
    method: req.method,
    route: req.originalUrl?.split("?")[0],
    status: res.statusCode,
    durationMs: Date.now() - startedAt,
    sessionHash: hashForLog(req.betaSession?.sid),
    ipHash: hashForLog(req.ip),
    provider: req.providerLabel,
    model: req.providerModel,
    quota: req.quotaDecision,
    errorType: req.errorType
  };
  console.log(JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== ""))));
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);
  res.on("finish", () => writeRequestLog(req, res, startedAt));
  next();
});

function jsonError(req, res, status, error, details) {
  req.errorType = error;
  return res.status(status).json({
    error,
    ...(details ? { details } : {})
  });
}

function providerEndpointOverrideBlocked(url) {
  return isProduction
    && process.env.ALLOW_PROVIDER_ENDPOINT_OVERRIDES !== "true"
    && openAIEndpointOverrideEnv.some((name) => process.env[name] && url === process.env[name]);
}

function fetchWithTimeout(url, options = {}, timeoutMs = providerTimeoutMs) {
  if (providerEndpointOverrideBlocked(url)) {
    return Promise.reject(new Error("Provider endpoint overrides are disabled in production."));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));
}

function quotaLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function pruneExpiredQuotas(now = Date.now()) {
  for (const [key, bucket] of quotaStore.entries()) {
    if (!bucket || bucket.resetAt <= now) quotaStore.delete(key);
  }
}

function consumeQuota(key, limit, windowMs) {
  if (!betaAccessRequired() || limit < 0) return { ok: true, remaining: Number.POSITIVE_INFINITY };
  if (limit === 0) return { ok: false, remaining: 0, resetAt: Date.now() + windowMs };
  const now = Date.now();
  pruneExpiredQuotas(now);
  const current = quotaStore.get(key);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
  if (bucket.count >= limit) {
    return { ok: false, remaining: 0, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  quotaStore.set(key, bucket);
  return { ok: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
}

function enforceQuota(req, res, next, kind) {
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const sessionId = req.betaSession?.sid || "anonymous";
  const ip = req.ip || "unknown";
  const quotaConfigs = {
    realtime: [
      [`quota:${kind}:session:${sessionId}`, quotaLimit("BETA_REALTIME_TOKENS_PER_SESSION_PER_HOUR", 6), hourMs],
      [`quota:${kind}:ip:${ip}`, quotaLimit("BETA_REALTIME_TOKENS_PER_IP_PER_HOUR", 20), hourMs],
      [`quota:${kind}:session-total:${sessionId}`, quotaLimit("BETA_REALTIME_MAX_RECONNECTS_PER_SESSION", 2) + 1, sessionTtlMs]
    ],
    frame: [
      [`quota:${kind}:session:${sessionId}`, quotaLimit("BETA_FRAME_ANALYSES_PER_SESSION_PER_HOUR", 120), hourMs],
      [`quota:${kind}:ip:${ip}`, quotaLimit("BETA_FRAME_ANALYSES_PER_IP_PER_HOUR", 360), hourMs]
    ],
    generation: [
      [`quota:${kind}:session:${sessionId}`, quotaLimit("BETA_GENERATIONS_PER_SESSION_PER_DAY", 30), dayMs],
      [`quota:${kind}:ip:${ip}`, quotaLimit("BETA_GENERATIONS_PER_IP_PER_DAY", 90), dayMs]
    ]
  };

  for (const [key, limit, windowMs] of quotaConfigs[kind] || []) {
    const result = consumeQuota(key, limit, windowMs);
    req.quotaDecision = result.ok ? `${kind}:allowed` : `${kind}:limited`;
    if (!result.ok) {
      return jsonError(req, res, 429, "Quota exceeded.", {
        resetAt: new Date(result.resetAt).toISOString()
      });
    }
  }
  return next();
}

function enforceAccessAttemptQuota(req, res, next) {
  if (!betaAccessRequired()) return next();
  const hourMs = 60 * 60 * 1000;
  const ip = req.ip || "unknown";
  const result = consumeQuota(
    `quota:access:ip:${ip}`,
    quotaLimit("BETA_ACCESS_ATTEMPTS_PER_IP_PER_HOUR", 10),
    hourMs
  );
  req.quotaDecision = result.ok ? "access:allowed" : "access:limited";
  if (!result.ok) {
    return jsonError(req, res, 429, "Too many beta access attempts.", {
      resetAt: new Date(result.resetAt).toISOString()
    });
  }
  return next();
}

function noStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function compactBoundedString(value, limit) {
  return compactText(value).slice(0, limit);
}

function validateDataImage(value, { required = false } = {}) {
  if (!value) {
    if (required) throw new Error("A camera frame data URL is required.");
    return "";
  }
  const frame = String(value);
  if (!frame.startsWith("data:image/")) throw new Error("Frame must be a data image URL.");
  if (frame.length > 1_500_000) throw new Error("Frame is too large.");
  return frame;
}

function boundedArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function sanitizeContextPayload(body = {}, { frameRequired = false } = {}) {
  return {
    ...body,
    transcript: compactBoundedString(body.transcript, 8000),
    recentTranscript: compactBoundedString(body.recentTranscript, 4000),
    visualAnalysis: compactBoundedString(body.visualAnalysis, 4000),
    previousBrief: compactBoundedString(body.previousBrief, 1000),
    generationAnalysis: compactBoundedString(body.generationAnalysis, 2000),
    mode: ["diagram", "metaphor", "steps"].includes(body.mode) ? body.mode : "diagram",
    imageProvider: getImageProvider(body.imageProvider),
    frame: validateDataImage(body.frame, { required: frameRequired }),
    gestures: boundedArray(body.gestures, 12).map((item) => ({
      label: compactBoundedString(item?.label, 80),
      score: compactBoundedString(item?.score, 16)
    })),
    strokes: boundedArray(body.strokes, 16).map((item) => ({
      hand: compactBoundedString(item?.hand, 40),
      direction: compactBoundedString(item?.direction, 80),
      points: Number.isFinite(Number(item?.points)) ? Number(item.points) : 0
    })),
    visualHistory: boundedArray(body.visualHistory, 5).map((item) => ({
      brief: compactBoundedString(item?.brief, 240),
      time: compactBoundedString(item?.time, 40),
      mode: compactBoundedString(item?.mode, 24)
    }))
  };
}

function betaAccessRequired() {
  return isProduction || Boolean(process.env.BETA_INVITE_CODES || process.env.BETA_ACCESS_SECRET);
}

function getSessionSecret() {
  if (process.env.SESSION_SIGNING_SECRET) return process.env.SESSION_SIGNING_SECRET;
  return isProduction ? "" : "dev-liveflow-session-secret";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseCookies(header) {
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf("=");
      if (separator === -1) return cookies;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = "";
      }
      return cookies;
    }, {});
}

function signSessionPayload(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function createSessionToken() {
  const secret = getSessionSecret();
  if (!secret) return null;
  const now = Date.now();
  const payload = {
    sid: randomBytes(18).toString("base64url"),
    csrfToken: randomBytes(24).toString("base64url"),
    createdAt: now,
    expiresAt: now + sessionTtlMs
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    token: `${encodedPayload}.${signSessionPayload(encodedPayload, secret)}`,
    payload
  };
}

function readSessionToken(req) {
  const token = parseCookies(req.get("cookie"))[sessionCookieName];
  if (!token || !token.includes(".")) return null;
  const secret = getSessionSecret();
  if (!secret) return null;
  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = signSessionPayload(encodedPayload, secret);
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload.expiresAt || payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCookieOptions(maxAgeSeconds) {
  return [
    `${sessionCookieName}=${maxAgeSeconds > 0 ? "%s" : ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(isProduction ? ["Secure"] : [])
  ].join("; ");
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", sessionCookieOptions(Math.floor(sessionTtlMs / 1000)).replace("%s", encodeURIComponent(token)));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", sessionCookieOptions(0));
}

function configuredInviteCodes() {
  return String(process.env.BETA_INVITE_CODES || "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function validAccessCode(value) {
  const code = String(value || "").trim();
  if (!code) return false;
  if (process.env.BETA_ACCESS_SECRET && safeEqual(code, process.env.BETA_ACCESS_SECRET)) return true;
  return configuredInviteCodes().some((inviteCode) => safeEqual(code, inviteCode));
}

function requestOrigin(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function configuredPublicBaseOrigins() {
  return String(process.env.PUBLIC_BASE_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        return origin;
      }
    });
}

function allowedOrigins(req) {
  const configuredOrigins = configuredPublicBaseOrigins();
  return new Set(isProduction && configuredOrigins.length ? configuredOrigins : [requestOrigin(req), ...configuredOrigins]);
}

function sameOriginAllowed(req) {
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return false;

  const origin = req.get("origin");
  if (origin) return allowedOrigins(req).has(origin);

  const referer = req.get("referer");
  if (referer) {
    try {
      return allowedOrigins(req).has(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return !isProduction;
}

function requireSameOrigin(req, res, next) {
  if (!betaAccessRequired() || sameOriginAllowed(req)) return next();
  return res.status(403).json({
    error: "Cross-site requests are not allowed."
  });
}

function requireBetaSession(req, res, next) {
  if (!betaAccessRequired()) {
    req.betaSession = {
      sid: "dev-session",
      csrfToken: "dev-csrf-token",
      expiresAt: Date.now() + sessionTtlMs,
      devMode: true
    };
    return next();
  }

  const session = readSessionToken(req);
  if (!session) {
    clearSessionCookie(res);
    return res.status(401).json({
      error: "Beta access is required."
    });
  }

  req.betaSession = session;
  return next();
}

function requireCsrfToken(req, res, next) {
  if (!betaAccessRequired()) return next();
  const csrfToken = req.get("x-csrf-token");
  if (req.betaSession?.csrfToken && safeEqual(csrfToken, req.betaSession.csrfToken)) return next();
  return res.status(403).json({
    error: "Valid CSRF token is required."
  });
}

function extractResponseText(payload) {
  if (payload.output_text) return payload.output_text;
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function transcriptWordCount(value) {
  return compactText(value).split(" ").filter(Boolean).length;
}

function getOpenAIImageContextStatus(requestContext) {
  const speech = compactText(requestContext.recentTranscript) || compactText(requestContext.transcript);
  const words = transcriptWordCount(speech);
  return {
    words,
    required: openAIImageMinTranscriptWords,
    ready: words >= openAIImageMinTranscriptWords,
    remaining: Math.max(0, openAIImageMinTranscriptWords - words)
  };
}

function pruneOpenAIImageLocks(now = Date.now()) {
  for (const [key, lock] of openAIImageInFlight.entries()) {
    if (!lock || now - lock.startedAt > openAIImageLockTtlMs) openAIImageInFlight.delete(key);
  }
}

function openAIImageLockKey(req) {
  return req.betaSession?.sid ? `session:${req.betaSession.sid}` : `ip:${req.ip || "unknown"}`;
}

function acquireOpenAIImageLock(req) {
  const now = Date.now();
  pruneOpenAIImageLocks(now);
  const key = openAIImageLockKey(req);
  const existing = openAIImageInFlight.get(key);
  if (existing) {
    return {
      ok: false,
      key,
      retryAfterSeconds: Math.max(1, Math.ceil((openAIImageLockTtlMs - (now - existing.startedAt)) / 1000))
    };
  }
  const token = randomUUID();
  openAIImageInFlight.set(key, { token, startedAt: now });
  return { ok: true, key, token };
}

function releaseOpenAIImageLock(key, token) {
  const existing = openAIImageInFlight.get(key);
  if (existing?.token === token) openAIImageInFlight.delete(key);
}

function buildImagePrompt({ transcript, recentTranscript, gestures, strokes, mode, visualAnalysis, generationAnalysis, previousBrief, visualHistory }) {
  const speech = compactText(recentTranscript) || compactText(transcript);
  const hasSpeech = speech.length > 0;
  const gestureSummary = gestures?.length
    ? gestures.slice(-8).map((item) => `${item.label} (${item.score})`).join(", ")
    : "No clear gesture detected yet.";
  const strokeSummary = strokes?.length
    ? strokes
        .slice(-4)
        .map((stroke, index) => `stroke ${index + 1}: ${stroke.hand || "hand"} drew ${stroke.points} points, ${stroke.direction}`)
        .join("; ")
    : "No visible tracing yet.";
  const sceneSummary = visualAnalysis?.trim() || "No camera scene analysis yet.";
  const continuity = previousBrief?.trim()
    ? `Continue and refine the previous visual instead of restarting: ${previousBrief.trim()}`
    : "This may be the first visual. Establish a simple reusable diagram foundation.";
  const freshSummary = generationAnalysis?.trim() || "No fresh generation snapshot analysis.";
  const historySummary = Array.isArray(visualHistory) && visualHistory.length
    ? visualHistory
        .slice(0, 3)
        .map((item, index) => `visual ${index + 1}: ${item.mode || "diagram"} at ${item.time || "recent"} - ${item.brief || "no brief"}`)
        .join("; ")
    : "No previous visual history.";

  return [
    "Create one clear educational visual aid for a live teacher overlay.",
    "The image should be instantly readable in a screen overlay and useful for deaf or hard-of-hearing learners following the lesson visually.",
    "Source priority is strict: 1) recent speech transcript, 2) hand-trace direction/grouping, 3) current camera analysis, 4) visual history only for style continuity.",
    "If recent speech is present, the subject, labels, and teaching point MUST come from that transcript. Do not introduce a different topic from the camera, prior image, or generic classroom assumptions.",
    "Use hand traces only to decide layout, arrows, emphasis, grouping, or sequence for the spoken concept.",
    "Use camera analysis only when it directly supports or clarifies the spoken concept. Ignore it if it conflicts with the transcript.",
    "Use a clean infographic, classroom diagram, or whiteboard visual that directly follows the current spoken lesson.",
    "Preserve continuity: evolve the active idea, add the new concept, and avoid changing style or subject unless the lesson clearly moved on.",
    "If the teacher traced arrows, circles, comparisons, or paths, convert those gestures into semantic arrows, highlights, groupings, or process flow.",
    "Reflect the teacher's visible pointing, board content, objects, and traced hand paths when they are pedagogically meaningful.",
    "Do not include photorealistic people, clutter, tiny text, brand marks, watermarks, or UI chrome.",
    continuity,
    `PRIMARY RECENT SPEECH TRANSCRIPT: ${hasSpeech ? speech : "No transcript yet. Use camera/gesture context cautiously."}`,
    `SECONDARY HAND TRACE SEMANTICS: ${strokeSummary}`,
    `SECONDARY DETECTED GESTURES: ${gestureSummary}`,
    `SECONDARY CURRENT SNAPSHOT ANALYSIS: ${freshSummary}`,
    `SECONDARY BACKGROUND CAMERA ANALYSIS: ${sceneSummary}`,
    `STYLE CONTINUITY ONLY - recent visual history: ${historySummary}`,
    `Visual mode: ${mode || "diagram"}`
  ].join("\n");
}

function compactErrorText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksLikeHtml(value) {
  return /<!doctype|<html|<\/[a-z][\s\S]*>/i.test(String(value || ""));
}

function normalizeProviderError(message, fallback = "Image generation failed.") {
  const text = compactErrorText(message);
  if (!text) return fallback;
  if (/operation aborted|aborterror|aborted|timed out|timeout/i.test(text)) {
    return "The provider request took too long and was stopped. Try again in a moment.";
  }
  if (/520|web server is returning an unknown error|cloudflare/i.test(text) || looksLikeHtml(text)) {
    return "The provider returned a temporary server error. Try again in a moment.";
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(text)) {
    return "The provider network connection was interrupted. Try again in a moment.";
  }
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function sanitizeOpenAIError(message) {
  const redacted = String(message || "Image generation failed.").replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted-api-key]");
  return normalizeProviderError(redacted);
}

function sanitizeFalError(message) {
  const redacted = String(message || "Image generation failed.")
    .replace(/Key\s+[A-Za-z0-9_*.:/-]+/g, "Key [redacted-api-key]")
    .replace(/fal_[A-Za-z0-9_*.-]+/g, "[redacted-api-key]");
  return normalizeProviderError(redacted);
}

async function readResponsePayload(response) {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      error: {
        message: normalizeProviderError(text, response.statusText || "Provider returned an unreadable response.")
      },
      details: text.slice(0, 500)
    };
  }
}

function frameAnalysisFallback(error, details) {
  return {
    analysis: "",
    fallback: true,
    error: sanitizeOpenAIError(error),
    details,
    createdAt: new Date().toISOString()
  };
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function getImageProvider(value) {
  if (value === "fal" && process.env.ENABLE_FAL_PROVIDER === "true") return value;
  if (value === "openai" || value === "mermaid") return value;
  return "openai";
}

function enabledImageProviders() {
  return [
    ...(process.env.ENABLE_FAL_PROVIDER === "true" ? ["fal"] : []),
    "openai",
    "mermaid"
  ];
}

function buildMermaidPrompt({ transcript, recentTranscript, gestures, strokes, mode, visualAnalysis, previousBrief, visualHistory }) {
  const speech = compactText(recentTranscript) || compactText(transcript);
  const hasSpeech = speech.length > 0;
  const gestureSummary = gestures?.length
    ? gestures.slice(-8).map((item) => `${item.label} (${item.score})`).join(", ")
    : "No clear gesture detected.";
  const strokeSummary = strokes?.length
    ? strokes.slice(-6).map((stroke) => `${stroke.hand || "hand"} ${stroke.direction}, ${stroke.points} points`).join("; ")
    : "No visible trace metadata.";
  const historySummary = Array.isArray(visualHistory) && visualHistory.length
    ? visualHistory.slice(0, 3).map((item) => item.brief || item.mode || "previous visual").join("; ")
    : "No previous visual history.";

  return [
    "Create one Mermaid diagram for a live teaching overlay.",
    "Return Mermaid syntax only. Do not use markdown fences, prose, HTML, emojis, comments, or unsupported styling.",
    "Prefer flowchart TD for processes, cause/effect, comparisons, cycles, or concept maps. Use sequenceDiagram only for clear timelines/conversations.",
    "Keep it readable in an overlay: 4 to 10 nodes, short labels, simple arrows, no dense paragraphs.",
    "Use quoted node labels when labels contain punctuation.",
    "Source priority is strict: 1) recent speech transcript, 2) hand trace direction/grouping, 3) camera analysis, 4) visual history only for continuity.",
    "If recent speech is present, every node label and relationship must represent the spoken concept. Do not switch to a camera/history topic.",
    "If the teacher trace implies direction, connection, grouping, cycle, or comparison, encode that in the arrows for the spoken concept.",
    `Visual mode: ${mode || "diagram"}`,
    `PRIMARY RECENT SPEECH TRANSCRIPT: ${hasSpeech ? speech : "No transcript yet. Use camera/gesture context cautiously."}`,
    `SECONDARY TRACES: ${strokeSummary}`,
    `SECONDARY GESTURES: ${gestureSummary}`,
    `SECONDARY CAMERA ANALYSIS: ${visualAnalysis || "No camera analysis."}`,
    `STYLE CONTINUITY ONLY - previous brief: ${previousBrief || "none"}`,
    `STYLE CONTINUITY ONLY - recent visual history: ${historySummary}`
  ].join("\n");
}

function cleanMermaidCode(value) {
  let code = String(value || "").trim();
  code = code.replace(/^```(?:mermaid)?\s*/i, "").replace(/```$/i, "").trim();
  code = code.replace(/^mermaid\s*/i, "").trim();
  const validStart = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|journey|timeline|mindmap)\b/i;
  if (validStart.test(code)) return code;

  const fallbackLabel = code
    .split(/\n+/)
    .map((line) => line.replace(/["[\]{}()<>]/g, "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const nodes = fallbackLabel.length ? fallbackLabel : ["Lesson context", "Key idea", "Visual aid"];
  return [
    "flowchart TD",
    ...nodes.map((label, index) => `  N${index + 1}["${label.slice(0, 72)}"]`),
    ...nodes.slice(1).map((_label, index) => `  N${index + 1} --> N${index + 2}`)
  ].join("\n");
}

async function analyzeGenerationFrame({ frame, transcript, recentTranscript, gestures, strokes }) {
  if (!process.env.OPENAI_API_KEY || !frame || !String(frame).startsWith("data:image/")) {
    return { analysis: "", durationMs: 0 };
  }

  const startedAt = Date.now();
  const speech = compactText(recentTranscript) || compactText(transcript);
  const gestureSummary = gestures?.length
    ? gestures.slice(-8).map((item) => `${item.label} (${item.score})`).join(", ")
    : "No gesture labels.";
  const strokeSummary = strokes?.length
    ? strokes.slice(-6).map((stroke) => `${stroke.hand || "hand"} ${stroke.direction}, ${stroke.points} points`).join("; ")
    : "No committed stroke metadata.";

  try {
    const response = await fetchWithTimeout(openAIResponsesEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Analyze this current teacher camera snapshot for text-to-image prompt grounding.",
                  "The image may include colored hand-trace overlays drawn from index-finger movement.",
                  "Recent speech is the primary lesson source. Interpret the snapshot and traces only as support for that speech.",
                  "If the image suggests a different topic than the recent speech, ignore the image topic unless readable board text clearly proves the lesson changed.",
                  "Return 4 concise, high-signal bullets only:",
                  "1. The spoken lesson topic and key terms from the recent speech.",
                  "2. Visible board/object content only if it supports or refines the spoken topic.",
                  "3. What the colored traces point to, circle, connect, compare, or sequence for that spoken topic.",
                  "4. The exact visual aid to generate next, including layout and key labels from the speech.",
                  `Recent speech: ${speech || "No recent speech."}`,
                  `Gesture labels: ${gestureSummary}`,
                  `Stroke metadata: ${strokeSummary}`
                ].join("\n")
              },
              {
                type: "input_image",
                image_url: frame
              }
            ]
          }
        ]
      })
    });

    const payload = await readResponsePayload(response);
    if (!response.ok) return { analysis: "", durationMs: Date.now() - startedAt };

    return {
      analysis: extractResponseText(payload),
      durationMs: Date.now() - startedAt
    };
  } catch {
    return { analysis: "", durationMs: Date.now() - startedAt };
  }
}

async function generateFalImage({ prompt, requestContext, generationFrame, startedAt }) {
  const falKey = process.env.FAL_KEY || process.env.FAL_API_KEY;

  if (!falKey) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "fal.ai",
      model: falImageModel,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: "FAL_KEY or FAL_API_KEY is not available to the server process.",
      createdAt: new Date().toISOString()
    };
  }

  const requestBody = {
    prompt,
    num_inference_steps: numberFromEnv("FAL_NUM_INFERENCE_STEPS", 4),
    image_size: process.env.FAL_IMAGE_SIZE || "square_hd",
    guidance_scale: numberFromEnv("FAL_GUIDANCE_SCALE", 3.5),
    sync_mode: false,
    num_images: 1,
    enable_safety_checker: process.env.FAL_ENABLE_SAFETY_CHECKER !== "false",
    output_format: process.env.FAL_OUTPUT_FORMAT || "jpeg",
    acceleration: process.env.FAL_ACCELERATION || "high"
  };

  const response = await fetchWithTimeout(falImageEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const payload = await readResponsePayload(response);
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "fal.ai",
      model: falImageModel,
      durationMs,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      timings: payload.timings,
      error: sanitizeFalError(payload.detail || payload.error?.message || payload.message || response.statusText),
      details: payload.error?.type || response.statusText,
      createdAt: new Date().toISOString()
    };
  }

  const imageUrl = payload.images?.[0]?.url;
  if (!imageUrl) {
    throw new Error("fal.ai returned no image URL.");
  }

  return {
    imageUrl,
    prompt,
    provider: "fal.ai",
    model: falImageModel,
    durationMs,
    contextDurationMs: generationFrame.durationMs,
    generationAnalysis: generationFrame.analysis,
    timings: payload.timings,
    seed: payload.seed,
    nsfw: payload.has_nsfw_concepts?.[0] || false,
    createdAt: new Date().toISOString()
  };
}

async function generateOpenAIImage({ prompt, requestContext, generationFrame, startedAt }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "OpenAI",
      model: openAIImageModel,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: "OPENAI_API_KEY is not available to the server process.",
      createdAt: new Date().toISOString()
    };
  }

  const response = await fetchWithTimeout(openAIImagesEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: openAIImageModel,
      prompt,
      size: process.env.OPENAI_IMAGE_SIZE || "1024x1024",
      quality: process.env.OPENAI_IMAGE_QUALITY || "low",
      n: 1
    })
  });

  const payload = await readResponsePayload(response);
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "OpenAI",
      model: openAIImageModel,
      durationMs,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: sanitizeOpenAIError(payload.error?.message || response.statusText),
      details: payload.error?.type || response.statusText,
      createdAt: new Date().toISOString()
    };
  }

  const first = payload.data?.[0];
  const imageUrl = first?.b64_json
    ? `data:image/png;base64,${first.b64_json}`
    : first?.url;

  if (!imageUrl) {
    throw new Error("OpenAI returned no image URL or base64 image data.");
  }

  return {
    imageUrl,
    prompt,
    provider: "OpenAI",
    model: openAIImageModel,
    durationMs,
    contextDurationMs: generationFrame.durationMs,
    generationAnalysis: generationFrame.analysis,
    usage: payload.usage,
    createdAt: new Date().toISOString()
  };
}

async function generateMermaidDiagram({ requestContext, generationFrame, startedAt }) {
  const prompt = buildMermaidPrompt({
    ...requestContext,
    generationAnalysis: generationFrame.analysis
  });

  if (!process.env.OPENAI_API_KEY) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "Mermaid",
      model: mermaidModel,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: "OPENAI_API_KEY is not available to the server process.",
      createdAt: new Date().toISOString()
    };
  }

  const response = await fetchWithTimeout(openAIResponsesEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: mermaidModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: prompt
            }
          ]
        }
      ]
    })
  });

  const payload = await readResponsePayload(response);
  const durationMs = Date.now() - startedAt;

  if (!response.ok) {
    return {
      imageUrl: makeFallbackImage(requestContext),
      prompt,
      fallback: true,
      provider: "Mermaid",
      model: mermaidModel,
      durationMs,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: sanitizeOpenAIError(payload.error?.message || response.statusText),
      details: payload.error?.type || response.statusText,
      createdAt: new Date().toISOString()
    };
  }

  const mermaidCode = cleanMermaidCode(extractResponseText(payload));
  return {
    diagramType: "mermaid",
    mermaidCode,
    prompt: mermaidCode,
    provider: "Mermaid",
    model: mermaidModel,
    durationMs,
    contextDurationMs: generationFrame.durationMs,
    generationAnalysis: generationFrame.analysis,
    createdAt: new Date().toISOString()
  };
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeFallbackImage({ transcript, gestures, strokes, mode }) {
  const title = mode === "steps" ? "Step-by-step cue" : mode === "metaphor" ? "Visual metaphor" : "Teaching diagram";
  const shortTranscript = (transcript || "Live lesson context").slice(0, 92);
  const gesture = gestures?.at?.(-1)?.label || "tracking gesture";
  const stroke = strokes?.at?.(-1)?.direction || "waiting for trace";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0d151b"/>
          <stop offset="1" stop-color="#1e2930"/>
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" fill="url(#bg)"/>
      <rect x="74" y="74" width="876" height="876" rx="46" fill="#f7f1df"/>
      <path d="M176 690 C310 560 358 612 462 480 S652 318 822 282" fill="none" stroke="#e4a83d" stroke-width="34" stroke-linecap="round"/>
      <circle cx="224" cy="646" r="46" fill="#4e9f86"/>
      <circle cx="512" cy="438" r="54" fill="#2f7190"/>
      <circle cx="790" cy="292" r="48" fill="#d65f4b"/>
      <text x="132" y="178" font-family="Inter, Arial, sans-serif" font-size="54" font-weight="800" fill="#182128">${escapeXml(title)}</text>
      <text x="132" y="258" font-family="Inter, Arial, sans-serif" font-size="34" fill="#31414a">${escapeXml(shortTranscript)}</text>
      <rect x="132" y="752" width="760" height="64" rx="18" fill="#182128"/>
      <text x="164" y="794" font-family="Inter, Arial, sans-serif" font-size="30" fill="#f7f1df">Gesture: ${escapeXml(gesture)}</text>
      <rect x="132" y="834" width="760" height="64" rx="18" fill="#31414a"/>
      <text x="164" y="876" font-family="Inter, Arial, sans-serif" font-size="30" fill="#f7f1df">Trace: ${escapeXml(stroke)}</text>
    </svg>
  `;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/beta") || req.path === "/api/realtime-token") {
    noStore(res);
  }
  next();
});

app.get("/api/beta/session", (req, res) => {
  if (!betaAccessRequired()) {
    return res.json({
      authenticated: true,
      devMode: true,
      csrfToken: "dev-csrf-token",
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
      reportContact: process.env.PUBLIC_BETA_REPORT_CONTACT || "",
      enabledImageProviders: enabledImageProviders()
    });
  }

  const session = readSessionToken(req);
  if (!session) {
    clearSessionCookie(res);
    return res.json({
      authenticated: false,
      requiresAccess: true,
      reportContact: process.env.PUBLIC_BETA_REPORT_CONTACT || "",
      enabledImageProviders: enabledImageProviders()
    });
  }

  res.json({
    authenticated: true,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
    reportContact: process.env.PUBLIC_BETA_REPORT_CONTACT || "",
    enabledImageProviders: enabledImageProviders()
  });
});

app.post("/api/beta/access", requireSameOrigin, enforceAccessAttemptQuota, (req, res) => {
  if (!betaAccessRequired()) {
    return res.json({
      authenticated: true,
      devMode: true,
      csrfToken: "dev-csrf-token",
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
      enabledImageProviders: enabledImageProviders()
    });
  }

  if (!getSessionSecret() || (!process.env.BETA_INVITE_CODES && !process.env.BETA_ACCESS_SECRET)) {
    return res.status(503).json({
      error: "Beta access is not configured."
    });
  }

  if (!validAccessCode(req.body?.code)) {
    return res.status(403).json({
      error: "Invalid beta access code."
    });
  }

  const session = createSessionToken();
  if (!session) {
    return res.status(503).json({
      error: "Beta session signing is not configured."
    });
  }

  setSessionCookie(res, session.token);
  res.json({
    authenticated: true,
    csrfToken: session.payload.csrfToken,
    expiresAt: new Date(session.payload.expiresAt).toISOString(),
    enabledImageProviders: enabledImageProviders()
  });
});

app.post("/api/beta/logout", requireSameOrigin, requireBetaSession, requireCsrfToken, (req, res) => {
  clearSessionCookie(res);
  res.json({
    ok: true
  });
});

app.get("/api/ready", (req, res) => {
  if (!process.env.READY_CHECK_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "readiness_unconfigured"
    });
  }

  const authorization = req.get("authorization") || "";
  if (authorization !== `Bearer ${process.env.READY_CHECK_TOKEN}`) {
    return res.status(403).json({
      ok: false,
      error: "forbidden"
    });
  }

  const missing = missingProductionConfig();
  const invalid = invalidProductionConfig();
  if (missing.length || invalid.length) {
    return res.status(503).json({
      ok: false,
      error: "readiness_failed",
      ...(missing.length ? { missing } : {}),
      ...(invalid.length ? { invalid } : {})
    });
  }

  res.json({
    ok: true,
    configured: true
  });
});

const realtimeLanguages = {
  en: {
    code: "en",
    label: "English",
    instructions: "Listen for English speech only. Transcribe English accurately. Do not translate."
  },
  zh: {
    code: "zh",
    label: "Chinese",
    instructions: "Listen for Chinese speech only. Transcribe Chinese accurately using Chinese characters. Do not translate."
  }
};

function getRealtimeLanguage(value) {
  return realtimeLanguages[String(value || "").toLowerCase()] || realtimeLanguages.en;
}

async function handleRealtimeToken(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not available to the server process."
    });
  }

  const realtimeLanguage = getRealtimeLanguage(req.body?.language || req.query.language);

  try {
    req.providerLabel = "OpenAI";
    req.providerModel = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
    const response = await fetchWithTimeout(openAIRealtimeEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2",
          instructions: `${realtimeLanguage.instructions} Do not generate spoken audio responses.`,
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              transcription: {
                model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe",
                language: realtimeLanguage.code
              },
              turn_detection: {
                type: "server_vad",
                create_response: false,
                threshold: 0.45,
                prefix_padding_ms: 300,
                silence_duration_ms: 650
              }
            }
          }
        }
      })
    });

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      return res.status(response.status).json({
        error: sanitizeOpenAIError(payload.error?.message || response.statusText),
        details: payload.error?.type || response.statusText
      });
    }

    res.json({
      value: payload.value || payload.client_secret?.value,
      expiresAt: payload.expires_at || payload.client_secret?.expires_at,
      language: realtimeLanguage.code,
      model: payload.session?.model,
      maxSessionMinutes: quotaLimit("BETA_REALTIME_MAX_SESSION_MINUTES", 30)
    });
  } catch (error) {
    res.status(500).json({
      error: sanitizeOpenAIError(error instanceof Error ? error.message : "Failed to create Realtime token.")
    });
  }
}

app.post("/api/realtime-token", requireSameOrigin, requireBetaSession, requireCsrfToken, (req, res, next) => enforceQuota(req, res, next, "realtime"), handleRealtimeToken);

app.post("/api/analyze-frame", requireSameOrigin, requireBetaSession, requireCsrfToken, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.json(frameAnalysisFallback("OPENAI_API_KEY is not available to the server process.", "missing_api_key"));
  }

  let requestBody;
  try {
    requestBody = sanitizeContextPayload(req.body, { frameRequired: true });
  } catch (error) {
    return jsonError(req, res, 400, error instanceof Error ? error.message : "Invalid frame analysis payload.");
  }

  let quotaPassed = false;
  enforceQuota(req, res, () => {
    quotaPassed = true;
  }, "frame");
  if (!quotaPassed) return;

  const { frame, transcript, recentTranscript, gestures, strokes } = requestBody;

  const context = [
    recentTranscript || transcript ? `Primary recent speech: ${compactText(recentTranscript) || compactText(transcript)}` : "",
    gestures?.length ? `Recent gestures: ${gestures.slice(-6).map((item) => item.label).join(", ")}` : "",
    strokes?.length ? `Recent traces: ${strokes.slice(-4).map((stroke) => `${stroke.hand || "hand"} ${stroke.direction}`).join("; ")}` : ""
  ].filter(Boolean).join("\n");

  try {
    req.providerLabel = "OpenAI";
    req.providerModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
    const response = await fetchWithTimeout(openAIResponsesEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: [
                  "Analyze this live teaching camera frame for an assistive visual-generation system.",
                  "Use the recent speech as the primary source of lesson meaning. The frame and hand traces should explain emphasis, layout, or board references for that speech.",
                  "If the camera appears unrelated to the speech, say that clearly and keep the suggested visual anchored to the speech.",
                  "Return 3 concise bullets only:",
                  "1. Spoken lesson topic and any visible board/object content that supports it.",
                  "2. What the teacher's hands/traces seem to emphasize for the spoken topic.",
                  "3. What visual aid should be generated next, using labels from the speech.",
                  context
                ].filter(Boolean).join("\n")
              },
              {
                type: "input_image",
                image_url: frame
              }
            ]
          }
        ]
      })
    });

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      return res.json(frameAnalysisFallback(
        payload.error?.message || response.statusText || "Frame analysis failed.",
        payload.error?.type || response.statusText || `HTTP ${response.status}`
      ));
    }

    res.json({
      analysis: extractResponseText(payload),
      createdAt: new Date().toISOString()
    });
  } catch (error) {
    res.json(frameAnalysisFallback(
      error instanceof Error ? error.message : "Frame analysis failed.",
      "request_failed"
    ));
  }
});

app.post("/api/generate", requireSameOrigin, requireBetaSession, requireCsrfToken, async (req, res) => {
  const startedAt = Date.now();
  let requestContext;
  let openAIImageLock;
  try {
    requestContext = sanitizeContextPayload(req.body);
  } catch (error) {
    return jsonError(req, res, 400, error instanceof Error ? error.message : "Invalid generation payload.");
  }

  const imageProvider = getImageProvider(requestContext.imageProvider);
  if (imageProvider === "openai") {
    const contextStatus = getOpenAIImageContextStatus(requestContext);
    if (!contextStatus.ready) {
      return jsonError(req, res, 422, `GPT Image 2 needs at least ${contextStatus.required} transcript words before generating.`, {
        words: contextStatus.words,
        required: contextStatus.required,
        remaining: contextStatus.remaining
      });
    }

    openAIImageLock = acquireOpenAIImageLock(req);
    if (!openAIImageLock.ok) {
      return jsonError(req, res, 409, "GPT Image 2 is already generating for this beta session.", {
        retryAfterSeconds: openAIImageLock.retryAfterSeconds
      });
    }
  }

  let quotaPassed = false;
  enforceQuota(req, res, () => {
    quotaPassed = true;
  }, "generation");
  if (!quotaPassed) {
    if (openAIImageLock?.ok) releaseOpenAIImageLock(openAIImageLock.key, openAIImageLock.token);
    return;
  }

  req.providerLabel = imageProvider === "mermaid" ? "Mermaid" : imageProvider === "openai" ? "OpenAI" : "fal.ai";
  req.providerModel = imageProvider === "mermaid" ? mermaidModel : imageProvider === "openai" ? openAIImageModel : falImageModel;
  let generationFrame = { analysis: "", durationMs: 0 };
  let prompt = "";

  try {
    generationFrame = imageProvider === "openai" || requestContext.forceGenerationAnalysis
      ? await analyzeGenerationFrame(requestContext)
      : generationFrame;
    prompt = buildImagePrompt({
      ...requestContext,
      generationAnalysis: generationFrame.analysis
    });

    const result = imageProvider === "mermaid"
      ? await generateMermaidDiagram({ requestContext, generationFrame, startedAt })
      : imageProvider === "openai"
        ? await generateOpenAIImage({ prompt, requestContext, generationFrame, startedAt })
        : await generateFalImage({ prompt, requestContext, generationFrame, startedAt });
    res.json(result);
  } catch (error) {
    const providerLabel = imageProvider === "mermaid" ? "Mermaid" : imageProvider === "openai" ? "OpenAI" : "fal.ai";
    const model = imageProvider === "mermaid" ? mermaidModel : imageProvider === "openai" ? openAIImageModel : falImageModel;
    const fallbackPrompt = prompt || buildImagePrompt({
      ...requestContext,
      generationAnalysis: generationFrame.analysis
    });
    res.status(200).json({
      imageUrl: makeFallbackImage(requestContext),
      prompt: fallbackPrompt,
      fallback: true,
      provider: providerLabel,
      model,
      durationMs: Date.now() - startedAt,
      contextDurationMs: generationFrame.durationMs,
      generationAnalysis: generationFrame.analysis,
      error: imageProvider === "openai" || imageProvider === "mermaid"
        ? sanitizeOpenAIError(error instanceof Error ? error.message : "Unexpected server error.")
        : sanitizeFalError(error instanceof Error ? error.message : "Unexpected server error."),
      createdAt: new Date().toISOString()
    });
  } finally {
    if (openAIImageLock?.ok) releaseOpenAIImageLock(openAIImageLock.key, openAIImageLock.token);
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({
    error: "API route not found."
  });
});

if (isProduction) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(port, () => {
  const mode = isProduction ? "production" : "development";
  console.log(`LiveFlow ${mode} server listening on http://localhost:${port}`);
});
