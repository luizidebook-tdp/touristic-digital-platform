import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(root, "provenance.json"), "utf8"),
);
const sha = (data) => createHash("sha256").update(data).digest("hex");
const original = readFileSync(join(root, "picomatch-4.0.7-upstream.tgz"));
assert.equal(sha(original), manifest.upstream.archiveSha256);
assert.equal(
  "sha512-" + createHash("sha512").update(original).digest("base64"),
  manifest.upstream.integrity,
);
const patch = readFileSync(join(root, "security.patch"));
assert.equal(sha(patch), manifest.patchSha256);
const temporary = mkdtempSync(join(tmpdir(), "tdp-picomatch-rebuild-"));
try {
  const names = execFileSync(
    "tar",
    ["-tzf", join(root, "picomatch-4.0.7-upstream.tgz")],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.deepEqual(names.sort(), Object.keys(manifest.upstream.files).sort());
  assert.ok(
    names.every(
      (name) => name.startsWith("package/") && !name.split("/").includes(".."),
    ),
  );
  execFileSync("tar", [
    "--no-same-owner",
    "--no-same-permissions",
    "-xzf",
    join(root, "picomatch-4.0.7-upstream.tgz"),
    "-C",
    temporary,
  ]);
  for (const [name, digest] of Object.entries(manifest.upstream.files))
    assert.equal(sha(readFileSync(join(temporary, name))), digest, name);
  execFileSync("patch", ["--batch", "--forward", "--fuzz=0", "-p1"], {
    cwd: join(temporary, "package"),
    input: patch,
  });
  assert.equal(
    sha(readFileSync(join(temporary, "package/lib/parse.js"))),
    manifest.fixedParserSha256,
  );
  const pkg = JSON.parse(
    readFileSync(join(temporary, "package/package.json"), "utf8"),
  );
  pkg.name = "@tdp/picomatch-secure";
  pkg.version = "4.0.7+tdp.1";
  pkg.private = true;
  pkg.description =
    "Local picomatch fork with a verified CVE-2026-112366 parser correction";
  pkg.repository = {
    type: "git",
    url: "https://github.com/luizidebook-tdp/touristic-digital-platform.git",
    directory: "tooling/quality/vendor/picomatch",
  };
  pkg.tdpUpstream = {
    name: "picomatch",
    version: "4.0.7",
    commit: manifest.upstream.commit,
    integrity: manifest.upstream.integrity,
    fixedParserSha256: manifest.fixedParserSha256,
  };
  writeFileSync(
    join(temporary, "package/package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  writeFileSync(
    join(temporary, "package/UPSTREAM.json"),
    JSON.stringify(
      {
        upstream: manifest.upstream,
        patchSha256: manifest.patchSha256,
        fixedParserSha256: manifest.fixedParserSha256,
        advisory: manifest.advisory,
        proposal: manifest.proposal,
      },
      null,
      2,
    ) + "\n",
  );
  const tar = execFileSync(
    "tar",
    [
      "--sort=name",
      "--format=ustar",
      "--mode=u=rwX,go=rX",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      "-",
      "-C",
      temporary,
      "package",
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const archive = gzipSync(tar, { level: 9, mtime: 0 });
  const target = join(root, "tdp-picomatch-secure-4.0.7-tdp.1.tgz");
  if (process.argv.includes("--write")) writeFileSync(target, archive);
  else {
    assert.equal(sha(archive), manifest.forkArchiveSha256);
    assert.deepEqual(archive, readFileSync(target));
  }
  console.log(
    JSON.stringify({
      status: "pass",
      sha256: sha(archive),
      bytes: archive.length,
      originalFilesVerified: names.length,
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
