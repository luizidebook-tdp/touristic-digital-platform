import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const vendor = dirname(fileURLToPath(import.meta.url));
const provenance = JSON.parse(
  readFileSync(join(vendor, "provenance.json"), "utf8"),
);
const temporary = mkdtempSync(join(tmpdir(), "tdp-picomatch-component-"));
after(() => rmSync(temporary, { recursive: true, force: true }));
for (const [name, file] of [
  ["original", "picomatch-4.0.7-upstream.tgz"],
  ["fixed", "tdp-picomatch-secure-4.0.7-tdp.1.tgz"],
]) {
  mkdirSync(join(temporary, name));
  execFileSync("tar", [
    "-xzf",
    join(vendor, file),
    "-C",
    join(temporary, name),
  ]);
}
const originalPath = join(temporary, "original/package");
const fixedPath = join(temporary, "fixed/package");
const original = require(originalPath);
const fixed = require(fixedPath);
const digest = (data) => createHash("sha256").update(data).digest("hex");

test("the component is reproducible from the original archive and reviewed parser delta", () => {
  const output = JSON.parse(
    execFileSync(process.execPath, [join(vendor, "rebuild.mjs")], {
      encoding: "utf8",
    }),
  );
  assert.equal(output.sha256, provenance.forkArchiveSha256);
  assert.equal(
    digest(readFileSync(join(fixedPath, "lib/parse.js"))),
    provenance.fixedParserSha256,
  );
  assert.notEqual(
    provenance.fixedParserSha256,
    provenance.upstream.files["package/lib/parse.js"],
  );
});

test("the local identity retains upstream origin, version and the complete MIT license", () => {
  const pkg = JSON.parse(readFileSync(join(fixedPath, "package.json"), "utf8"));
  assert.equal(pkg.name, "@tdp/picomatch-secure");
  assert.equal(pkg.version, "4.0.7+tdp.1");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.tdpUpstream.name, "picomatch");
  assert.equal(pkg.tdpUpstream.version, "4.0.7");
  assert.deepEqual(
    readFileSync(join(fixedPath, "LICENSE")),
    readFileSync(join(originalPath, "LICENSE")),
  );
  assert.equal(
    JSON.parse(readFileSync(join(fixedPath, "UPSTREAM.json"))).patchSha256,
    provenance.patchSha256,
  );
});

test("all four original timeout cases complete with the actual fixed distribution", () => {
  const vectors = [
    ["+(*a)", "a".repeat(50) + "b"],
    ["*(*a)", "a".repeat(50) + "b"],
    ["+(a*)", "a".repeat(50) + "/"],
    ["+([/a]*a)", "a".repeat(50) + "b"],
  ];
  for (const [pattern, input] of vectors) {
    const script = (path) =>
      `const pm=require(${JSON.stringify(path)}); console.log(pm(${JSON.stringify(pattern)})(${JSON.stringify(input)}));`;
    const before = spawnSync(process.execPath, ["-e", script(originalPath)], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4096,
    });
    assert.equal(before.error?.code, "ETIMEDOUT", pattern);
    const after = spawnSync(process.execPath, ["-e", script(fixedPath)], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
    });
    assert.ifError(after.error);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout.trim(), "false", pattern);
  }
});

test("safe matching results remain compatible across small inputs and option combinations", () => {
  const alphabet = ["a", "b", ".", "*", "/", "\\", " "];
  let level = [""];
  const inputs = [""];
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
          const before = original(pattern, options);
          const after = fixed(pattern, options);
          for (const input of inputs)
            assert.equal(
              after(input),
              before(input),
              JSON.stringify({ pattern, input, options }),
            );
        }
      }
});

test("nested extglobs and quoted literal stars retain their existing matching behavior", () => {
  for (const [pattern, input] of [
    ["*(f*(o))", "fooofoofofooo"],
    ['+("*a")', "*a*a"],
    ["*(f*(o)x)", "foooxfooxfoxfooox"],
  ]) {
    assert.equal(
      fixed(pattern, { windows: true })(input),
      original(pattern, { windows: true })(input),
    );
    assert.equal(fixed(pattern, { windows: true })(input), true);
  }
});
