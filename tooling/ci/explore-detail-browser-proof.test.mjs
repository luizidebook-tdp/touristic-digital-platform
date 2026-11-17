import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  readDetailContract,
  assertMembers,
  assertDetailState,
  assertCamera,
  verifyDetailSelection,
} from "./explore-detail-browser-proof.mjs";

const single = "[location], category, true, false, datasetCriteria";
const retained =
  "visibleLocations.length ? visibleLocations : [location], visibleLocations.length ? datasetCategory : category, false, visibleLocations.length > 0, datasetCriteria";
const source = (args) =>
  `const selectLocation=async(location)=>{if(!refreshingLocale){await renderLocationsOnMap(${args});}};`;
const key = (name) => JSON.stringify(["beaches", name]);
const camera = { lng: -38.91, lat: -13.38, zoom: 13.5, pitch: 0, bearing: 0 };
const origin = (mode) => ({
  category: "beaches",
  name: "A",
  place: "A",
  expected: [key("A"), key("B")],
  contract: { mode },
  camera,
});
const marker = (name, selected = false) => ({
  id: name,
  name,
  category: "beaches",
  clustered: false,
  selected,
  current: selected ? "location" : null,
});
const state = (mode) => ({
  category: "beaches",
  place: "A",
  stage: "detail",
  ready: true,
  moving: false,
  physical: mode === "LEGACY_SINGLE" ? 1 : 2,
  members: mode === "LEGACY_SINGLE" ? 1 : 2,
  semantic: mode === "LEGACY_SINGLE" ? 1 : 2,
  markers:
    mode === "LEGACY_SINGLE" ? [marker("A")] : [marker("A", true), marker("B")],
  camera,
});

test("binds the two explicit producer call contracts through parsed code", () => {
  assert.equal(readDetailContract(source(single)).mode, "LEGACY_SINGLE");
  assert.equal(readDetailContract(source(retained)).mode, "RETAINED_FILTER");
  assert.match(
    readDetailContract(source(single)).sourceSha256,
    /^[a-f0-9]{64}$/,
  );
});
test("reads the actual repository producer without a fixture opt-in", () => {
  assert.ok(
    ["LEGACY_SINGLE", "RETAINED_FILTER"].includes(
      readDetailContract(
        readFileSync(
          "apps/morro-digital-platform/src/map/explore-locations-control.ts",
          "utf8",
        ),
      ).mode,
    ),
  );
});
for (const [label, text] of [
  ["missing", "const text='selectLocation renderLocationsOnMap';"],
  [
    "string lookalike",
    `const selectLocation=async()=>{const text=${JSON.stringify(`renderLocationsOnMap(${retained})`)};}`,
  ],
  ["duplicated producer", source(single) + `{${source(retained)}}`],
  [
    "duplicated call",
    source(single).replace(";}", `;await renderLocationsOnMap(${single});}`),
  ],
  ["unknown replacement", source(single.replace("[location]", "[]"))],
  ["unknown focus flag", source(retained.replace(", false,", ", true,"))],
  ["missing criteria", source(retained.replace(", datasetCriteria", ""))],
  [
    "different dataset",
    source(retained.replace("? visibleLocations", "? otherLocations")),
  ],
  [
    "unknown method",
    source(single).replace("renderLocationsOnMap", "map.renderLocationsOnMap"),
  ],
  ["malformed source", "const selectLocation = ("],
])
  test("rejects producer ambiguity: " + label, () =>
    assert.throws(() => readDetailContract(text)),
  );

for (const mode of ["LEGACY_SINGLE", "RETAINED_FILTER"]) {
  test("validates the explicit " + mode + " dataset", () => {
    assert.equal(
      assertDetailState(state(mode), origin(mode)).length,
      mode === "LEGACY_SINGLE" ? 1 : 2,
    );
  });
  for (const [field, value] of [
    ["stage", "places"],
    ["category", "hotels"],
    ["place", "wrong place"],
    ["ready", false],
    ["physical", 999],
    ["members", 999],
    ["semantic", 999],
  ]) {
    test(mode + " rejects changed " + field, () =>
      assert.throws(() =>
        assertDetailState({ ...state(mode), [field]: value }, origin(mode)),
      ),
    );
  }
  test(mode + " rejects a missing marker identity", () => {
    const s = state(mode);
    s.markers[0].id = "";
    assert.throws(() => assertDetailState(s, origin(mode)));
  });
  test(mode + " never silently accepts an unknown policy", () =>
    assert.throws(() => assertDetailState(state(mode), origin("UNKNOWN"))),
  );
}
test("retained mode rejects the old destructive single-member result", () =>
  assert.throws(() =>
    assertDetailState(state("LEGACY_SINGLE"), origin("RETAINED_FILTER")),
  ));
test("legacy mode does not accidentally certify the new dataset", () =>
  assert.throws(() =>
    assertDetailState(state("RETAINED_FILTER"), origin("LEGACY_SINGLE")),
  ));
test("same-count membership substitution cannot pass", () =>
  assert.throws(() =>
    assertMembers(
      [key("A"), key("other place")],
      origin("RETAINED_FILTER").expected,
    ),
  ));
test("duplicates and missing members cannot pass", () => {
  assert.throws(() =>
    assertMembers([key("A"), key("A")], origin("RETAINED_FILTER").expected),
  );
  assert.throws(() =>
    assertMembers([key("A")], origin("RETAINED_FILTER").expected),
  );
});
test("multiple selected markers cannot pass", () => {
  const s = state("RETAINED_FILTER");
  s.markers[1] = marker("B", true);
  assert.throws(() => assertDetailState(s, origin("RETAINED_FILTER")));
});
test("camera comparison covers center, zoom, pitch and bearing", () => {
  assertCamera(camera, camera);
  for (const field of Object.keys(camera)) {
    assert.throws(() =>
      assertCamera({ ...camera, [field]: camera[field] + 0.01 }, camera),
    );
    assert.throws(() => assertCamera({ ...camera, [field]: NaN }, camera));
  }
});

// These boundary fixtures test the proof's rejection behavior, not product/browser acceptance.
function pageBoundary(s, clusterMembers = []) {
  return {
    evaluate: async () => structuredClone(s),
    waitForTimeout: async () => {},
    locator: () => ({
      waitFor: async () => {},
      evaluate: async () => {},
      evaluateAll: async () => structuredClone(clusterMembers),
      click: async () => {},
    }),
  };
}
for (const mode of ["LEGACY_SINGLE", "RETAINED_FILTER"]) {
  test(
    "proof boundary accepts valid " + mode + " and its negative canaries",
    async () => {
      assert.equal(
        (await verifyDetailSelection(pageBoundary(state(mode)), origin(mode)))
          .members,
        mode === "LEGACY_SINGLE" ? 1 : 2,
      );
    },
  );
}
test("a wrong selected group fails despite correct dataset identities/counts", async () => {
  const s = state("RETAINED_FILTER");
  s.markers = [marker("A"), marker("B", true)];
  await assert.rejects(
    verifyDetailSelection(pageBoundary(s), origin("RETAINED_FILTER")),
    /DETAIL_WRONG_GROUP_SELECTED/,
  );
});
test("proof traverses the actual cluster member interface", async () => {
  const s = state("RETAINED_FILTER");
  s.markers = [{ ...marker("A", true), clustered: true, count: 2 }];
  s.physical = 1;
  const members = [
    { name: "A", category: "beaches", source: "catalog" },
    { name: "B", category: "beaches", source: "catalog" },
  ];
  assert.equal(
    (
      await verifyDetailSelection(
        pageBoundary(s, members),
        origin("RETAINED_FILTER"),
      )
    ).members,
    2,
  );
  await assert.rejects(
    verifyDetailSelection(
      pageBoundary(
        s,
        members.map((m) => ({ ...m, source: "canonical" })),
      ),
      origin("RETAINED_FILTER"),
    ),
    /DETAIL_CLUSTER_SOURCE_CHANGED/,
  );
  await assert.rejects(
    verifyDetailSelection(
      pageBoundary(s, members.slice(1)),
      origin("RETAINED_FILTER"),
    ),
    /DETAIL_CLUSTER_COUNT_CHANGED/,
  );
  await assert.rejects(
    verifyDetailSelection(
      pageBoundary(s, [{ ...members[0], name: "X" }, members[1]]),
      origin("RETAINED_FILTER"),
    ),
    /DETAIL_WRONG_GROUP_SELECTED/,
  );
});
