import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFiles } from "./impact-analyzer.mjs";

test("file-like literal rules are exact while directory and stem rules retain prefix semantics", () => {
  const exact = analyzeFiles([".gitignore"]);
  assert.ok(exact.domains.includes("ci-tooling"));
  assert.equal(exact.classificationBlocked, false);
  assert.equal(exact.qualityProfile, "NON_RUNTIME");

  const nearCollision = analyzeFiles([".gitignore.local"]);
  assert.equal(nearCollision.classificationBlocked, true);
  assert.deepEqual(nearCollision.unknownFiles, [".gitignore.local"]);
  assert.equal(nearCollision.qualityProfile, "CLASSIFICATION_BLOCK");

  const directoryPrefix = analyzeFiles(["tooling/ci/nested/example.mjs"]);
  assert.ok(directoryPrefix.domains.includes("ci-tooling"));
  assert.equal(directoryPrefix.classificationBlocked, false);

  const stemPrefix = analyzeFiles(["Dockerfile.production"]);
  assert.ok(stemPrefix.domains.includes("database"));
  assert.equal(stemPrefix.classificationBlocked, false);
});

test("ticketing financial API impact is CRITICAL and exact-path", () => {
  const path = "apps/morro-digital-platform/tooling/ticketing-api.mjs";
  const decision = analyzeFiles([path]);
  assert.equal(decision.classificationBlocked, false);
  assert.deepEqual(decision.unknownFiles, []);
  assert.ok(decision.domains.includes("payments"));
  assert.equal(decision.risk, "CRITICAL");
  assert.equal(decision.needsFullRegression, true);
  assert.equal(decision.qualityProfile, "DEEP_PROOF");
  assert.equal(decision.needsDatabase, true);
  assert.equal(decision.needsFullSecurity, true);
  assert.ok(decision.suites.includes("payments-browser-checkout-contract.yml"));
  const composed = analyzeFiles([path, ".github/morro-control/claims.json"]);
  assert.equal(composed.classificationBlocked, false);
  assert.ok(composed.domains.includes("governance"));
  assert.equal(composed.risk, "CRITICAL");
  for (const alias of [
    path + ".bak",
    path + "x",
    "apps/morro-digital-platform/tooling/ticketing-api-mock.mjs",
  ]) {
    const rejected = analyzeFiles([alias]);
    assert.equal(rejected.classificationBlocked, true);
    assert.ok(rejected.unknownFiles.includes(alias));
  }
});

import { readFileSync } from "node:fs";
import { matchesOwnershipPath } from "../fabric/ownership-path.mjs";

const ownershipAdditions = [
  "apps/morro-digital-platform/src/bootstrap/geospatial.test.ts",
  "apps/morro-digital-platform/src/bootstrap/geospatial.ts",
  "apps/morro-digital-platform/src/bootstrap/runtime.test.ts",
  "apps/morro-digital-platform/src/bootstrap/runtime.ts",
  "apps/morro-digital-platform/src/browser.ts",
  "apps/morro-digital-platform/src/destinations/destination-browser-entry.ts",
  "apps/morro-digital-platform/src/destinations/destination-page.test.ts",
  "apps/morro-digital-platform/src/destinations/destination-page.ts",
  "apps/morro-digital-platform/src/runtime/public-destination.test.ts",
  "apps/morro-digital-platform/src/runtime/public-destination.ts",
];
const impactAdditions = [
  "apps/morro-digital-platform/public/assets/brand/itacare-digital-micro-v2.svg",
  "apps/morro-digital-platform/public/assets/brand/itacare-digital-symbol-v2.svg",
  "apps/morro-digital-platform/public/destination.css",
  "apps/morro-digital-platform/public/destination.html",
  "apps/morro-digital-platform/src/bootstrap/geospatial.test.ts",
  "apps/morro-digital-platform/src/bootstrap/geospatial.ts",
  "apps/morro-digital-platform/src/bootstrap/runtime.test.ts",
  "apps/morro-digital-platform/src/bootstrap/runtime.ts",
  "apps/morro-digital-platform/src/browser.ts",
  "apps/morro-digital-platform/src/destinations/destination-browser-entry.ts",
  "apps/morro-digital-platform/src/destinations/destination-page.test.ts",
  "apps/morro-digital-platform/src/destinations/destination-page.ts",
  "apps/morro-digital-platform/src/runtime/public-destination.test.ts",
  "apps/morro-digital-platform/src/runtime/public-destination.ts",
];
const impactDomain = {
  paths: [
    "apps/morro-digital-platform/public/assets/brand/itacare-digital-micro-v2.svg",
    "apps/morro-digital-platform/public/assets/brand/itacare-digital-symbol-v2.svg",
    "apps/morro-digital-platform/public/destination.css",
    "apps/morro-digital-platform/public/destination.html",
    "apps/morro-digital-platform/src/bootstrap/geospatial.test.ts",
    "apps/morro-digital-platform/src/bootstrap/geospatial.ts",
    "apps/morro-digital-platform/src/bootstrap/runtime.test.ts",
    "apps/morro-digital-platform/src/bootstrap/runtime.ts",
    "apps/morro-digital-platform/src/browser.ts",
    "apps/morro-digital-platform/src/destinations/destination-browser-entry.ts",
    "apps/morro-digital-platform/src/destinations/destination-page.test.ts",
    "apps/morro-digital-platform/src/destinations/destination-page.ts",
    "apps/morro-digital-platform/src/runtime/public-destination.test.ts",
    "apps/morro-digital-platform/src/runtime/public-destination.ts",
  ],
  risk: "CRITICAL",
  dependsOn: ["auth", "business"],
  suites: ["itacare-product-candidate-proof.yml"],
  needsBrowser: true,
  needsVisual: true,
  needsDatabase: true,
  needsDependencyAudit: false,
  needsFullSecurity: true,
};

const nearCollisions = (path) => [
  `${path}.bak`,
  `${path}x`,
  `${path}/nested.ts`,
  `${path.slice(0, path.lastIndexOf("/") + 1)}unclaimed-${path.slice(path.lastIndexOf("/") + 1)}`,
];

test("Itacare public UI exact paths retain critical runtime proof and reject near collisions", () => {
  for (const path of impactAdditions) {
    const decision = analyzeFiles([path]);
    assert.equal(decision.classificationBlocked, false, path);
    assert.deepEqual(decision.unknownFiles, [], path);
    assert.ok(decision.domains.includes("destination-public-ui"), path);
    assert.equal(decision.risk, "CRITICAL", path);
    assert.equal(decision.qualityProfile, "DEEP_PROOF", path);
    assert.equal(decision.needsFullRegression, true, path);
    for (const key of [
      "needsBrowser",
      "needsVisual",
      "needsDatabase",
      "needsFullSecurity",
    ]) {
      assert.equal(decision[key], true, `${path}:${key}`);
    }
    assert.ok(
      decision.suites.includes("itacare-product-candidate-proof.yml"),
      path,
    );
    for (const alias of nearCollisions(path)) {
      const rejected = analyzeFiles([alias]);
      assert.equal(rejected.classificationBlocked, true, alias);
      assert.ok(rejected.unknownFiles.includes(alias), alias);
      assert.ok(!rejected.domains.includes("destination-public-ui"), alias);
    }
  }
  const classification = JSON.parse(
    readFileSync(
      new URL("./test-impact-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    classification.domains["destination-public-ui"],
    impactDomain,
  );
});

test("Itacare app ownership is exact and preserves trusted server ownership", () => {
  const ownership = JSON.parse(
    readFileSync(
      new URL("../../.morro/ownership.json", import.meta.url),
      "utf8",
    ),
  );
  const owners = (path) =>
    ownership.domains
      .filter((domain) =>
        domain.pathPrefixes.some((prefix) =>
          matchesOwnershipPath(path, prefix),
        ),
      )
      .map((domain) => domain.id);
  for (const path of ownershipAdditions) {
    assert.deepEqual(owners(path), ["map"], path);
    for (const alias of nearCollisions(path))
      assert.deepEqual(owners(alias), [], alias);
  }
  assert.deepEqual(
    owners("apps/morro-digital-platform/tooling/dev-server.mjs"),
    ["auth"],
  );
  assert.deepEqual(
    owners(
      "apps/morro-digital-platform/tooling/itacare-place-destination-http.mysql.mjs",
    ),
    ["business"],
  );
  const server = analyzeFiles([
    "apps/morro-digital-platform/tooling/dev-server.mjs",
  ]);
  assert.equal(server.risk, "CRITICAL");
  assert.ok(server.domains.includes("destination-host-isolation"));
  assert.ok(server.domains.includes("destination-scoped-public-place"));
});

test("Control Center activation UI has exact auth ownership and retains the authorization floor", () => {
  const ownership = JSON.parse(
    readFileSync(
      new URL("../../.morro/ownership.json", import.meta.url),
      "utf8",
    ),
  );
  const owners = (path) =>
    ownership.domains
      .filter((domain) =>
        domain.pathPrefixes.some((prefix) =>
          matchesOwnershipPath(path, prefix),
        ),
      )
      .map((domain) => domain.id);
  const path = "apps/control-center/public/control-center.js";
  assert.deepEqual(owners(path), ["auth"]);
  for (const alias of nearCollisions(path))
    assert.deepEqual(owners(alias), [], alias);
  assert.deepEqual(
    ownership.domains.find((domain) => domain.id === "auth").contracts,
    ["platform-authz"],
  );
  const risk = JSON.parse(
    readFileSync(
      new URL("../../.morro/risk-policy.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(risk.semanticRiskFloor["platform-authz"], "critical");
  const report = analyzeFiles([path]);
  assert.equal(report.classificationBlocked, false);
  assert.ok(report.domains.includes("control-center"));
  assert.equal(report.risk, "HIGH");
  for (const key of [
    "needsBrowser",
    "needsVisual",
    "needsDatabase",
    "needsFullSecurity",
  ])
    assert.equal(report[key], true, key);
  assert.deepEqual(
    owners(".github/workflows/control-center-destination-contract.yml"),
    ["ci-release"],
  );
});

test("assistant profile exact paths inherit existing conversation proof without admitting aliases", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("./test-impact-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const domain = manifest.domains["assistant-conversation"];
  assert.equal(domain.risk, "MEDIUM");
  assert.deepEqual(domain.dependsOn, [
    "assistant",
    "explore",
    "map",
    "navigation",
    "search",
    "commerce",
    "payments",
    "geolocation",
    "network",
    "shell",
  ]);
  assert.deepEqual(domain.suites, [
    "assistant-conversation-continuity-browser-contract.yml",
    "assistant-input-menu-flow-v1-parity.yml",
    "navigation-turn-by-turn-parity.yml",
    "navigation-accessibility-baseline.yml",
  ]);
  assert.equal(domain.needsBrowser, true);
  assert.equal(domain.needsVisual, true);
  assert.equal(domain.needsDatabase, false);
  assert.equal(domain.needsDependencyAudit, false);
  assert.equal(domain.needsFullSecurity, false);
  const { files: baselineFiles, ...baseline } = analyzeFiles([
    "packages/assistant/src/dialog-controller.ts",
  ]);
  for (const path of [
    "packages/assistant/src/user-profile.ts",
    "packages/assistant/src/user-profile.test.ts",
  ]) {
    assert.equal(domain.paths.filter((rule) => rule === path).length, 1);
    const { files, ...decision } = analyzeFiles([path]);
    assert.deepEqual(files, [path]);
    assert.deepEqual(decision, baseline);
    assert.equal(decision.classificationBlocked, false);
    assert.ok(decision.domains.includes("assistant-conversation"));
    for (const alias of nearCollisions(path)) {
      const rejected = analyzeFiles([alias]);
      assert.equal(rejected.classificationBlocked, true, alias);
      assert.ok(rejected.unknownFiles.includes(alias), alias);
    }
  }
});

for (const [path, domain, risk, db] of [
  [
    "apps/morro-digital-platform/src/map/public-place-catalog-presentation.ts",
    "explore-marker-rendering",
    "HIGH",
    false,
  ],
  [
    "apps/morro-digital-platform/tooling/catalog-platform-runtime.mjs",
    "destination-scoped-public-place",
    "CRITICAL",
    true,
  ],
  [
    "apps/morro-digital-platform/tooling/public-place-catalog-presentation.test.mjs",
    "destination-scoped-public-place",
    "CRITICAL",
    true,
  ],
])
  test(`exact catalog classification ${path}`, () => {
    const r = analyzeFiles([path]);
    assert.equal(r.classificationBlocked, false);
    assert.ok(r.domains.includes(domain));
    assert.equal(r.risk, risk);
    assert.equal(r.needsBrowser, true);
    assert.equal(r.needsDatabase, db);
    if (db) assert.equal(r.needsFullSecurity, true);
    else assert.equal(r.needsVisual, true);
    for (const alias of [
      path + ".backup",
      path + "/nested",
      path.replace(/\.(ts|mjs)$/, "-other.$1"),
    ])
      assert.equal(analyzeFiles([alias]).classificationBlocked, true, alias);
  });

import { execFileSync } from "node:child_process";
const ownerBusinessPaths = [
  "apps/morro-digital-platform/src/morro-pro-business-management.ts",
  "apps/morro-digital-platform/src/morro-pro-business-management.test.ts",
];

test("owner business management paths inherit the existing business gates exactly", () => {
  const reference = analyzeFiles([
    "apps/morro-digital-platform/src/business-dashboard-client.ts",
  ]);
  assert.deepEqual(reference.domains, ["business"]);
  assert.equal(reference.classificationBlocked, false);
  assert.equal(reference.needsFullSecurity, true);
  for (const path of ownerBusinessPaths) {
    assert.deepEqual(
      analyzeFiles([path]),
      { ...reference, files: [path] },
      path,
    );
    for (const alias of nearCollisions(path)) {
      const rejected = analyzeFiles([alias]);
      assert.equal(rejected.classificationBlocked, true, alias);
      assert.deepEqual(rejected.unknownFiles, [alias]);
    }
  }
});

test("affiliate portal markup stays blocked until its browser proof is routed", () => {
  const page = "apps/morro-digital-platform/public/affiliate-portal.html";
  for (const files of [[page], [...ownerBusinessPaths, page]]) {
    const report = analyzeFiles(files);
    assert.equal(report.classificationBlocked, true);
    assert.deepEqual(report.unknownFiles, [page]);
  }
});

test("catalog and owner panel impact additions preserve all prior rules and coverage", () => {
  const before = JSON.parse(
    execFileSync(
      "git",
      [
        "show",
        "0173ab404809e62eadcc20849263fdb7105aec81:tooling/ci/test-impact-manifest.json",
      ],
      { encoding: "utf8" },
    ),
  );
  const after = JSON.parse(
    readFileSync(
      new URL("./test-impact-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const additions = {
    business: ownerBusinessPaths,
    "explore-marker-rendering": [
      "apps/morro-digital-platform/src/map/public-place-catalog-presentation.ts",
      "apps/morro-digital-platform/src/map/explore-location-actions-v1.ts",
      "apps/morro-digital-platform/src/map/explore-location-actions-v1.test.ts",
    ],
    "entry-css-runtime": [
      "apps/morro-digital-platform/public/design-system-v2.css",
    ],
    payments: [
      "apps/morro-digital-platform/public/ticketing.js",
      "apps/morro-digital-platform/public/tickets.html",
      "apps/morro-digital-platform/public/tour-booking.html",
      "apps/morro-digital-platform/public/experience.js",
    ],
    "destination-scoped-public-place": [
      "apps/morro-digital-platform/tooling/catalog-platform-runtime.mjs",
      "apps/morro-digital-platform/tooling/public-place-catalog-presentation.test.mjs",
    ],
  };
  const restored = structuredClone(after);
  for (const [domain, paths] of Object.entries(additions)) {
    assert.deepEqual(after.domains[domain].paths, [
      ...before.domains[domain].paths,
      ...paths,
    ]);
    restored.domains[domain].paths = restored.domains[domain].paths.filter(
      (path) => !paths.includes(path),
    );
  }
  assert.deepEqual(restored, before);
});

const manualImpactCases = [
  {
    domain: "explore-marker-rendering",
    paths: [
      "apps/morro-digital-platform/src/map/explore-location-actions-v1.ts",
      "apps/morro-digital-platform/src/map/explore-location-actions-v1.test.ts",
    ],
    reference: "apps/morro-digital-platform/src/map/explore-marker-grouping.ts",
    risk: "HIGH",
    suites: ["place-explore-v2-visual-regression.yml"],
    expected: {
      needsBrowser: true,
      needsVisual: true,
      needsDatabase: false,
      needsDependencyAudit: false,
      needsFullSecurity: false,
      needsFullRegression: false,
      qualityProfile: "UI_BUGFIX_FAST",
    },
  },
  {
    domain: "entry-css-runtime",
    paths: ["apps/morro-digital-platform/public/design-system-v2.css"],
    reference: "apps/morro-digital-platform/src/map/feature-styles.ts",
    risk: "HIGH",
    suites: [
      "home-discover-manual-conformance.yml",
      "home-first-run-browser-regression.yml",
      "morro-performance-budget.yml",
      "morro-runtime-startup-performance.yml",
      "navigation-accessibility-baseline.yml",
      "navigation-turn-by-turn-parity.yml",
      "place-explore-v2-visual-regression.yml",
      "pwa-offline-browser-contract.yml",
    ],
    expected: {
      needsBrowser: true,
      needsVisual: true,
      needsDatabase: false,
      needsDependencyAudit: false,
      needsFullSecurity: false,
      needsFullRegression: false,
      qualityProfile: "UI_BUGFIX_FAST",
    },
  },
  {
    domain: "payments",
    paths: [
      "apps/morro-digital-platform/public/ticketing.js",
      "apps/morro-digital-platform/public/tickets.html",
      "apps/morro-digital-platform/public/tour-booking.html",
      "apps/morro-digital-platform/public/experience.js",
    ],
    reference: "apps/morro-digital-platform/tooling/ticketing-api.mjs",
    risk: "CRITICAL",
    suites: [
      "commerce-browser-regression.yml",
      "payments-browser-checkout-contract.yml",
    ],
    expected: {
      needsBrowser: true,
      needsVisual: true,
      needsDatabase: true,
      needsDependencyAudit: true,
      needsFullSecurity: true,
      needsFullRegression: true,
      qualityProfile: "DEEP_PROOF",
    },
  },
];

const manualImpactAliases = (path) => {
  const separator = path.lastIndexOf("/");
  const directory = path.slice(0, separator + 1);
  const basename = path.slice(separator + 1);
  return [
    `${path}.bak`,
    `${path}.old`,
    `${path}/nested`,
    `${directory}homonym-${basename}`,
  ];
};

test("manual map visual and commerce paths are exact and retain proof floors", () => {
  for (const definition of manualImpactCases) {
    for (const path of definition.paths) {
      const decision = analyzeFiles([path]);
      assert.equal(decision.classificationBlocked, false, path);
      assert.deepEqual(decision.unknownFiles, [], path);
      assert.deepEqual(decision.domains, [definition.domain], path);
      assert.equal(decision.risk, definition.risk, path);
      assert.deepEqual(decision.suites, definition.suites, path);
      for (const [key, value] of Object.entries(definition.expected))
        assert.equal(decision[key], value, `${path}:${key}`);

      for (const alias of manualImpactAliases(path)) {
        const rejected = analyzeFiles([alias]);
        assert.equal(rejected.classificationBlocked, true, alias);
        assert.deepEqual(rejected.unknownFiles, [alias], alias);
        assert.deepEqual(rejected.domains, [], alias);
      }
    }
  }
});

test("manual exact paths compose with existing files without changing gates", () => {
  for (const definition of manualImpactCases) {
    for (const path of definition.paths) {
      const single = analyzeFiles([path]);
      const composed = analyzeFiles([path, definition.reference]);
      const { files: singleFiles, ...singleDecision } = single;
      const { files: composedFiles, ...composedDecision } = composed;
      assert.deepEqual(composedDecision, singleDecision, path);
      assert.deepEqual(singleFiles, [path]);
      assert.deepEqual(composedFiles, [path, definition.reference]);
    }
  }

  const existingI18n = analyzeFiles([
    "apps/morro-digital-platform/src/map/explore-v1-i18n.test.ts",
  ]);
  const composedI18n = analyzeFiles([
    "apps/morro-digital-platform/src/map/explore-v1-i18n.test.ts",
    manualImpactCases[0].paths[0],
  ]);
  assert.ok(
    composedI18n.domains.includes("discover-controls-and-filter-labels"),
  );
  assert.ok(composedI18n.domains.includes("explore-marker-rendering"));
  for (const key of [
    "needsBrowser",
    "needsVisual",
    "needsDatabase",
    "needsDependencyAudit",
    "needsFullSecurity",
    "needsFullRegression",
    "qualityProfile",
  ])
    assert.equal(composedI18n[key], existingI18n[key], `i18n:${key}`);
});
