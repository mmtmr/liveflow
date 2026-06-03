import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const appPort = 18000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${appPort}`;
const inviteCode = "invite-123";
const csrfHeader = "x-csrf-token";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function startProviderStub() {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, body: await readBody(req) });

    if (req.url === "/slow-images") {
      await delay(250);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgo=" }] }));
      return;
    }

    if (req.url === "/realtime/client_secrets") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        client_secret: { value: "stub-realtime-secret", expires_at: 1893456000 },
        session: { model: "gpt-realtime-2" }
      }));
      return;
    }

    if (req.url === "/responses") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ output_text: "stub response" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub route not found" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function startAppServer(providerBaseUrl, envOverrides = {}) {
  const logs = [];
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      LIVEFLOW_SKIP_DOTENV: "1",
      PORT: String(appPort),
      SESSION_SIGNING_SECRET: "smoke-session-signing-secret",
      READY_CHECK_TOKEN: "smoke-ready-token",
      PUBLIC_BETA_REPORT_CONTACT: "beta@example.test",
      BETA_INVITE_CODES: inviteCode,
      BETA_SESSION_TTL_HOURS: "1",
      BETA_REALTIME_TOKENS_PER_SESSION_PER_HOUR: "3",
      BETA_REALTIME_TOKENS_PER_IP_PER_HOUR: "3",
      BETA_REALTIME_MAX_SESSION_MINUTES: "7",
      BETA_REALTIME_MAX_RECONNECTS_PER_SESSION: "2",
      BETA_GENERATIONS_PER_SESSION_PER_DAY: "5",
      BETA_GENERATIONS_PER_IP_PER_DAY: "1",
      BETA_FRAME_ANALYSES_PER_SESSION_PER_HOUR: "1",
      BETA_FRAME_ANALYSES_PER_IP_PER_HOUR: "1",
      BETA_ACCESS_ATTEMPTS_PER_IP_PER_HOUR: "3",
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_IMAGES_URL: `${providerBaseUrl}/slow-images`,
      OPENAI_REALTIME_CLIENT_SECRETS_URL: `${providerBaseUrl}/realtime/client_secrets`,
      OPENAI_RESPONSES_URL: `${providerBaseUrl}/responses`,
      ALLOW_PROVIDER_ENDPOINT_OVERRIDES: "true",
      PROVIDER_TIMEOUT_MS: "50",
      PUBLIC_BASE_URL: `${origin}/`,
      TRUST_PROXY: "false",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  return { child, logs };
}

async function waitForServer(child, logs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    if (logs.join("").includes("server listening")) return;
    if (child.exitCode !== null) {
      throw new Error(`server exited before startup:\n${logs.join("")}`);
    }
    await delay(50);
  }
  throw new Error(`server did not start:\n${logs.join("")}`);
}

async function stopAppServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      ...(options.json ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    body: options.json ? JSON.stringify(options.json) : options.body
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload, text };
}

function sessionCookie(setCookie) {
  assert.match(setCookie || "", /liveflow_beta_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  return setCookie.split(";")[0];
}

async function verifyReadinessRejectsInvalidConfig(provider) {
  const { child, logs } = startAppServer(provider.baseUrl, {
    PUBLIC_BASE_URL: "",
    TRUST_PROXY: "",
    PROVIDER_TIMEOUT_MS: "0",
    ALLOW_PROVIDER_ENDPOINT_OVERRIDES: ""
  });

  try {
    await waitForServer(child, logs);
    const result = await request("/api/ready", {
      headers: { Authorization: "Bearer smoke-ready-token" }
    });
    assert.equal(result.response.status, 503);
    assert.equal(result.payload.error, "readiness_failed");
    assert.ok(result.payload.missing.includes("PUBLIC_BASE_URL"));
    assert.ok(result.payload.missing.includes("TRUST_PROXY"));
    assert.ok(result.payload.invalid.some((item) => item.includes("PROVIDER_TIMEOUT_MS")));
    assert.ok(result.payload.invalid.some((item) => item.includes("OPENAI_RESPONSES_URL")));

    let access = await request("/api/beta/access", {
      method: "POST",
      headers: { Origin: origin },
      json: { code: inviteCode }
    });
    assert.equal(access.response.status, 200);
    const cookie = sessionCookie(access.response.headers.get("set-cookie"));
    const csrf = access.payload.csrfToken;
    const providerRequestsBefore = provider.requests.length;

    access = await request("/api/generate", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf },
      json: { imageProvider: "openai", transcript: "blocked provider override" }
    });
    assert.equal(access.response.status, 200);
    assert.equal(access.payload.fallback, true);
    assert.match(access.payload.error, /overrides are disabled/i);
    assert.equal(provider.requests.length, providerRequestsBefore);
  } finally {
    await stopAppServer(child);
  }
}

async function main() {
  const provider = await startProviderStub();
  await verifyReadinessRejectsInvalidConfig(provider);
  const { child, logs } = startAppServer(provider.baseUrl);

  try {
    await waitForServer(child, logs);

    let result = await request("/api/health");
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, { ok: true });

    result = await request("/api/ready");
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, "forbidden");

    result = await request("/api/ready", {
      headers: { Authorization: "Bearer smoke-ready-token" }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.configured, true);

    result = await request("/");
    assert.equal(result.response.status, 200);
    assert.match(result.text, /<div id="root"><\/div>/);

    result = await request("/api/nope");
    assert.equal(result.response.status, 404);
    assert.equal(result.payload.error, "API route not found.");

    result = await request("/api/beta/session");
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.authenticated, false);
    assert.equal(result.payload.reportContact, "beta@example.test");
    assert.deepEqual(result.payload.enabledImageProviders, ["openai", "mermaid"]);
    assert.equal(result.response.headers.get("cache-control"), "no-store");

    result = await request("/api/beta/session", {
      headers: { Cookie: "liveflow_beta_session=%E0%A4%A" }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.authenticated, false);

    result = await request("/api/generate", {
      method: "POST",
      headers: { Origin: origin },
      json: { transcript: "no session" }
    });
    assert.equal(result.response.status, 401);
    assert.equal(result.payload.error, "Beta access is required.");

    result = await request("/api/beta/access", {
      method: "POST",
      json: { code: inviteCode }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, "Cross-site requests are not allowed.");

    result = await request("/api/beta/access", {
      method: "POST",
      headers: { Origin: origin },
      json: { code: "wrong-code" }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, "Invalid beta access code.");

    result = await request("/api/beta/access", {
      method: "POST",
      headers: { Origin: origin },
      json: { code: inviteCode }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.authenticated, true);
    assert.ok(result.payload.csrfToken);
    assert.deepEqual(result.payload.enabledImageProviders, ["openai", "mermaid"]);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    const cookie = sessionCookie(result.response.headers.get("set-cookie"));
    const csrf = result.payload.csrfToken;

    result = await request("/api/beta/logout", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, "Valid CSRF token is required.");

    result = await request("/api/generate", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
      json: { transcript: "missing csrf" }
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, "Valid CSRF token is required.");

    result = await request("/api/analyze-frame", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf },
      json: { frame: "https://example.test/frame.png" }
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, "Frame must be a data image URL.");

    result = await request("/api/analyze-frame", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf },
      json: { frame: "data:image/png;base64,iVBORw0KGgo=", transcript: "frame quota" }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.analysis, "stub response");

    result = await request("/api/analyze-frame", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf },
      json: { frame: "data:image/png;base64,iVBORw0KGgo=", transcript: "frame quota" }
    });
    assert.equal(result.response.status, 429);
    assert.equal(result.payload.error, "Quota exceeded.");

    result = await request("/api/realtime-token", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf },
      json: { language: "zh" }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.value, "stub-realtime-secret");
    assert.equal(result.payload.language, "zh");
    assert.equal(result.payload.maxSessionMinutes, 7);
    assert.equal(result.response.headers.get("cache-control"), "no-store");

    result = await request("/api/realtime-token", {
      method: "GET",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf }
    });
    assert.equal(result.response.status, 404);

    result = await request("/api/generate", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf },
      json: { imageProvider: "openai", transcript: "timeout fallback path" }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.fallback, true);
    assert.equal(result.payload.provider, "OpenAI");

    result = await request("/api/generate", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        [csrfHeader]: csrf,
        "X-Forwarded-For": "203.0.113.99",
        "X-Real-IP": "203.0.113.100",
        "Forwarded": "for=203.0.113.101;proto=https;host=spoofed.example",
        "CF-Connecting-IP": "203.0.113.102",
        "Fly-Client-IP": "203.0.113.103"
      },
      json: { imageProvider: "openai", transcript: "proxy spoof attempt" }
    });
    assert.equal(result.response.status, 429);
    assert.equal(result.payload.error, "Quota exceeded.");

    result = await request("/api/beta/logout", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, [csrfHeader]: csrf }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);

    result = await request("/api/beta/access", {
      method: "POST",
      headers: { Origin: origin },
      json: { code: "wrong-code-again" }
    });
    assert.equal(result.response.status, 403);

    result = await request("/api/beta/access", {
      method: "POST",
      headers: { Origin: origin },
      json: { code: "wrong-code-limited" }
    });
    assert.equal(result.response.status, 429);
    assert.equal(result.payload.error, "Too many beta access attempts.");

    await delay(100);
    const combinedLogs = logs.join("");
    const jsonLogs = combinedLogs
      .split(/\n+/)
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.ok(jsonLogs.some((line) => line.requestId && line.method === "POST" && line.status === 429));
    assert.ok(jsonLogs.some((line) => line.route === "/api/generate" && line.provider === "OpenAI"));
    assert.equal(combinedLogs.includes(inviteCode), false);
    assert.equal(combinedLogs.includes("proxy spoof attempt"), false);
    assert.ok(provider.requests.some((item) => item.url === "/realtime/client_secrets"));
    assert.ok(provider.requests.some((item) => item.url === "/slow-images"));

    console.log("smoke-api: ok");
  } finally {
    await stopAppServer(child);
    await provider.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
