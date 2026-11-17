import type { PublicPlaceMediaProjection } from "@touristic/business";
import { publicPlaceCatalogText } from "./public-place-catalog-presentation.js";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantContextManager,
  createAssistantDialogController,
  getAssistantMainMenu,
  normalizeAssistantVoiceLanguage,
  type AssistantDialogResponse,
} from "@touristic/assistant";
import {
  getAssistantConversationOrchestrator,
  type AssistantConversationOrchestrator,
} from "../assistant/assistant-conversation-orchestrator.js";
import { morroV1SearchCatalog, normalizeSearchText } from "@touristic/search";
import {
  executeAssistantV1ResidualCommand,
  resolveAssistantV1ResidualCommand,
} from "../assistant/assistant-v1-residual-command-adapter.js";
import { readAssistantResponseOptions } from "../assistant/assistant-dom-view.js";
import { assistantUiStateStatus } from "../assistant/assistant-ui-state.js";
import {
  resolveAssistantMenuCommand,
  resolveAssistantRuntimeAction,
} from "../assistant/assistant-menu-command-router.js";
import {
  getV1ExploreSubcategoryOptions,
  resolveV1ExploreAppliedResult,
} from "./explore-locations-v1-flow.js";

import {
  createExploreCameraReturn,
  createPlaceDetailMedia,
  normalizePlaceDetailImageSource,
  resolvePlaceDetailMedia,
  resolvePlaceDetailGallery,
  isExploreLocationVisible,
  appliedMapFilterSummary,
  createExploreLocationDetailsCommand,
  type ExternalTourMapPreparation,
  type ExploreMapLocation,
  type ExploreLocationsCommand,
  type ExploreSearchResult,
  getAssistantCategoryButtonId,
  getExploreLocationsCategories,
  getExploreLocationsForCategory,
  resolveExploreLocationByName,
} from "./explore-locations-control.js";
import { groupProjectedMarkers } from "./explore-marker-grouping.js";
import { getV1ExplorePlaceActionOptions } from "./explore-location-actions-v1.js";
import { getV1ExploreLabel, getV1ExploreUiCopy } from "./explore-v1-i18n.js";

const EXPECTED_CATEGORY_COUNTS = Object.freeze({
  beaches: 8,
  restaurants: 45,
  hotels: 35,
  shops: 12,
  transport: 8,
  attractions: 8,
  tours: 6,
  nightlife: 5,
  emergencies: 4,
});

describe("V1 explore locations control", () => {
  it("exposes the nine frozen location categories in canonical menu order", () => {
    const categories = getExploreLocationsCategories();

    expect(categories.map(({ value }) => value)).toEqual([
      "beaches",
      "tours",
      "attractions",
      "restaurants",
      "hotels",
      "nightlife",
      "shops",
      "transport",
      "emergencies",
    ]);
    expect(categories.map(({ label }) => label)).toEqual([
      "Praias",
      "Passeios",
      "Atrações",
      "Restaurantes",
      "Pousadas",
      "Vida Noturna",
      "Lojas",
      "Transporte",
      "Emergências",
    ]);
  });

  it("preserves the exact V1 POI counts without synthesizing locations", () => {
    const categories = getExploreLocationsCategories();

    expect(
      Object.fromEntries(categories.map(({ value, count }) => [value, count])),
    ).toEqual(EXPECTED_CATEGORY_COUNTS);

    const total = categories.reduce((sum, category) => sum + category.count, 0);
    expect(total).toBe(131);
  });

  it("returns only frozen catalog entries for the selected category", () => {
    const beaches = getExploreLocationsForCategory("beaches");

    expect(beaches).toHaveLength(8);
    expect(beaches.map(({ name }) => name)).toContain("Primeira Praia");
    expect(
      beaches.every(
        ({ category, latitude, longitude }) =>
          category === "beaches" &&
          Number.isFinite(latitude) &&
          Number.isFinite(longitude),
      ),
    ).toBe(true);
  });

  it("binds categories to stable ids on the existing assistant buttons", () => {
    expect(getAssistantCategoryButtonId("beaches")).toBe(
      "assistant-category-beaches",
    );
    expect(getAssistantCategoryButtonId("restaurants")).toBe(
      "assistant-category-restaurants",
    );
  });

  it("reuses the localized Search-to-Details command contract", () => {
    expect(createExploreLocationDetailsCommand("Toca do Morcego")).toBe(
      "Fale sobre Toca do Morcego",
    );
  });
});

describe("discovery grouping across the actual catalog", () => {
  it("retains every source record and category at dense and separated camera scales", () => {
    const locations = morroV1SearchCatalog;
    const members = locations.map((location, index) => ({
      ...location,
      key: `catalog:${index}`,
      location,
    }));
    for (const scale of [1, 100_000]) {
      const groups = groupProjectedMarkers(members, ([x, y]) => ({
        x: x * scale,
        y: y * scale,
      }));
      const represented = groups.flatMap(({ members }) =>
        members.map(({ location }) => location),
      );
      expect(represented).toHaveLength(locations.length);
      expect(new Set(represented)).toEqual(new Set(locations));
      expect(new Set(represented.map(({ category }) => category)).size).toBe(9);
      for (const group of groups) expect(group.members).toContain(group.anchor);
    }
  });
});

// Execute the actual producer functions together: the fixture supplies only
// browser/queue boundaries, never an alternative implementation of geometry.
type Actions = Record<"publish" | "regroup" | "clear" | "dispose", () => void>;

function actualDatasetProducer() {
  const sourcePath = new URL("./explore-locations-control.ts", import.meta.url);
  const ast = ts.createSourceFile(
    sourcePath.pathname,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
  );
  const names = new Set([
    "clearDatasetGeometry",
    "publishDatasetGeometry",
    "syncLocationCounts",
    "installDataset",
    "updateMapState",
    "renderMapOnlyLocations",
  ]);
  const methods = ["prepareExternalTour", "setGeospatialEngine"];
  const actual = (name: string, kind: ts.SyntaxKind): string => {
    const matches: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      if (node.kind === kind) {
        const declaration = node as ts.NamedDeclaration;
        if (declaration.name?.getText(ast) === name) matches.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (matches.length !== 1)
      throw Error(`Expected one ${name}; found ${matches.length}`);
    return matches[0]!.getText(ast);
  };
  const declarations = [...names].map(
    (name) => `const ${actual(name, ts.SyntaxKind.VariableDeclaration)};`,
  );
  const body = `
    let destroyed=false, datasetGeometryGeneration=0, datasetGeneration=0, interactionGeneration=0, renderGeneration=0;
    let externalTourOwnsMap=false, visibleLocations=[], activeMarkerMembers, retainedMenuContext=false, datasetCategory="places", datasetCriteria=[], placeReturnCriteria=[];
    let activeStage="menu", activeCategory, activeCategoryButton, activePlace, activePlaceLocation;
    let activePlaceActionValues=[], activeSearchQuery="", placeReturnLocations=[], placeReturnMessage="", placeReturnIsSearch=false;
    let closeMarkerList,refreshMarkerList,returnToMarkerList,restoreCurrentFlow;
    let markerQueue=Promise.resolve();
    const markerRegistry=new Map(), initialRegistry=new Map(), attributes=new Map();
    const geometryElement={setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k),get dataset(){return {exploreState:attributes.get("data-explore-state")}}};
    const document={getElementById:()=>geometryElement};
    const placeCamera={invalidate(){}};
    const removeAssistantFlowResults=()=>{}, resetCategoryTriggerState=()=>{}, restoreCategoryRail=()=>{},showMainMenu=()=>{},clearExploreRuntimeStatus=()=>{},emitStateChange=()=>{syncLocationCounts();};
    const exploreFlowBottomSheet={hide(){}},immersiveTourController={destroy(){}};
    let geospatialEngine={initialized:true,replaceMarkers:async()=>{}};
    const loadHybridGlobalMarkers=()=>{};
    const clearTourPresentation=()=>{},renderAppliedFilters=()=>{};
    const renderLocationsOnMap=async(locations,category,_open,_camera,criteria=datasetCriteria)=>{installDataset(locations,category,criteria);updateMapState(locations.length,category,"ready");};
    ${actual("categoryBounds", ts.SyntaxKind.FunctionDeclaration)}
    ${declarations.join("\n")}
    const producer={${methods.map((name) => actual(name, ts.SyntaxKind.MethodDeclaration)).join(",")}};
    return {install:(records,category,criteria=[])=>installDataset(records,category,criteria),publish:publishDatasetGeometry,prepare:()=>producer.prepareExternalTour(),mapOnly:renderMapOnlyLocations,
      regroup:()=>updateMapState(visibleLocations.length,datasetCategory,"ready"),
      recover:async()=>{producer.setGeospatialEngine({initialized:true,replaceMarkers:async()=>{}});await markerQueue;},
      subset:members=>{activeMarkerMembers=members;syncLocationCounts();},
      clear:clearDatasetGeometry, dispose:()=>{destroyed=true;publishDatasetGeometry();},
      hold:()=>{let release;markerQueue=new Promise(r=>release=r);return release;},
      attribute:name=>attributes.get(name),
      snapshot:()=>({attributes:Object.fromEntries(attributes),generation:datasetGeometryGeneration,external:externalTourOwnsMap,criteria:datasetCriteria})};
  `;
  const javascript = ts.transpileModule(body, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const execute = compileFunction(javascript, []) as () => Actions & {
    install(
      records: readonly object[],
      category: string,
      criteria?: readonly object[],
    ): void;
    mapOnly(records: readonly object[], category?: string): Promise<boolean>;
    recover(): Promise<void>;
    prepare(): Promise<ExternalTourMapPreparation | null>;
    attribute(name: string): string | undefined;
    subset(records: readonly object[] | undefined): void;
    hold(): () => void;
    snapshot(): {
      attributes: Record<string, string>;
      generation: number;
      external: boolean;
      criteria: readonly object[];
    };
  };
  return execute();
}

describe("actual dataset geometry and external ownership lifecycle", () => {
  const BOUNDS = "data-explore-dataset-bounds";
  const GENERATION = "data-explore-dataset-generation";
  const records = Object.freeze([
    { name: "West", latitude: -13, longitude: -39 },
    { name: "East", latitude: -12, longitude: -38 },
  ]);
  it("preserves the absent show-all category through regroup and subset return without losing an explicit map filter", async () => {
    const producer = actualDatasetProducer();
    expect(await producer.mapOnly(records, "beaches")).toBe(true);
    expect(producer.attribute("data-explore-category")).toBe("beaches");
    expect(await producer.mapOnly(records)).toBe(true);
    const full = producer.snapshot();
    expect(full.attributes["data-explore-stage"]).toBe("menu");
    expect(full.attributes["data-explore-category"]).toBeUndefined();
    producer.subset(records.slice(0, 1));
    producer.regroup();
    expect(producer.attribute("data-explore-category")).toBeUndefined();
    expect(producer.attribute("data-map-member-count")).toBe("2");
    producer.subset(undefined);
    producer.regroup();
    expect(producer.attribute("data-explore-category")).toBeUndefined();
    expect(producer.snapshot().generation).toBe(full.generation);
    expect(producer.attribute(BOUNDS)).toBe(full.attributes[BOUNDS]);
    expect(await producer.mapOnly(records, "beaches")).toBe(true);
    producer.regroup();
    expect(producer.attribute("data-explore-category")).toBe("beaches");
  });
  it("recovers the installed semantic category and complete geometry after an engine replacement", async () => {
    const producer = actualDatasetProducer();
    for (const category of ["beaches", undefined]) {
      await producer.mapOnly(records, category);
      const before = producer.snapshot();
      await producer.recover();
      const after = producer.snapshot();
      expect(after.attributes["data-explore-category"]).toBe(category);
      expect(after.attributes["data-explore-stage"]).toBe("menu");
      expect(after.attributes["data-explore-state"]).toBe("ready");
      expect(after.attributes["data-map-member-count"]).toBe("2");
      expect(after.attributes[BOUNDS]).toBe(before.attributes[BOUNDS]);
    }
  });
  it("keeps full bounds and generation across subset/regroup publication, and clears on a new dataset", () => {
    const producer = actualDatasetProducer();
    const criteria = [{ kind: "category", value: "beaches" }];
    producer.install(records, "beaches", criteria);
    producer.publish();
    const initial = producer.snapshot();
    expect(initial.attributes[BOUNDS]).toBe("[[-39,-13],[-38,-12]]");
    expect(initial.attributes[GENERATION]).toBe("1");
    producer.subset(records.slice(0, 1));
    producer.publish();
    expect(producer.snapshot().attributes).toMatchObject({
      "data-map-member-count": "2",
      "data-explore-location-count": "1",
      [GENERATION]: "1",
      [BOUNDS]: initial.attributes[BOUNDS],
    });
    producer.subset(undefined);
    producer.publish();
    expect(producer.snapshot().generation).toBe(1);
    expect(producer.snapshot().criteria).toEqual(criteria);
    producer.install(records, "beaches");
    expect(producer.attribute(BOUNDS)).toBeUndefined();
    expect(producer.attribute(GENERATION)).toBeUndefined();
    producer.publish();
    expect(producer.attribute(GENERATION)).toBe("2");
    producer.clear();
    expect(producer.attribute(BOUNDS)).toBeUndefined();
    producer.publish();
    producer.dispose();
    expect(producer.attribute(GENERATION)).toBeUndefined();
  });
  it("invalidates a waiting external handoff on reset and prevents a stale selection or geometry publication", async () => {
    const producer = actualDatasetProducer();
    producer.install(records, "beaches");
    producer.publish();
    expect(producer.snapshot().criteria).toEqual([]);
    const release = producer.hold();
    const waiting = producer.prepare();
    expect(producer.snapshot()).toMatchObject({
      external: true,
      generation: 2,
    });
    expect(producer.attribute("data-map-member-count")).toBe("0");
    expect(producer.attribute(BOUNDS)).toBeUndefined();
    producer.install(records, "hotels");
    release();
    expect(await waiting).toBeNull();
    const boundary = await producer.prepare();
    expect(boundary).not.toBeNull();
    expect(boundary!.publishGeometry(records)).toBe(true);
    expect(producer.attribute(GENERATION)).toBe("4");
    producer.install(records, "beaches");
    expect(boundary!.isCurrent()).toBe(false);
    let selected = false;
    expect(
      await boundary!.runSelection(async () => {
        selected = true;
        return 1;
      }),
    ).toBeNull();
    expect(selected).toBe(false);
    expect(boundary!.publishGeometry(records)).toBe(false);
    expect(producer.attribute(BOUNDS)).toBeUndefined();
  });
});

describe("applied map filter projection", () => {
  it("counts committed executor criteria including fine filters, independently of marker or selection count", () => {
    const criteria = [
      { kind: "category", value: "restaurants" },
      { kind: "filter", value: "vegetariano" },
    ];
    expect(
      appliedMapFilterSummary({
        exploreState: "ready",
        exploreCriteria: JSON.stringify(criteria),
      }),
    ).toEqual({ phase: "ready", criteria, count: 2 });
    expect(
      appliedMapFilterSummary({ exploreState: "ready", exploreCriteria: "[]" })
        .count,
    ).toBe(0);
  });
  it("never calls loading or failed clearing zero confirmed filters", () => {
    expect(
      appliedMapFilterSummary({
        exploreState: "loading",
        exploreCriteria: "[]",
      }).count,
    ).toBe(null);
    expect(
      appliedMapFilterSummary({ exploreState: "error", exploreCriteria: "[]" })
        .count,
    ).toBe(null);
  });
});

describe("external tour criteria publication", () => {
  it("clears prior criteria on takeover and confirms zero only at guarded geometry publication", async () => {
    const producer = actualDatasetProducer();
    const records = [{ name: "One", latitude: -13, longitude: -39 }];
    producer.install(records, "restaurants", [
      { kind: "category", value: "restaurants" },
      { kind: "filter", value: "vegetariano" },
    ]);
    const boundary = await producer.prepare();
    expect(producer.snapshot().criteria).toEqual([]);
    expect(
      producer.snapshot().attributes["data-explore-criteria"],
    ).toBeUndefined();
    expect(producer.snapshot().attributes["data-explore-state"]).toBe(
      "loading",
    );
    expect(boundary?.publishGeometry(records)).toBe(true);
    expect(producer.snapshot().attributes["data-explore-criteria"]).toBe("[]");
    expect(producer.snapshot().attributes["data-explore-state"]).toBe("ready");
    producer.install(records, "beaches", [
      { kind: "category", value: "beaches" },
    ]);
    expect(boundary?.publishGeometry(records)).toBe(false);
    expect(producer.snapshot().criteria).toEqual([
      { kind: "category", value: "beaches" },
    ]);
  });
});

interface PlaceDetailConsumer {
  document: Document;
  conversation: AssistantConversationOrchestrator;
  presenter(): Record<string, string>;
  media(): { state: string; src?: string } | undefined;
  detailOrder(): string[];
  setPresenterData(values: Record<string, string>): void;
  setAssistantHidden(hidden: boolean): void;
  select(location: ExploreMapLocation): Promise<void>;
  changeLocale(locale: string): void;
  execute(command: ExploreLocationsCommand): Promise<boolean>;
  holdMarkers(): () => void;
  holdPosition(): () => void;
  listenerCount(type: string): number;
  click(value: string): void;
  readState(): { placeId?: string | null; stage: string };
  setFavorites(value: unknown[]): void;
  refreshSaved(): void;
  setLocations(locations: ExploreMapLocation[]): void;
  getLocations(): ExploreSearchResult[];
  getRenderedLocations(): ExploreSearchResult[];
  getFramedLocations(): ExploreSearchResult[];
  getFramingCalls(): ExploreSearchResult[][];
  getSelectedMarkerIds(): string[];
  setProjectedPoint(x: number, y: number): void;
  setMapMode(mode: string): void;
  search(locations: ExploreSearchResult[]): void;
  back(): void;
  openMembers(locations: ExploreMapLocation[]): () => void;
  setCamera(longitude: number, latitude: number, zoom: number): void;
  camera(): {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  };
  rails: Array<Array<{ label: string; value: string }>>;
  messages: Array<{ name: string; description: string; lineBreaks: number }>;
  events: Array<{ type: string; detail: Record<string, unknown> }>;
  snapshot(): {
    place: string | undefined;
    stage: string;
    generation: number;
    mapCalls: number;
    detailRequests: number;
    positionRequests: number;
  };
}

function actualPlaceDetailConsumer(
  locale: "pt" | "en" | "es" | "he",
  getDetail: (placeId: string, options: { locale: string }) => unknown,
  styleReady?: Promise<void>,
): PlaceDetailConsumer {
  const sourcePath = new URL("./explore-locations-control.ts", import.meta.url);
  const ast = ts.createSourceFile(
    sourcePath.pathname,
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
  );
  const names = new Set([
    "CANONICAL_MAP_DESTINATION_ID",
    "stateSnapshot",
    "renderPlaceDetailMessage",
    "readActivePlaceDetail",
    "handlePlaceAction",
    "renderPlaceActionsRail",
    "selectLocation",
    "localeObserver",
    "replaceMarkersSerial",
    "installDataset",
    "updateMapState",
    "renderLocationsOnMap",
    "renderMapOnlyLocations",
    "execute",
    "applyFlowOption",
    "openCategory",
    "openCategoryByValue",
    "renderPlaces",
    "renderSearchPlaces",
    "returnFromPlaceDetail",
    "placeCamera",
    "backToMenu",
    "openMarkerMembers",
  ]);
  const declarations: string[] = [];
  const functions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) {
      declarations.push(`const ${node.getText(ast)};`);
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      ["getCurrentPosition", "renderFilters"].includes(node.name.text)
    ) {
      functions.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (declarations.length !== names.size || functions.length !== 2)
    throw new Error(
      "Expected the actual place detail consumers and locale observer",
    );

  // Run the production consumers together. Only browser/network boundaries
  // are fixtures; the ID, generation, copy and dispatch decisions are real.
  const javascript = ts.transpileModule(
    `
      const {createExploreCameraReturn,createPlaceDetailMedia,isExploreLocationVisible,styleReady,publicPlaceCatalogText,locale,getDetail,normalizeSearchText,normalizeAssistantVoiceLanguage,getExploreLocationsCategories,getExploreLocationsForCategory,getAssistantCategoryButtonId,createExploreLocationDetailsCommand,resolveExploreLocationByName,getV1ExploreSubcategoryOptions,resolveV1ExploreAppliedResult,morroV1SearchCatalog,getV1ExploreLabel,getV1ExploreUiCopy,getV1ExplorePlaceActionOptions,getAssistantConversationOrchestrator}=dependencies;
      let styleGeneration=0;
      const placeDetailStyles={cancel(){styleGeneration++;},run(action){const generation=++styleGeneration;if(styleReady)void styleReady.then(()=>{if(generation===styleGeneration)action()}).catch(()=>{});else action();}};
      let activePlace,activePlaceLocation,activePlaceDetail,activeCategory,activeStage="menu",interactionGeneration=0;
      let refreshSavedPlaceActions=()=>{};
      let activePlaceActionValues=[],datasetCriteria=[],mapCalls=0,detailRequests=0;
      const messages=[],events=[],rails=[];
      const listeners=new Map();
      let positionRequests=0,holdPosition=false,resolvePosition;
      const elements=new Map();
      class HTMLElement {
        constructor(){this.dataset={};this.textContent="";this.children=[];this.classList={remove(){},add(){}};}
        getAttribute(name){return this[name]??null;}
        setAttribute(name,value){this[name]=value;if(name.startsWith("data-"))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;}
        removeAttribute(name){delete this[name];if(name.startsWith("data-"))delete this.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())];}
        get childNodes(){return this.children;}
        appendChild(node){this.children.push(node);node.parentNode=this;node.isConnected=true;if(node.id)elements.set(node.id,node);}
        prepend(node){this.children.unshift(node);}
        replaceChildren(...nodes){
          this.children=nodes;
          if(this.className==="md-assistant-place-detail-description")this.textContent=nodes.map(node=>node.textContent).join("");
          if(this.id===ASSISTANT_FLOW_MESSAGE_ID){
            messages.push({name:nodes[0]?.textContent??"",description:nodes.find(n=>n.className==="md-assistant-place-detail-description")?.textContent??"",lineBreaks:nodes.find(n=>n.className==="md-assistant-place-detail-description")?.children.filter(n=>n.tagName==="br").length??0});
          }
        }
        addEventListener(){}
        remove(){if(elements.get(this.id)===this)elements.delete(this.id);if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.isConnected=false;}
        replaceWith(node){const parent=this.parentNode;if(parent){parent.children=parent.children.map(child=>child===this?node:child);node.parentNode=parent;node.isConnected=true;}this.isConnected=false;if(node.id)elements.set(node.id,node);}
      }
      class HTMLButtonElement extends HTMLElement {}
      class CustomEvent { constructor(type,init) { this.type=type;this.detail=init.detail; } }
      class MutationObserverCtor { constructor(callback) { this.callback=callback; } }
      const ASSISTANT_FLOW_MESSAGE_ID="assistant-category-results-message";
      const ASSISTANT_FLOW_RESULTS_ID="assistant-category-results";
      const area=new HTMLElement();
      const map=new HTMLElement();map.dataset.exploreState="ready";elements.set("map",map);
      map.getBoundingClientRect=()=>({left:0,top:0,width:390,height:844,right:390,bottom:844});
      let projectedPoint={x:100,y:100};
      let camera={center:[-38.91,-13.38],zoom:14,pitch:20,bearing:35};
      const nativeMap={project:()=>projectedPoint,getCenter:()=>({lng:camera.center[0],lat:camera.center[1]}),getZoom:()=>camera.zoom,getPitch:()=>camera.pitch,getBearing:()=>camera.bearing,stop(){},jumpTo:value=>{camera={...camera,...value};}},currentMap=()=>nativeMap;
      let storedFavorites=[];
      let mapMarkerElements=[];
      const document={body:{dataset:{mdMode:"explore"}},documentElement:{lang:locale},activeElement:null,
        defaultView:{localStorage:{getItem:()=>JSON.stringify({favoritePlaces:storedFavorites})},fetch() { throw Error("Unexpected direct network access"); },navigator:{geolocation:{getCurrentPosition(resolve){positionRequests+=1;if(holdPosition)resolvePosition=resolve;else resolve({coords:{latitude:-13.38,longitude:-38.91}});}}}},
        querySelector:()=>null,querySelectorAll:selector=>selector.includes("morro-explore-marker")?mapMarkerElements:[],
        getElementById:id=>elements.get(id)??null,
        createElement:(tag)=>Object.assign(new HTMLElement(),{tagName:tag}),
        addEventListener:(type,listener)=>{const current=listeners.get(type)??new Set();current.add(listener);listeners.set(type,current);},
        removeEventListener:(type,listener)=>listeners.get(type)?.delete(listener),
        dispatchEvent:event=>{events.push(event);for(const listener of listeners.get(event.type)??[])listener(event);}};
      for(const category of getExploreLocationsCategories(locale))elements.set(getAssistantCategoryButtonId(category.value),new HTMLButtonElement());
      const assistantMessagesArea=()=>area,hideMainMenu=()=>{};
      const currentLocale=()=>normalizeAssistantVoiceLanguage(document.documentElement.lang);
      const currentCategories=()=>getExploreLocationsCategories(currentLocale());
      const contextualRailScroll=null,exploreFlowBottomSheet={hide(){},setStatus(){},getState(){return null;}};
      const UNREGISTERED_COMMERCIAL_ACTION_IDS=new Set();
      const removeAssistantFlowResults=()=>{},requestAssistantOpen=()=>{};
      const renderContextualRail=(_stage,_label,options)=>{rails.push(options);return null;};
      const createPublicPlaceMapClient=()=>({getDetail:(id,options)=>{detailRequests+=1;return getDetail(id,options);}});
      let destroyed=false,renderGeneration=0,datasetGeneration=0,datasetGeometryGeneration=0;
      let externalTourOwnsMap=false,retainedMenuContext=false,activeMarkerMembers,datasetCategory,visibleLocations=[];
      let activeCategoryButton,activeSearchQuery="",restoreCurrentFlow,closeMarkerList,refreshMarkerList,returnToMarkerList;
      let placeReturnLocations=[],placeReturnCriteria=[],placeReturnMessage="",placeReturnIsSearch=false;
      let markerQueue=Promise.resolve(),markerProviderReady=Promise.resolve();
      let renderedLocations=[],framedLocations=[],framingCalls=[];
      const geospatialEngine={initialized:true,replaceMarkers:(markers)=>{renderedLocations=markers;mapMarkerElements=markers.map(marker=>{const el=new HTMLElement();el.dataset.markerId=marker.id;return el;});mapCalls+=1;return markerProviderReady;}};
      const markerRegistry=new Map();
      const clearDatasetGeometry=()=>{},publishDatasetGeometry=()=>{},syncLocationCounts=()=>{};
      const groupedMarkers=(locations,registry)=>{registry.clear();return locations.map((location,index)=>{const id=String(index);registry.set(id,[location]);return {...location,id};});};
      const frameLocationsOnMap=(_document,locations)=>{framedLocations=locations;framingCalls.push(locations);if(locations[0])camera={...camera,center:[locations[0].longitude,locations[0].latitude],zoom:16};},clearTourPresentation=()=>{},resetCategoryTriggerState=()=>{},showMainMenu=()=>{},clearExploreRuntimeStatus=()=>{};
      const discoveryClusterLabel=(count)=>String(count)+" places";
      const renderFlow=(text)=>{let message=elements.get(ASSISTANT_FLOW_MESSAGE_ID);if(!message){message=new HTMLElement();message.id=ASSISTANT_FLOW_MESSAGE_ID;area.appendChild(message);}message.dataset.messageType="category-flow";message.children=[];message.textContent=text;elements.get(ASSISTANT_FLOW_RESULTS_ID)?.remove();const results=new HTMLElement();results.id=ASSISTANT_FLOW_RESULTS_ID;results.setAttribute("aria-label",text);area.appendChild(results);return null;};
      const setExploreRuntimeStatus=()=>{},emitStateChange=()=>{};
      const shareActivePlace=()=>{events.push({type:"share-observed",detail:{}});},tourTicketingUrl=()=>null,startImmersiveTour=()=>{},loadHybridGlobalMarkers=()=>{};
      const refreshCategoryPresentation=()=>{},restoreCategoryRail=()=>{},renderExploreRuntimeStatus=()=>{};
      const exploreRuntimeStatusDescriptor=null,immersiveTourController=null;
      ${functions.join("\n")}
      ${declarations.join("\n")}
      return {document,execute,select:selectLocation,click:handlePlaceAction,readState:stateSnapshot,setFavorites:(value)=>{storedFavorites=value;},refreshSaved:()=>refreshSavedPlaceActions(),rails,messages,events,
        search:locations=>renderSearchPlaces(locations,"Resultados","query"),back:returnFromPlaceDetail,
        openMembers:locations=>{openMarkerMembers(locations);const restore=closeMarkerList;return ()=>restore?.();},
        setCamera:(longitude,latitude,zoom)=>{camera={...camera,center:[longitude,latitude],zoom};},camera:()=>({...camera,center:[...camera.center]}),
        setProjectedPoint:(x,y)=>{projectedPoint={x,y};},
        setMapMode:mode=>{document.body.dataset.mdMode=mode;},
        getFramingCalls:()=>framingCalls,
        setLocations:locations=>{visibleLocations=locations;datasetCategory="search";},getLocations:()=>visibleLocations,getRenderedLocations:()=>renderedLocations,getFramedLocations:()=>framedLocations,getSelectedMarkerIds:()=>mapMarkerElements.filter(el=>el.dataset.selected==="true").map(el=>el.dataset.markerId),
        listenerCount:type=>listeners.get(type)?.size??0,
        holdMarkers:()=>{let release;markerProviderReady=new Promise(resolve=>{release=resolve;});return ()=>{markerProviderReady=Promise.resolve();release();};},
        holdPosition:()=>{holdPosition=true;return ()=>{holdPosition=false;resolvePosition?.({coords:{latitude:-13.38,longitude:-38.91}});};},
        changeLocale:locale=>{document.documentElement.lang=locale;localeObserver.callback([{attributeName:"lang"}]);},
        conversation:getAssistantConversationOrchestrator(document),
        presenter:()=>({...elements.get(ASSISTANT_FLOW_MESSAGE_ID)?.dataset}),
        setAssistantHidden:(hidden)=>{let el=elements.get("assistant-messages");if(!el){el=new HTMLElement();elements.set("assistant-messages",el);}el.setAttribute("aria-hidden",String(hidden));},
        detailOrder:()=>elements.get(ASSISTANT_FLOW_MESSAGE_ID)?.children.map(node=>node.className)??[],
        media:()=>{const figure=elements.get(ASSISTANT_FLOW_MESSAGE_ID)?.children.find(node=>node.className==="md-place-detail-media");return figure?{state:figure.dataset.mediaState,src:figure.children.find(node=>node.tagName==="img")?.src}:undefined;},
        setPresenterData:values=>Object.assign(elements.get(ASSISTANT_FLOW_MESSAGE_ID).dataset,values),
        snapshot:()=>({place:activePlace,stage:activeStage,generation:interactionGeneration,mapCalls,detailRequests,positionRequests})};
    `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const dependencies = {
    createExploreCameraReturn,
    isExploreLocationVisible,
    styleReady,
    createPlaceDetailMedia,
    publicPlaceCatalogText,
    locale,
    getDetail,
    normalizeSearchText,
    normalizeAssistantVoiceLanguage,
    getExploreLocationsCategories,
    getExploreLocationsForCategory,
    getAssistantCategoryButtonId,
    createExploreLocationDetailsCommand,
    resolveExploreLocationByName,
    getV1ExploreSubcategoryOptions,
    resolveV1ExploreAppliedResult,
    morroV1SearchCatalog,
    getV1ExploreLabel,
    getV1ExploreUiCopy,
    getV1ExplorePlaceActionOptions,
    getAssistantConversationOrchestrator,
  };
  const execute = compileFunction(javascript, ["dependencies"]) as (
    context: typeof dependencies,
  ) => PlaceDetailConsumer;
  return execute(dependencies);
}

const canonicalLocation = (placeId: string): ExploreSearchResult => ({
  name: "Same place name",
  category: "beaches",
  latitude: -13.38,
  longitude: -38.91,
  source: "canonical",
  placeId,
});

function canonicalDetail(placeId: string, description = "Full place details") {
  return {
    profile: {
      id: placeId,
      name: "Same place name",
      description,
      shortDescription: "",
    },
    actions: {
      placeId,
      primaryAction: null,
      secondaryActions: [
        {
          id: "info",
          label: "Saiba mais",
          value: `place-action:info:${placeId}`,
          disabled: false,
        },
        {
          id: "photos",
          label: "Photo channel label",
          value: "ver fotos",
          disabled: false,
        },
      ],
    },
  };
}

describe("selected canonical place detail action", () => {
  it.each(["canonical", "catalog"] as const)(
    "restores the selected %s detail after inspecting a marker group",
    async (source) => {
      const consumer = actualPlaceDetailConsumer("pt", () =>
        canonicalDetail("place-a"),
      );
      const location =
        source === "canonical"
          ? canonicalLocation("place-a")
          : morroV1SearchCatalog.find(
              (item) => item.name === "Primeira Praia",
            )!;
      const members = [location, { ...location, name: "Other member" }];
      consumer.setLocations(members);
      await consumer.select(location);
      const message = consumer.document.getElementById(
        "assistant-category-results-message",
      )!;
      const content = Array.from(message.childNodes);
      const area = message.parentNode as HTMLElement;
      area.scrollTop = 37;
      const before = consumer.snapshot();
      const camera = consumer.camera();
      const close = consumer.openMembers(members);
      expect(consumer.snapshot().stage).toBe("places");
      expect(
        consumer.document.getElementById("assistant-category-results"),
      ).not.toBeNull();
      close();
      expect(consumer.snapshot()).toEqual(before);
      expect(consumer.camera()).toEqual(camera);
      const restored = consumer.document.getElementById(message.id)!;
      expect(restored.dataset.messageType).toBe("place-detail");
      expect(restored).toBe(message);
      expect(Array.from(restored.childNodes)).toEqual(content);
      expect(area.scrollTop).toBe(37);
      expect(
        consumer.document.getElementById("assistant-category-results"),
      ).toBeNull();
      expect(consumer.rails.at(-1)).toContainEqual(
        expect.objectContaining({ value: "__back_to_places__" }),
      );
    },
  );

  it("ignores a stale group return after selecting another place", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const a = canonicalLocation("place-a");
    const b = { ...canonicalLocation("place-b"), name: "Other place" };
    consumer.setLocations([a, b]);
    await consumer.select(a);
    const close = consumer.openMembers([a, b]);
    await consumer.select(b);
    const before = consumer.snapshot();
    const message = consumer.document.getElementById(
      "assistant-category-results-message",
    );
    close();
    expect(consumer.snapshot()).toEqual(before);
    expect(
      consumer.document.getElementById("assistant-category-results-message"),
    ).toBe(message);
  });

  it("resumes an unresolved canonical detail without moving the map", async () => {
    let resolveFirst!: (detail: ReturnType<typeof canonicalDetail>) => void;
    const pending = new Promise<ReturnType<typeof canonicalDetail>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    let requests = 0;
    const consumer = actualPlaceDetailConsumer("pt", () =>
      ++requests === 1
        ? pending
        : canonicalDetail("place-a", "Resolved detail"),
    );
    const a = canonicalLocation("place-a");
    const b = { ...a, name: "Other member" };
    consumer.setLocations([a, b]);
    const selection = consumer.select(a);
    await Promise.resolve();
    const close = consumer.openMembers([a, b]);
    resolveFirst(canonicalDetail("place-a", "Response while group is open"));
    await selection;
    const camera = consumer.camera();
    const mapCalls = consumer.snapshot().mapCalls;
    close();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(requests).toBe(2);
    expect(consumer.snapshot().stage).toBe("detail");
    expect(consumer.snapshot().mapCalls).toBe(mapCalls);
    expect(consumer.camera()).toEqual(camera);
    expect(consumer.messages.at(-1)?.description).toBe("Resolved detail");
  });

  it("restores detail actions in the language chosen while the group was open", async () => {
    const consumer = actualPlaceDetailConsumer("pt", () => null);
    const a = morroV1SearchCatalog.find(
      (item) => item.name === "Primeira Praia",
    )!;
    const members = [a, { ...a, name: "Other member" }];
    consumer.setLocations(members);
    await consumer.select(a);
    const camera = consumer.camera();
    const mapCalls = consumer.snapshot().mapCalls;
    const close = consumer.openMembers(members);
    consumer.changeLocale("he");
    close();
    await Promise.resolve();
    expect(consumer.snapshot().stage).toBe("detail");
    expect(consumer.snapshot().mapCalls).toBe(mapCalls);
    expect(consumer.camera()).toEqual(camera);
    expect(consumer.rails.at(-1)).toContainEqual(
      expect.objectContaining({
        value: "__back_to_places__",
        label: `⬅️ ${getV1ExploreLabel("back", "he")}`,
      }),
    );
  });

  it("hydrates confirmed details when styles settle while the marker group is open", async () => {
    let releaseStyles!: () => void;
    const styles = new Promise<void>((resolve) => {
      releaseStyles = resolve;
    });
    const consumer = actualPlaceDetailConsumer(
      "pt",
      () => canonicalDetail("place-a"),
      styles,
    );
    const a = canonicalLocation("place-a");
    const members = [a, { ...a, name: "Other member" }];
    consumer.setLocations(members);
    await consumer.select(a);
    expect(consumer.media()).toBeUndefined();
    const close = consumer.openMembers(members);
    releaseStyles();
    await Promise.resolve();
    const camera = consumer.camera();
    const requests = consumer.snapshot().detailRequests;
    close();
    await Promise.resolve();
    expect(consumer.media()).toEqual({ state: "missing", src: undefined });
    expect(consumer.messages.at(-1)?.description).toBe("Full place details");
    expect(consumer.snapshot().detailRequests).toBe(requests);
    expect(consumer.camera()).toEqual(camera);
  });

  it.each([
    ["pt", "Ver detalhes"],
    ["en", "View details"],
    ["es", "Ver detalles"],
    ["he", "הצגת פרטים"],
  ] as const)(
    "labels only the handled canonical rail in %s",
    async (locale, label) => {
      const consumer = actualPlaceDetailConsumer(locale, () =>
        canonicalDetail("place-a"),
      );
      await consumer.select(canonicalLocation("place-a"));
      expect(consumer.rails.at(-1)).toContainEqual(
        expect.objectContaining({ label, value: "place-action:info:place-a" }),
      );
      expect(consumer.rails.at(-1)).toContainEqual(
        expect.objectContaining({
          label: "Photo channel label",
          value: "ver fotos",
        }),
      );
      expect(consumer.rails[0]).toContainEqual(
        expect.objectContaining({
          label: `ℹ️ ${getV1ExploreLabel("learnMore", locale)}`,
          value: "saiba mais",
        }),
      );
      const before = consumer.snapshot();
      consumer.click("place-action:info:place-a");
      expect(consumer.messages.at(-1)?.description).toBe("Full place details");
      expect(consumer.events).toEqual([
        {
          type: "morro:assistant-place-details-presented",
          detail: {
            turnId: consumer.conversation.snapshot().lastMeaningfulTurn,
          },
        },
      ]);
      expect(consumer.snapshot()).toEqual(before);
    },
  );

  it.each(["profile", "actions"] as const)(
    "rejects a mismatched %s ID without a free-text query",
    async (field) => {
      const detail = canonicalDetail("place-a");
      if (field === "profile") detail.profile.id = "place-b";
      else detail.actions.placeId = "place-b";
      const consumer = actualPlaceDetailConsumer("pt", () => detail);
      await consumer.select(canonicalLocation("place-a"));
      const count = consumer.messages.length;
      consumer.click("place-action:info:place-a");
      consumer.click("place-action:info:place-b");
      expect(consumer.messages).toHaveLength(count);
      expect(consumer.events).toEqual([]);
      expect(
        consumer.rails
          .at(-1)
          ?.some(({ value }) => value.startsWith("place-action:info:")),
      ).toBe(false);
    },
  );

  it("omits details when both descriptions are empty, but accepts a real short description", async () => {
    const empty = canonicalDetail("place-a", "  ");
    const consumer = actualPlaceDetailConsumer("pt", () => empty);
    await consumer.select(canonicalLocation("place-a"));
    expect(
      consumer.rails
        .at(-1)
        ?.some(({ value }) => value.startsWith("place-action:info:")),
    ).toBe(false);
    const count = consumer.messages.length;
    consumer.click("place-action:info:place-a");
    expect(consumer.messages).toHaveLength(count);
    expect(consumer.events).toEqual([]);

    empty.profile.shortDescription = "Short description from the profile";
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    expect(consumer.messages.at(-1)?.description).toBe(
      empty.profile.shortDescription,
    );
  });

  it("ignores a late response for another ID with the same name", async () => {
    let resolveFirst!: (detail: ReturnType<typeof canonicalDetail>) => void;
    const first = new Promise<ReturnType<typeof canonicalDetail>>((resolve) => {
      resolveFirst = resolve;
    });
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      id === "place-a" ? first : canonicalDetail("place-b", "Details for B"),
    );
    const waiting = consumer.select(canonicalLocation("place-a"));
    await consumer.select(canonicalLocation("place-b"));
    resolveFirst(canonicalDetail("place-a", "Late details for A"));
    await waiting;
    const count = consumer.messages.length;
    consumer.click("place-action:info:place-a");
    expect(consumer.messages).toHaveLength(count);
    consumer.click("place-action:info:place-b");
    expect(consumer.messages.at(-1)?.description).toBe("Details for B");
    expect(consumer.rails.at(-1)).toContainEqual(
      expect.objectContaining({ value: "place-action:info:place-b" }),
    );
    expect(consumer.events).toEqual([
      {
        type: "morro:assistant-place-details-presented",
        detail: { turnId: consumer.conversation.snapshot().lastMeaningfulTurn },
      },
    ]);
  });

  it("consumes info safely on a failed request and preserves other action channels", async () => {
    const consumer = actualPlaceDetailConsumer("pt", () =>
      Promise.reject(new Error("unavailable")),
    );
    await consumer.select(canonicalLocation("place-a"));
    const count = consumer.messages.length;
    consumer.click("place-action:info:place-a");
    expect(consumer.messages).toHaveLength(count);
    expect(consumer.events).toEqual([]);
    consumer.click("saiba mais");
    consumer.click("ver fotos");
    consumer.click("como chegar");
    expect(consumer.events.map(({ type }) => type)).toEqual([
      "morro:assistant-option-selected",
      "morro:assistant-option-selected",
      "morro:navigation-requested",
    ]);
    expect(consumer.events[0]?.detail.value).toBe("saiba mais");
    expect(consumer.events[1]?.detail.value).toBe("ver fotos");
    expect(consumer.events[2]?.detail.destination).toMatchObject({
      name: "Same place name",
      latitude: -13.38,
      longitude: -38.91,
    });
  });
});

describe("confirmed details conversation continuity", () => {
  it.each(["pt", "en", "es", "he"] as const)(
    "records an explicit linked turn and projects it through the actual renderer in %s",
    async (locale) => {
      const consumer = actualPlaceDetailConsumer(locale, () =>
        canonicalDetail("place-a"),
      );
      await consumer.select(canonicalLocation("place-a"));
      const previous = consumer.conversation.transition({
        cause: "place_selected",
        messageKey: "place_selected",
        renderedText: "Selected place A",
        place: "Same place name",
        category: "beaches",
        priority: "contextual",
      });
      consumer.setPresenterData({
        contextualState: "place_selected",
        conversationTurnId: previous.id,
        previousConversationTurnId: "obsolete",
        conversationCause: "place_selected",
        conversationMessageKey: "place_selected",
        conversationPriority: "contextual",
        contextualCta: "Old contextual action",
        contextualVoiceCopy: "Old contextual voice",
        contextualNonBlocking: "true",
      });
      const before = consumer.snapshot();
      consumer.click("place-action:info:place-a");
      const turn = consumer.conversation.recentTurns().at(-1);
      expect(turn).toMatchObject({
        previousTurnId: previous.id,
        cause: "place_details",
        messageKey: "place_details",
        intent: "place_info",
        userAction: "place-action:info:place-a",
        renderedText: "Full place details",
        priority: "explicit",
        entities: { placeId: "place-a" },
      });
      expect(turn?.id).not.toBe(previous.id);
      expect(consumer.conversation.snapshot()).toMatchObject({
        currentPlace: "Same place name",
        currentIntent: "place_info",
        previousAssistantMessage: "Full place details",
        mapContext: { selectedPlaceId: "place-a" },
      });
      expect(consumer.presenter()).toMatchObject({
        conversationTurnId: turn?.id,
        previousConversationTurnId: previous.id,
        conversationCause: "place_details",
        conversationMessageKey: "place_details",
        conversationPriority: turn?.priority,
      });
      expect(consumer.presenter().contextualState).toBeUndefined();
      expect(consumer.presenter().contextualCta).toBeUndefined();
      expect(consumer.presenter().contextualVoiceCopy).toBeUndefined();
      expect(consumer.presenter().contextualNonBlocking).toBeUndefined();
      expect(consumer.messages.at(-1)?.description).toBe(turn?.renderedText);
      expect(consumer.snapshot()).toEqual(before);
      expect(consumer.events).toEqual([
        {
          type: "morro:assistant-place-details-presented",
          detail: { turnId: turn?.id },
        },
      ]);
      consumer.click("place-action:info:place-a");
      expect(consumer.conversation.recentTurns()).toHaveLength(2);
      expect(consumer.presenter().conversationTurnId).toBe(turn?.id);
      expect(consumer.events).toHaveLength(2);
      expect(consumer.events[1]?.detail.turnId).toBe(turn?.id);
    },
  );

  it("clears a stale predecessor when details are the first conversation turn", async () => {
    const consumer = actualPlaceDetailConsumer("pt", () =>
      canonicalDetail("place-a"),
    );
    await consumer.select(canonicalLocation("place-a"));
    consumer.setPresenterData({
      previousConversationTurnId: "obsolete",
      contextualState: "place_selected",
    });
    consumer.click("place-action:info:place-a");
    const turns = consumer.conversation.recentTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.previousTurnId).toBeNull();
    expect(consumer.presenter().previousConversationTurnId).toBeUndefined();
    expect(consumer.presenter().contextualState).toBeUndefined();
    expect(consumer.presenter().conversationTurnId).toBe(turns[0]?.id);
  });

  it("does not retain prior turn metadata when selecting another place", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    const first = consumer.conversation.recentTurns().at(-1);
    expect(first?.cause).toBe("place_details");
    consumer.setPresenterData({
      conversationPriority: "explicit",
      contextualState: "place_selected",
      contextualCta: "Old contextual action",
      contextualVoiceCopy: "Old contextual voice",
      contextualNonBlocking: "true",
    });
    await consumer.select(canonicalLocation("place-b"));
    expect(consumer.presenter().conversationTurnId).toBeUndefined();
    expect(consumer.presenter().conversationCause).toBeUndefined();
    expect(consumer.presenter().conversationMessageKey).toBeUndefined();
    expect(consumer.presenter().conversationPriority).toBeUndefined();
    expect(consumer.presenter().contextualState).toBeUndefined();
    expect(consumer.presenter().contextualCta).toBeUndefined();
    expect(consumer.presenter().contextualVoiceCopy).toBeUndefined();
    expect(consumer.presenter().contextualNonBlocking).toBeUndefined();
    const count = consumer.conversation.recentTurns().length;
    consumer.click("place-action:info:place-a");
    expect(consumer.conversation.recentTurns()).toHaveLength(count);
    consumer.click("place-action:info:place-b");
    expect(consumer.conversation.recentTurns().at(-1)).toMatchObject({
      previousTurnId: first?.id,
      entities: { placeId: "place-b" },
    });
  });

  it.each(["profile", "actions", "empty", "error"] as const)(
    "does not invent a conversation turn for %s details",
    async (scenario) => {
      const detail = canonicalDetail("place-a");
      if (scenario === "profile") detail.profile.id = "place-b";
      if (scenario === "actions") detail.actions.placeId = "place-b";
      if (scenario === "empty") detail.profile.description = " ";
      const consumer = actualPlaceDetailConsumer("pt", () =>
        scenario === "error" ? Promise.reject(Error("unavailable")) : detail,
      );
      await consumer.select(canonicalLocation("place-a"));
      consumer.click("place-action:info:place-a");
      consumer.click("place-action:info:place-b");
      expect(consumer.conversation.recentTurns()).toEqual([]);
      expect(consumer.events).toEqual([]);
    },
  );
});

const settleDetailRefresh = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

function deferredDetail() {
  let resolve!: (detail: ReturnType<typeof canonicalDetail>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof canonicalDetail>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function actualConversationRuntime(
  consumer: PlaceDetailConsumer,
  settings: {
    response?: AssistantDialogResponse;
    executionResult?: "reject" | "false";
    styles?: Promise<void>;
  } = {},
) {
  const source = readFileSync(
    new URL("../assistant/browser-assistant-runtime.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "runtime.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    "runtimeErrorResponse",
    "withPresentationLanguage",
    "controller",
    "dropStaleResponse",
    "appendStandardMessage",
    "executeInputTurn",
    "processInputTurn",
    "processInput",
    "eventDetail",
    "onPlaceDetailsPresented",
  ]);
  const functionNames = new Set([
    "supersededResponse",
    "assistantRecoveryResponse",
    "snapshotPresentation",
    "readRuntimeAction",
    "isUnknownArray",
    "readDeterministicExploreCommands",
  ]);
  const declarations: string[] = [];
  const subscriptions: string[] = [];
  const cleanups: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) {
      declarations.push(`const ${node.getText(ast)};`);
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      functionNames.has(node.name.text)
    ) {
      declarations.push(node.getText(ast));
    }
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression)
    ) {
      const call = node.expression;
      if (
        call.arguments[0] &&
        ts.isStringLiteral(call.arguments[0]) &&
        call.arguments[0].text === "morro:assistant-place-details-presented" &&
        ts.isPropertyAccessExpression(call.expression)
      ) {
        if (call.expression.name.text === "addEventListener")
          subscriptions.push(node.getText(ast));
        if (call.expression.name.text === "removeEventListener")
          cleanups.push(node.getText(ast));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const context = createAssistantContextManager();
  context.updateContext({ lastCategory: "beaches" });
  const handler = vi.fn(
    async () => settings.response ?? { text: "Current intentional answer" },
  );
  const execute = vi.fn(async (command: ExploreLocationsCommand) => {
    const result = await consumer.execute(command);
    if (settings.executionResult === "reject")
      throw Error("Injected Explore boundary rejection");
    return settings.executionResult === "false" ? false : result;
  });
  const messages: Array<{ sender: string; html: string }> = [];
  const uiStates: string[] = [];
  const voice = { speak: vi.fn() };
  const dependencies = {
    options: {
      document: consumer.document,
      explore: { execute, getState: () => consumer.snapshot() },
    },
    conversation: consumer.conversation,
    context,
    createAssistantDialogController,
    profile: { recordInteraction: vi.fn() },
    domainHandlers: { help: handler },
    intelligenceHandlers: {},
    navigationHandlers: {},
    createAssistantLlmHandler: () => async () => null,
    getAssistantMainMenu,
    normalizeAssistantVoiceLanguage,
    assistantUiStateStatus,
    messages: {
      append: (message: { sender: string; html: string }) =>
        messages.push(message),
    },
    ensureFeatureStyles: () => settings.styles ?? null,
    dispatchAssistantUiState: (_document: Document, state: string) =>
      uiStates.push(state),
    syncExploreContext: () => undefined,
    commerceCheckoutUrl: () => null,
    resolveAssistantV1ResidualCommand,
    executeAssistantV1ResidualCommand,
    resolveAssistantV1PlaceAction: () => null,
    resolveAssistantMenuCommand,
    resolveAssistantRuntimeAction,
    presentationLanguage: () =>
      normalizeAssistantVoiceLanguage(consumer.document.documentElement.lang),
    voiceLanguage: () =>
      normalizeAssistantVoiceLanguage(consumer.document.documentElement.lang),
    readVisiblePresentation: () => null,
    readExploreState: () => consumer.snapshot(),
    clearAssistantDomOptions: () => undefined,
    removePhotoPresentation: () => undefined,
    readPlaceOwnedActionValues: () => [],
    readAssistantResponseOptions,
    renderAssistantDomOptions: vi.fn(),
    revealLatestAssistantContent: () => undefined,
    readPhotoPresentation: () => null,
    isPhotoResponse: () => false,
    CONTROLLER_OWNED_AWAITING_TYPES: new Set(),
    voice,
    CustomEvent: class {
      constructor(
        readonly type: string,
        readonly init: unknown,
      ) {}
    },
  };
  // The actual subscription, boundary consumers and controller run with the
  // same document as the real Explore queue/selection/locale consumers above.
  const javascript = ts.transpileModule(
    `
    let destroyed=false,requestGeneration=0,assistantUiGeneration=0,currentPresentation=null,legacyMenuRouting=false,navigationActive=false;
    ${declarations.join("\n")}
    ${subscriptions.join("\n")}
    return {process:processInput,dispose(){destroyed=true;${cleanups.join("\n")}}};
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const create = compileFunction(javascript, Object.keys(dependencies)) as (
    ...values: unknown[]
  ) => {
    process(value: string): Promise<AssistantDialogResponse>;
    dispose(): void;
  };
  return {
    ...create(...Object.values(dependencies)),
    execute,
    handler,
    context,
    voice,
    messages,
    uiStates,
  };
}

describe("selected place viewport visibility", () => {
  const location = canonicalLocation("place-a");
  const rect = { left: 30, top: 50, width: 390, height: 844 };
  const dock = {
    left: 30,
    right: 420,
    top: 650,
    bottom: 894,
    width: 390,
    height: 244,
  };
  const document = {
    getElementById: (id: string) =>
      id === "map"
        ? { getBoundingClientRect: () => rect }
        : id === "unified-assistant-dock"
          ? { getBoundingClientRect: () => dock }
          : null,
  } as unknown as Document;
  const mapAt = (x: number, y: number) => ({ project: () => ({ x, y }) });
  it("checks the projected point against the map and the assistant overlay", () => {
    expect(isExploreLocationVisible(document, location, mapAt(100, 100))).toBe(
      true,
    );
    expect(isExploreLocationVisible(document, location, mapAt(500, 100))).toBe(
      false,
    );
    expect(isExploreLocationVisible(document, location, mapAt(100, 700))).toBe(
      false,
    );
  });
  it("cannot establish visibility from absent, invalid or failed projection", () => {
    expect(isExploreLocationVisible(document, location, undefined)).toBe(false);
    expect(isExploreLocationVisible(document, location, mapAt(NaN, 100))).toBe(
      false,
    );
    const map = {
      project: () => {
        throw new Error("provider not ready");
      },
    };
    expect(isExploreLocationVisible(document, location, map)).toBe(false);
  });
});

describe("camera return ownership", () => {
  function cameraFixture() {
    const jumpTo = vi.fn(),
      stop = vi.fn();
    const map = {
      getCenter: () => ({ lng: -38.92, lat: -13.39 }),
      getZoom: () => 13,
      jumpTo,
      stop,
    };
    const state = {
      map,
      dataset: 1,
      interaction: 1,
      detail: false,
      blocked: false,
      destroyed: false,
    };
    let changed: MutationCallback = () => {};
    const attributes = new Map<string, string>();
    const element = {
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
    };
    const document = {
      body: { dataset: { mdMode: "explore" } },
      getElementById: () => element,
      defaultView: {
        MutationObserver: class {
          constructor(callback: MutationCallback) {
            changed = callback;
          }
          observe() {}
          disconnect() {}
        },
      },
    } as unknown as Document;
    const camera = createExploreCameraReturn({
      document,
      read: () => state as never,
    });
    return {
      camera,
      state,
      map,
      jumpTo,
      stop,
      document,
      changed: (oldValue: string) =>
        changed([{ oldValue } as MutationRecord], {} as MutationObserver),
    };
  }
  it.each([
    "dataset",
    "map",
    "interaction",
    "destroyed",
    "blocked",
    "detail",
  ] as const)("rejects a pending return after %s changes", async (field) => {
    const f = cameraFixture();
    f.camera.select(false);
    let release!: () => void;
    const returning = f.camera.restore(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    if (field === "map") f.state.map = { ...f.map };
    else if (field === "dataset" || field === "interaction") f.state[field]++;
    else f.state[field] = true;
    release();
    expect(await returning).toBe(false);
    expect(f.jumpTo).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });
  it.each(["navigation", "tour"])(
    "invalidates a snapshot even when %s starts and ends in one mutation batch",
    async (mode) => {
      const f = cameraFixture();
      f.camera.select(false);
      f.changed(mode);
      expect(await f.camera.restore(Promise.resolve())).toBe(false);
      expect(f.jumpTo).not.toHaveBeenCalled();
    },
  );
  it("does not restore after disposal or failed marker replacement", async () => {
    const f = cameraFixture();
    f.camera.select(false);
    expect(
      await f.camera.restore(Promise.reject(Error("provider unavailable"))),
    ).toBe(false);
    f.camera.destroy();
    expect(await f.camera.restore(Promise.resolve())).toBe(false);
    expect(f.jumpTo).not.toHaveBeenCalled();
  });
});

describe("explicit details across actual runtime async boundaries", () => {
  it("restores a direct selection's origin when returning to the menu without prior search results", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    consumer.setCamera(-38.93, -13.4, 11);
    const origin = consumer.camera();
    consumer.setProjectedPoint(500, 100);
    await consumer.select(canonicalLocation("place-a"));
    expect(consumer.camera()).not.toEqual(origin);
    consumer.back();
    await vi.waitFor(() => expect(consumer.camera()).toEqual(origin));
    expect(consumer.readState().stage).toBe("menu");
  });
  it("restores the manual camera after returning to the original canonical search results", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const results = [
      canonicalLocation("place-a"),
      canonicalLocation("place-b"),
    ];
    consumer.search(results);
    await vi.waitFor(() =>
      expect(consumer.getRenderedLocations()).toHaveLength(2),
    );
    consumer.setCamera(-38.925, -13.39, 12);
    const origin = consumer.camera();
    consumer.setProjectedPoint(500, 100);
    await consumer.select(canonicalLocation("place-outside"));
    expect(consumer.camera()).not.toEqual(origin);
    const fits = consumer.getFramingCalls().length;
    consumer.back();
    await vi.waitFor(() => expect(consumer.camera()).toEqual(origin));
    expect(consumer.getLocations()).toEqual(results);
    expect(consumer.getRenderedLocations().map((item) => item.placeId)).toEqual(
      ["place-a", "place-b"],
    );
    expect(consumer.getFramingCalls()).toHaveLength(fits);
  });
  it("keeps the pre-detail origin through rapid selection and locale changes", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const results = [
      canonicalLocation("place-a"),
      canonicalLocation("place-b"),
    ];
    consumer.search(results);
    await vi.waitFor(() =>
      expect(consumer.getRenderedLocations()).toHaveLength(2),
    );
    consumer.setCamera(-38.93, -13.4, 11);
    const origin = consumer.camera();
    consumer.setProjectedPoint(500, 100);
    await consumer.select(results[0]!);
    await consumer.select(results[1]!);
    consumer.changeLocale("en");
    consumer.back();
    await vi.waitFor(() => expect(consumer.camera()).toEqual(origin));
  });
  it("does not restore an older return after another place takes over its pending marker queue", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const results = [
      canonicalLocation("place-a"),
      canonicalLocation("place-b"),
    ];
    consumer.search(results);
    await vi.waitFor(() =>
      expect(consumer.getRenderedLocations()).toHaveLength(2),
    );
    consumer.setCamera(-38.93, -13.4, 11);
    consumer.setProjectedPoint(500, 100);
    await consumer.select(results[0]!);
    const release = consumer.holdMarkers();
    consumer.back();
    const selecting = consumer.select(results[1]!);
    release();
    await selecting;
    expect(consumer.camera().center).toEqual([
      results[1]!.longitude,
      results[1]!.latitude,
    ]);
    expect(consumer.readState().placeId).toBe("place-b");
  });
  it.each(["navigation", "tour"])(
    "leaves the camera to %s when returning with pending markers",
    async (mode) => {
      const consumer = actualPlaceDetailConsumer("pt", (id) =>
        canonicalDetail(id),
      );
      const results = [canonicalLocation("place-a")];
      consumer.search(results);
      await vi.waitFor(() =>
        expect(consumer.getRenderedLocations()).toHaveLength(1),
      );
      consumer.setCamera(-38.93, -13.4, 11);
      await consumer.select(results[0]!);
      const release = consumer.holdMarkers();
      consumer.back();
      consumer.setMapMode(mode);
      consumer.setCamera(-38.95, -13.5, 18);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(consumer.camera().center).toEqual([-38.95, -13.5]);
    },
  );
  it("frames only the current selection after rapid switching with a pending provider", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const first = canonicalLocation("place-a");
    const second = canonicalLocation("place-b");
    consumer.setLocations([first, second]);
    consumer.setProjectedPoint(500, 100);
    const release = consumer.holdMarkers();
    const selectingA = consumer.select(first);
    const selectingB = consumer.select(second);
    release();
    await Promise.all([selectingA, selectingB]);
    expect(consumer.getFramingCalls()).toEqual([[second]]);
    expect(consumer.readState().placeId).toBe("place-b");
  });
  it.each(["navigation", "tour"])(
    "does not move the camera after %s takes ownership during marker replacement",
    async (mode) => {
      const consumer = actualPlaceDetailConsumer("pt", (id) =>
        canonicalDetail(id),
      );
      const first = canonicalLocation("place-a");
      consumer.setLocations([first]);
      consumer.setProjectedPoint(500, 100);
      const release = consumer.holdMarkers();
      const selecting = consumer.select(first);
      consumer.setMapMode(mode);
      release();
      await selecting;
      expect(consumer.getFramedLocations()).toEqual([]);
    },
  );
  it("frames a selected member that has moved outside the viewport without changing the filter", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const first = canonicalLocation("place-a");
    const second = canonicalLocation("place-b");
    consumer.setLocations([first, second]);
    consumer.setProjectedPoint(500, 100);
    await consumer.select(first);
    expect(consumer.getFramedLocations()).toEqual([first]);
    expect(consumer.getLocations()).toEqual([first, second]);
    expect(consumer.getRenderedLocations()).toHaveLength(2);
  });
  it("retains the visible search dataset when selecting one place", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const first = canonicalLocation("place-a");
    const second = canonicalLocation("place-b");
    consumer.setLocations([first, second]);
    await consumer.select(first);
    expect(consumer.getLocations()).toEqual([first, second]);
    expect(consumer.readState().placeId).toBe("place-a");
    expect(consumer.getRenderedLocations()).toHaveLength(2);
    expect(consumer.getSelectedMarkerIds()).toEqual(["0"]);
    expect(consumer.getFramedLocations()).toEqual([]);
  });

  it("temporarily shows an out-of-filter selection without replacing search results or conflating same names", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    const first = canonicalLocation("place-a");
    const second = canonicalLocation("place-b");
    const outside = canonicalLocation("place-c");
    consumer.setLocations([first, second]);
    consumer.setProjectedPoint(500, 100);
    await consumer.select(outside);
    expect(consumer.getLocations()).toEqual([first, second]);
    expect(consumer.getRenderedLocations().map((item) => item.placeId)).toEqual(
      ["place-a", "place-b", "place-c"],
    );
    expect(consumer.readState().placeId).toBe("place-c");
    expect(consumer.getSelectedMarkerIds()).toEqual(["2"]);
    expect(consumer.getFramedLocations()).toEqual([outside]);
  });
  it.each([
    ["mostrar só praias", undefined],
    ["mostrar todos os locais", undefined],
    ["mostrar só praias", "reject"],
  ] as const)(
    "supersedes residual %s (%s) after selection and locale complete before the marker queue",
    async (input, executionResult) => {
      const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) =>
        canonicalDetail(id, `Confirmed ${locale} details`),
      );
      const runtime = actualConversationRuntime(consumer, {
        ...(executionResult ? { executionResult } : {}),
      });
      const releaseMap = consumer.holdMarkers();
      const old = runtime.process(input).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await settleDetailRefresh();
      expect(consumer.snapshot()).toMatchObject({ stage: "menu", mapCalls: 1 });
      const selected = consumer.select(canonicalLocation("place-b"));
      await settleDetailRefresh();
      consumer.click("place-action:info:place-b");
      expect(consumer.conversation.recentTurns()).toEqual([]);
      consumer.changeLocale("en");
      await settleDetailRefresh();
      consumer.click("place-action:info:place-b");
      const details = consumer.conversation.recentTurns().at(-1)!;
      expect(details.cause).toBe("place_details");
      expect(consumer.snapshot().mapCalls).toBe(1);
      releaseMap();
      await selected;
      expect(await old).toMatchObject({
        value: { metadata: { state: "superseded" } },
      });
      expect(consumer.conversation.snapshot().lastMeaningfulTurn).toBe(
        details.id,
      );
      expect(
        runtime.messages.filter((message) => message.sender === "assistant"),
      ).toEqual([]);
      expect(runtime.context.getContext().history).toEqual([]);
      expect(runtime.voice.speak).not.toHaveBeenCalled();
      expect(runtime.uiStates.at(-1)).not.toBe("loading");
      expect(runtime.uiStates).not.toContain("error");
    },
  );

  it.each([undefined, "false", "reject"] as const)(
    "supersedes a real nearby menu command (%s) before fallback, answer or error",
    async (executionResult) => {
      const consumer = actualPlaceDetailConsumer("pt", (id) =>
        canonicalDetail(id),
      );
      await consumer.execute({ type: "open_category", category: "beaches" });
      const releasePosition = consumer.holdPosition();
      const runtime = actualConversationRuntime(consumer, {
        ...(executionResult ? { executionResult } : {}),
      });
      const old = runtime.process("próximo").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await settleDetailRefresh();
      expect(consumer.snapshot().positionRequests).toBe(1);
      await consumer.select(canonicalLocation("place-b"));
      consumer.click("place-action:info:place-b");
      const details = consumer.conversation.recentTurns().at(-1)!;
      releasePosition();
      expect(await old).toMatchObject({
        value: { metadata: { state: "superseded" } },
      });
      expect(runtime.execute).toHaveBeenCalledOnce();
      expect(runtime.handler).not.toHaveBeenCalled();
      expect(runtime.voice.speak).not.toHaveBeenCalled();
      expect(runtime.context.getContext().history).toEqual([]);
      expect(consumer.conversation.snapshot().lastMeaningfulTurn).toBe(
        details.id,
      );
      expect(runtime.uiStates).not.toContain("error");
    },
  );

  it.each([undefined, "reject"] as const)(
    "stops the next deterministic command and late voice after a real nearby action (%s)",
    async (executionResult) => {
      const consumer = actualPlaceDetailConsumer("pt", (id) =>
        canonicalDetail(id),
      );
      await consumer.execute({ type: "open_category", category: "beaches" });
      const releasePosition = consumer.holdPosition();
      const runtime = actualConversationRuntime(consumer, {
        ...(executionResult ? { executionResult } : {}),
        response: {
          text: "Finding nearby places",
          metadata: {
            deterministic: true,
            exploreCommands: [
              { type: "show_nearby" },
              { type: "select_place", place: "Primeira Praia" },
            ],
          },
        },
      });
      const old = runtime.process("ajuda").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await settleDetailRefresh();
      expect(consumer.snapshot().positionRequests).toBe(1);
      await consumer.select(canonicalLocation("place-b"));
      consumer.click("place-action:info:place-b");
      const details = consumer.conversation.recentTurns().at(-1)!;
      const messagesBeforeCompletion = [...runtime.messages];
      releasePosition();
      expect(await old).toMatchObject({
        value: { metadata: { state: "superseded" } },
      });
      expect(runtime.execute).toHaveBeenCalledOnce();
      expect(runtime.messages).toEqual(messagesBeforeCompletion);
      expect(runtime.voice.speak).not.toHaveBeenCalled();
      expect(consumer.conversation.snapshot().lastMeaningfulTurn).toBe(
        details.id,
      );
      expect(runtime.uiStates).not.toContain("error");
    },
  );

  it.each([undefined, "reject"] as const)(
    "stops late voice or error from a mapped show_place action (%s)",
    async (executionResult) => {
      const consumer = actualPlaceDetailConsumer("pt", (id) =>
        canonicalDetail(id),
      );
      await consumer.execute({ type: "open_category", category: "beaches" });
      await settleDetailRefresh();
      const releaseMap = consumer.holdMarkers();
      const runtime = actualConversationRuntime(consumer, {
        ...(executionResult ? { executionResult } : {}),
        response: {
          text: "Showing the requested beach",
          metadata: { action: "show_place:Primeira Praia" },
        },
      });
      const old = runtime.process("ajuda").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await settleDetailRefresh();
      expect(runtime.execute).toHaveBeenCalledWith({
        type: "select_place",
        place: "Primeira Praia",
      });
      const selected = consumer.select(canonicalLocation("place-b"));
      consumer.changeLocale("en");
      await settleDetailRefresh();
      consumer.click("place-action:info:place-b");
      const details = consumer.conversation.recentTurns().at(-1)!;
      const messagesBeforeCompletion = [...runtime.messages];
      releaseMap();
      await selected;
      expect(await old).toMatchObject({
        value: { metadata: { state: "superseded" } },
      });
      expect(runtime.messages).toEqual(messagesBeforeCompletion);
      expect(runtime.voice.speak).not.toHaveBeenCalled();
      expect(consumer.conversation.snapshot().lastMeaningfulTurn).toBe(
        details.id,
      );
      expect(runtime.uiStates).not.toContain("error");
    },
  );

  it.each([
    [false, "resolve"],
    [false, "reject"],
    [true, "resolve"],
    [true, "reject"],
  ] as const)(
    "does not begin a request superseded by details (already open: %s) while styles %s",
    async (alreadyOpen, outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const styles = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const consumer = actualPlaceDetailConsumer("pt", (id) =>
        canonicalDetail(id),
      );
      await consumer.select(canonicalLocation("place-b"));
      if (alreadyOpen) consumer.click("place-action:info:place-b");
      const runtime = actualConversationRuntime(consumer, { styles });
      const old = runtime.process("ajuda").then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      consumer.click("place-action:info:place-b");
      const details = consumer.conversation.recentTurns().at(-1)!;
      if (outcome === "resolve") resolve();
      else reject(Error("Injected stylesheet failure"));
      expect(await old).toMatchObject({
        value: { metadata: { state: "superseded" } },
      });
      expect(runtime.handler).not.toHaveBeenCalled();
      expect(runtime.execute).not.toHaveBeenCalled();
      expect(runtime.voice.speak).not.toHaveBeenCalled();
      expect(consumer.conversation.snapshot().lastMeaningfulTurn).toBe(
        details.id,
      );
      expect(runtime.uiStates).not.toContain("loading");
      expect(runtime.uiStates).not.toContain("error");
    },
  );

  it("invalidates a waiting request when an open detail is reprojected in a new locale", async () => {
    let releaseStyles!: () => void;
    const styles = new Promise<void>((resolve) => {
      releaseStyles = resolve;
    });
    const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) =>
      canonicalDetail(id, `Confirmed ${locale} details`),
    );
    await consumer.select(canonicalLocation("place-b"));
    consumer.click("place-action:info:place-b");
    const runtime = actualConversationRuntime(consumer, { styles });
    const old = runtime.process("ajuda");
    consumer.changeLocale("en");
    await settleDetailRefresh();
    const translated = consumer.conversation.recentTurns().at(-1)!;
    expect(translated.renderedText).toBe("Confirmed en details");
    releaseStyles();
    expect((await old).metadata?.state).toBe("superseded");
    expect(runtime.handler).not.toHaveBeenCalled();
    expect(consumer.conversation.snapshot().lastMeaningfulTurn).toBe(
      translated.id,
    );
    expect(runtime.uiStates).toEqual(["idle"]);
  });

  it("validates details notifications against the current turn and removes its listener", async () => {
    let releaseStyles!: () => void;
    const styles = new Promise<void>((resolve) => {
      releaseStyles = resolve;
    });
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    await consumer.select(canonicalLocation("place-b"));
    consumer.click("place-action:info:place-b");
    const eventName = "morro:assistant-place-details-presented";
    expect(consumer.listenerCount(eventName)).toBe(0);
    const runtime = actualConversationRuntime(consumer, { styles });
    expect(consumer.listenerCount(eventName)).toBe(1);
    const pending = runtime.process("ajuda");
    consumer.document.dispatchEvent(
      new CustomEvent(eventName, { detail: { turnId: "unrelated-turn" } }),
    );
    releaseStyles();
    expect((await pending).text).toBe("Current intentional answer");
    expect(runtime.handler).toHaveBeenCalledOnce();
    runtime.dispose();
    expect(consumer.listenerCount(eventName)).toBe(0);
  });

  it.each(["mostrar só praias", "mostrar todos os locais", "próximo", "ajuda"])(
    "keeps current residual/menu/response-owned operations valid: %s",
    async (input) => {
      const consumer = actualPlaceDetailConsumer("pt", (id) =>
        canonicalDetail(id),
      );
      await consumer.execute({ type: "open_category", category: "beaches" });
      await consumer.select(canonicalLocation("place-b"));
      consumer.click("place-action:info:place-b");
      const runtime = actualConversationRuntime(consumer, {
        response: {
          text: "Current mapped action",
          metadata: { action: "show_place:Primeira Praia" },
        },
      });
      const response = await runtime.process(input);
      expect(response.metadata?.state).not.toBe("superseded");
      expect(runtime.voice.speak).toHaveBeenCalledExactlyOnceWith(
        response.text,
        "pt",
      );
      expect(runtime.execute).toHaveBeenCalledOnce();
      expect(runtime.uiStates.at(-1)).toBe("success");
    },
  );
});

describe("confirmed details locale refresh", () => {
  it("keeps the opened description while loading and links the translated details without selecting again", async () => {
    const english = deferredDetail();
    const requested: string[] = [];
    const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) => {
      requested.push(locale);
      return locale === "pt"
        ? canonicalDetail(id, "Detalhes confirmados")
        : english.promise;
    });
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    const previous = consumer.conversation.recentTurns().at(-1)!;
    consumer.changeLocale("en");
    expect(consumer.messages.at(-1)?.description).toBe("Detalhes confirmados");
    expect(consumer.presenter().conversationTurnId).toBe(previous.id);
    english.resolve(canonicalDetail("place-a", "Confirmed English details"));
    await settleDetailRefresh();
    const translated = consumer.conversation.recentTurns().at(-1)!;
    expect(translated).toMatchObject({
      previousTurnId: previous.id,
      cause: "place_details",
      messageKey: "place_details",
      priority: "explicit",
      renderedText: "Confirmed English details",
      entities: { placeId: "place-a" },
    });
    expect(consumer.presenter()).toMatchObject({
      conversationTurnId: translated.id,
      previousConversationTurnId: previous.id,
      conversationCause: "place_details",
      conversationPriority: "explicit",
    });
    expect(consumer.messages.at(-1)?.description).toBe(
      "Confirmed English details",
    );
    expect(requested).toEqual(["pt", "en"]);
    expect(consumer.snapshot().mapCalls).toBe(1);
    consumer.click("place-action:info:place-a");
    expect(consumer.conversation.recentTurns()).toHaveLength(2);
    expect(consumer.presenter().conversationTurnId).toBe(translated.id);
  });

  it("keeps the latest locale when PT, EN and HE details complete out of order", async () => {
    const english = deferredDetail();
    const hebrew = deferredDetail();
    const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) =>
      locale === "pt"
        ? canonicalDetail(id, "Descrição em português")
        : locale === "en"
          ? english.promise
          : hebrew.promise,
    );
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    const previous = consumer.conversation.recentTurns().at(-1)!;
    consumer.changeLocale("en");
    consumer.changeLocale("he");
    hebrew.resolve(canonicalDetail("place-a", "פרטים מאומתים"));
    await settleDetailRefresh();
    expect(consumer.messages.at(-1)?.description).toBe("פרטים מאומתים");
    const current = consumer.conversation.recentTurns().at(-1)!;
    expect(current.previousTurnId).toBe(previous.id);
    english.resolve(canonicalDetail("place-a", "Outdated English details"));
    await settleDetailRefresh();
    consumer.click("place-action:info:place-a");
    expect(consumer.messages.at(-1)?.description).toBe("פרטים מאומתים");
    expect(consumer.presenter().conversationTurnId).toBe(current.id);
    expect(consumer.conversation.recentTurns()).toHaveLength(2);
  });

  it("does not restore place A after selecting same-named place B during locale loading", async () => {
    const englishA = deferredDetail();
    const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) =>
      locale === "en" && id === "place-a"
        ? englishA.promise
        : canonicalDetail(id, `Details for ${id}`),
    );
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    consumer.changeLocale("en");
    await consumer.select(canonicalLocation("place-b"));
    englishA.resolve(canonicalDetail("place-a", "Obsolete A details"));
    await settleDetailRefresh();
    expect(consumer.messages.at(-1)?.description).toBe("Details for place-b");
    expect(consumer.presenter().conversationTurnId).toBeUndefined();
    consumer.click("place-action:info:place-a");
    expect(consumer.conversation.recentTurns()).toHaveLength(1);
    consumer.click("place-action:info:place-b");
    expect(consumer.messages.at(-1)?.description).toBe("Details for place-b");
    expect(consumer.conversation.recentTurns().at(-1)?.entities.placeId).toBe(
      "place-b",
    );
  });

  it("does not inherit opened details when the same ID is selected anew", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    await consumer.select(canonicalLocation("place-a"));
    consumer.changeLocale("en");
    await settleDetailRefresh();
    expect(consumer.messages.at(-1)?.description).toBe("Full place details");
    expect(consumer.presenter().conversationTurnId).toBeUndefined();
    expect(consumer.conversation.recentTurns()).toHaveLength(1);
  });

  it.each(["profile", "actions", "empty", "error"] as const)(
    "preserves confirmed text without inventing a translated turn for %s details",
    async (scenario) => {
      const english = deferredDetail();
      const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) =>
        locale === "pt"
          ? canonicalDetail(id, "Texto confirmado")
          : english.promise,
      );
      await consumer.select(canonicalLocation("place-a"));
      consumer.click("place-action:info:place-a");
      const previous = consumer.conversation.recentTurns().at(-1)!;
      consumer.changeLocale("en");
      const invalid = canonicalDetail("place-a");
      if (scenario === "profile") invalid.profile.id = "place-b";
      if (scenario === "actions") invalid.actions.placeId = "place-b";
      if (scenario === "empty") invalid.profile.description = " ";
      if (scenario === "error")
        english.reject(Error("translation unavailable"));
      else english.resolve(invalid);
      await settleDetailRefresh();
      consumer.click("place-action:info:place-a");
      expect(consumer.messages.at(-1)?.description).toBe("Texto confirmado");
      expect(consumer.presenter().conversationTurnId).toBe(previous.id);
      expect(consumer.conversation.recentTurns()).toHaveLength(1);
    },
  );

  it.each(["pending request", "completed turn"])(
    "does not reopen translated details over a newer assistant %s",
    async (scenario) => {
      const english = deferredDetail();
      const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) =>
        locale === "pt"
          ? canonicalDetail(id, "Texto confirmado")
          : english.promise,
      );
      await consumer.select(canonicalLocation("place-a"));
      consumer.click("place-action:info:place-a");
      consumer.changeLocale("en");
      consumer.conversation.issueSequence();
      if (scenario === "completed turn") {
        consumer.conversation.transition({
          cause: "assistant_response",
          messageKey: "assistant_response",
          renderedText: "A newer intentional answer",
          priority: "explicit",
        });
      }
      const current = consumer.conversation.recentTurns().at(-1)!;
      const turnCount = consumer.conversation.recentTurns().length;
      english.resolve(canonicalDetail("place-a", "Confirmed English details"));
      await settleDetailRefresh();
      expect(consumer.conversation.snapshot().lastMeaningfulTurn).toBe(
        current.id,
      );
      expect(consumer.conversation.recentTurns()).toHaveLength(turnCount);
      expect(consumer.messages.at(-1)?.description).toBe("Texto confirmado");
      consumer.click("place-action:info:place-a");
      expect(consumer.messages.at(-1)?.description).toBe(
        "Confirmed English details",
      );
      expect(consumer.conversation.recentTurns().at(-1)?.previousTurnId).toBe(
        current.id,
      );
    },
  );
});

describe("public place sharing URL boundary", () => {
  function shareConsumer(
    href: string,
    options: {
      nativeShare?: boolean;
      abort?: boolean;
      missingPlace?: boolean;
      missingView?: boolean;
    } = {},
  ) {
    const source = readFileSync(
      new URL("./explore-locations-control.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("  const shareActivePlace = (): void => {");
    const end = source.indexOf("  const readActivePlaceDetail =", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const compiled = ts.transpileModule(
      `${source.slice(start, end)}\nreturn shareActivePlace;`,
      {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const payloads: ShareData[] = [];
    const copied: string[] = [];
    const navigator = {
      ...(options.nativeShare !== false
        ? {
            share: async (payload: ShareData) => {
              payloads.push(payload);
              if (options.abort)
                throw new DOMException("Cancelled", "AbortError");
            },
          }
        : {}),
      clipboard: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    };
    const document = {
      defaultView: options.missingView
        ? null
        : { location: { href }, navigator },
    };
    const location = options.missingPlace
      ? undefined
      : { name: "Primeira Praia", area: "Morro de São Paulo" };
    const createShare = compileFunction(compiled, [
      "document",
      "activePlaceLocation",
      "DOMException",
      "URL",
    ]) as (...args: unknown[]) => () => void;
    const share = createShare(document, location, DOMException, URL);
    return { share, payloads, copied };
  }

  it.each([
    "https://morro.example/?session=sentinel-test-only&return=%2Fprivate",
    "https://morro.example/#transient-state",
  ])("shares a public URL without transient query or fragment: %s", (href) => {
    const consumer = shareConsumer(href);
    consumer.share();
    expect(consumer.payloads).toEqual([
      {
        title: "Primeira Praia",
        text: "Primeira Praia · Morro de São Paulo",
        url: "https://morro.example/",
      },
    ]);
    expect(consumer.copied).toEqual([]);
  });

  it.each([
    "https://morro.example/?session=sentinel-test-only&return=%2Fprivate",
    "https://morro.example/#transient-state",
  ])("copies only the public URL in the clipboard fallback: %s", (href) => {
    const consumer = shareConsumer(href, { nativeShare: false });
    consumer.share();
    expect(consumer.copied).toEqual([
      "Primeira Praia · Morro de São Paulo\nhttps://morro.example/",
    ]);
    expect(consumer.payloads).toEqual([]);
  });

  it("preserves the public origin, port, encoded path and current place copy", () => {
    const consumer = shareConsumer(
      "https://morro.example:8443/pt/lugares%20publicos/",
    );
    consumer.share();
    expect(consumer.payloads[0]).toEqual({
      title: "Primeira Praia",
      text: "Primeira Praia · Morro de São Paulo",
      url: "https://morro.example:8443/pt/lugares%20publicos/",
    });
  });

  it("does not copy another payload after the native share is cancelled", async () => {
    const consumer = shareConsumer("https://morro.example/", { abort: true });
    consumer.share();
    await Promise.resolve();
    await Promise.resolve();
    expect(consumer.payloads).toHaveLength(1);
    expect(consumer.copied).toEqual([]);
  });

  it.each(["not a URL", "javascript:sentinel-test-only"])(
    "omits a non-public URL while retaining the selected place: %s",
    (href) => {
      const consumer = shareConsumer(href);
      consumer.share();
      expect(consumer.payloads).toEqual([
        {
          title: "Primeira Praia",
          text: "Primeira Praia · Morro de São Paulo",
        },
      ]);
    },
  );

  it.each([{ missingPlace: true }, { missingView: true }])(
    "does nothing without a selected place or a view: %j",
    (options) => {
      const consumer = shareConsumer("https://morro.example/", options);
      consumer.share();
      expect(consumer.payloads).toEqual([]);
      expect(consumer.copied).toEqual([]);
    },
  );
});

describe("canonical saved/share action routing", () => {
  it("binds the selected canonical place ID in the runtime snapshot", async () => {
    const consumer = actualPlaceDetailConsumer("pt", () =>
      canonicalDetail("place-a"),
    );
    await consumer.select(canonicalLocation("place-a"));
    expect(consumer.readState()).toMatchObject({
      stage: "detail",
      placeId: "place-a",
      destinationId: "morro-de-sao-paulo",
    });
  });
  it("refreshes save to remove and back by canonical identity", async () => {
    const detail = canonicalDetail("place-a");
    detail.actions.secondaryActions.push({
      id: "save",
      label: "Salvar",
      value: "place-action:save:place-a:add",
      disabled: false,
    });
    const consumer = actualPlaceDetailConsumer("pt", () => detail);
    await consumer.select(canonicalLocation("place-a"));
    expect(consumer.rails.at(-1)).toContainEqual(
      expect.objectContaining({ value: "place-action:save:place-a:add" }),
    );
    consumer.setFavorites([
      {
        name: "Renamed",
        placeId: "place-a",
        destinationId: "morro-de-sao-paulo",
      },
    ]);
    consumer.refreshSaved();
    expect(consumer.rails.at(-1)).toContainEqual(
      expect.objectContaining({
        value: "place-action:save:place-a:remove",
        label: "Remover dos salvos",
      }),
    );
    consumer.setFavorites([
      { name: "Renamed", placeId: "place-a", destinationId: "itacare" },
    ]);
    consumer.refreshSaved();
    expect(consumer.rails.at(-1)).toContainEqual(
      expect.objectContaining({ value: "place-action:save:place-a:add" }),
    );
  });
  it("routes an issued canonical share token without treating it as search", async () => {
    const detail = canonicalDetail("place-a");
    detail.actions.secondaryActions.push({
      id: "share",
      label: "Compartilhar",
      value: "place-action:share:place-a",
      disabled: false,
    });
    const consumer = actualPlaceDetailConsumer("pt", () => detail);
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:share:place-a");
    expect(
      consumer.events.filter((e) => e.type === "share-observed"),
    ).toHaveLength(1);
    expect(
      consumer.events.some((e) => e.type === "morro:assistant-option-selected"),
    ).toBe(false);
  });
  it("discards canonical share tokens for another place or not issued in the active rail", async () => {
    const consumer = actualPlaceDetailConsumer("pt", () =>
      canonicalDetail("place-a"),
    );
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:share:place-b");
    consumer.click("place-action:share:place-a");
    expect(consumer.events).toEqual([]);
  });
});

describe("published catalog actions on the selected place", () => {
  it("renders server published products and menu without falling through to free-text assistant", async () => {
    const detail = {
      ...canonicalDetail("place-a", ""),
      commerce: {
        products: [
          {
            id: "product-a",
            name: "Sunset",
            description: "Published experience",
          },
        ],
        offers: [
          {
            id: "offer-a",
            productId: "product-a",
            name: "Sunset offer",
            description: "Published offer",
            price: { minorUnits: 4500, currency: "BRL" },
            salesEndsAt: null,
          },
        ],
        menu: {
          id: "menu-a",
          name: "Evening menu",
          description: "",
          fallbackMediaId: null,
          fallbackDocumentUrl: null,
          categories: [
            {
              id: "cat-a",
              name: "Drinks",
              items: [
                {
                  id: "item-a",
                  name: "Juice",
                  description: "Fresh",
                  price: { minorUnits: 1200, currency: "BRL" },
                  available: true,
                  mediaId: null,
                  tags: [],
                  allergens: [],
                },
              ],
            },
          ],
        },
      },
      actions: {
        placeId: "place-a",
        primaryAction: null,
        secondaryActions: ["products", "menu", "offers"].map((id) => ({
          id,
          label: id,
          value: `place-action:${id}:place-a`,
          disabled: false,
        })),
      },
    };
    const consumer = actualPlaceDetailConsumer("pt", () => detail);
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:products:place-a");
    expect(consumer.messages.at(-1)?.description).toContain(
      "Sunset — Published experience",
    );
    expect(consumer.messages.at(-1)?.lineBreaks).toBe(
      (consumer.messages.at(-1)?.description.match(/\n/g) ?? []).length,
    );
    expect(consumer.messages.at(-1)?.lineBreaks).toBeGreaterThan(0);
    consumer.click("place-action:offers:place-a");
    expect(consumer.messages.at(-1)?.description).toContain(
      "Sunset offer — R$",
    );
    consumer.click("place-action:menu:place-a");
    expect(consumer.messages.at(-1)?.description).toContain("Juice — R$");
    expect(
      consumer.events.some(
        (event) => event.type === "morro:assistant-option-selected",
      ),
    ).toBe(false);
    const count = consumer.messages.length;
    consumer.click("place-action:products:place-b");
    consumer.click("place-action:offers:place-b");
    expect(consumer.messages).toHaveLength(count);
    expect(
      consumer.events.some(
        (event) => event.type === "morro:commerce-cta-activated",
      ),
    ).toBe(false);
  });

  it("does not execute unadvertised catalog actions or reuse a previous place catalog", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      canonicalDetail(id),
    );
    await consumer.select(canonicalLocation("place-a"));
    const count = consumer.messages.length;
    consumer.click("place-action:products:place-a");
    consumer.click("place-action:menu:place-a");
    expect(consumer.messages).toHaveLength(count);
    await consumer.select(canonicalLocation("place-b"));
    const after = consumer.messages.length;
    consumer.click("place-action:products:place-a");
    expect(consumer.messages).toHaveLength(after);
  });
});

it("preserves the current catalog section during locale refresh", async () => {
  const consumer = actualPlaceDetailConsumer("pt", (id, { locale }) => ({
    ...canonicalDetail(id, ""),
    commerce: {
      products: [
        { id: "product-a", name: `Product ${locale}`, description: "" },
      ],
      offers: [],
      menu: null,
    },
    actions: {
      placeId: id,
      primaryAction: null,
      secondaryActions: [
        {
          id: "products",
          label: "Products",
          value: `place-action:products:${id}`,
          disabled: false,
        },
      ],
    },
  }));
  await consumer.select(canonicalLocation("place-a"));
  consumer.click("place-action:products:place-a");
  expect(consumer.messages.at(-1)?.description).toContain("Product pt");
  consumer.changeLocale("en");
  await settleDetailRefresh();
  expect(consumer.messages.at(-1)?.description).toContain("Product en");
});

describe("place catalog detail visibility", () => {
  it("keeps the canonical detail id while excluding it from compact clipping", () => {
    const css = readFileSync(
      new URL("../../public/tourist-shell-v2.css", import.meta.url),
      "utf8",
    );
    expect(css).not.toMatch(/#assistant-category-results-message\s*\{/u);
    expect(css).toMatch(
      /#assistant-category-results-message:not\(\.md-assistant-place-detail-message\)\s*\{[^}]*max-height: 3\.25rem;[^}]*overflow: hidden;/u,
    );
    expect(css).toMatch(
      /\.messages-area\.md-assistant-message-scroll\s*\{[^}]*overflow-y: auto;/u,
    );
  });
});

describe("manual visual pilot in the active detail flow", () => {
  const photoDetail = (id: string) => ({
    ...canonicalDetail(id),
    media: {
      placeId: id,
      coverImage: {
        providerReference: `/images/${id}.jpg`,
        alt: `Photo ${id}`,
      },
      gallery: [],
    },
  });

  it("shows the selected place media and retains it on explicit details without changing the map", async () => {
    const consumer = actualPlaceDetailConsumer("pt", photoDetail);
    await consumer.select(canonicalLocation("place-a"));
    expect(consumer.media()?.src).toBe("/images/place-a.jpg");
    const before = consumer.snapshot();
    consumer.click("place-action:info:place-a");
    expect(consumer.media()).toEqual({
      state: "ready",
      src: "/images/place-a.jpg",
    });
    expect(consumer.presenter().placeDetailVisual).toBe("true");
    expect(consumer.detailOrder()).toEqual([
      "md-assistant-place-detail-title",
      "md-place-detail-media",
      "md-assistant-place-detail-meta",
      "md-assistant-place-detail-description",
    ]);
    expect(consumer.snapshot()).toEqual(before);
    await consumer.select(canonicalLocation("place-b"));
    expect(consumer.media()?.src).toBe("/images/place-b.jpg");
    expect(consumer.presenter().placeDetailVisual).toBe("true");
    consumer.click("place-action:info:place-b");
    expect(consumer.media()?.src).toBe("/images/place-b.jpg");
  });

  it.each(["beaches", "restaurants", "nightlife"] as const)(
    "keeps related tours out of the %s place detail",
    async (category) => {
      const consumer = actualPlaceDetailConsumer("pt", photoDetail);
      await consumer.select({ ...canonicalLocation("place-a"), category });
      consumer.click("place-action:info:place-a");
      expect(consumer.detailOrder()).toEqual([
        "md-assistant-place-detail-title",
        "md-place-detail-media",
        "md-assistant-place-detail-meta",
        "md-assistant-place-detail-description",
      ]);
      expect(
        consumer.rails
          .at(-1)
          ?.some(({ label, value }) =>
            /passeios|related tours|tour\./iu.test(`${label} ${value}`),
          ),
      ).toBe(false);
    },
  );

  it("waits for feature CSS before presenting a rich detail", async () => {
    let ready!: () => void;
    const styles = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const consumer = actualPlaceDetailConsumer("pt", photoDetail, styles);
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    expect(consumer.media()).toBeUndefined();
    ready();
    await styles;
    expect(consumer.media()?.src).toBe("/images/place-a.jpg");
  });

  it.each([
    "selection",
    "locale",
    "action",
    "conversation",
    "minimize",
  ] as const)(
    "does not reopen stale details after CSS resolves following a %s change",
    async (change) => {
      let ready!: () => void;
      const styles = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const consumer = actualPlaceDetailConsumer("pt", photoDetail, styles);
      await consumer.select(canonicalLocation("place-a"));
      consumer.click("place-action:info:place-a");
      if (change === "selection")
        await consumer.select(canonicalLocation("place-b"));
      if (change === "locale") consumer.changeLocale("en");
      if (change === "action") consumer.click("ver fotos");
      if (change === "conversation") consumer.conversation.issueSequence();
      if (change === "minimize") consumer.setAssistantHidden(true);
      ready();
      await styles;
      if (change === "selection")
        expect(consumer.media()?.src).toBe("/images/place-b.jpg");
      else expect(consumer.media()).toBeUndefined();
    },
  );

  it.each([false, true])(
    "allows explicit details from a hidden panel (deferred CSS=%s)",
    async (deferred) => {
      let ready!: () => void;
      const styles = deferred
        ? new Promise<void>((resolve) => {
            ready = resolve;
          })
        : undefined;
      const consumer = actualPlaceDetailConsumer("pt", photoDetail, styles);
      await consumer.select(canonicalLocation("place-a"));
      consumer.setAssistantHidden(true);
      consumer.click("place-action:info:place-a");
      if (styles) {
        ready();
        await styles;
      }
      expect(consumer.media()?.src).toBe("/images/place-a.jpg");
    },
  );

  it("does not present rich detail when the stylesheet fails", async () => {
    let fail!: () => void;
    const styles = new Promise<void>((_, reject) => {
      fail = () => reject(new Error("styles unavailable"));
    });
    const consumer = actualPlaceDetailConsumer("pt", photoDetail, styles);
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    fail();
    await styles.catch(() => undefined);
    expect(consumer.media()).toBeUndefined();
  });

  it("rejects another place's media and uses a neutral fallback", async () => {
    const consumer = actualPlaceDetailConsumer("pt", (id) => ({
      ...photoDetail(id),
      media: photoDetail("wrong-place").media,
    }));
    await consumer.select(canonicalLocation("place-a"));
    consumer.click("place-action:info:place-a");
    expect(consumer.media()?.state).toBe("missing");
    expect(consumer.media()?.src).toBeUndefined();
  });

  it("ignores stale media when a same-named place is selected while loading", async () => {
    let release!: (value: ReturnType<typeof photoDetail>) => void;
    const waiting = new Promise<ReturnType<typeof photoDetail>>((resolve) => {
      release = resolve;
    });
    const consumer = actualPlaceDetailConsumer("pt", (id) =>
      id === "place-a" ? waiting : photoDetail(id),
    );
    const first = consumer.select(canonicalLocation("place-a"));
    await consumer.select(canonicalLocation("place-b"));
    release(photoDetail("place-a"));
    await first;
    consumer.click("place-action:info:place-b");
    expect(consumer.media()?.src).toBe("/images/place-b.jpg");
  });
});

// Media and layout contracts stay beside their owning active controller.
describe("canonical detail media presentation", () => {
  const media = (
    reference = "/images/toca.jpg",
  ): PublicPlaceMediaProjection => ({
    placeId: "place-toca",
    coverImage: {
      mediaId: "published-photo",
      provider: "cms",
      providerReference: reference,
      mimeType: "image/jpeg",
      width: 350,
      height: 220,
      alt: "Toca do Morcego",
    },
    gallery: [],
    logo: null,
  });

  class ElementFixture {
    className = "";
    textContent = "";
    hidden = false;
    alt = "";
    src = "";
    loading = "";
    decoding = "";
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    focused = false;
    children: ElementFixture[] = [];
    parent: ElementFixture | undefined;
    listeners = new Map<string, () => void>();
    constructor(readonly tagName: string) {}
    appendChild(child: ElementFixture) {
      child.parent = this;
      this.children.push(child);
    }
    prepend(child: ElementFixture) {
      child.parent = this;
      this.children.unshift(child);
    }
    addEventListener(name: string, callback: () => void) {
      this.listeners.set(name, callback);
    }
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    }
    focus() {
      this.focused = true;
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter(
          (node) => node !== this,
        );
    }
  }
  const dom = () => ({
    document: {
      createElement: (tag: string) => new ElementFixture(tag),
    } as unknown as Document,
    parent: new ElementFixture("div"),
  });

  describe("published place detail media", () => {
    it.each([
      "javascript:alert(1)",
      "data:image/svg+xml,test",
      "http://example.com/photo.jpg",
      "//example.com/photo.jpg",
      "/\\example.com/photo.jpg",
      "https://user:password@example.com/photo.jpg",
      "https://example.com/a\nb.jpg",
      "https://example.com/a b.jpg",
      "relative/photo.jpg",
      "https:example.com/photo.jpg",
      "https:/example.com/photo.jpg",
      "",
      null,
      {},
    ])("rejects unsafe or ambiguous image reference %s", (source) => {
      expect(normalizePlaceDetailImageSource(source)).toBeNull();
    });

    it.each([
      [" /images/toca.jpg ", "/images/toca.jpg"],
      ["https://example.com/a%20b.jpg", "https://example.com/a%20b.jpg"],
    ])("accepts an explicit safe reference %s", (source, normalized) => {
      expect(normalizePlaceDetailImageSource(source)).toBe(normalized);
    });

    it("does not reuse media from a same-named but different place", () => {
      expect(
        resolvePlaceDetailMedia(media(), "place-other", "Toca"),
      ).toBeNull();
      expect(resolvePlaceDetailMedia(media(), "", "Toca")).toBeNull();
    });

    it("uses a published gallery image when the cover reference is unusable", () => {
      const input = media("javascript:alert(1)");
      const galleryImage = { ...media().coverImage!, alt: "" };
      expect(
        resolvePlaceDetailMedia(
          { ...input, gallery: [galleryImage] },
          "place-toca",
          "Toca",
        ),
      ).toEqual({ src: "/images/toca.jpg", alt: "Toca" });
    });

    it("deduplicates published cover and gallery without mixing place identities", () => {
      const input = media();
      const first = input.coverImage!;
      const second = {
        ...first,
        mediaId: "second",
        providerReference: "/images/toca2.jpg",
      };
      const duplicateUrl = { ...second, mediaId: "third" };
      expect(
        resolvePlaceDetailGallery(
          { ...input, gallery: [first, second, duplicateUrl] },
          "place-toca",
          "Toca",
        ),
      ).toEqual([
        { src: "/images/toca.jpg", alt: "Toca do Morcego" },
        { src: "/images/toca2.jpg", alt: "Toca do Morcego" },
      ]);
      expect(
        resolvePlaceDetailGallery(
          { ...input, gallery: [first, second] },
          "other-place",
          "Toca",
        ),
      ).toEqual([]);
    });

    it("ignores an obsolete image failure after switching photos", () => {
      const fixture = dom();
      const input = media();
      const figure = createPlaceDetailMedia(
        fixture.document,
        {
          ...input,
          gallery: [
            {
              ...input.coverImage!,
              mediaId: "next",
              providerReference: "/images/next.jpg",
            },
          ],
        },
        "place-toca",
        "Toca",
        "pt",
      ) as unknown as ElementFixture;
      const oldImage = figure.children.find((node) => node.tagName === "img")!;
      const next = figure.children.find(
        (node) => node.className === "md-place-detail-gallery-next",
      )!;
      next.listeners.get("click")!();
      oldImage.listeners.get("error")!();
      expect(figure.children.find((node) => node.tagName === "img")?.src).toBe(
        "/images/next.jpg",
      );
      expect(
        figure.children.find(
          (node) => node.className === "md-place-detail-gallery-counter",
        )?.textContent,
      ).toBe("2 de 2");
      expect(figure.dataset.mediaState).toBe("ready");
    });

    it("points previous and next controls in the Hebrew reading direction", () => {
      const fixture = dom();
      const input = media();
      const figure = createPlaceDetailMedia(
        fixture.document,
        {
          ...input,
          gallery: [
            {
              ...input.coverImage!,
              mediaId: "next",
              providerReference: "/images/next.jpg",
            },
          ],
        },
        "place-toca",
        "Toca",
        "he",
      ) as unknown as ElementFixture;
      expect(
        figure.children.find(
          (node) => node.className === "md-place-detail-gallery-previous",
        )?.textContent,
      ).toBe("›");
      expect(
        figure.children.find(
          (node) => node.className === "md-place-detail-gallery-next",
        )?.textContent,
      ).toBe("‹");
    });

    it("navigates multiple photos and falls back only when all have failed", () => {
      const fixture = dom();
      const input = media();
      const second = {
        ...input.coverImage!,
        mediaId: "second",
        providerReference: "/images/toca2.jpg",
      };
      fixture.parent.appendChild(
        createPlaceDetailMedia(
          fixture.document,
          { ...input, gallery: [input.coverImage!, second] },
          "place-toca",
          "Toca",
          "pt",
        ) as unknown as ElementFixture,
      );
      const figure = fixture.parent.children[0]!;
      const [, previous, next, counter, status, fallback] = figure.children as [
        ElementFixture,
        ElementFixture,
        ElementFixture,
        ElementFixture,
        ElementFixture,
        ElementFixture,
      ];
      expect(next.attributes["aria-label"]).toBe("Próxima foto");
      expect(previous.attributes["aria-label"]).toBe("Foto anterior");
      expect(counter.textContent).toBe("1 de 2");
      next.listeners.get("click")!();
      const secondImage = figure.children.find(
        (node) => node.tagName === "img",
      )!;
      expect(secondImage.src).toBe("/images/toca2.jpg");
      expect(counter.textContent).toBe("2 de 2");
      Object.defineProperty(fixture.document, "activeElement", {
        value: next,
        configurable: true,
      });
      secondImage.listeners.get("error")!();
      const returnedImage = figure.children.find(
        (node) => node.tagName === "img",
      )!;
      expect(returnedImage.src).toBe("/images/toca.jpg");
      expect(fallback.hidden).toBe(true);
      expect(figure.focused).toBe(true);
      expect(status.attributes.role).toBe("status");
      expect(status.textContent).toBe("Uma foto não pôde ser carregada.");
      returnedImage.listeners.get("error")!();
      expect(figure.dataset.mediaState).toBe("missing");
      expect(fallback.hidden).toBe(false);
      expect(next.hidden).toBe(true);
    });

    it("counts only available photos after an image fails", () => {
      const fixture = dom();
      const input = media();
      const second = {
        ...input.coverImage!,
        mediaId: "second",
        providerReference: "/images/second.jpg",
      };
      const third = {
        ...input.coverImage!,
        mediaId: "third",
        providerReference: "/images/third.jpg",
      };
      fixture.parent.appendChild(
        createPlaceDetailMedia(
          fixture.document,
          { ...input, gallery: [second, third] },
          "place-toca",
          "Toca",
          "pt",
        ) as unknown as ElementFixture,
      );
      const [image, , next, counter] = fixture.parent.children[0]!.children;
      image!.listeners.get("error")!();
      expect(counter!.textContent).toBe("1 de 2");
      next!.listeners.get("click")!();
      expect(counter!.textContent).toBe("2 de 2");
    });

    it.each([
      ["pt", "Foto não disponível"],
      ["en", "Photo unavailable"],
      ["es", "Foto no disponible"],
      ["he", "התמונה אינה זמינה"],
    ] as const)(
      "uses a neutral fallback in %s without fetching another photo",
      (locale, text) => {
        const fixture = dom();
        fixture.parent.appendChild(
          createPlaceDetailMedia(
            fixture.document,
            null,
            "place-toca",
            "Toca",
            locale,
          ) as unknown as ElementFixture,
        );
        const figure = fixture.parent.children[0]!;
        expect(figure.className).toBe("md-place-detail-media");
        expect(figure.dataset.mediaState).toBe("missing");
        expect(figure.children.map((node) => node.tagName)).toEqual(["span"]);
        expect(figure.children[0]!.textContent).toBe(text);
        expect(figure.children[0]!.hidden).toBe(false);
      },
    );

    it("shows the canonical image and recovers from an image load failure", () => {
      const fixture = dom();
      fixture.parent.appendChild(
        createPlaceDetailMedia(
          fixture.document,
          media(),
          "place-toca",
          "Toca",
          "pt",
        ) as unknown as ElementFixture,
      );
      const figure = fixture.parent.children[0]!;
      const image = figure.children[0]!;
      const fallback = figure.children[1]!;
      expect(image.src).toBe("/images/toca.jpg");
      expect(image.alt).toBe("Toca do Morcego");
      expect(image.loading).toBe("lazy");
      expect(fallback.hidden).toBe(true);
      image.listeners.get("error")!();
      expect(figure.children).toEqual([fallback]);
      expect(fallback.hidden).toBe(false);
      expect(figure.dataset.mediaState).toBe("missing");
    });

    it("does not insert strings as HTML or create actions", () => {
      const fixture = dom();
      fixture.parent.appendChild(
        createPlaceDetailMedia(
          fixture.document,
          media(),
          "place-toca",
          "<script>alert(1)</script>",
          "pt",
        ) as unknown as ElementFixture,
      );
      expect(fixture.parent.children).toHaveLength(1);
      expect(
        fixture.parent.children[0]!.children.map((node) => node.tagName),
      ).toEqual(["img", "span"]);
    });
  });
});
describe("canonical detail layout integration", () => {
  // Exercise the production layout callback, including its observer/resize wiring,
  // without importing the unrelated shell bootstrap or requiring a browser runtime.
  const source = ts.createSourceFile(
    "app-shell.ts",
    readFileSync(new URL("../layouts/app-shell.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const layout = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "synchronizeAssistantLayout",
  );
  if (!layout)
    throw new Error("Production assistant layout function not found");
  const compiled = ts.transpileModule(layout.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  class ElementFixture {
    dataset: Record<string, string> = {};
    hidden = false;
    attributes = new Map<string, string>();
    classes = new Set<string>();
    classList = {
      add: (...names: string[]) =>
        names.forEach((name) => this.classes.add(name)),
      remove: (...names: string[]) =>
        names.forEach((name) => this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, enabled: boolean) =>
        enabled ? this.classes.add(name) : this.classes.delete(name),
    };
    textContent = "Place description";
    heading: ElementFixture | null = null;
    top = 0;
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    getBoundingClientRect() {
      return { top: this.top };
    }
    querySelector(): ElementFixture | null {
      return this.heading;
    }
  }

  function fixture() {
    let mutation = () => {};
    let resize = () => {};
    let fontsReady = () => {};
    const messages: ElementFixture[] = [];
    const area = new ElementFixture();
    const geometry = { scrollTop: 0, scrollHeight: 1000, clientHeight: 288 };
    Object.assign(area, geometry, { clientTop: 2 });
    const scroller = area as ElementFixture &
      typeof geometry & { clientTop: number };
    scroller.top = 100;
    Object.assign(scroller, {
      querySelectorAll: (selector: string) => {
        if (selector.startsWith(".message")) return messages;
        if (selector.includes("data-place-detail-visual")) {
          return messages.filter(
            (message) => message.dataset.placeDetailVisual === "true",
          );
        }
        return [];
      },
    });
    const region = new ElementFixture();
    region.querySelector = () => scroller;
    const document = {
      getElementById: () => region,
      defaultView: {
        addEventListener: (name: string, callback: () => void) => {
          if (name === "resize") resize = callback;
        },
        MutationObserver: class {
          constructor(callback: () => void) {
            mutation = callback;
          }
          observe() {}
        },
      },
      fonts: {
        ready: {
          then: (callback: () => void) => {
            fontsReady = callback;
          },
        },
      },
    };
    const mount = compileFunction(
      `${compiled}\nreturn synchronizeAssistantLayout(document);`,
      ["document", "HTMLElement"],
    ) as (document: object, element: typeof ElementFixture) => void;
    function addDetail(offset = 400) {
      const detail = new ElementFixture();
      detail.dataset.placeDetailVisual = "true";
      replaceHeading(detail, offset);
      messages.push(detail);
      return detail;
    }
    function replaceHeading(detail: ElementFixture, offset: number) {
      const heading = new ElementFixture();
      heading.getBoundingClientRect = () => ({
        top: scroller.top + scroller.clientTop + offset - scroller.scrollTop,
      });
      detail.heading = heading;
    }
    return {
      messages,
      scroller,
      region,
      addDetail,
      replaceHeading,
      mount: () => mount(document, ElementFixture),
      mutate: () => mutation(),
      resize: () => resize(),
      fontsReady: () => fontsReady(),
    };
  }

  describe("canonical place detail scroll ownership", () => {
    it("anchors the current heading, not history start or content bottom", () => {
      const f = fixture();
      f.messages.push(new ElementFixture());
      f.addDetail(420);
      f.scroller.scrollTop = 700;
      f.mount();
      expect(f.scroller.scrollTop).toBe(420);
      expect(f.region.classes.has("has-rich-content")).toBe(true);
      expect(f.region.classes.has("has-overflow")).toBe(true);
      f.mutate();
      expect(f.scroller.scrollTop).toBe(420);
    });

    it("preserves manual reading through mutations, image fallback, fonts and resize", () => {
      const f = fixture();
      const detail = f.addDetail();
      f.mount();
      f.scroller.scrollTop = 560;
      detail.textContent = "Photo unavailable; same description";
      f.mutate();
      f.scroller.clientHeight = 220;
      f.resize();
      f.fontsReady();
      expect(f.scroller.scrollTop).toBe(560);
    });

    it("reanchors a new render in the reused presenter, including a same-name place", () => {
      const f = fixture();
      const detail = f.addDetail();
      f.mount();
      f.scroller.scrollTop = 620;
      f.replaceHeading(detail, 430);
      f.mutate();
      expect(f.scroller.scrollTop).toBe(430);
      f.scroller.scrollTop = 500;
      f.mutate();
      expect(f.scroller.scrollTop).toBe(500);
    });

    it("reanchors a reused presenter before later conversation history", () => {
      const f = fixture();
      const detail = f.addDetail(300);
      f.mount();
      f.messages.push(new ElementFixture());
      f.mutate();
      expect(f.scroller.scrollTop).toBe(f.scroller.scrollHeight);
      f.replaceHeading(detail, 320);
      f.mutate();
      expect(f.scroller.scrollTop).toBe(320);
      f.scroller.scrollTop = 410;
      f.resize();
      f.mutate();
      expect(f.scroller.scrollTop).toBe(410);
    });

    it("anchors a newly inserted detail after initial shell mounting", () => {
      const f = fixture();
      f.messages.push(new ElementFixture());
      f.mount();
      f.addDetail(510);
      f.mutate();
      expect(f.scroller.scrollTop).toBe(510);
    });

    it("keeps the initial welcome at the top", () => {
      const f = fixture();
      const welcome = new ElementFixture();
      welcome.attributes.set("data-i18n", "assistant_welcome_message");
      f.messages.push(welcome);
      f.scroller.scrollTop = 150;
      f.mount();
      f.mutate();
      expect(f.scroller.scrollTop).toBe(0);
    });

    it("retains bottom scrolling for ordinary messages after a visual detail", () => {
      const f = fixture();
      f.addDetail();
      f.mount();
      f.messages.push(new ElementFixture());
      f.mutate();
      expect(f.scroller.scrollTop).toBe(f.scroller.scrollHeight);
    });

    it("retains legacy scrolling when the presenter changes to offers", () => {
      const f = fixture();
      const detail = f.addDetail();
      f.mount();
      delete detail.dataset.placeDetailVisual;
      f.mutate();
      expect(f.scroller.scrollTop).toBe(f.scroller.scrollHeight);
    });

    it.each(["hidden", "class", "aria"])(
      "does not anchor a %s detail",
      (mode) => {
        const f = fixture();
        const detail = f.addDetail();
        if (mode === "hidden") detail.hidden = true;
        if (mode === "class") detail.classes.add("hidden");
        if (mode === "aria") detail.attributes.set("aria-hidden", "true");
        f.mount();
        expect(f.scroller.scrollTop).toBe(f.scroller.scrollHeight);
      },
    );

    it("keeps non-overflowing ordinary content untouched", () => {
      const f = fixture();
      f.messages.push(new ElementFixture());
      f.scroller.scrollHeight = 200;
      f.mount();
      expect(f.scroller.scrollTop).toBe(0);
      expect(f.region.classes.has("has-overflow")).toBe(false);
    });
  });
});
