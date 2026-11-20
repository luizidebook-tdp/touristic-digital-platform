import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Control Center shell source contract", { timeout: 600_000 }, () => {
  const env = { ...process.env, CLICOLOR: "0", NO_COLOR: "1" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@touristic/morro-digital-platform",
      "exec",
      "vitest",
      "run",
      "src/ux/control-center-shell-sidebar-v1-contract.test.ts",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 600_000,
    },
  );

  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    [
      "Vitest shell contract failed.",
      result.stdout ?? "",
      result.stderr ?? "",
    ].join("\n"),
  );
});
