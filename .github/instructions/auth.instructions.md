---
applyTo: "packages/auth/**,packages/auth-browser/**,services/auth/**,apps/morro-digital-platform/tooling/auth-*.mjs"
---

# auth

These instructions extend `AGENTS.md` for matching paths.

- Authentication and authorization are server-enforced.
- Session, cookie, origin and CSRF behavior must remain fail-closed.
- Never derive authorization from client-visible role labels.
- Cross-tenant or cross-session leakage is a release blocker.
- A material write requires an active ChangeSet claim covering the exact path whenever the applicable executable policy requires one. Ordinary application changes explicitly eligible under `tooling/fabric/ordinary-pr-policy.mjs` do not require a ChangeSet, claim or lease, but remain subject to applicable tests, quality checks and review.
- Evidence must name the exact source SHA and cannot be reused across non-equivalent trees.
