# Security Policy

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities or credential leaks. Report them privately to the repository maintainers via GitHub Security Advisories.

## Operational Security Defaults

- **No secrets in Git**: Production `GATEWAY_API_KEYS` and upstream engine API keys must only live in `/opt/sonargate/.env` (`chmod 600`) on the deployment host or in the isolated `smoke` GitHub Environment.
- **Zero-downtime key rotation**: Configure comma-separated `GATEWAY_API_KEYS` during rotation windows; authentication uses constant-time comparison.
- **Container hardening**: Production containers run as non-root (`uid=10001`), with `read_only: true`, `no-new-privileges:true`, and a loopback-only host publish (`127.0.0.1:18082` to container port `8080`). CD does not publish `0.0.0.0` and does not fall back to host port `8080`.
- **No-redirect policy**: Public HTTPS endpoints must route `POST /v1/collect` directly without `3xx` redirects.
