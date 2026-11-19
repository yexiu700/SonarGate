# SonarGate

[![CI](https://github.com/yexiu700/SonarGate/actions/workflows/ci.yml/badge.svg)](https://github.com/yexiu700/SonarGate/actions/workflows/ci.yml)
![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

**SonarGate** is a stateless, high-reliability **AI visibility observation aggregation gateway** built with Node.js 22, Fastify 5, TypeScript, and Zod. It exposes a unified GeoMix Remote Scraper–compatible HTTP API (`POST /v1/collect`) across **10 AI search engines** (5 domestic native web-search APIs + 5 overseas DataForSEO adapters) with strict normalization, singleflight deduplication, LRU caching, deadline-aware retries, and concurrency isolation.

---

## Features

- **Unified GeoMix Contract**: Consistent `POST /v1/collect` JSON response (`answerText`, `citations`, `fanOutQueries`, `rawMeta`) with a 6-step normalization pipeline and 1.9 MB 3-tier byte guard.
- **10 Supported AI Search Engines**:
  - **Domestic (5)**: `doubao` (Volcengine Ark), `deepseek`, `tongyi` (Alibaba DashScope), `zhipu` (BigModel), `wenxin` (Baidu Qianfan V2)
  - **Overseas via DataForSEO (5)**: `chatgpt`, `perplexity`, `gemini` (`scraper` / `responses` modes), `claude`, `google_aio` (with `<60`-char `[NO_AI_OVERVIEW]` fallback & short TTL)
- **Resilience & Isolation**:
  - Per-engine semaphores for domestic engines and a shared semaphore pool for DataForSEO.
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
| `GET /ready` | None | Readiness probe (`200` when ≥1 engine configured & not shutting down; otherwise `503`) |
| `GET /v1/engines` | Bearer | Lists all 10 supported engines and their configuration status |
| `POST /v1/collect` | Bearer | Collects normalized AI search response for a single engine & prompt |

### Supported Engines

| Engine | Region | Provider | Default Env Key(s) |
| :--- | :--- | :--- | :--- |
| `doubao` | Domestic | Volcengine Ark | `DOUBAO_API_KEY`, `DOUBAO_MODEL` |
| `deepseek` | Domestic | DeepSeek | `DEEPSEEK_API_KEY` |
| `tongyi` | Domestic | Alibaba DashScope | `TONGYI_API_KEY` |
| `zhipu` | Domestic | Zhipu BigModel | `ZHIPU_API_KEY` |
| `wenxin` | Domestic | Baidu Qianfan V2 | `WENXIN_API_KEY` |
| `chatgpt` | Overseas | DataForSEO | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` |
| `perplexity` | Overseas | DataForSEO | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` |
| `gemini` | Overseas | DataForSEO | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` |
| `claude` | Overseas | DataForSEO | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` |
| `google_aio` | Overseas | DataForSEO | `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` |

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

### Production (GHCR + Self-Hosted Runner + Nginx)

Production deployments use [`docker-compose.prod.yml`](./docker-compose.prod.yml) (pulling `ghcr.io/<owner>/sonargate:<tag>`) and [`deploy/nginx-sonargate.conf`](./deploy/nginx-sonargate.conf):

- Deployed to `/opt/sonargate` with server-managed `/opt/sonargate/.env` (`chmod 600`).
- Listens strictly on loopback `127.0.0.1:8080` behind Nginx HTTPS termination (direct `POST /v1/collect` with zero `3xx` redirects).
- `stop_grace_period: 35s` aligns with the 30 s graceful in-flight drain.

---

## CI/CD Workflows

| Workflow | Trigger | Purpose |
| :--- | :--- | :--- |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) | `push` (`main`), `pull_request`, manual | `verify` (lint, typecheck, unit/integration, E2E, build) + `docker-check` (build & non-root read-only container smoke) |
| [`.github/workflows/auto-merge.yml`](./.github/workflows/auto-merge.yml) | `pull_request`, `workflow_run` (`CI`) | Automatically squash-merges same-repo non-draft PRs once `CI` passes |
| [`.github/workflows/cd.yml`](./.github/workflows/cd.yml) | Manual (`workflow_dispatch`) | Builds/pushes GHCR image (`:sha-<7>`, `:latest`), deploys to `self-hosted` runner, runs `/health` + `/ready` + no-`3xx` post-deploy gate, and auto-rolls back on failure; supports instant `rollback_tag` |
| [`.github/workflows/smoke.yml`](./.github/workflows/smoke.yml) | Manual (`workflow_dispatch`, Env: `smoke`) | Controlled real-key smoke testing (local or remote gateway) isolated from PRs |

---

## License

MIT — see [LICENSE](./LICENSE).
