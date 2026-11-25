---
applyTo: "packages/assistant/**,apps/morro-digital-platform/src/assistant/**,apps/morro-digital-platform/public/**/*assistant*,apps/morro-digital-platform/tooling/**/*assistant*"
---

# assistant

These instructions extend `AGENTS.md` for matching paths.

- Conversation authority must remain singular.
- Preserve session and turn causality and drop stale asynchronous responses.
- Deterministic critical flows must not depend on an LLM.
- Public copy must not expose internal technical state.
- A material write requires an active ChangeSet claim covering the exact path whenever the applicable executable policy requires one. Ordinary application changes explicitly eligible under `tooling/fabric/ordinary-pr-policy.mjs` do not require a ChangeSet, claim or lease, but remain subject to applicable tests, quality checks and review.
- Evidence must name the exact source SHA and cannot be reused across non-equivalent trees.
