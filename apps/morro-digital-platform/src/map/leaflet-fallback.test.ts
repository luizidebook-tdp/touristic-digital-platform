import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { createLeafletCompatibilitySdk } from "../development/leaflet-compatibility-sdk.js";

function fixture() {
  let center = { lat: -13.3833, lng: -38.9167 },
    zoom = 14;
  const nativeMap = {
    attributionControl: { setPosition: vi.fn() },
    setView: vi.fn(function (
      position: [number, number],
      nextZoom: number = zoom,
    ): unknown {
      center = { lat: position[0], lng: position[1] };
      zoom = nextZoom;
      return nativeMap;
    }),
    getCenter: () => center,
    getZoom: () => zoom,
    latLngToContainerPoint: vi.fn(() => ({ x: 120, y: 300 })),
    stop: vi.fn(),
    remove: vi.fn(),
  };
  const tiles = { addTo: vi.fn().mockReturnThis() };
  const leaflet = {
    map: vi.fn(() => nativeMap),
    tileLayer: vi.fn(() => tiles),
    marker: vi.fn(),
  };
  const sdk = createLeafletCompatibilitySdk({ L: leaflet });
  const map = new sdk.Map({
    container: "map",
    center: [-38.9167, -13.3833],
    zoom: 14,
    style: "development://morro-digital",
  });
  return { map, nativeMap, tiles, leaflet };
}

it("loads canonical OSM tiles with an origin-only referrer and visible attribution", () => {
  const { nativeMap, tiles, leaflet } = fixture();
  expect(leaflet.map).toHaveBeenCalledWith("map", {
    zoomControl: false,
    attributionControl: true,
  });
  expect(nativeMap.attributionControl.setPosition).toHaveBeenCalledWith(
    "topright",
  );
  expect(leaflet.tileLayer).toHaveBeenCalledWith(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      referrerPolicy: "strict-origin",
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  );
  expect(tiles.addTo).toHaveBeenCalledWith(nativeMap);
});

it("reads the user's live Leaflet camera and restores it without animation or coordinate inversion", () => {
  const { map, nativeMap } = fixture();
  nativeMap.setView([-13.4, -38.93], 12);
  expect(map.getCenter?.()).toEqual({ lng: -38.93, lat: -13.4 });
  expect(map.getZoom?.()).toBe(12);
  map.setCenter([-38.94, -13.41]);
  expect(nativeMap.setView).toHaveBeenLastCalledWith([-13.41, -38.94], 12, {
    animate: false,
  });
  map.setZoom?.(16);
  expect(map.getCenter?.()).toEqual({ lng: -38.94, lat: -13.41 });
  expect(map.getZoom?.()).toBe(16);
  const cameraMap = map as typeof map & {
    stop(): void;
    jumpTo(input: { center: [number, number]; zoom: number }): void;
  };
  cameraMap.stop();
  cameraMap.jumpTo({ center: [-38.93, -13.4], zoom: 12 });
  expect(nativeMap.stop).toHaveBeenCalledOnce();
  expect(nativeMap.setView).toHaveBeenLastCalledWith([-13.4, -38.93], 12, {
    animate: false,
  });
});

it("projects through the native viewport after manual panning", () => {
  const { map, nativeMap } = fixture();
  expect(map.project?.([-38.93, -13.4])).toEqual({ x: 120, y: 300 });
  expect(nativeMap.latLngToContainerPoint).toHaveBeenCalledWith([
    -13.4, -38.93,
  ]);
});

it.each([false, true])(
  "binds the fallback map to Explore while retaining navigation (failed real provider: %s)",
  async (failedReal) => {
    const sourcePath = new URL("../browser-entry.ts", import.meta.url);
    const source = ts.createSourceFile(
      sourcePath.pathname,
      readFileSync(sourcePath, "utf8"),
      ts.ScriptTarget.Latest,
    );
    const names = new Set([
      "setV1MapboxCompatibilityAliases",
      "startBrowserWithProvider",
    ]);
    const functions = source.statements.filter(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        statement.name &&
        names.has(statement.name.text),
    );
    expect(functions).toHaveLength(2);
    const { map } = fixture();
    const setNativeMap = vi.fn(),
      installBrowserNavigationRuntime = vi.fn(() => ({ destroy: vi.fn() }));
    const provider = { mode: "leaflet", sdk: {}, environment: {} };
    const startMorroDigitalBrowser = vi.fn(
      async (options: { onMapCreated?(instance: typeof map): void }) => {
        options.onMapCreated?.(map);
        return { ready: true };
      },
    );
    if (failedReal)
      startMorroDigitalBrowser.mockRejectedValueOnce(
        Error("WebGL unavailable"),
      );
    const script = ts.transpileModule(
      `
    const {provider,startMorroDigitalBrowser,installBrowserNavigationRuntime,setNativeMap}=dependencies;
    const globalThis={}, document={}, mapContainer={setAttribute(){}};
    const application={exploreLocations:{setNativeMap}};
    let activeNavigationRuntimeInstall,activeDiscoverPoiCleanup;
    const clearBrowserNavigationRuntime=()=>activeNavigationRuntimeInstall?.destroy(),
      createTourMarkerElement=()=>{},updateStatus=()=>{},prepareMapContainerForFallback=()=>{},
      createFallbackMapProvider=()=>provider,installDiscoverPoiMarkers=()=>()=>{};
    ${functions.map((node) => node.getText(source)).join("\n")}
    return {start:startBrowserWithProvider,aliases:globalThis};
  `,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const dependencies = {
      provider,
      startMorroDigitalBrowser,
      installBrowserNavigationRuntime,
      setNativeMap,
    };
    const execute = compileFunction(script, ["dependencies"]) as (
      dependencies: typeof dependencies,
    ) => {
      start(input: typeof provider): Promise<{ ready: boolean }>;
      aliases: { mapboxPrimaryInstance?: typeof map };
    };
    const runtime = execute(dependencies);
    await expect(
      runtime.start(failedReal ? { ...provider, mode: "real" } : provider),
    ).resolves.toEqual({ ready: true });
    expect(setNativeMap).toHaveBeenCalledExactlyOnceWith(map);
    expect(runtime.aliases.mapboxPrimaryInstance).toBe(map);
    expect(installBrowserNavigationRuntime).toHaveBeenCalledExactlyOnceWith({
      map,
      sdk: provider.sdk,
      document: expect.any(Object) as object,
    });
  },
);

it("preserves coordinate order, navigation and cleanup when WebGL is unavailable", () => {
  const { map, nativeMap } = fixture();
  expect(nativeMap.setView).toHaveBeenCalledWith([-13.3833, -38.9167], 14);
  map.setCenter([-38.92, -13.39]);
  expect(nativeMap.setView).toHaveBeenLastCalledWith([-13.39, -38.92], 14, {
    animate: false,
  });
  const navigationMap = map as typeof map & {
    easeTo(input: {
      center: [number, number];
      zoom: number;
      duration: number;
    }): void;
  };
  navigationMap.easeTo({ center: [-38.93, -13.4], zoom: 16, duration: 500 });
  expect(nativeMap.setView).toHaveBeenLastCalledWith([-13.4, -38.93], 16, {
    animate: true,
    duration: 0.5,
  });
  map.remove();
  expect(nativeMap.remove).toHaveBeenCalledOnce();
});
