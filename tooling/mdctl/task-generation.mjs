#!/usr/bin/env node
import assert from "node:assert/strict";
import prettier from "prettier";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  lstatSync,
  existsSync,
  realpathSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi } from "../control-state/status.mjs";
import {
  canonicalJson,
  changeSetDigest,
  validateChangeSetV2,
} from "./changeset-v2.mjs";
import { buildClaimReanchor } from "./claim-lifecycle.mjs";
import {
  buildClaimGuardProof,
  findClaimCollisions,
} from "../fabric/claim-guard.mjs";
import {
  createLeaseRegistry,
  validateLeaseRegistry,
} from "./capability-leases.mjs";
import {
  buildTaskStart,
  buildTaskTest,
  buildTaskSubmit,
  validateTaskContext,
  validateTaskLocalProof,
} from "./task-lifecycle.mjs";

export const GENERATION_REPOSITORY =
  "luizidebook-tdp/touristic-digital-platform";
const RP = ".github/morro-control/claims.json";
const EP = ".github/morro-control/events.ndjson";
const ENTRY = "tooling/mdctl/task-generation.mjs";
const SHA = /^[a-f0-9]{40}$/u;
const check = (v, code) => assert.ok(v, "GENERATION_" + code);
const same = (a, b, code) => assert.deepEqual(a, b, "GENERATION_" + code);
const hash = (v) => createHash("sha256").update(v).digest("hex");
export const generationDigest = (v) => hash(canonicalJson(v));
const bytes = (v) => JSON.stringify(v, null, 2) + "\n";
const pretty = (v) => prettier.format(bytes(v), { parser: "json" });
const git = (root, ...args) =>
  execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
const at = (root, sha, path) =>
  execFileSync("git", ["-C", root, "show", sha + ":" + path], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
const json = (path) => JSON.parse(regular(path));
function regular(path) {
  const stat = lstatSync(path);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024,
    "REGULAR_FILE_REQUIRED",
  );
  return readFileSync(path, "utf8");
}
function identity(root, base) {
  return {
    branch: git(root, "branch", "--show-current"),
    headSha: git(root, "rev-parse", "HEAD"),
    treeSha: git(root, "rev-parse", "HEAD^{tree}"),
    dirty: git(root, "status", "--porcelain", "--untracked-files=all") !== "",
    baseIsAncestor: git(root, "merge-base", base, "HEAD") === base,
  };
}
function stateDirectory(root) {
  const parent = realpathSync(
    resolve(root, git(root, "rev-parse", "--git-dir")),
  );
  const state = join(parent, "morro-control");
  if (lstatSync(state, { throwIfNoEntry: false }))
    check(
      lstatSync(state).isDirectory() && !lstatSync(state).isSymbolicLink(),
      "STATE_DIRECTORY",
    );
  return state;
}
function sourceFiles(root, id) {
  const directory = stateDirectory(root);
  return [
    id + ".task.json",
    id + ".context-pack.json",
    id + ".handoff.json",
    "capability-leases.json",
  ].map((name) => {
    const path = join(directory, name);
    const content = lstatSync(path, { throwIfNoEntry: false })
      ? regular(path)
      : null;
    return { name, content, sha256: content === null ? null : hash(content) };
  });
}
function noActiveLeases(registry, now) {
  validateLeaseRegistry(registry);
  for (const lease of Object.values(registry.leases))
    check(
      !(lease.state === "ACTIVE" && Date.parse(lease.expiresAt) > now),
      "ACTIVE_PREDECESSOR_LEASE",
    );
}
function sourceMode(root, manifest, files, executor, now) {
  const values = files.map((f) =>
    f.content === null ? null : JSON.parse(f.content),
  );
  const [task, contextPack, handoff, leases] = values;
  if (files[3].content !== null) noActiveLeases(leases, now);
  if (files.slice(0, 3).every((file) => file.content === null))
    return "MISSING";
  if (task && contextPack && leases) {
    const historical = JSON.parse(
      at(root, task.candidateSha, ".morro/changesets/" + manifest.id + ".json"),
    );
    check(
      task.changeSetId === manifest.id &&
        task.branch === manifest.branch &&
        task.owner === executor,
      "HISTORY_IDENTITY",
    );
    check(
      git(root, "merge-base", task.candidateSha, "HEAD") === task.candidateSha,
      "HISTORY_NOT_ANCESTOR",
    );
    same(
      task.changeSetDigest,
      changeSetDigest(historical),
      "HISTORICAL_MANIFEST_DIGEST",
    );
    if (task.state !== "SUBMITTED")
      validateTaskContext({
        task,
        changeSet: historical,
        leaseRegistry: leases,
        contextPack,
      });
    else
      validateSubmitted(
        {
          task,
          contextPack,
          handoff,
          leaseRegistry: leases,
          localProof: task.localProof,
        },
        historical,
        {
          branch: task.branch,
          headSha: task.candidateSha,
          treeSha: git(root, "rev-parse", task.candidateSha + "^{tree}"),
          dirty: false,
          baseIsAncestor: true,
        },
      );
    if (task.state === "SUBMITTED")
      check(Date.parse(task.submittedAt) <= now, "HISTORY_FUTURE_SUBMISSION");
    if (task.state !== "STARTED")
      check(task.localProof, "HISTORY_PROOF_REQUIRED");
    if (task.localProof)
      validateTaskLocalProof({
        proof: task.localProof,
        task,
        changeSet: historical,
      });
    check(
      ["STARTED", "LOCAL_PROVEN", "SUBMITTED"].includes(task.state),
      "HISTORY_STATE",
    );
    return "HISTORY";
  }
  throw new Error("GENERATION_HISTORY_REQUIRED");
}

// Transport injection is for deterministic provider fixtures. The operational
// CLI below has no injection flag and verifies its canonical entrypoint first.
export async function captureGeneration(
  options,
  { api = githubApi, clock = Date.now } = {},
) {
  const { workspace: input, mainSha, prNumber, executor } = options;
  check(
    SHA.test(mainSha) && Number.isSafeInteger(prNumber) && prNumber > 0,
    "ARGUMENT_IDENTITY",
  );
  check(/^[A-Za-z0-9._:@/-]{1,120}$/u.test(executor ?? ""), "EXECUTOR");
  const workspace = realpathSync(input);
  same(
    git(workspace, "rev-parse", "--show-toplevel"),
    workspace,
    "WORKSPACE_TOPLEVEL",
  );
  const remote = "repos/" + GENERATION_REPOSITORY;
  const main = await api(remote + "/commits/main");
  same(main.sha, mainSha, "MAIN_MOVED");
  const observed = identity(workspace, mainSha);
  check(!observed.dirty && observed.baseIsAncestor, "WORKSPACE_IDENTITY");
  const pull = await api(remote + "/pulls/" + prNumber);
  check(pull.state === "open", "PR_NOT_OPEN");
  check(
    pull.number === prNumber &&
      pull.head?.repo?.full_name === GENERATION_REPOSITORY &&
      pull.base?.repo?.full_name === GENERATION_REPOSITORY &&
      pull.base.ref === "main" &&
      pull.head.ref === observed.branch,
    "PR_IDENTITY",
  );
  const ref = await api(
    remote + "/git/ref/heads/" + encodeURIComponent(observed.branch),
  );
  same(ref.object?.sha, pull.head.sha, "REMOTE_BRANCH_MOVED");
  check(
    git(workspace, "merge-base", ref.object.sha, observed.headSha) ===
      ref.object.sha,
    "REMOTE_HEAD_NOT_ANCESTOR",
  );
  const registry = JSON.parse(at(workspace, mainSha, RP));
  const entries = Object.entries(registry.claims).filter(
    ([, c]) => c.branch === observed.branch,
  );
  check(entries.length === 1, "CLAIM_RESOLUTION");
  const [id, claim] = entries[0];
  const mp = ".morro/changesets/" + id + ".json";
  const canonicalManifest = JSON.parse(at(workspace, mainSha, mp));
  const manifest = json(join(workspace, mp));
  validateChangeSetV2(manifest);
  const now = clock();
  check(
    claim.owner === "CHATGPT-PRO-CONTROL" &&
      claim.reviewer === "AUTOMATED-INDEPENDENT-PROOF" &&
      claim.status === "IMPLEMENTING" &&
      Date.parse(claim.expiresAt) > now,
    "CLAIM_AUTHORITY",
  );
  same(
    {
      ...manifest,
      baseSha: canonicalManifest.baseSha,
      state: canonicalManifest.state,
    },
    canonicalManifest,
    "MANIFEST_SCOPE_CHANGED",
  );
  same([...claim.paths].sort(), [...manifest.owns.paths].sort(), "CLAIM_SCOPE");
  same(findClaimCollisions(registry, id, now), [], "CLAIM_COLLISION");
  buildClaimGuardProof(workspace, {
    EXPECTED_CANDIDATE_SHA: observed.headSha,
    EXPECTED_BASE_SHA: mainSha,
    EXPECTED_BRANCH: observed.branch,
    MANIFEST_PATH: mp,
    CLAIM_GUARD_AUTHORITY: "ORCHESTRATOR",
  });
  const files = sourceFiles(workspace, id);
  const mode = sourceMode(workspace, manifest, files, executor, now);
  same((await api(remote + "/commits/main")).sha, mainSha, "MAIN_MOVED");
  return {
    workspace,
    mainSha,
    prNumber,
    executor,
    observed,
    id,
    claim,
    manifest,
    mp,
    files,
    mode,
    now,
    providerIdentity: {
      number: pull.number,
      state: pull.state,
      base: { ref: pull.base.ref, repository: pull.base.repo.full_name },
      head: {
        ref: pull.head.ref,
        sha: pull.head.sha,
        repository: pull.head.repo.full_name,
      },
      refSha: ref.object.sha,
      mergedAt: pull.merged_at ?? null,
      mergeCommitSha: pull.merge_commit_sha ?? null,
    },
  };
}

export function generationRequest(capture, nonce = randomUUID()) {
  check(["HISTORY", "MISSING"].includes(capture.mode), "HISTORY_REQUIRED");
  return {
    schemaVersion: 1,
    kind: "TDP_TASK_GENERATION_REQUEST",
    repository: GENERATION_REPOSITORY,
    claimId: capture.id,
    claimDigest: generationDigest(capture.claim),
    mainSha: capture.mainSha,
    candidateSha: capture.observed.headSha,
    treeSha: capture.observed.treeSha,
    branch: capture.observed.branch,
    prNumber: capture.prNumber,
    providerIdentity: capture.providerIdentity,
    executor: capture.executor,
    workspace: capture.workspace,
    mode: capture.mode,
    history: capture.files.map(({ name, sha256 }) => ({ name, sha256 })),
    authority:
      capture.mode === "MISSING"
        ? "OWNER_ATTESTED_NO_OTHER_WRITERS"
        : "CANONICAL_CLAIM_AND_TASK_HISTORY",
    ...(capture.mode === "MISSING"
      ? {
          missingHistoryAcknowledged: true,
          noOtherWritersAttested: true,
          historyNotRetroactivelyRestored: true,
        }
      : {}),
    nonce,
    issuedAt: new Date(capture.now).toISOString(),
    expiresAt: new Date(
      Math.min(capture.now + 1800000, Date.parse(capture.claim.expiresAt)),
    ).toISOString(),
  };
}
function validateRequest(request, capture) {
  check(/^[a-f0-9-]{32,36}$/u.test(request.nonce ?? ""), "NONCE");
  const issued = Date.parse(request.issuedAt),
    expiry = Date.parse(request.expiresAt);
  check(
    Number.isFinite(issued) &&
      Number.isFinite(expiry) &&
      issued <= capture.now &&
      capture.now < expiry &&
      expiry <= issued + 1800000 &&
      expiry <= Date.parse(capture.claim.expiresAt),
    "REQUEST_EXPIRED",
  );
  same(
    request,
    {
      ...generationRequest(capture, request.nonce),
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
    },
    "REQUEST_CHANGED",
  );
}
const normalizeOwnerDecision = (value) => ({
  ...value,
  pin: value?.pin ?? null,
});
export async function verifyGenerationOwner(
  request,
  { api = githubApi, clock = Date.now } = {},
) {
  check(
    request.mode === "MISSING" &&
      request.authority === "OWNER_ATTESTED_NO_OTHER_WRITERS" &&
      request.missingHistoryAcknowledged === true &&
      request.noOtherWritersAttested === true &&
      request.historyNotRetroactivelyRestored === true,
    "OWNER_ATTESTATION_REQUIRED",
  );
  check(
    Date.parse(request.issuedAt) <= clock() &&
      clock() < Date.parse(request.expiresAt),
    "REQUEST_EXPIRED",
  );
  const suffix = `${request.claimId}:${generationDigest(request)}:${request.nonce}:${request.mainSha}`;
  const approval = "APPROVED_TASK_GENERATION:" + suffix;
  const revocation = "REVOKED_TASK_GENERATION:" + suffix;
  return readPersonalOwnerDecision(
    { ...request, approval, revocation },
    { api, clock },
  );
}
async function readPersonalOwnerDecision(request, { api, clock }) {
  const { approval, revocation } = request;
  const remote = "repos/" + GENERATION_REPOSITORY;
  const repo = await api(remote);
  check(
    repo.full_name === GENERATION_REPOSITORY &&
      repo.owner?.type === "User" &&
      Number.isSafeInteger(repo.owner.id) &&
      repo.owner.id > 0 &&
      repo.owner.login === GENERATION_REPOSITORY.split("/")[0],
    "REPOSITORY_OWNER",
  );
  async function readDecision() {
    const found = [];
    for (let page = 1; page <= 10; page++) {
      const comments = await api(
        `${remote}/issues/${request.prNumber}/comments?per_page=100&page=${page}`,
      );
      check(Array.isArray(comments) && comments.length <= 100, "COMMENT_PAGE");
      for (const comment of comments) {
        if (![approval, revocation].includes(comment.body)) continue;
        check(
          comment.user?.id === repo.owner.id &&
            comment.user.login === repo.owner.login &&
            comment.user.type === "User" &&
            comment.author_association === "OWNER" &&
            comment.performed_via_github_app === null,
          "OWNER_COMMENT_IDENTITY",
        );
        check(comment.body !== revocation, "OWNER_REVOKED");
        check(
          Number.isSafeInteger(comment.id) &&
            comment.id > 0 &&
            comment.created_at === comment.updated_at,
          "OWNER_COMMENT_EDITED",
        );
        check(
          comment.issue_url ===
            `https://api.github.com/${remote}/issues/${request.prNumber}` &&
            comment.html_url ===
              `https://github.com/${GENERATION_REPOSITORY}/pull/${request.prNumber}#issuecomment-${comment.id}`,
          "OWNER_COMMENT_TARGET",
        );
        const created = Date.parse(comment.created_at);
        check(
          created >= Date.parse(request.issuedAt) &&
            created <= clock() &&
            clock() - created <= 1800000,
          "OWNER_COMMENT_EXPIRED",
        );
        found.push(comment);
      }
      if (comments.length < 100) {
        check(found.length === 1, "OWNER_DECISION_REQUIRED");
        return found[0];
      }
    }
    throw new Error("GENERATION_COMMENT_PAGINATION_LIMIT");
  }
  const first = normalizeOwnerDecision(await readDecision());
  same(
    normalizeOwnerDecision(await api(`${remote}/issues/comments/${first.id}`)),
    first,
    "OWNER_COMMENT_CHANGED",
  );
  same(
    normalizeOwnerDecision(await readDecision()),
    first,
    "OWNER_COMMENT_CHANGED",
  );
  return first;
}
async function preserveOwnerDecision(request, decision, dependencies) {
  if (request.mode === "MISSING")
    same(
      await verifyGenerationOwner(request, dependencies),
      normalizeOwnerDecision(decision),
      "OWNER_COMMENT_CHANGED",
    );
  else same(decision, null, "JOURNAL_AUTHORITY");
}
function durable(path, content, exclusive = true) {
  const temporary = exclusive ? path : path + ".tmp-" + randomUUID();
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!exclusive) renameSync(temporary, path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
function generationPaths(capture, request) {
  const state = stateDirectory(capture.workspace);
  const generations = join(state, "generations");
  if (existsSync(generations))
    check(
      realpathSync(generations) === generations &&
        lstatSync(generations).isDirectory(),
      "GENERATION_DIRECTORY",
    );
  const common = realpathSync(
    resolve(
      capture.workspace,
      git(capture.workspace, "rev-parse", "--git-common-dir"),
    ),
  );
  return {
    directory: join(generations, request.nonce),
    lock: join(common, "task-generation.lock"),
  };
}
function preserveSource(capture) {
  same(
    sourceFiles(capture.workspace, capture.id),
    capture.files,
    "SOURCE_HISTORY_CHANGED",
  );
}
function preserveJournal(directory, expected) {
  check(
    realpathSync(directory) === directory && lstatSync(directory).isDirectory(),
    "GENERATION_DIRECTORY",
  );
  for (const [name, content] of Object.entries(expected))
    same(regular(join(directory, name)), content, "JOURNAL_CHANGED");
}
function appendJournal(directory, journal, name, value) {
  preserveJournal(directory, journal);
  journal[name] = bytes(value);
  durable(join(directory, name), journal[name]);
  preserveJournal(directory, journal);
}
function verifyFiles(root, expected, code) {
  for (const [path, content] of Object.entries(expected))
    same(regular(join(root, path)), content, code);
}
function sameCapture(current, capture) {
  same(current.observed, capture.observed, "FINAL_CANDIDATE_MOVED");
  same(current.manifest, capture.manifest, "FINAL_MANIFEST_MOVED");
  same(current.providerIdentity, capture.providerIdentity, "PROVIDER_CHANGED");
}
function finalFence(capture, request, clock) {
  preserveSource(capture);
  check(clock() < Date.parse(request.expiresAt), "REQUEST_EXPIRED");
  check(
    clock() < Date.parse(capture.claim.expiresAt),
    "CLAIM_EXPIRED_DURING_PROOF",
  );
  same(
    identity(capture.workspace, capture.mainSha),
    capture.observed,
    "FINAL_CANDIDATE_MOVED",
  );
}
async function terminalCapture(
  options,
  capture,
  request,
  decision,
  dependencies,
) {
  const { clock } = dependencies;
  const current = await captureGeneration(options, dependencies);
  sameCapture(current, capture);
  await preserveOwnerDecision(request, decision, dependencies);
  finalFence(capture, request, clock);
  return current;
}
export async function runGenerationProofCommand(workspace, command) {
  // Nested proofs must run without the parent's Node test-runner marker.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, command.argv.slice(1), {
    cwd: workspace,
    encoding: "utf8",
    timeout: command.timeoutSeconds * 1000,
    maxBuffer: 4 * 1024 * 1024,
    env,
  });
  return {
    status: result.status === 0 && !result.error ? "PASS" : "FAIL",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
async function boundedProof(capture, manifest, registry, clock) {
  const initial = identity(capture.workspace, manifest.baseSha);
  same(initial, capture.observed, "FINAL_CANDIDATE_MOVED");
  const shared = {
    changeSet: manifest,
    identity: initial,
    now: () => new Date(clock()).toISOString(),
  };
  const started = buildTaskStart({
    ...shared,
    owner: capture.executor,
    leaseRegistry: registry,
  });
  const active = { ...shared, leaseRegistry: started.leaseRegistry };
  const tested = await buildTaskTest({
    ...active,
    task: started.task,
    commandRunner: (command) =>
      runGenerationProofCommand(capture.workspace, command),
  });
  same(
    identity(capture.workspace, manifest.baseSha),
    initial,
    "CANDIDATE_CHANGED_DURING_PROOF",
  );
  const submitted = buildTaskSubmit({ ...active, task: tested.task });
  return {
    ...submitted,
    contextPack: tested.contextPack,
    localProof: tested.task.localProof,
  };
}

function validateSubmitted(record, manifest, identity, prior) {
  const { task, contextPack, localProof, leaseRegistry } = record;
  check(
    Date.parse(task.startedAt) <= Date.parse(localProof.completedAt) &&
      Date.parse(localProof.completedAt) <= Date.parse(task.submittedAt),
    "HISTORY_PROOF_TIME",
  );
  const historical = structuredClone(leaseRegistry);
  if (!prior)
    for (const id of task.leaseIds) {
      const lease = historical.leases[id];
      same(lease.state, "RELEASED", "HISTORY_RELEASED_LEASE");
      check(
        Date.parse(lease.issuedAt) <= Date.parse(task.startedAt),
        "HISTORY_LEASE_TIME",
      );
      lease.state = "ACTIVE";
    }
  const ids = [...task.leaseIds];
  const started = buildTaskStart({
    changeSet: manifest,
    owner: task.owner,
    identity,
    leaseRegistry: prior ?? historical,
    now: task.startedAt,
    idFactory: () => ids.shift()?.replace(/^lease-/u, ""),
  });
  const active = {
    changeSet: manifest,
    identity,
    leaseRegistry: started.leaseRegistry,
  };
  const tested = {
    ...started.task,
    state: "LOCAL_PROVEN",
    testedAt: localProof.completedAt,
    contextPackDigest: contextPack.digest,
    localProof,
  };
  validateTaskContext({ ...active, task: tested, contextPack });
  const submitted = buildTaskSubmit({
    task: tested,
    ...active,
    now: task.submittedAt,
  });
  for (const id of task.leaseIds)
    same(
      leaseRegistry.leases[id],
      submitted.leaseRegistry.leases[id],
      "HISTORY_RELEASED_LEASE",
    );
  same(
    record,
    {
      ...submitted,
      leaseRegistry: prior ? submitted.leaseRegistry : leaseRegistry,
      contextPack,
      localProof,
    },
    "JOURNAL_PROOF_IDENTITY",
  );
}

async function metadataProjection(capture, preimages, projectedAt) {
  const transition =
    capture.manifest.baseSha === capture.mainSha
      ? {
          registry: JSON.parse(preimages[RP]),
          ledgerText: preimages[EP],
          manifest: capture.manifest,
        }
      : buildClaimReanchor({
          registry: JSON.parse(preimages[RP]),
          ledgerText: preimages[EP],
          manifest: capture.manifest,
          newBaseSha: capture.mainSha,
          observedAt: projectedAt,
          reason: "PROVEN_TASK_GENERATION_REANCHOR",
        });
  const proven = { ...transition.manifest, state: "LOCAL_PROVEN" };
  return {
    [RP]: await pretty(transition.registry),
    [EP]: transition.ledgerText,
    [capture.mp]: await pretty(proven),
  };
}
async function validateJournal(capture, nonce, intent, prepared, preliminary) {
  const request = intent.request;
  same(request.nonce, nonce, "JOURNAL_NONCE");
  same(prepared.state, "PREPARED_REQUIRES_FINAL_PROOF", "JOURNAL_STATE");
  same(prepared.requestDigest, generationDigest(request), "JOURNAL_DIGEST");
  same(
    prepared.preliminaryDigest,
    generationDigest(preliminary),
    "JOURNAL_PROOF_DIGEST",
  );
  same(intent.files, capture.files, "SOURCE_HISTORY_CHANGED");
  const original = {
    ...capture,
    manifest: JSON.parse(
      at(capture.workspace, request.candidateSha, capture.mp),
    ),
    observed: {
      ...capture.observed,
      headSha: request.candidateSha,
      treeSha: git(
        capture.workspace,
        "rev-parse",
        request.candidateSha + "^{tree}",
      ),
    },
  };
  validateRequest(request, original);
  if (request.mode === "HISTORY")
    same(intent.ownerDecision, null, "JOURNAL_AUTHORITY");
  else
    check(Number.isSafeInteger(intent.ownerDecision?.id), "JOURNAL_AUTHORITY");
  const preimages = Object.fromEntries(
    [RP, EP, capture.mp].map((p) => [
      p,
      at(capture.workspace, request.candidateSha, p),
    ]),
  );
  same(intent.preimages, preimages, "JOURNAL_PREIMAGES");
  check(
    Date.parse(prepared.projectedAt) >=
      Date.parse(preliminary.localProof.completedAt) &&
      Date.parse(prepared.projectedAt) <= capture.now &&
      Date.parse(preliminary.task.startedAt) >= Date.parse(request.issuedAt),
    "JOURNAL_TIME",
  );
  same(
    prepared.after,
    await metadataProjection(original, preimages, prepared.projectedAt),
    "JOURNAL_PROJECTION",
  );
  const prior = intent.files[3].content
    ? JSON.parse(intent.files[3].content)
    : createLeaseRegistry();
  validateSubmitted(preliminary, original.manifest, original.observed, prior);
}

async function withGenerationLock(lock, action) {
  mkdirSync(lock);
  const result = await action();
  rmdirSync(lock);
  return result;
}
export async function prepareGeneration(options, request, dependencies = {}) {
  const api = dependencies.api ?? githubApi,
    clock = dependencies.clock ?? Date.now;
  const capture = await captureGeneration(options, { api, clock });
  validateRequest(request, capture);
  const ownerDecision =
    capture.mode === "MISSING"
      ? await verifyGenerationOwner(request, { api, clock })
      : null;
  const paths = generationPaths(capture, request);
  const { directory } = paths;
  check(!existsSync(directory), "NONCE_ALREADY_USED");
  return withGenerationLock(paths.lock, async () => {
    const recaptured = await captureGeneration(options, { api, clock });
    validateRequest(request, recaptured);
    await preserveOwnerDecision(request, ownerDecision, { api, clock });
    finalFence(capture, request, clock);
    await maintenanceFence(
      dependencies.maintenance,
      recaptured,
      "prepare",
      "reserve",
    );
    const preimages = Object.fromEntries(
      [RP, EP, capture.mp].map((p) => [p, regular(join(capture.workspace, p))]),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const journal = {
      "intent.json": bytes({
        request,
        ownerDecision,
        ...(dependencies.maintenance
          ? {
              maintenanceDigest: generationDigest(
                dependencies.maintenance.envelope,
              ),
            }
          : {}),
        files: capture.files,
        preimages,
      }),
    };
    durable(join(directory, "intent.json"), journal["intent.json"]);
    const priorLeases = capture.files.find(
      (f) => f.name === "capability-leases.json",
    ).content;
    const preliminary = await boundedProof(
      capture,
      capture.manifest,
      priorLeases ? JSON.parse(priorLeases) : createLeaseRegistry(),
      clock,
    );
    appendJournal(directory, journal, "preliminary-proof.json", preliminary);
    const terminal = await terminalCapture(
      options,
      capture,
      request,
      ownerDecision,
      { api, clock },
    );
    validateRequest(request, terminal);
    await maintenanceFence(
      dependencies.maintenance,
      terminal,
      "prepare",
      "prewrite",
    );
    const projectedAt = new Date(clock()).toISOString();
    const after = await metadataProjection(capture, preimages, projectedAt);
    if (dependencies.maintenance) {
      same(after[RP], preimages[RP], "MAINTENANCE_REGISTRY_PROJECTION");
      same(after[EP], preimages[EP], "MAINTENANCE_LEDGER_PROJECTION");
      maintenanceTime(dependencies.maintenance, capture);
    }
    finalFence(capture, request, clock);
    verifyFiles(capture.workspace, preimages, "PREIMAGE_CHANGED");
    appendJournal(directory, journal, "prepared.json", {
      state: "PREPARED_REQUIRES_FINAL_PROOF",
      requestDigest: generationDigest(request),
      preliminaryDigest: generationDigest(preliminary),
      projectedAt,
      after,
    });
    for (const [path, content] of Object.entries(after)) {
      preserveJournal(directory, journal);
      preserveSource(capture);
      same(
        regular(join(capture.workspace, path)),
        preimages[path],
        "PREIMAGE_CHANGED",
      );
      if (content !== preimages[path])
        durable(join(capture.workspace, path), content, false);
      same(regular(join(capture.workspace, path)), content, "WRITE_READBACK");
    }
    verifyFiles(capture.workspace, after, "TERMINAL_WRITE_READBACK");
    preserveJournal(directory, journal);
    await maintenanceFinish(
      dependencies.maintenance,
      terminal,
      "prepare",
      () => {
        verifyFiles(capture.workspace, after, "MAINTENANCE_TERMINAL_METADATA");
        preserveJournal(directory, journal);
        preserveSource(capture);
        same(
          execFileSync(
            "git",
            [
              "--no-optional-locks",
              "-C",
              capture.workspace,
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=all",
            ],
            { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
          ),
          " M " + capture.mp + "\0",
          "MAINTENANCE_TERMINAL_SCOPE",
        );
      },
    );
    return {
      state: "PREPARED_REQUIRES_FINAL_PROOF",
      directory: directory,
      candidateSha: capture.observed.headSha,
      published: false,
    };
  });
}

export async function proveGeneration(options, nonce, dependencies = {}) {
  const api = dependencies.api ?? githubApi,
    clock = dependencies.clock ?? Date.now;
  check(/^[a-f0-9-]{32,36}$/u.test(nonce), "NONCE");
  const directory = join(
    stateDirectory(realpathSync(options.workspace)),
    "generations",
    nonce,
  );
  check(
    realpathSync(directory) === directory && lstatSync(directory).isDirectory(),
    "GENERATION_DIRECTORY",
  );
  const journal = Object.fromEntries(
    ["intent.json", "prepared.json", "preliminary-proof.json"].map((name) => [
      name,
      regular(join(directory, name)),
    ]),
  );
  const intent = JSON.parse(journal["intent.json"]),
    prepared = JSON.parse(journal["prepared.json"]);
  const request = intent.request;
  if (intent.maintenanceDigest !== undefined) {
    check(
      maintenanceSessions.has(dependencies.maintenance),
      "MAINTENANCE_ADMISSION_REQUIRED",
    );
    same(
      intent.maintenanceDigest,
      generationDigest(dependencies.maintenance.envelope),
      "MAINTENANCE_JOURNAL_BINDING",
    );
  } else
    check(
      dependencies.maintenance === undefined,
      "MAINTENANCE_JOURNAL_REQUIRED",
    );
  const preliminary = JSON.parse(journal["preliminary-proof.json"]);
  const capture = await captureGeneration(options, { api, clock });
  await validateJournal(capture, nonce, intent, prepared, preliminary);
  check(
    capture.observed.headSha !== request.candidateSha &&
      git(capture.workspace, "merge-base", request.candidateSha, "HEAD") ===
        request.candidateSha,
    "FINAL_COMMIT_REQUIRED",
  );
  verifyFiles(capture.workspace, prepared.after, "PREPARED_METADATA_CHANGED");
  // Material changes after the preliminary proof are allowed only inside the
  // existing claim, and are tested again here. No preliminary result is reused.
  await preserveOwnerDecision(request, intent.ownerDecision, { api, clock });
  const paths = generationPaths(capture, request);
  check(!existsSync(join(directory, "final-proof.json")), "FINAL_PROOF_EXISTS");
  return withGenerationLock(paths.lock, async () => {
    await preserveOwnerDecision(request, intent.ownerDecision, { api, clock });
    const recaptured = await captureGeneration(options, { api, clock });
    sameCapture(recaptured, capture);
    await maintenanceFence(
      dependencies.maintenance,
      recaptured,
      "prove",
      "prewrite",
    );
    preserveJournal(directory, journal);
    await validateJournal(recaptured, nonce, intent, prepared, preliminary);
    const final = await boundedProof(
      capture,
      capture.manifest,
      preliminary.leaseRegistry,
      clock,
    );
    const terminal = await terminalCapture(
      options,
      capture,
      request,
      intent.ownerDecision,
      { api, clock },
    );
    await validateJournal(terminal, nonce, intent, prepared, preliminary);
    await maintenanceFence(
      dependencies.maintenance,
      terminal,
      "prove",
      "prewrite",
    );
    finalFence(capture, request, clock);
    appendJournal(directory, journal, "final-proof.json", {
      ...(dependencies.maintenance
        ? {
            maintenanceDigest: generationDigest(
              dependencies.maintenance.envelope,
            ),
          }
        : {}),
      state: dependencies.maintenance
        ? "MAINTENANCE_PROOF_REQUIRES_RECEIPT"
        : "FINAL_PROVEN",
      requestDigest: generationDigest(request),
      mainSha: capture.mainSha,
      candidateSha: capture.observed.headSha,
      treeSha: capture.observed.treeSha,
      ...final,
    });
    await maintenanceFinish(dependencies.maintenance, terminal, "prove", () => {
      same(
        identity(capture.workspace, capture.mainSha),
        capture.observed,
        "MAINTENANCE_TERMINAL_IDENTITY",
      );
      verifyFiles(
        capture.workspace,
        prepared.after,
        "MAINTENANCE_TERMINAL_METADATA",
      );
      preserveJournal(directory, journal);
      preserveSource(capture);
    });
    return {
      state: dependencies.maintenance
        ? "MAINTENANCE_FINAL_PROVEN"
        : "FINAL_PROVEN",
      directory,
      mainSha: capture.mainSha,
      candidateSha: capture.observed.headSha,
      treeSha: capture.observed.treeSha,
      ...(dependencies.maintenance
        ? {
            maintenanceReceipt: maintenancePaths(dependencies.maintenance)
              .complete,
          }
        : {}),
      localProofDigest: final.localProof.digest,
      remoteProofAccepted: false,
    };
  });
}

// Narrow, explicit admission for the repository-identity repair only. This is
// not an override for ordinary generation and does not authorize merge/deploy.
const MAINTENANCE = Object.freeze({
  claimId: "MD-TASK-GENERATION-REPOSITORY-20261114",
  branch: "infra/acquire-task-generation-repository-20261114",
  prNumber: 23,
  legacyEntryBlob: "406ed48a403fb2aaefd71021f900a459c94108e5",
});
const maintenanceSessions = new WeakSet();
function closed(value, keys, code) {
  check(value && Object.getPrototypeOf(value) === Object.prototype, code);
  same(Object.keys(value).sort(), [...keys].sort(), code);
}
function maintenanceShape(envelope, clock) {
  closed(
    envelope,
    [
      "schemaVersion",
      "kind",
      "repository",
      "claimId",
      "prNumber",
      "generationRequest",
      "executorSha",
      "executorTree",
      "executorPath",
      "executorSourceSha256",
      "noOtherWritersAttested",
      "unintegratedExecutorAcknowledged",
      "issuedAt",
      "expiresAt",
      "nonce",
    ],
    "MAINTENANCE_SHAPE",
  );
  const r = envelope.generationRequest;
  check(r && r.mode === "HISTORY", "MAINTENANCE_HISTORY_ONLY");
  same(envelope.schemaVersion, 1, "MAINTENANCE_VERSION");
  same(envelope.kind, "TDP_REPOSITORY_REPAIR_MAINTENANCE", "MAINTENANCE_KIND");
  same(envelope.repository, GENERATION_REPOSITORY, "MAINTENANCE_REPOSITORY");
  same(envelope.claimId, MAINTENANCE.claimId, "MAINTENANCE_CLAIM");
  same(envelope.prNumber, MAINTENANCE.prNumber, "MAINTENANCE_PR");
  same(r.repository, envelope.repository, "MAINTENANCE_REPOSITORY");
  same(r.claimId, envelope.claimId, "MAINTENANCE_CLAIM");
  same(r.prNumber, envelope.prNumber, "MAINTENANCE_PR");
  same(r.branch, MAINTENANCE.branch, "MAINTENANCE_BRANCH");
  same(
    r.authority,
    "CANONICAL_CLAIM_AND_TASK_HISTORY",
    "MAINTENANCE_AUTHORITY",
  );
  same(
    envelope.noOtherWritersAttested,
    true,
    "MAINTENANCE_WRITERS_ATTESTATION",
  );
  same(
    envelope.unintegratedExecutorAcknowledged,
    true,
    "MAINTENANCE_SOURCE_ACK",
  );
  for (const name of ["executorSha", "executorTree"])
    check(SHA.test(envelope[name]), "MAINTENANCE_SHA");
  check(
    /^[a-f0-9]{64}$/u.test(envelope.executorSourceSha256),
    "MAINTENANCE_SOURCE_DIGEST",
  );
  same(envelope.executorSha, r.candidateSha, "MAINTENANCE_EXECUTOR_CANDIDATE");
  same(envelope.executorTree, r.treeSha, "MAINTENANCE_EXECUTOR_TREE");
  same(envelope.nonce, r.nonce, "MAINTENANCE_NONCE");
  check(/^[a-f0-9-]{32,36}$/u.test(envelope.nonce), "MAINTENANCE_NONCE");
  for (const k of ["issuedAt", "expiresAt"]) {
    check(
      typeof envelope[k] === "string" &&
        Number.isFinite(Date.parse(envelope[k])),
      "MAINTENANCE_TIME",
    );
    same(envelope[k], r[k], "MAINTENANCE_TIME_BINDING");
  }
  const issued = Date.parse(envelope.issuedAt),
    expires = Date.parse(envelope.expiresAt);
  check(
    issued <= clock() &&
      clock() < expires &&
      expires > issued &&
      expires - issued <= 1800000,
    "MAINTENANCE_EXPIRED",
  );
}
export async function verifyMaintenanceOwner(
  envelope,
  { api = githubApi, clock = Date.now } = {},
) {
  maintenanceShape(envelope, clock);
  return readPersonalOwnerDecision(
    {
      prNumber: envelope.prNumber,
      issuedAt: envelope.issuedAt,
      approval: "APPROVED_EXECUTOR_MAINTENANCE:" + generationDigest(envelope),
      revocation: "REVOKED_EXECUTOR_MAINTENANCE:" + generationDigest(envelope),
    },
    { api, clock },
  );
}
function maintenanceSource(session) {
  const e = session.envelope,
    r = e.generationRequest;
  same(
    realpathSync(e.executorPath),
    session.authorityRoot,
    "MAINTENANCE_SOURCE_PATH",
  );
  check(
    session.authorityRoot !== realpathSync(session.options.workspace),
    "MAINTENANCE_SEPARATE_SOURCE",
  );
  const id = identity(session.authorityRoot, r.mainSha);
  same(id.headSha, e.executorSha, "MAINTENANCE_SOURCE_HEAD");
  same(id.treeSha, e.executorTree, "MAINTENANCE_SOURCE_TREE");
  same(id.dirty, false, "MAINTENANCE_SOURCE_DIRTY");
  same(id.baseIsAncestor, true, "MAINTENANCE_SOURCE_ANCESTRY");
  // The entire reviewed source tree is fixed, not only the entry file.
  same(
    hash(regular(join(session.authorityRoot, ENTRY))),
    e.executorSourceSha256,
    "MAINTENANCE_SOURCE_DIGEST",
  );
  same(
    hash(regular(fileURLToPath(import.meta.url))),
    e.executorSourceSha256,
    "MAINTENANCE_LOADED_SOURCE",
  );
  same(
    git(session.authorityRoot, "rev-parse", r.mainSha + ":" + ENTRY),
    MAINTENANCE.legacyEntryBlob,
    "MAINTENANCE_NO_LONGER_APPLICABLE",
  );
}
function maintenancePaths(session) {
  const workspace = realpathSync(session.options.workspace);
  const common = realpathSync(
    resolve(workspace, git(workspace, "rev-parse", "--git-common-dir")),
  );
  const directory = join(common, "task-generation-maintenance");
  if (existsSync(directory))
    check(
      realpathSync(directory) === directory &&
        lstatSync(directory).isDirectory(),
      "MAINTENANCE_DIRECTORY",
    );
  return {
    directory,
    reservation: join(directory, session.envelope.nonce + ".reservation.json"),
    prepared: join(directory, session.envelope.nonce + ".prepared.json"),
    complete: join(directory, session.envelope.nonce + ".complete.json"),
  };
}
function maintenanceFinalIdentity(session, capture) {
  const r = session.envelope.generationRequest,
    root = capture.workspace;
  same(
    git(root, "show", "-s", "--format=%P", "HEAD"),
    r.candidateSha,
    "MAINTENANCE_SINGLE_COMMIT",
  );
  same(
    git(root, "diff", "--name-only", r.candidateSha, "HEAD"),
    capture.mp,
    "MAINTENANCE_FINAL_SCOPE",
  );
  same(
    JSON.parse(at(root, "HEAD", capture.mp)),
    {
      ...JSON.parse(at(root, r.candidateSha, capture.mp)),
      state: "LOCAL_PROVEN",
    },
    "MAINTENANCE_FINAL_PROJECTION",
  );
  const mode = (sha) => git(root, "ls-tree", sha, capture.mp).split(" ")[0];
  same(mode("HEAD"), mode(r.candidateSha), "MAINTENANCE_FILE_MODE");
}
function maintenanceTime(session, capture) {
  maintenanceShape(session.envelope, session.clock);
  check(
    session.clock() < Date.parse(capture.claim.expiresAt),
    "CLAIM_EXPIRED_DURING_PROOF",
  );
}
async function maintenanceFence(session, capture, phase, stage) {
  if (session === undefined) return;
  check(maintenanceSessions.has(session), "MAINTENANCE_ADMISSION_REQUIRED");
  const e = session.envelope,
    r = e.generationRequest;
  maintenanceShape(e, session.clock);
  maintenanceSource(session);
  same(capture.workspace, r.workspace, "MAINTENANCE_WORKSPACE");
  same(capture.id, MAINTENANCE.claimId, "MAINTENANCE_CLAIM");
  same(capture.mode, "HISTORY", "MAINTENANCE_HISTORY_ONLY");
  same(capture.mainSha, r.mainSha, "MAINTENANCE_MAIN");
  same(capture.manifest.baseSha, r.mainSha, "MAINTENANCE_ALREADY_REANCHORED");
  check(
    Date.parse(e.expiresAt) <= Date.parse(capture.claim.expiresAt),
    "MAINTENANCE_CLAIM_EXPIRY",
  );
  same(
    capture.providerIdentity.head.sha,
    r.candidateSha,
    "MAINTENANCE_REMOTE_HEAD",
  );
  same(
    capture.files.map(({ name, sha256 }) => ({ name, sha256 })),
    r.history,
    "MAINTENANCE_HISTORY_CHANGED",
  );
  same(
    await verifyMaintenanceOwner(e, { api: session.api, clock: session.clock }),
    session.decision,
    "MAINTENANCE_CONSENT_CHANGED",
  );
  const remote = "repos/" + GENERATION_REPOSITORY;
  same(
    (await session.api(remote + "/commits/main")).sha,
    r.mainSha,
    "MAINTENANCE_MAIN",
  );
  const pull = await session.api(remote + "/pulls/23");
  check(
    pull.state === "open" &&
      pull.merged_at === null &&
      pull.head?.sha === r.candidateSha &&
      pull.head.ref === r.branch &&
      pull.head.repo.full_name === GENERATION_REPOSITORY &&
      pull.base?.repo?.full_name === GENERATION_REPOSITORY &&
      pull.base.ref === "main" &&
      pull.base.sha === r.mainSha,
    "MAINTENANCE_PR_DRIFT",
  );
  same(
    (
      await session.api(
        remote + "/git/ref/heads/" + encodeURIComponent(r.branch),
      )
    ).object?.sha,
    r.candidateSha,
    "MAINTENANCE_REMOTE_HEAD",
  );
  maintenanceTime(session, capture);
  maintenanceSource(session);
  preserveSource(capture);
  same(
    identity(capture.workspace, capture.mainSha),
    { ...capture.observed, dirty: phase === "prepare" && stage === "terminal" },
    "MAINTENANCE_TERMINAL_IDENTITY",
  );
  if (phase === "prepare")
    same(capture.observed.headSha, r.candidateSha, "MAINTENANCE_INITIAL_HEAD");
  else maintenanceFinalIdentity(session, capture);
  maintenanceTime(session, capture);
  const p = maintenancePaths(session);
  const expected = { request: e, decision: session.decision };
  if (stage === "reserve") {
    check(!existsSync(p.reservation), "MAINTENANCE_NONCE_USED");
    mkdirSync(p.directory, { recursive: true, mode: 0o700 });
    const fd = openSync(dirname(p.directory), "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    check(realpathSync(p.directory) === p.directory, "MAINTENANCE_DIRECTORY");
    durable(p.reservation, bytes(expected));
  } else {
    same(json(p.reservation), expected, "MAINTENANCE_RESERVATION_CHANGED");
    if (phase === "prove") {
      same(
        json(p.prepared),
        { requestDigest: generationDigest(e), initialHead: r.candidateSha },
        "MAINTENANCE_PREPARE_REQUIRED",
      );
      check(!existsSync(p.complete), "MAINTENANCE_ALREADY_COMPLETE");
    }
  }
}
async function maintenanceFinish(session, capture, phase, finalReadback) {
  if (session === undefined) return;
  await maintenanceFence(session, capture, phase, "terminal");
  finalReadback();
  maintenanceTime(session, capture);
  const p = maintenancePaths(session);
  if (phase === "prepare")
    durable(
      p.prepared,
      bytes({
        requestDigest: generationDigest(session.envelope),
        initialHead: session.envelope.generationRequest.candidateSha,
      }),
    );
  else
    durable(
      p.complete,
      bytes({
        state: "MAINTENANCE_FINAL_PROVEN",
        finalProofDigest: hash(
          regular(
            join(
              generationPaths(capture, session.envelope.generationRequest)
                .directory,
              "final-proof.json",
            ),
          ),
        ),
        requestDigest: generationDigest(session.envelope),
        finalHead: capture.observed.headSha,
        finalTree: capture.observed.treeSha,
        remoteProofAccepted: false,
      }),
    );
}
export async function runMaintenanceGeneration(
  action,
  options,
  envelope,
  {
    api = githubApi,
    clock = Date.now,
    authorityRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  } = {},
) {
  check(["prepare", "prove"].includes(action), "MAINTENANCE_ACTION");
  const frozen = JSON.parse(JSON.stringify(envelope));
  maintenanceShape(frozen, clock);
  same(
    options,
    {
      workspace: frozen.generationRequest.workspace,
      mainSha: frozen.generationRequest.mainSha,
      prNumber: 23,
      executor: frozen.generationRequest.executor,
    },
    "MAINTENANCE_OPTIONS",
  );
  const session = {
    envelope: frozen,
    api,
    clock,
    authorityRoot: realpathSync(authorityRoot),
    options: { ...options },
    decision: null,
  };
  maintenanceSource(session);
  session.decision = await verifyMaintenanceOwner(frozen, { api, clock });
  maintenanceSessions.add(session);
  // No outer lock. The additional fence executes INSIDE the existing lock.
  return action === "prepare"
    ? prepareGeneration(options, frozen.generationRequest, {
        api,
        clock,
        maintenance: session,
      })
    : proveGeneration(options, frozen.nonce, {
        api,
        clock,
        maintenance: session,
      });
}

async function main(args) {
  if (["maintenance-prepare", "maintenance-prove"].includes(args[0])) {
    check(args.length === 2, "MAINTENANCE_USAGE");
    const envelope = json(args[1]),
      r = envelope.generationRequest;
    console.log(
      JSON.stringify(
        await runMaintenanceGeneration(
          args[0].slice("maintenance-".length),
          {
            workspace: r.workspace,
            mainSha: r.mainSha,
            prNumber: r.prNumber,
            executor: r.executor,
          },
          envelope,
        ),
        null,
        2,
      ),
    );
    return;
  }

  const [action, workspace, mainSha, pr, executor, value] = args;
  check(
    ["inspect", "prepare", "prove"].includes(action) &&
      args.length === (action === "inspect" ? 5 : 6),
    "USAGE",
  );
  const authorityRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  check(
    git(authorityRoot, "rev-parse", "HEAD") === mainSha &&
      git(authorityRoot, "status", "--porcelain", "--untracked-files=all") ===
        "",
    "CANONICAL_EXECUTABLE_REQUIRED",
  );
  check(
    git(authorityRoot, "hash-object", fileURLToPath(import.meta.url)) ===
      git(authorityRoot, "rev-parse", mainSha + ":" + ENTRY),
    "EXECUTABLE_CHANGED",
  );
  const options = { workspace, mainSha, prNumber: Number(pr), executor };
  const result =
    action === "inspect"
      ? generationRequest(await captureGeneration(options))
      : action === "prepare"
        ? await prepareGeneration(options, json(value))
        : await proveGeneration(options, value);
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch(() => {
    console.error("GENERATION_COMMAND_FAILED");
    process.exitCode = 1;
  });
