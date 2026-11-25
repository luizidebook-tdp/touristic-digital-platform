---
applyTo: "packages/geospatial/**,apps/morro-digital-platform/src/map/**,apps/morro-digital-platform/src/navigation/**,apps/morro-digital-platform/public/**/*map*,apps/morro-digital-platform/public/**/*search*,apps/morro-digital-platform/tooling/**/*map*,apps/morro-digital-platform/tooling/**/*search*"
---

# search-map

These instructions extend `AGENTS.md` for matching paths.

- Canonical Place and Destination ownership must be preserved.
- Search and Map must converge on the same canonical entities and IDs.
- Fallbacks may degrade presentation, never authority.
- Mobile navigation and location flows require browser or runtime proof.
- A material write requires an active ChangeSet claim covering the exact path whenever the applicable executable policy requires one. Ordinary application changes explicitly eligible under `tooling/fabric/ordinary-pr-policy.mjs` do not require a ChangeSet, claim or lease, but remain subject to applicable tests, quality checks and review.
- Evidence must name the exact source SHA and cannot be reused across non-equivalent trees.
