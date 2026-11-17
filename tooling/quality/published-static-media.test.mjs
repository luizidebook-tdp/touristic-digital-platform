import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stagePublishedStaticMedia } from "./published-static-media.mjs";

const MANIFEST =
  "apps/morro-digital-platform/src/migration/legacy-commercial-media-mappings.ndjson";
const JPEG = Buffer.from("ffd8ff012345", "hex");
const WEBP = Buffer.from("524946460400000057454250", "hex");
const repositoryRoot = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

function asset(name, bytes, overrides = {}) {
  return {
    mediaId: `media-${name}`,
    provider: "legacy-static",
    providerReference: `/images/fotos/${name}`,
    publicationState: "published",
    mimeType: "image/jpeg",
    byteSize: bytes.length,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
}

async function fixture(t, assets) {
  const directory = await mkdtemp(resolve(tmpdir(), "published-media-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const root = resolve(directory, "source");
  const output = resolve(directory, "selected");
  await mkdir(resolve(root, "images/fotos"), { recursive: true });
  await mkdir(resolve(root, "apps/morro-digital-platform/src/migration"), {
    recursive: true,
  });
  await writeFile(resolve(root, MANIFEST), `${JSON.stringify({ assets })}\n`);
  return { root, output };
}

test("copies only published legacy assets and preserves JPEG/WebP bytes", async (t) => {
  const a = asset("one.jpg", JPEG);
  const b = asset("two.jpg", WEBP, { mimeType: "image/webp" });
  const draft = asset("draft.jpg", JPEG, { publicationState: "draft" });
  const external = asset("external.jpg", JPEG, { provider: "external" });
  const { root, output } = await fixture(t, [a, b, draft, external]);
  for (const [name, bytes] of [
    ["one.jpg", JPEG],
    ["two.jpg", WEBP],
    ["draft.jpg", JPEG],
    ["external.jpg", JPEG],
  ]) {
    await writeFile(resolve(root, "images/fotos", name), bytes);
  }
  const result = await stagePublishedStaticMedia({ root, output });
  assert.equal(result.count, 2);
  assert.deepEqual((await readdir(resolve(output, "fotos"))).sort(), [
    "one.jpg",
    "two.jpg",
  ]);
  assert.deepEqual(await readFile(resolve(output, "fotos/two.jpg")), WEBP);
});

for (const [description, overrides, error] of [
  [
    "path traversal",
    { providerReference: "/images/fotos/../private.jpg" },
    /PUBLISHED_MEDIA_REFERENCE_INVALID/u,
  ],
  [
    "wrong checksum",
    { checksumSha256: "0".repeat(64) },
    /PUBLISHED_MEDIA_CHECKSUM_MISMATCH/u,
  ],
  [
    "wrong size",
    { byteSize: JPEG.length + 1 },
    /PUBLISHED_MEDIA_SIZE_MISMATCH/u,
  ],
  [
    "wrong declared content",
    { mimeType: "image/webp" },
    /PUBLISHED_MEDIA_TYPE_MISMATCH/u,
  ],
  [
    "unsafe extension",
    { providerReference: "/images/fotos/one.png" },
    /PUBLISHED_MEDIA_EXTENSION_MISMATCH/u,
  ],
  [
    "unknown publication state",
    { publicationState: "pending" },
    /PUBLISHED_MEDIA_STATE_INVALID/u,
  ],
]) {
  test(`rejects ${description} before creating output`, async (t) => {
    const entry = asset("one.jpg", JPEG, overrides);
    const { root, output } = await fixture(t, [entry]);
    await writeFile(resolve(root, "images/fotos/one.jpg"), JPEG);
    await assert.rejects(stagePublishedStaticMedia({ root, output }), error);
    await assert.rejects(readdir(output), { code: "ENOENT" });
  });
}

test("rejects a symlink even if it points to bytes with the expected checksum", async (t) => {
  const { root, output } = await fixture(t, [asset("one.jpg", JPEG)]);
  const outside = resolve(root, "outside.jpg");
  await writeFile(outside, JPEG);
  await symlink(outside, resolve(root, "images/fotos/one.jpg"));
  await assert.rejects(
    stagePublishedStaticMedia({ root, output }),
    /PUBLISHED_MEDIA_FILE_INVALID/u,
  );
  await assert.rejects(readdir(output), { code: "ENOENT" });
});

test("does not replace an existing output directory", async (t) => {
  const { root, output } = await fixture(t, [asset("one.jpg", JPEG)]);
  await writeFile(resolve(root, "images/fotos/one.jpg"), JPEG);
  await mkdir(output);
  await writeFile(resolve(output, "untouched"), "keep");
  await assert.rejects(stagePublishedStaticMedia({ root, output }), {
    code: "EEXIST",
  });
  assert.equal(await readFile(resolve(output, "untouched"), "utf8"), "keep");
});

test("allows an empty published catalog without copying draft images", async (t) => {
  const { root, output } = await fixture(t, [
    asset("draft.jpg", JPEG, { publicationState: "draft" }),
  ]);
  await writeFile(resolve(root, "images/fotos/draft.jpg"), JPEG);
  const result = await stagePublishedStaticMedia({ root, output });
  assert.equal(result.count, 0);
  assert.deepEqual(await readdir(resolve(output, "fotos")), []);
});

test("the current published manifest stages every referenced file and no other images", async (t) => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "published-media-current-"),
  );
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = resolve(directory, "selected");
  const entries = (await readFile(resolve(repositoryRoot, MANIFEST), "utf8"))
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const expected = entries
    .flatMap((entry) => entry.assets)
    .filter(
      (item) =>
        item.provider === "legacy-static" &&
        item.publicationState === "published",
    )
    .map((item) => item.providerReference.split("/").at(-1))
    .sort();
  const result = await stagePublishedStaticMedia({
    root: repositoryRoot,
    output,
  });
  assert.equal(result.count, expected.length);
  assert.deepEqual((await readdir(resolve(output, "fotos"))).sort(), expected);
});
