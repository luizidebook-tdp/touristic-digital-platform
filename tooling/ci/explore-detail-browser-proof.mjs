import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

const controller =
  "apps/morro-digital-platform/src/map/explore-locations-control.ts";
const selector = '.morro-explore-marker[data-morro-explore-marker="true"]';
const key = ({ category, name }) => JSON.stringify([category, name]);
const sorted = (keys) => [...keys].sort();

// Select the expectation from the actual producer, never the observed count.
// Unknown call contracts fail closed; comments and string lookalikes cannot opt in.
export function readDetailContract(source = readFileSync(controller, "utf8")) {
  const file = ts.createSourceFile(
    controller,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.equal(file.parseDiagnostics.length, 0, "DETAIL_SOURCE_PARSE_FAILED");
  const functions = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "selectLocation"
    )
      functions.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(functions.length, 1, "DETAIL_PRODUCER_AMBIGUOUS");
  assert.ok(ts.isArrowFunction(functions[0]), "DETAIL_PRODUCER_UNKNOWN");
  const calls = [];
  const find = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "renderLocationsOnMap"
    )
      calls.push(node);
    ts.forEachChild(node, find);
  };
  find(functions[0].body);
  assert.equal(calls.length, 1, "DETAIL_MAP_CALL_AMBIGUOUS");
  const printer = ts.createPrinter({ removeComments: true });
  const signature = calls[0].arguments
    .map((argument) =>
      printer
        .printNode(ts.EmitHint.Expression, argument, file)
        .replace(/\s+/gu, ""),
    )
    .join(",");
  const modes = new Map([
    ["[location],category,true,false,datasetCriteria", "LEGACY_SINGLE"],
    [
      "visibleLocations.length?visibleLocations:[location],visibleLocations.length?datasetCategory:category,false,visibleLocations.length>0,datasetCriteria",
      "RETAINED_FILTER",
    ],
  ]);
  assert.ok(modes.has(signature), "DETAIL_MAP_CALL_UNKNOWN");
  return Object.freeze({
    mode: modes.get(signature),
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  });
}

export function assertMembers(observed, expected) {
  assert.ok(
    expected.length > 0 && new Set(expected).size === expected.length,
    "DETAIL_EXPECTATION_INVALID",
  );
  assert.equal(
    new Set(observed).size,
    observed.length,
    "DETAIL_MEMBER_DUPLICATE",
  );
  assert.deepEqual(
    sorted(observed),
    sorted(expected),
    "DETAIL_MEMBER_IDENTITY_CHANGED",
  );
}

export function assertDetailState(state, origin) {
  assert.equal(origin.name, origin.place, "DETAIL_EXPECTED_PLACE_INVALID");
  assertMembers(origin.expected, origin.expected);
  assert.ok(
    origin.expected.includes(key(origin)),
    "DETAIL_EXPECTED_SELECTION_MISSING",
  );
  assert.ok(
    ["LEGACY_SINGLE", "RETAINED_FILTER"].includes(origin.contract.mode),
    "DETAIL_CONTRACT_UNKNOWN",
  );
  assert.equal(state.stage, "detail", "DETAIL_STAGE_CHANGED");
  assert.equal(state.category, origin.category, "DETAIL_CATEGORY_CHANGED");
  assert.equal(state.place, origin.place, "DETAIL_PLACE_CHANGED");
  assert.equal(state.ready, true, "DETAIL_NOT_READY");
  assert.equal(
    state.physical,
    state.markers.length,
    "DETAIL_PHYSICAL_COUNT_CHANGED",
  );
  assert.ok(
    state.markers.length > 0 &&
      state.markers.every((m) => m.id) &&
      new Set(state.markers.map((m) => m.id)).size === state.markers.length,
    "DETAIL_MARKER_ID_INVALID",
  );
  const expected =
    origin.contract.mode === "LEGACY_SINGLE" ? [key(origin)] : origin.expected;
  assert.equal(state.members, expected.length, "DETAIL_DATASET_COUNT_CHANGED");
  assert.equal(
    state.semantic,
    expected.length,
    "DETAIL_SEMANTIC_COUNT_CHANGED",
  );
  if (origin.contract.mode === "LEGACY_SINGLE") {
    assert.equal(state.markers.length, 1, "DETAIL_LEGACY_MARKER_COUNT_CHANGED");
    assert.equal(
      key(state.markers[0]),
      key(origin),
      "DETAIL_LEGACY_PLACE_CHANGED",
    );
  } else {
    assert.equal(
      state.markers.filter((m) => m.selected && m.current === "location")
        .length,
      1,
      "DETAIL_SELECTION_MISSING_OR_DUPLICATED",
    );
  }
  return expected;
}

export function assertCamera(actual, expected) {
  for (const field of ["lng", "lat", "zoom", "pitch", "bearing"]) {
    assert.ok(
      Number.isFinite(actual?.[field]) && Number.isFinite(expected?.[field]),
      "DETAIL_CAMERA_UNAVAILABLE",
    );
    assert.ok(
      Math.abs(actual[field] - expected[field]) < 0.00001,
      "DETAIL_CAMERA_NOT_RESTORED:" + field,
    );
  }
}

async function snapshot(page) {
  return page.evaluate((selector) => {
    const map = document.getElementById("map");
    const provider = globalThis.mapboxPrimaryInstance;
    const center = provider?.getCenter?.();
    return {
      stage: map?.getAttribute("data-explore-stage"),
      category: map?.getAttribute("data-explore-category"),
      place: map?.getAttribute("data-explore-place"),
      ready: map?.getAttribute("data-explore-state") === "ready",
      moving: Boolean(provider?.isMoving?.()),
      physical: Number(map?.getAttribute("data-map-marker-count")),
      members: Number(map?.getAttribute("data-map-member-count")),
      semantic: Number(map?.getAttribute("data-explore-location-count")),
      camera: {
        lng: center?.lng,
        lat: center?.lat,
        zoom: provider?.getZoom?.(),
        pitch: provider?.getPitch?.(),
        bearing: provider?.getBearing?.(),
      },
      markers: [...document.querySelectorAll(selector)].map((node) => ({
        id: node.getAttribute("data-marker-id"),
        name: node.getAttribute("data-location-name"),
        category: node.getAttribute("data-explore-category"),
        clustered:
          node.getAttribute("data-marker-cluster") === "true" ||
          node.getAttribute("data-tour-cluster") === "true",
        count: Number(node.getAttribute("data-cluster-count")),
        selected: node.getAttribute("data-selected") === "true",
        current: node.getAttribute("aria-current"),
      })),
    };
  }, selector);
}

async function settle(page, check) {
  const deadline = Date.now() + 10000;
  let last;
  while (Date.now() < deadline) {
    const state = await snapshot(page);
    try {
      assert.ok(!state.moving, "DETAIL_CAMERA_MOVING");
      check(state);
      return state;
    } catch (error) {
      last = error;
    }
    await page.waitForTimeout(50);
  }
  throw last;
}

export async function captureDetailSelectionOrigin(page, category, place) {
  const { morroV1SearchCatalog } =
    await import("../../packages/search/dist/index.js");
  const expected = morroV1SearchCatalog
    .filter((item) => item.category === category)
    .map(key);
  assert.ok(
    expected.includes(key({ category, name: place })),
    "DETAIL_SELECTED_PLACE_NOT_IN_CATALOG",
  );
  const selected = morroV1SearchCatalog.find(
    (item) => item.category === category && item.name === place,
  );
  assertMembers(expected, expected);
  // Let the existing viewport observer's two RAFs settle before recording origin.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const state = await settle(page, (state) => {
    assert.ok(
      ["places", "filters"].includes(state.stage) && state.ready,
      "DETAIL_ORIGIN_NOT_READY",
    );
    assert.equal(state.category, category, "DETAIL_ORIGIN_CATEGORY_CHANGED");
    assert.equal(
      state.members,
      expected.length,
      "DETAIL_ORIGIN_DATASET_CHANGED",
    );
    assert.equal(
      state.semantic,
      expected.length,
      "DETAIL_ORIGIN_SEMANTIC_CHANGED",
    );
    assert.equal(
      state.physical,
      state.markers.length,
      "DETAIL_ORIGIN_PHYSICAL_CHANGED",
    );
  });
  const origin = {
    category,
    name: place,
    place,
    expected,
    coordinates: [selected.longitude, selected.latitude],
    camera: state.camera,
    contract: readDetailContract(),
  };
  assertCamera(origin.camera, origin.camera);
  return Object.freeze(origin);
}

export async function verifyDetailSelection(page, origin) {
  const state = await settle(page, (state) => assertDetailState(state, origin));
  const expected = assertDetailState(state, origin);
  const observed = [];
  let selectedMemberGroups = 0;
  for (const marker of state.markers) {
    let members = [key(marker)];
    if (marker.clustered) {
      await page
        .locator(`${selector}[data-marker-id=${JSON.stringify(marker.id)}]`)
        .evaluate((node) => node.click());
      const back = page.locator(
        '#assistant-category-rail [data-explore-action="back-cluster"]',
      );
      await back.waitFor({ state: "visible", timeout: 5000 });
      const listed = await page
        .locator(
          "#assistant-category-rail [data-location-name][data-location-category]",
        )
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            name: node.getAttribute("data-location-name"),
            category: node.getAttribute("data-location-category"),
            source: node.getAttribute("data-location-source"),
          })),
        );
      assert.equal(listed.length, marker.count, "DETAIL_CLUSTER_COUNT_CHANGED");
      assert.ok(
        listed.every((item) => item.source === "catalog"),
        "DETAIL_CLUSTER_SOURCE_CHANGED",
      );
      members = listed.map(key);
      await back.click();
      await back.waitFor({ state: "hidden", timeout: 5000 });
      await settle(page, (state) => assertDetailState(state, origin));
    }
    if (origin.contract.mode === "RETAINED_FILTER" && marker.selected) {
      assert.ok(members.includes(key(origin)), "DETAIL_WRONG_GROUP_SELECTED");
      selectedMemberGroups += 1;
    }
    observed.push(...members);
  }
  assertMembers(observed, expected);
  for (const wrong of [
    observed.slice(1),
    [...observed, observed[0]],
    [
      JSON.stringify([origin.category, "not-the-selected-catalog-identity"]),
      ...observed.slice(1),
    ],
  ]) {
    assert.throws(
      () => assertMembers(wrong, expected),
      "DETAIL_NEGATIVE_CANARY_FAILED",
    );
  }
  if (origin.contract.mode === "RETAINED_FILTER")
    assert.equal(selectedMemberGroups, 1, "DETAIL_SELECTED_MEMBER_NOT_PROVEN");
  await page
    .locator(
      `#assistant-category-rail[data-rail-stage="detail"][data-context-place=${JSON.stringify(origin.place)}]`,
    )
    .waitFor({ state: "visible", timeout: 5000 });
  const proof = {
    proofMode: "DETAIL_SELECTION_FROM_PRODUCER_AND_ACTUAL_CLUSTER_UI",
    contract: origin.contract,
    members: observed.length,
    selected: key(origin),
    canonicalPlace: "UNAVAILABLE_IN_THIS_LEGACY_CATALOG_SCENARIO",
  };
  console.log(JSON.stringify(proof));
  return proof;
}

export async function verifyDetailReturn(page, origin) {
  await settle(page, (state) => {
    assert.ok(
      state.ready && ["places", "menu"].includes(state.stage),
      "DETAIL_RETURN_NOT_READY",
    );
    assert.equal(
      state.members,
      origin.expected.length,
      "DETAIL_RETURN_DATASET_CHANGED",
    );
    assert.equal(
      state.semantic,
      origin.expected.length,
      "DETAIL_RETURN_SEMANTIC_CHANGED",
    );
    assert.equal(
      state.physical,
      state.markers.length,
      "DETAIL_RETURN_PHYSICAL_CHANGED",
    );
    if (origin.contract.mode === "RETAINED_FILTER")
      assertCamera(state.camera, origin.camera);
  });
}

export async function verifySelectedVisibility(page, origin) {
  assert.equal(
    origin.contract.mode,
    "RETAINED_FILTER",
    "DETAIL_VISIBILITY_CONTRACT_UNKNOWN",
  );
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await page.evaluate((coordinates) => {
      const map = document.getElementById("map"),
        provider = globalThis.mapboxPrimaryInstance;
      const point = provider?.project?.(coordinates),
        rect = map?.getBoundingClientRect();
      if (
        !point ||
        !rect ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
      )
        return { visible: false };
      const x = rect.left + point.x,
        y = rect.top + point.y,
        hit = document.elementFromPoint(x, y);
      return {
        visible:
          !provider.isMoving() &&
          x > Math.max(0, rect.left) &&
          y > Math.max(0, rect.top) &&
          x < Math.min(innerWidth, rect.right) &&
          y < Math.min(innerHeight, rect.bottom) &&
          map.contains(hit) &&
          !hit?.closest(".mapboxgl-ctrl"),
        point: { x, y },
      };
    }, origin.coordinates);
    if (result.visible)
      return {
        method: "independent-catalog-coordinate-project-and-map-hit-test",
        ...result,
      };
    await page.waitForTimeout(50);
  }
  throw new Error("DETAIL_SELECTED_PLACE_NOT_VISIBLE_ON_MAP");
}
