import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const root = process.cwd();
const vendor = join(root, "tooling/quality/vendor/picomatch");
const provenance = JSON.parse(
  readFileSync(join(vendor, "provenance.json"), "utf8"),
);
const temporary = mkdtempSync(join(tmpdir(), "tdp-picomatch-proof-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
execFileSync("tar", [
  "-xzf",
  join(vendor, "picomatch-4.0.7-upstream.tgz"),
  "-C",
  temporary,
]);
const upstreamPath = join(temporary, "package");
const upstream = require(upstreamPath);
const viteRequire = createRequire(require.resolve("vite"));
const entry = viteRequire.resolve("picomatch");
const installed = require(entry);
const installedRoot = dirname(entry);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the local component contains the real parser correction and upstream attribution", () => {
  const pkg = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  );
  assert.equal(pkg.name, "@tdp/picomatch-secure");
  assert.equal(pkg.version, "4.0.7+tdp.1");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.tdpUpstream.name, "picomatch");
  assert.equal(pkg.tdpUpstream.version, "4.0.7");
  const parser = readFileSync(join(installedRoot, "lib/parse.js"));
  assert.equal(digest(parser), provenance.fixedParserSha256);
  assert.notEqual(
    digest(parser),
    provenance.upstream.files["package/lib/parse.js"],
  );
  assert.deepEqual(
    readFileSync(join(installedRoot, "LICENSE")),
    readFileSync(join(upstreamPath, "LICENSE")),
  );
  assert.equal(
    JSON.parse(readFileSync(join(installedRoot, "UPSTREAM.json"))).patchSha256,
    provenance.patchSha256,
  );
});

test("the installed archive is reproducible from the original distribution and visible patch", () => {
  const output = execFileSync(process.execPath, [join(vendor, "rebuild.mjs")], {
    encoding: "utf8",
  });
  assert.equal(JSON.parse(output).sha256, provenance.forkArchiveSha256);
});

test("the lockfile replaces every consumer while security gates retain their advisory", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    pkg.pnpm.overrides.picomatch,
    "file:tooling/quality/vendor/picomatch/tdp-picomatch-secure-4.0.7-tdp.1.tgz",
  );
  assert.equal(pkg.pnpm.auditConfig, undefined);
  assert.doesNotMatch(
    readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    /^  picomatch@\d/m,
  );
  assert.doesNotMatch(
    readFileSync(join(root, ".trivyignore.yaml"), "utf8"),
    /CVE-2026-112366|GHSA-fc5q-39xc-vjpf/,
  );
  const audit = readFileSync(
    join(root, ".github/workflows/dependency-security-audit.yml"),
    "utf8",
  );
  assert.match(audit, /pnpm audit --audit-level high --json/);
  assert.doesNotMatch(audit, /ignore-unfixable|ignore-cves|ignore-ghsas/);
});

test("Vite, Vitest, TypeScript ESLint and fdir resolve the corrected component", () => {
  const tsRequire = createRequire(require.resolve("typescript-eslint"));
  const parserRequire = createRequire(
    tsRequire.resolve("@typescript-eslint/parser"),
  );
  const estreeRequire = createRequire(
    parserRequire.resolve("@typescript-eslint/typescript-estree"),
  );
  const tinyRequire = createRequire(estreeRequire.resolve("tinyglobby"));
  const fdirRequire = createRequire(tinyRequire.resolve("fdir"));
  for (const consumer of [
    viteRequire,
    createRequire(require.resolve("vitest")),
    tinyRequire,
    fdirRequire,
  ]) {
    const selected = consumer.resolve("picomatch");
    assert.equal(selected, entry);
    assert.equal(
      digest(readFileSync(join(dirname(selected), "lib/parse.js"))),
      provenance.fixedParserSha256,
    );
  }
});

test("the vulnerable original exceeds a process bound and the installed parser completes", () => {
  const vectors = [
    ["+(*a)", "a".repeat(50) + "b"],
    ["*(*a)", "a".repeat(50) + "b"],
    ["+(a*)", "a".repeat(50) + "/"],
    ["+([/a]*a)", "a".repeat(50) + "b"],
  ];
  for (const [pattern, input] of vectors) {
    const script = (modulePath) =>
      `const pm=require(${JSON.stringify(modulePath)}); console.log(pm(${JSON.stringify(pattern)})(${JSON.stringify(input)}));`;
    const original = spawnSync(process.execPath, ["-e", script(upstreamPath)], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4096,
    });
    assert.equal(original.error?.code, "ETIMEDOUT", pattern);
    const corrected = spawnSync(process.execPath, ["-e", script(entry)], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
    });
    assert.ifError(corrected.error);
    assert.equal(corrected.status, 0, corrected.stderr);
    assert.equal(corrected.stdout.trim(), "false", pattern);
  }
});

test("safe glob results match upstream across small inputs and supported options", () => {
  const alphabet = ["a", "b", ".", "*", "/", "\\", " "];
  const inputs = [""];
  let level = [""];
  for (let depth = 1; depth <= 4; depth++) {
    level = level.flatMap((prefix) => alphabet.map((char) => prefix + char));
    inputs.push(...level);
  }
  const bodies = [
    "*",
    "*a",
    "a*",
    "a*b",
    "*a*b*",
    "?*a",
    "[ab]*",
    "a*[ab]",
    "*a?",
    '"a"*b',
    "\\**a",
    '"*a"',
    '"a*b"',
    '"*a"*',
  ];
  for (const body of bodies)
    for (const operator of ["+", "*"])
      for (const [prefix, suffix] of [
        ["", ""],
        ["x", "y"],
      ]) {
        const pattern = `${prefix}${operator}(${body})${suffix}`;
        for (const options of [
          {},
          { dot: true },
          { windows: true },
          { bash: true },
          { capture: true },
        ]) {
          const before = upstream(pattern, options);
          const after = installed(pattern, options);
          for (const input of inputs)
            assert.equal(
              after(input),
              before(input),
              JSON.stringify({ pattern, input, options }),
            );
        }
      }
});

test("tinyglobby retains nested file selection and exclusion through the real dependency chain", async () => {
  const tsRequire = createRequire(require.resolve("typescript-eslint"));
  const parserRequire = createRequire(
    tsRequire.resolve("@typescript-eslint/parser"),
  );
  const estreeRequire = createRequire(
    parserRequire.resolve("@typescript-eslint/typescript-estree"),
  );
  const { glob } = estreeRequire("tinyglobby");
  const fixture = join(temporary, "consumer");
  for (const file of [
    "src/main.ts",
    "src/nested/view.ts",
    "src/view.test.ts",
    "dist/generated.js",
  ]) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    writeFileSync(join(fixture, file), "export {};\n");
  }
  assert.deepEqual(
    (
      await glob(["src/**/*.ts", "!**/*.test.ts"], {
        cwd: fixture,
        onlyFiles: true,
      })
    ).sort(),
    ["src/main.ts", "src/nested/view.ts"],
  );
});
