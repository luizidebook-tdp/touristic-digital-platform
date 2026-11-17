# Local picomatch security remediation

This directory owns the temporary, private `@tdp/picomatch-secure` component,
version `4.0.7+tdp.1`. It derives from the genuine npm `picomatch@4.0.7`
distribution and retains its MIT license and author attribution. It is a local
fork; no patched upstream release is claimed.

The parser corrects CVE-2026-112366 / GHSA-fc5q-39xc-vjpf. A single-branch star
glob absorbs its own repetition, allowing the outer unbounded quantifier to be
removed. Quoted literal stars are preserved. Branches containing bare stars
that cannot be safely reduced, including separator or nested forms, use the
existing literal fallback for risky repeated extglobs. The explicit upstream
`maxExtglobRecursion: false` opt-out retains its existing behavior.

The implementation is based on upstream PR #237, with local handling for
quoted stars, path separators and nested extglob compatibility. The proposal
was open when incorporated. Its source identity and the local differences are
recorded in `provenance.json`; the complete parser delta is `security.patch`.

`picomatch-4.0.7-upstream.tgz` is the unchanged, integrity-verified distribution.
`rebuild.mjs` checks its integrity and every source file, applies the visible
patch, records the original component identity, preserves the license and
creates the fixed archive with deterministic metadata. Run it with Node 22 to
verify the checked-in archive; `--write` explicitly regenerates that archive.
GNU tar and patch are build-time prerequisites. No network access is needed.

The root override and lockfile select the fixed archive for all consumers.
Security tests verify installed parser bytes, the original timeout versus the
corrected result, safe matching behavior and actual consumer resolution.
Dependency audits and container scans remain unchanged and have no exception
for this advisory. Scanners see a distinct local component; the source,
regression and provenance proofs establish the correction beyond its name.

Replace this fork with an upstream release only after its parser correction,
integrity, consumer compatibility and required security checks are verified.
Monitor the original component advisories while this fork remains in use.
