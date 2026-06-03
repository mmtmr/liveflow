# LiveFlow Public Beta Runbook

This document is the operating contract for the first public beta. It is intentionally smaller than a full SaaS launch and follows the approved plan in `.omx/plans/public-beta-deployment-option-3.md`.

## Stage 0 Decisions

These defaults unblock implementation. Revisit them before inviting a wider cohort.

### Access Model

- Default: individually revocable invite codes through `BETA_INVITE_CODES`.
- Shared password fallback: not enabled for stranger-facing beta. If used for an internal preview, configure it through `BETA_ACCESS_SECRET`, rotate it after the preview, and keep stricter quotas.
- Session transport: short-lived signed `Secure`, `HttpOnly`, `SameSite=Lax` or `SameSite=Strict` cookie.
- Session TTL: 4 hours.
- Session renewal: explicit renewal through the server; no silent renewal after the Realtime max duration expires.
- Logout: clear the beta session cookie and require a valid invite code to re-enter.

### Initial Quotas

Use these values for the first public beta unless the owner sets stricter production values:

```text
BETA_REALTIME_TOKENS_PER_SESSION_PER_HOUR=6
BETA_REALTIME_TOKENS_PER_IP_PER_HOUR=20
BETA_REALTIME_MAX_SESSION_MINUTES=30
BETA_REALTIME_MAX_RECONNECTS_PER_SESSION=2
BETA_GENERATIONS_PER_SESSION_PER_DAY=30
BETA_GENERATIONS_PER_IP_PER_DAY=90
BETA_FRAME_ANALYSES_PER_SESSION_PER_HOUR=120
BETA_FRAME_ANALYSES_PER_IP_PER_HOUR=360
BETA_ACCESS_ATTEMPTS_PER_IP_PER_HOUR=10
```

Budget ceiling: use a separate beta OpenAI project/key and fal.ai key with provider-side spend/rate limits. Start with a daily provider spend alert and a hard monthly cap before sharing the URL outside trusted testers.

### Provider Scope

- Enabled by default: OpenAI Realtime transcription, OpenAI frame analysis, OpenAI image generation, and Mermaid generation.
- Disabled by default for first external cohort: fal.ai Flux. To enable it, configure `ENABLE_FAL_PROVIDER=true` and `FAL_KEY` or `FAL_API_KEY`, then explicitly include Flux in the beta scope.
- If provider errors occur, keep the existing fallback visual behavior but ensure errors are sanitized.

### Hosting Topology

- Default topology: single Express process serving both the API and built `dist/` assets behind managed HTTPS.
- In-memory quotas are acceptable only for this single-process beta topology.
- If the app is deployed on multiple instances or serverless isolates, use shared quota storage before launch.

### Trusted Proxy And Client IP

- Configure Express trusted proxy behavior for the selected host before using IP fallback quotas.
- Treat `req.ip` as reliable only after that host-specific trust boundary is configured.
- Ignore or reject spoofable forwarding headers from untrusted clients.
- Smoke tests must prove `X-Forwarded-For`, `Forwarded`, and platform-specific headers cannot bypass IP quotas when sent from an untrusted client path.

### Data Retention

- Default: no server-side persistence of camera frames, transcripts, prompts, generated images, or visual history.
- Logs may retain request metadata only: request id, route, status, duration, provider/model, quota decision, hashed session id, hashed IP, and sanitized error type.
- Do not log raw camera frames, full transcripts, invite codes, provider keys, Realtime client secrets, or generated image payloads.
- Initial log retention: 14 days.

### Safety And Privacy Reporting

- Add a visible in-app report/contact path before public beta.
- Configure the contact as `PUBLIC_BETA_REPORT_CONTACT`; do not launch externally with the placeholder value.
- Report categories: unsafe output, wrong/inaccessible visual, privacy concern, camera/mic issue, quota/access issue.

### Local Artifact Hygiene

- Remove tracked `.playwright-mcp` browser artifacts before launch unless they are intentionally retained as reproducible QA evidence.
- Add ignore coverage so future local browser artifacts are not committed.

## Stage 0 Launch Blocker Checklist

- [x] Access model chosen: revocable invite codes by default.
- [x] Initial quota values chosen.
- [x] Provider scope chosen.
- [x] Hosting topology chosen for first beta: single Express process behind HTTPS.
- [x] Trusted proxy/IP policy documented.
- [x] Data retention default documented.
- [x] Reporting channel required through `PUBLIC_BETA_REPORT_CONTACT`.
- [x] `.playwright-mcp` artifact decision documented.

External launch remains blocked until the implementation stories enforce these decisions and `PUBLIC_BETA_REPORT_CONTACT` is set to a real monitored channel.

## Production Server Boundary

Production should run one Express process:

```bash
npm run build
npm start
```

`npm start` runs `NODE_ENV=production node server/index.mjs`. In production mode, Express serves:

- `/api/*` from the server routes.
- built Vite assets from `dist/`.
- non-API `GET` and `HEAD` routes through `dist/index.html` for the React app.

Do not use `vite preview` as the production server. Keep it as a local preview tool only.

### Health And Readiness

- `GET /api/health` is public liveness and returns exactly `{ "ok": true }`.
- `GET /api/ready` is private readiness and requires `Authorization: Bearer $READY_CHECK_TOKEN`.
- If `READY_CHECK_TOKEN` is unset, readiness returns `503 { "ok": false, "error": "readiness_unconfigured" }`.
- If authorization is missing or wrong, readiness returns `403 { "ok": false, "error": "forbidden" }`.
- If authorization is valid and required production config is missing, readiness returns `503 { "ok": false, "error": "readiness_failed", "missing": ["ENV_NAME"] }`.
- If authorization is valid but production config is invalid, readiness returns `503 { "ok": false, "error": "readiness_failed", "invalid": ["reason"] }`.
- If authorization is valid and config is present, readiness returns `200 { "ok": true, "configured": true }`.

### Required Production Environment

```text
OPENAI_API_KEY=
READY_CHECK_TOKEN=
SESSION_SIGNING_SECRET=
BETA_INVITE_CODES=
PUBLIC_BETA_REPORT_CONTACT=
TRUST_PROXY=
PUBLIC_BASE_URL=
PROVIDER_TIMEOUT_MS=30000
BETA_REALTIME_TOKENS_PER_SESSION_PER_HOUR=6
BETA_REALTIME_TOKENS_PER_IP_PER_HOUR=20
BETA_REALTIME_MAX_SESSION_MINUTES=30
BETA_REALTIME_MAX_RECONNECTS_PER_SESSION=2
BETA_GENERATIONS_PER_SESSION_PER_DAY=30
BETA_GENERATIONS_PER_IP_PER_DAY=90
BETA_FRAME_ANALYSES_PER_SESSION_PER_HOUR=120
BETA_FRAME_ANALYSES_PER_IP_PER_HOUR=360
BETA_ACCESS_ATTEMPTS_PER_IP_PER_HOUR=10
```

Optional provider/config variables:

```text
FAL_KEY=
FAL_API_KEY=
ENABLE_FAL_PROVIDER=false
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe
OPENAI_VISION_MODEL=gpt-4.1-mini
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_SIZE=1024x1024
OPENAI_IMAGE_QUALITY=low
OPENAI_MERMAID_MODEL=gpt-4.1-mini
FAL_IMAGE_MODEL=fal-ai/flux/schnell
```

Test-only provider endpoint overrides used by `npm run test:smoke`:

```text
OPENAI_RESPONSES_URL=
OPENAI_IMAGES_URL=
OPENAI_REALTIME_CLIENT_SECRETS_URL=
ALLOW_PROVIDER_ENDPOINT_OVERRIDES=false
LIVEFLOW_SKIP_DOTENV=1
```

Do not point public beta traffic at these override variables unless intentionally routing through a controlled provider proxy. In production, readiness rejects these overrides unless `ALLOW_PROVIDER_ENDPOINT_OVERRIDES=true` is also set. `LIVEFLOW_SKIP_DOTENV=1` is useful in CI and managed hosts where process environment should be the only config source.

## Deploy Procedure

1. Create a dedicated public-beta provider project for OpenAI. Do not reuse a personal or production-wide provider key.
2. Create fresh provider keys for this beta. Store them only in the host secret manager.
3. Configure the required environment variables above. Use a generated `SESSION_SIGNING_SECRET` and a non-guessable `READY_CHECK_TOKEN`.
4. Set `PUBLIC_BASE_URL` to the exact HTTPS origin users will open.
5. Configure `TRUST_PROXY` for the hosting provider. Use `1` for a single trusted edge hop only after confirming the host strips or overwrites client-supplied forwarding headers.
6. Build and start:

```bash
npm ci
npm run build
npm start
```

7. Check public liveness:

```bash
curl -fsS https://PUBLIC_BASE_URL/api/health
```

8. Check private readiness from a trusted operator environment:

```bash
curl -fsS -H "Authorization: Bearer $READY_CHECK_TOKEN" https://PUBLIC_BASE_URL/api/ready
```

9. Invite the first cohort with individual invite codes. Keep the code list short enough to revoke by rotating `BETA_INVITE_CODES`.
10. Confirm the in-app report contact renders correctly before sharing the URL externally.

## Verification And CI

Required local release checks:

```bash
npm run build
npm audit --omit=dev
npm run test:smoke
git diff --check
```

The smoke suite starts the production server with synthetic beta env and local provider stubs. It verifies:

- liveness and private readiness
- built `dist/` app serving
- beta session, invite code, cookie flags, logout, and CSRF enforcement
- same-origin rejection for access attempts without a trusted origin
- beta access attempt throttling before session creation
- validation errors before provider calls
- session/IP quota enforcement
- Realtime token response and `maxSessionMinutes`
- provider timeout fallback without live provider spend
- `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`, and `Fly-Client-IP` spoof attempts do not bypass IP quotas when proxy trust is unset
- structured logs include request metadata but not invite codes, transcripts, or raw payloads

GitHub Actions runs `npm ci`, `npm run build`, `npm audit --omit=dev`, and `npm run test:smoke` on pull requests and pushes to `main`.

## Monitoring

Minimum beta monitoring:

- Host logs: request id, route, status, latency, quota decisions, sanitized error type, hashed session id, and hashed IP.
- Provider dashboard: OpenAI project spend, request rate, error rate, and Realtime session usage.
- Alerts: daily spend threshold, monthly hard cap, unusual 429 spike, sustained 5xx rate, and repeated invalid invite attempts.
- Manual review cadence: inspect logs daily during the first week, then after each cohort expansion.

Do not add raw frame, transcript, prompt, image, invite code, API key, cookie, CSRF token, or Realtime secret logging for debugging. Reproduce with local stubs instead.

## Abuse Response

1. If one invite code is abused, remove it from `BETA_INVITE_CODES` and redeploy/restart.
2. If abuse is broad or spend is rising unexpectedly, set provider project hard caps to the minimum available value and disable external invites.
3. If an IP range is clearly abusive, apply host-level rate limiting or blocking outside the app. Keep app-level quotas as a second line of defense.
4. If privacy-sensitive material may have appeared in logs, preserve the relevant log window for investigation, stop further logging export, and rotate secrets.
5. After any incident, rotate invite codes and `SESSION_SIGNING_SECRET` if cookie/session integrity is in doubt.

## Rollback

Preferred rollback is host-level deployment rollback to the last known-good build. If that is unavailable:

1. Stop the public process or remove public routing to the service.
2. Rotate provider keys if provider traffic was involved.
3. Restore the previous known-good commit and run:

```bash
npm ci
npm run build
npm run test:smoke
```

4. Restart only after `/api/ready` passes with the private token.

## Red-Team Checklist

Run this before expanding beyond trusted testers:

- Invite code cannot be submitted cross-site without a valid same-origin request.
- Repeated invite-code failures return `429` before unbounded guessing.
- AI routes return `401` without a beta session.
- AI routes return `403` with a session but missing/invalid CSRF token.
- Logout requires same-origin, session, and CSRF.
- Oversized or non-image frame payloads are rejected before provider calls.
- Quotas return `429` for session and IP limits.
- Realtime responses include a finite `maxSessionMinutes`, and the frontend stops the session after the limit.
- `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `CF-Connecting-IP`, and `Fly-Client-IP` do not bypass IP quotas unless `TRUST_PROXY` is deliberately configured for a trusted host boundary.
- Production same-origin checks use `PUBLIC_BASE_URL` as the authoritative allowed origin.
- `/api/health` exposes no sensitive details.
- `/api/ready` is inaccessible without the private bearer token and does not print secret values.
- Logs do not include invite codes, transcripts, raw image data, provider keys, cookies, CSRF tokens, or Realtime secrets.
- `.playwright-mcp/`, `.env*`, `.omx/`, `dist/`, and `node_modules/` are not committed.

## Runbook Dry Run

Dry run completed for this code path:

- Build: `npm run build`
- API smoke with provider stubs: `npm run test:smoke`
- Dependency audit: `npm audit --omit=dev`
- Patch hygiene: `git diff --check`

Do another dry run after setting real production env values in the hosting provider. The final external launch blocker is a real, monitored `PUBLIC_BETA_REPORT_CONTACT` and provider-side spend/rate limits on the dedicated beta project.
