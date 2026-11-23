# SonarGate

[![CI](https://github.com/yexiu700/SonarGate/actions/workflows/ci.yml/badge.svg)](https://github.com/yexiu700/SonarGate/actions/workflows/ci.yml)
![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

**SonarGate** is a stateless, high-reliability **AI visibility observation aggregation gateway** built with Node.js 22, Fastify 5, TypeScript, and Zod. It exposes a unified GeoMix Remote Scraper–compatible HTTP API (`POST /v1/collect`) across **12 AI search engines** (7 domestic native web-search APIs + 5 overseas DataForSEO / OpenAI-compatible relay adapters) with strict normalization, redirect URL unwrapping, dual-market `market`/`locale`/`region` passthrough, singleflight deduplication, LRU caching, deadline-aware retries, and concurrency isolation.

---

## Features

- **Unified GeoMix Contract**: Consistent `POST /v1/collect` JSON response (`answerText`, `citations`, `fanOutQueries`, `rawMeta`) with a 6-step normalization pipeline, deterministic redirect URL unwrapping, semicolon/newline `fanOutQueries` splitting, and a 1.9 MB 3-tier byte guard.
- **Server-side search trace**: For engines that expose their server-side web-search trace (e.g. DeepSeek `message.server_tool_calls` with `deepseek_web_search`), `search` sub-queries are merged into `fanOutQueries` (round order, deduped), while pages recalled-but-not-cited and pages the model opened are surfaced separately as `rawMeta.retrievedSources[]` (`url`, `title`, `snippet`, `siteName`, `publishedAt`, `opened`) and `rawMeta.openedPages[]` — they never inflate `citations`. `usage.server_tool_use` counters are exposed as `rawMeta.serverToolSearchCount` / `serverToolFetchCount`.
- **Dual-Market Geo/Locale Passthrough**: Optional `market` (`CN` | `GLOBAL`), `locale` (BCP-47 e.g. `zh-CN`, `en-US`, `de-DE`, `ja-JP`), and `region` (ISO-3166-1 alpha-2 e.g. `CN`, `US`, `GB`, `DE`, `JP`) forwarded to overseas retrieval APIs (`location_code`, `language_code`, `web_search_country_iso_code`, `web_search_options.user_location`, `Accept-Language`) with backward-compatible defaults.
- **12 Supported AI Search Engines**:
  - **Domestic (7)**: `doubao` (Volcengine Ark SSE streaming + phase timing observability & stall fast-fail), `deepseek`, `tongyi` (Alibaba DashScope, alias `qwen`), `zhipu` (BigModel), `wenxin` (Baidu Qianfan V2), `yuanbao` (Tencent Hunyuan + Sogou/WeChat search enhancement), `kimi` (Moonshot AI `$web_search` multi-round tool-call protocol)
  - **Overseas (5)**: `chatgpt`, `perplexity`, `gemini`, `claude`, `google_aio` — supports both **DataForSEO** (Basic Auth, native web scraping & Google AI Overview) and **OpenAI-compatible relays** (NewAPI / SubAPI / OpenRouter via `OVERSEAS_RELAY_BASE_URL` + `OVERSEAS_RELAY_API_KEY`, with per-engine overrides; `google_aio` uses Gemini as an `openai_compat` placeholder).
- **Resilience & Isolation**:
  - Per-engine semaphores for domestic engines (with gentle default concurrency & adaptive cooldown for `doubao`) and a shared semaphore pool for overseas engines.
  - Doubao SSE phase timing logs (`dispatchMs`, `webSearchMs`, `ttftMs`, `finishMs`, `totalMs`) plus early first-byte/idle stall fast-fail and guaranteed socket cleanup.
  - Deadline-aware exponential backoff retry (`Retry-After` aware) bounded by per-request budgets.
  - Singleflight in-flight deduplication + TTL-based LRU cache (`X-Bypass-Cache: true` or `noCache: true` to bypass).
- **Security & Operations**:
  - Constant-time multi-key Bearer authentication (`GATEWAY_API_KEYS` for zero-downtime key rotation).
  - Pino secret redaction, 64 KB request body limit, `X-Request-Id` propagation, and 30 s graceful shutdown (`/ready` flips to `503` while draining in-flight requests).
  - Hardened non-root (`uid=10001`), `read_only` Docker image + reference Nginx reverse-proxy config (no `3xx` redirects).

---

## API Overview

| Method & Path | Auth | Description |
| :--- | :--- | :--- |
| `GET /health` | None | Process liveness probe (`200 OK`) |
| `GET /ready` | None | Readiness probe (`200` when ≥1 engine configured & not shutting down; otherwise `503`), including sanitized `engines`, `plannedEngines`, and `aliases` availability |
| `GET /v1/engines` | Bearer | Lists all 12 supported engines, planned engines, aliases, and detailed runtime status |
| `POST /v1/collect` | Bearer | Collects normalized AI search response for a single engine & prompt (supports optional `market`, `locale`, `region`, `locationCode`, `languageCode`, `noCache`) |

### Supported Engines

| Engine | Region | Provider(s) | Default Env Key(s) |
| :--- | :--- | :--- | :--- |
| `doubao` | Domestic | Volcengine Ark (SSE + JSON) | `DOUBAO_API_KEY`, `DOUBAO_MODEL` |
| `deepseek` | Domestic | DeepSeek | `DEEPSEEK_API_KEY` |
| `tongyi` (alias: `qwen`) | Domestic | Alibaba DashScope | `TONGYI_API_KEY` (or `QWEN_API_KEY`) |
| `zhipu` | Domestic | Zhipu BigModel | `ZHIPU_API_KEY` |
| `wenxin` | Domestic | Baidu Qianfan V2 | `WENXIN_API_KEY` |
| `yuanbao` | Domestic | Tencent Hunyuan (WeChat/Sogou search) | `YUANBAO_API_KEY` (or `HUNYUAN_API_KEY`) |
| `kimi` | Domestic | Moonshot AI (`$web_search`) | `KIMI_API_KEY` (or `MOONSHOT_API_KEY`) |
| `chatgpt` | Overseas | DataForSEO / `openai_compat` (NewAPI, SubAPI) | `DATAFORSEO_*` or `OVERSEAS_RELAY_*` / `CHATGPT_*` |
| `perplexity` | Overseas | DataForSEO / `openai_compat` (NewAPI, SubAPI) | `DATAFORSEO_*` or `OVERSEAS_RELAY_*` / `PERPLEXITY_*` |
| `gemini` | Overseas | DataForSEO / `openai_compat` (NewAPI, SubAPI) | `DATAFORSEO_*` or `OVERSEAS_RELAY_*` / `GEMINI_*` |
| `claude` | Overseas | DataForSEO / `openai_compat` (NewAPI, SubAPI) | `DATAFORSEO_*` or `OVERSEAS_RELAY_*` / `CLAUDE_*` |
| `google_aio` | Overseas | DataForSEO / `openai_compat` (Gemini placeholder) | `DATAFORSEO_*` or `OVERSEAS_RELAY_*` / `GOOGLE_AIO_*` |

### Planned Engines & Error Contract (`400` vs `501`)

`GET /ready` and `GET /v1/engines` return `engines` (each with `status: "ready" | "unconfigured" | "disabled"`), `plannedEngines` (`nami`, `status: "planned"`), and `aliases` (`{ "qwen": "tongyi" }`).

`POST /v1/collect` separates client protocol errors (`400`) from unavailable engine capabilities (`501`):

| HTTP | `error.code` | `retryable` | Semantics |
| :--- | :--- | :--- | :--- |
| `400` | `INVALID_REQUEST` | `false` | Malformed JSON or schema validation failure |
| `400` | `UNSUPPORTED_ENGINE` | `false` | Unknown / invalid engine name not in gateway contract |
| `400` | `ENGINE_DISABLED` | `false` | Supported engine explicitly disabled via `DISABLED_ENGINES` |
| `401` | `UNAUTHORIZED` | `false` | Missing or invalid Bearer token |
| `408` | `UPSTREAM_TIMEOUT` | `true` | Upstream request, first-byte/idle stall, or request deadline exceeded |
| `429` | `RATE_LIMITED` | `true` | Upstream rate limit or local semaphore saturation |
| `501` | `ENGINE_NOT_CONFIGURED` | `false` | Supported engine adapter exists but credentials/config are missing |
| `501` | `ENGINE_NOT_IMPLEMENTED` | `false` | Planned engine (`nami`) not yet implemented on gateway |
| `502` | `UPSTREAM_BAD_RESPONSE` | `true` | Upstream 5xx or invalid/empty response payload |
| `503` | `UPSTREAM_AUTH_OR_QUOTA` | `false` | Upstream authentication or quota exhaustion |
| `500` | `INTERNAL_ERROR` | `false` | Unexpected internal gateway failure |

---

## Quick Start

### Prerequisites

- Node.js `>= 22.0.0`
- `pnpm` (`10.x`, managed via Corepack)

### Local Development

```bash
cp .env.example .env
# Edit .env to set GATEWAY_API_KEYS and at least one engine's credentials

pnpm install --frozen-lockfile
pnpm dev
```

### Verification Commands

```bash
pnpm lint          # ESLint + Prettier check
pnpm typecheck     # TypeScript strict typecheck
pnpm test          # Unit + GeoMix contract integration tests
pnpm test:e2e      # Full 5-tier mocked E2E & adversarial hardening suite
pnpm build         # Compile TypeScript to dist/
```

### Manual Smoke Test (Real Upstream Keys)

```bash
pnpm smoke --engine=doubao --prompt="2026年中小企业CRM系统推荐哪几款？" --no-cache
pnpm smoke --all-configured --prompt="2026年中小企业CRM系统推荐哪几款？"
```

---

## Deployment

### Docker (Local)

```bash
docker compose up -d --build
```

### Production (GHCR + dedicated self-hosted runner)

Production on the shared `us-test` host uses [`docker-compose.prod.yml`](./docker-compose.prod.yml). The process listens on container port `8080` and is published only as **`127.0.0.1:18082`**. Public HTTPS routing already targets that loopback address. CD does not change it.

[`deploy/nginx-sonargate.conf`](./deploy/nginx-sonargate.conf) is only a reference sample. CD does not copy it and does not edit, reload, or restart the host web server. Do not install that sample over the live routing: the live upstream is `127.0.0.1:18082`.

CD ([`.github/workflows/cd.yml`](./.github/workflows/cd.yml)) is manual (`workflow_dispatch` only). Opening or merging a pull request does not deploy.

Shared-host rules enforced by [`deploy/sonargate-deploy.sh`](./deploy/sonargate-deploy.sh):

- Copy only `docker-compose.prod.yml` to `/opt/sonargate`. Server-managed `/opt/sonargate/.env` (mode `600`) is required and is never overwritten. A deploy path other than `/opt/sonargate` is refused.
- Update only Compose project `sonargate`, service `sonargate` (`pull sonargate`, then `up -d --no-deps --no-build sonargate`). There is no whole-stack `down` and no orphan removal.
- Do not delete images, volumes, networks, or containers. Global image cleanup is intentionally absent, so other projects on `us-test` keep their images. The tag that was running is pinned to its image id before pull and is left in place for rollback.
- Do not run database migrations. The service is stateless. If the post-deploy gate fails, only the `sonargate` service is recreated from the previous image.
- `stop_grace_period: 40s` leaves room for the 30 s in-flight drain.

#### Dedicated runner labels

The deploy job requires every label below. GitHub matches them with AND, so a runner that only has the default self-hosted labels is not eligible:

```yaml
runs-on: [self-hosted, linux, x64, sonargate-us-test]
```

| Label | How the runner gets it |
| :--- | :--- |
| `self-hosted` | Added automatically by the runner agent |
| `linux` | Added automatically. The UI may show `Linux`; matching is case-insensitive |
| `x64` | Added automatically. The UI may show `X64`; matching is case-insensitive |
| `sonargate-us-test` | Custom label. Add it only on the SonarGate runner |

The existing GeoMix runner (`us_test` at `/opt/actions-runner`) on `us-test` must keep its current labels and must not receive `sonargate-us-test`. A job that asks only for `self-hosted` can be picked up by that GeoMix runner. This workflow does not do that.

`us-test` is CentOS 7 (glibc 2.17). Do not install a current GitHub Actions runner binary on the host itself. Run a separate SonarGate runner in its own container, with a userspace that provides a newer glibc, its own config directory, and no shared state with the GeoMix runner. At registration, add the custom label `sonargate-us-test`; the agent still applies `self-hosted`, `linux`, and `x64`. Keep the registration token out of git. This repository does not register or start that runner.

#### Deploying after that runner is online

1. Cancel any older CD run that still uses `runs-on: self-hosted` before it is picked up. Those runs can land on the GeoMix runner and can clean images for the whole host. This repository change does not cancel them.
2. Confirm the new runner is idle and lists `sonargate-us-test`, and that the GeoMix runner does not.
3. Confirm the live publish address is still `127.0.0.1:18082`. Leave the host web server as it is.
4. Run the CD workflow manually from the Actions tab. Merge does not deploy.
5. The job checks `http://127.0.0.1:18082/health` and `http://127.0.0.1:18082/ready`. When the `PUBLIC_COLLECT_URL` repository variable is set, it also checks that an unauthenticated public `POST /v1/collect` returns `401` with no `3xx`.

---

## CI/CD Workflows

| Workflow | Trigger | Purpose |
| :--- | :--- | :--- |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) | `push` (`main`), `pull_request`, manual | `verify` (CD shared-host safety check, lint, typecheck, unit/integration, E2E, build) + `docker-check` (build & non-root read-only container smoke) |
| [`.github/workflows/auto-merge.yml`](./.github/workflows/auto-merge.yml) | `pull_request`, `workflow_run` (`CI`) | Automatically squash-merges same-repo non-draft PRs once `CI` passes |
| [`.github/workflows/cd.yml`](./.github/workflows/cd.yml) | Manual (`workflow_dispatch`) | Builds/pushes GHCR image (`:sha-<7>`, `:latest`) and deploys only the `sonargate` service on the runner labeled `sonargate-us-test` (plus `self-hosted`, `linux`, `x64`). Checks `127.0.0.1:18082` `/health` + `/ready` + no-`3xx`, and rolls that service back on failure; supports instant `rollback_tag`. Does not clean host Docker data or change the host web server |
| [`.github/workflows/smoke.yml`](./.github/workflows/smoke.yml) | Manual (`workflow_dispatch`, Env: `smoke`) | Controlled real-key smoke testing (local or remote gateway) isolated from PRs |

---

## License

MIT — see [LICENSE](./LICENSE).
