---
applyTo: ".github/workflows/*release*,.github/workflows/*promotion*,render*.yaml,render*.yml,docs/operations/**/*release*"
---

# render-release

These instructions extend `AGENTS.md` for matching paths.

- Current main is the release source of truth.
- Build once and promote the same immutable OCI digest.
- Require exact SHA, tree, artifact and provenance identity across environments.
- Staging proof precedes production; production requires runtime evidence.
- A material write requires an active ChangeSet claim covering the exact path whenever the applicable executable policy requires one. Ordinary application changes explicitly eligible under `tooling/fabric/ordinary-pr-policy.mjs` do not require a ChangeSet, claim or lease, but remain subject to applicable tests, quality checks and review.
- Evidence must name the exact source SHA and cannot be reused across non-equivalent trees.
