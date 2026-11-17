import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST =
  "apps/morro-digital-platform/src/migration/legacy-commercial-media-mappings.ndjson";
const REFERENCE =
  /^\/images\/fotos\/[a-z0-9][a-z0-9_-]*\.(?:jpg|jpeg|png|webp)$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_BYTES = 12 * 1024 * 1024;

function contentType(bytes) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return "image/png";
  }
  throw new Error("PUBLISHED_MEDIA_UNSUPPORTED_CONTENT");
}

/** Build-time snapshot, not an authorization check for subsequent requests. */
export async function stagePublishedStaticMedia({ root, output }) {
  const repoRoot = await realpath(resolve(root));
  const photosRoot = await realpath(resolve(repoRoot, "images/fotos"));
  assert.ok(
    photosRoot.startsWith(`${repoRoot}${sep}`),
    "PUBLISHED_MEDIA_ROOT_ESCAPE",
  );
  const outputRoot = resolve(output);
  const manifestText = await readFile(resolve(repoRoot, MANIFEST), "utf8");
  const entries = manifestText
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const selected = [];
  const names = new Set();
  const ids = new Set();

  for (const entry of entries) {
    assert.ok(Array.isArray(entry.assets), "PUBLISHED_MEDIA_ASSETS_INVALID");
    for (const asset of entry.assets) {
      assert.ok(
        asset && typeof asset === "object",
        "PUBLISHED_MEDIA_ASSET_INVALID",
      );
      assert.ok(
        ["published", "draft"].includes(asset.publicationState),
        "PUBLISHED_MEDIA_STATE_INVALID",
      );
      if (
        asset.publicationState !== "published" ||
        asset.provider !== "legacy-static"
      )
        continue;
      assert.match(
        asset.providerReference ?? "",
        REFERENCE,
        "PUBLISHED_MEDIA_REFERENCE_INVALID",
      );
      assert.match(
        asset.checksumSha256 ?? "",
        HASH,
        "PUBLISHED_MEDIA_CHECKSUM_INVALID",
      );
      assert.ok(
        typeof asset.mediaId === "string" && asset.mediaId.length > 0,
        "PUBLISHED_MEDIA_ID_INVALID",
      );
      const name = basename(asset.providerReference);
      const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
      const validExtension = {
        "image/jpeg": [".jpg", ".jpeg"],
        "image/webp": [".jpg", ".jpeg", ".webp"],
        "image/png": [".png"],
      };
      assert.ok(
        validExtension[asset.mimeType]?.includes(extension),
        "PUBLISHED_MEDIA_EXTENSION_MISMATCH",
      );
      assert.ok(
        !names.has(name) && !ids.has(asset.mediaId),
        "PUBLISHED_MEDIA_DUPLICATE",
      );
      names.add(name);
      ids.add(asset.mediaId);
      const file = resolve(photosRoot, name);
      assert.ok(
        file.startsWith(`${photosRoot}${sep}`),
        "PUBLISHED_MEDIA_PATH_ESCAPE",
      );
      const stat = await lstat(file);
      assert.ok(
        stat.isFile() && !stat.isSymbolicLink(),
        "PUBLISHED_MEDIA_FILE_INVALID",
      );
      const actualPath = await realpath(file);
      assert.ok(
        actualPath.startsWith(`${photosRoot}${sep}`),
        "PUBLISHED_MEDIA_PATH_ESCAPE",
      );
      assert.ok(
        Number.isSafeInteger(asset.byteSize) &&
          asset.byteSize > 0 &&
          asset.byteSize <= MAX_BYTES,
        "PUBLISHED_MEDIA_SIZE_INVALID",
      );
      assert.equal(stat.size, asset.byteSize, "PUBLISHED_MEDIA_SIZE_MISMATCH");
      const bytes = await readFile(actualPath);
      assert.equal(
        bytes.length,
        asset.byteSize,
        "PUBLISHED_MEDIA_SIZE_MISMATCH",
      );
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        asset.checksumSha256,
        "PUBLISHED_MEDIA_CHECKSUM_MISMATCH",
      );
      assert.equal(
        contentType(bytes),
        asset.mimeType,
        "PUBLISHED_MEDIA_TYPE_MISMATCH",
      );
      selected.push({ name, bytes });
    }
  }
  // The output is newly created only after every asset passed validation.
  // Never remove or replace an existing destination owned by another caller.
  await mkdir(outputRoot);
  try {
    const photos = resolve(outputRoot, "fotos");
    await mkdir(photos);
    for (const item of selected)
      await writeFile(resolve(photos, item.name), item.bytes, { flag: "wx" });
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    count: selected.length,
    names: Object.freeze(selected.map((item) => item.name)),
  });
}

const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const [, , root, output] = process.argv;
  if (!root || !output || process.argv.length !== 4) {
    throw new Error("PUBLISHED_MEDIA_ARGUMENTS_INVALID");
  }
  const result = await stagePublishedStaticMedia({ root, output });
  process.stdout.write(`${JSON.stringify({ count: result.count })}\n`);
}
