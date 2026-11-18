import type { AssistantLocale } from "@touristic/assistant";
import type { PublicPlaceDetail } from "@touristic/business";
import { publicPlaceCatalogText } from "./public-place-catalog-presentation.js";
import { createFeatureStyleGate } from "./feature-styles.js";
export type ExploreFlowBottomSheetState = "peek" | "half" | "full";
export type ExploreFlowBottomSheetKind = "explore" | "tour";
export type ExploreFlowBottomSheetStatus =
  "loading" | "ready" | "empty" | "error";

export interface PublishedPlaceReading {
  readonly placeId: string;
  readonly detail: PublicPlaceDetail;
  readonly locale: AssistantLocale;
  /** The active map controller owns the published gallery and its missing-photo fallback. */
  readonly renderMedia: (
    document: Document,
    media: PublicPlaceDetail["media"],
    placeId: string,
    name: string,
    locale: AssistantLocale,
  ) => HTMLElement;
  readonly returnFocus: HTMLElement;
}

export interface ExploreFlowBottomSheetPresentation {
  readonly kind: ExploreFlowBottomSheetKind;
  readonly accessibleLabel: string;
  readonly source: HTMLElement;
  readonly messageSource?: HTMLElement;
  readonly content?: HTMLElement;
  readonly status?: ExploreFlowBottomSheetStatus;
  readonly statusText?: string;
  readonly onDismiss: () => void;
}

export interface ExploreFlowBottomSheetController {
  show(presentation: ExploreFlowBottomSheetPresentation): void;
  showPlace(reading: PublishedPlaceReading): void;
  hide(): void;
  setState(state: ExploreFlowBottomSheetState): void;
  getState(): ExploreFlowBottomSheetState;
  setStatus(status: ExploreFlowBottomSheetStatus, text?: string): void;
  destroy(): void;
}

export interface ExploreFlowBottomSheetOptions {
  readonly document: Document;
}

type SheetCopy = Readonly<{
  close: string;
  backToPlace: string;
  loading: string;
  empty: string;
  unavailable: string;
  states: Readonly<Record<ExploreFlowBottomSheetState, string>>;
}>;
const copyByLanguage = Object.freeze<Record<string, SheetCopy>>({
  pt: {
    close: "Fechar painel",
    backToPlace: "Voltar ao local",
    loading: "Atualizando o mapa e os resultados…",
    empty: "Nenhum resultado encontrado para este filtro.",
    unavailable:
      "Não foi possível atualizar o mapa agora. Seus filtros foram preservados.",
    states: {
      peek: "Mostrar resumo",
      half: "Mostrar conteúdo principal",
      full: "Expandir painel",
    },
  },
  en: {
    close: "Close panel",
    backToPlace: "Back to place",
    loading: "Updating the map and results…",
    empty: "No results were found for this filter.",
    unavailable:
      "The map could not be updated right now. Your filters were preserved.",
    states: {
      peek: "Show summary",
      half: "Show main content",
      full: "Expand panel",
    },
  },
  es: {
    close: "Cerrar panel",
    backToPlace: "Volver al lugar",
    loading: "Actualizando el mapa y los resultados…",
    empty: "No se encontraron resultados para este filtro.",
    unavailable:
      "No fue posible actualizar el mapa ahora. Tus filtros se conservaron.",
    states: {
      peek: "Mostrar resumen",
      half: "Mostrar contenido principal",
      full: "Expandir panel",
    },
  },
  he: {
    close: "סגירת הלוח",
    backToPlace: "חזרה למקום",
    loading: "מעדכן את המפה והתוצאות…",
    empty: "לא נמצאו תוצאות למסנן הזה.",
    unavailable: "לא ניתן לעדכן את המפה כרגע. המסננים שלך נשמרו.",
    states: {
      peek: "הצגת תקציר",
      half: "הצגת התוכן הראשי",
      full: "הרחבת הלוח",
    },
  },
});

function languageKey(document: Document): string {
  const raw = document.documentElement.lang.trim().toLowerCase();
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("he")) return "he";
  return "pt";
}

function currentCopy(document: Document): SheetCopy {
  return copyByLanguage[languageKey(document)] ?? copyByLanguage.pt!;
}

function isPrimaryTourAction(value: string): boolean {
  return ["__tour_start__", "__tour_next__", "__tour_finish__"].includes(value);
}

const stateGlyph: Readonly<Record<ExploreFlowBottomSheetState, string>> =
  Object.freeze({
    peek: "⌄",
    half: "—",
    full: "⌃",
  });

function createStateButton(
  document: Document,
  state: ExploreFlowBottomSheetState,
  copy: SheetCopy,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "md-icon-button explore-flow-sheet-state-button";
  button.dataset.sheetStateTarget = state;
  button.setAttribute("aria-label", copy.states[state]);
  button.title = copy.states[state];
  button.textContent = stateGlyph[state];
  return button;
}

function createStepButton(
  document: Document,
  direction: "up" | "down",
  copy: SheetCopy,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "md-icon-button explore-flow-sheet-state-button";
  button.dataset.sheetStep = direction;
  button.setAttribute(
    "aria-label",
    direction === "up" ? copy.states.full : copy.states.peek,
  );
  button.title = direction === "up" ? copy.states.full : copy.states.peek;
  button.textContent = direction === "up" ? "⌃" : "⌄";
  return button;
}

/** Build a read-only detail from the single publication already accepted for the map selection. */
function createPublishedPlaceReading(
  document: Document,
  reading: PublishedPlaceReading,
): HTMLElement | null {
  const { placeId, detail, locale, renderMedia } = reading;
  if (
    !placeId ||
    detail.profile.id !== placeId ||
    detail.actions.placeId !== placeId ||
    detail.actions.destinationId !== detail.profile.destinationId ||
    !detail.revision.id ||
    !Number.isSafeInteger(detail.revision.number) ||
    detail.revision.number < 1
  ) {
    return null;
  }
  const content = document.createElement("article");
  content.dataset.placeId = placeId;
  content.dataset.publicationRevision = detail.revision.id;
  const media =
    detail.partial.media === "ready" && detail.media?.placeId === placeId
      ? detail.media
      : null;
  content.append(
    renderMedia(document, media, placeId, detail.profile.name, locale),
  );
  const description =
    detail.profile.description?.trim() ||
    detail.profile.shortDescription?.trim();
  if (description) {
    const body = document.createElement("p");
    body.textContent = description;
    content.append(body);
  }

  // Browsing a catalog is local presentation. Only expose the published read action.
  const offerAction = [
    detail.actions.primaryAction,
    ...detail.actions.secondaryActions,
  ].find(
    (action) =>
      action?.id === "offers" &&
      action.value === `place-action:offers:${placeId}` &&
      !action.disabled &&
      action.availability === "available",
  );
  if (
    offerAction &&
    detail.partial.actions === "ready" &&
    detail.partial.commerce === "ready" &&
    detail.commerce?.offers.length
  ) {
    const offers = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = offerAction.label;
    offers.append(label);
    const lines = publicPlaceCatalogText(
      "offers",
      detail.commerce,
      locale,
    ).split("\n");
    for (const line of lines) {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      offers.append(paragraph);
    }
    content.append(offers);
  }
  return content;
}

export function installExploreFlowBottomSheet({
  document,
}: ExploreFlowBottomSheetOptions): ExploreFlowBottomSheetController {
  let destroyed = false;
  const featureStyles = createFeatureStyleGate(document);
  let state: ExploreFlowBottomSheetState = "half";
  const sheet = document.createElement("aside");
  sheet.id = "explore-flow-bottom-sheet";
  sheet.className = "md-bottom-sheet md-card explore-flow-bottom-sheet hidden";
  sheet.dataset.sheetState = state;
  sheet.setAttribute("role", "region");
  sheet.setAttribute("aria-hidden", "true");

  const toolbar = document.createElement("div");
  toolbar.className = "explore-flow-sheet-toolbar";

  const handle = document.createElement("div");
  handle.className = "md-bottom-sheet-handle explore-flow-sheet-drag-handle";
  handle.setAttribute("aria-hidden", "true");

  const stateControls = document.createElement("div");
  stateControls.className = "explore-flow-sheet-state-controls";
  stateControls.setAttribute("role", "group");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "md-icon-button explore-flow-sheet-close";
  close.textContent = "×";

  toolbar.append(handle, stateControls, close);

  const content = document.createElement("div");
  content.className = "md-bottom-sheet-content explore-flow-sheet-content";

  const heading = document.createElement("h2");
  heading.id = "explore-flow-bottom-sheet-title";
  heading.className = "explore-flow-sheet-title";
  sheet.setAttribute("aria-labelledby", heading.id);
  sheet.tabIndex = -1;

  const status = document.createElement("div");
  status.className = "explore-flow-sheet-status hidden";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const richContent = document.createElement("div");
  richContent.className = "explore-flow-sheet-rich";

  const actions = document.createElement("div");
  actions.className = "explore-flow-sheet-actions";
  actions.setAttribute("role", "group");

  content.append(heading, status, richContent, actions);
  sheet.append(toolbar, content);
  document.body.appendChild(sheet);

  let dismissHandler: (() => void) | undefined;
  let activeKind: ExploreFlowBottomSheetKind | undefined;
  let compatibilityMessageSource: HTMLElement | undefined;

  const clearCompatibilityMessageSource = (): void => {
    if (!compatibilityMessageSource) return;
    compatibilityMessageSource.classList.remove(
      "explore-flow-message-compat-source",
    );
    compatibilityMessageSource.removeAttribute("aria-hidden");
    compatibilityMessageSource = undefined;
  };

  const setStatus = (
    nextStatus: ExploreFlowBottomSheetStatus,
    text?: string,
  ): void => {
    const copy = currentCopy(document);
    sheet.dataset.flowState = nextStatus;
    sheet.setAttribute("aria-busy", String(nextStatus === "loading"));
    status.replaceChildren();
    if (nextStatus === "ready") {
      status.classList.add("hidden");
      return;
    }
    status.classList.remove("hidden");
    if (nextStatus === "loading") {
      const skeleton = document.createElement("span");
      skeleton.className = "md-skeleton explore-flow-sheet-status-skeleton";
      skeleton.setAttribute("aria-hidden", "true");
      status.appendChild(skeleton);
      const sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = text || copy.loading;
      status.appendChild(sr);
      return;
    }
    status.textContent =
      text || (nextStatus === "empty" ? copy.empty : copy.unavailable);
  };

  const setState = (nextState: ExploreFlowBottomSheetState): void => {
    if (destroyed) return;
    state = nextState;
    sheet.dataset.sheetState = nextState;
    const order: readonly ExploreFlowBottomSheetState[] = [
      "peek",
      "half",
      "full",
    ];
    const current = order.indexOf(nextState);
    for (const child of Array.from(stateControls.children)) {
      if (!(child instanceof HTMLButtonElement)) continue;
      const direction = child.dataset.sheetStep;
      if (direction === "down") child.disabled = current <= 0;
      if (direction === "up") child.disabled = current >= order.length - 1;
      const target = child.dataset.sheetStateTarget as
        ExploreFlowBottomSheetState | undefined;
      if (target) {
        child.disabled = false;
        child.setAttribute("aria-pressed", String(target === nextState));
      }
    }
  };

  let dragStartY: number | null = null;
  let dragPointerId: number | null = null;
  const dragStep = (direction: "up" | "down"): void => {
    const order: readonly ExploreFlowBottomSheetState[] = [
      "peek",
      "half",
      "full",
    ];
    const current = order.indexOf(state);
    const offset = direction === "up" ? 1 : -1;
    const next =
      order[Math.min(order.length - 1, Math.max(0, current + offset))];
    if (next) setState(next);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (activeKind !== "explore") return;
    dragStartY = event.clientY;
    dragPointerId = event.pointerId;
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointerup", (event) => {
    if (dragStartY === null || dragPointerId !== event.pointerId) return;
    const delta = event.clientY - dragStartY;
    dragStartY = null;
    dragPointerId = null;
    if (Math.abs(delta) < 36) return;
    dragStep(delta < 0 ? "up" : "down");
  });
  handle.addEventListener("pointercancel", () => {
    dragStartY = null;
    dragPointerId = null;
  });

  const rebuildStateControls = (kind: ExploreFlowBottomSheetKind): void => {
    const copy = currentCopy(document);
    stateControls.replaceChildren();
    if (kind === "tour") {
      for (const target of ["peek", "half", "full"] as const) {
        const button = createStateButton(document, target, copy);
        button.addEventListener("click", () => setState(target));
        stateControls.appendChild(button);
      }
    } else {
      for (const direction of ["down", "up"] as const) {
        const button = createStepButton(document, direction, copy);
        button.addEventListener("click", () => dragStep(direction));
        stateControls.appendChild(button);
      }
    }
    close.setAttribute("aria-label", copy.close);
    close.title = copy.close;
    setState(state);
  };

  let stateBeforePlace: ExploreFlowBottomSheetState | undefined;
  const clearPlaceReading = (): void => {
    if (stateBeforePlace === undefined) return;
    setState(stateBeforePlace);
    stateBeforePlace = undefined;
    delete sheet.dataset.placeReading;
    richContent.replaceChildren();
  };

  const render = (presentation: ExploreFlowBottomSheetPresentation): void => {
    clearPlaceReading();
    dismissHandler = presentation.onDismiss;
    clearCompatibilityMessageSource();
    compatibilityMessageSource = presentation.messageSource;
    if (compatibilityMessageSource) {
      compatibilityMessageSource.classList.add(
        "explore-flow-message-compat-source",
      );
      compatibilityMessageSource.setAttribute("aria-hidden", "true");
    }
    activeKind = presentation.kind;
    rebuildStateControls(presentation.kind);
    sheet.dataset.flowKind = presentation.kind;
    heading.textContent = presentation.accessibleLabel;
    setStatus(presentation.status ?? "ready", presentation.statusText);

    richContent.replaceChildren();
    if (presentation.content) {
      presentation.content.classList.add("md-card");
      richContent.appendChild(presentation.content);
    }
    richContent.classList.toggle("hidden", richContent.childElementCount === 0);
    actions.replaceChildren(presentation.source);
    presentation.source.classList.add("explore-flow-sheet-source");
    presentation.source.removeAttribute("aria-hidden");
    for (const button of Array.from(
      presentation.source.querySelectorAll<HTMLButtonElement>(
        ".assistant-option-btn",
      ),
    )) {
      const primary =
        presentation.kind === "tour" &&
        isPrimaryTourAction(button.dataset.value ?? "");
      button.classList.add(
        "md-button",
        primary ? "md-button--primary" : "md-button--secondary",
        "explore-flow-sheet-option",
      );
      button.classList.toggle("explore-flow-sheet-option--primary", primary);
    }

    sheet.classList.remove("hidden");
    sheet.setAttribute("aria-hidden", "false");
  };

  const hide = (): void => {
    featureStyles.cancel();
    if (destroyed) return;
    dismissHandler = undefined;
    activeKind = undefined;
    clearCompatibilityMessageSource();
    sheet.classList.add("hidden");
    sheet.setAttribute("aria-hidden", "true");
    delete sheet.dataset.flowKind;
    clearPlaceReading();
  };

  sheet.addEventListener("keydown", (event) => {
    if (sheet.dataset.placeReading !== "true" || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    dismissHandler?.();
  });
  close.addEventListener("click", () => dismissHandler?.());

  return Object.freeze({
    show(presentation: ExploreFlowBottomSheetPresentation): void {
      if (destroyed) return;
      featureStyles.run(() => {
        if (!destroyed) render(presentation);
      });
    },
    showPlace(reading: PublishedPlaceReading): void {
      if (destroyed) return;
      const article = createPublishedPlaceReading(document, reading);
      if (!article) {
        hide();
        return;
      }
      featureStyles.run(() => {
        if (destroyed) return;
        render({
          kind: "explore",
          accessibleLabel: reading.detail.profile.name,
          source: document.createElement("div"),
          content: article,
          onDismiss() {
            hide();
            if (reading.returnFocus.isConnected)
              reading.returnFocus.focus({ preventScroll: true });
          },
        });
        stateBeforePlace = state;
        sheet.dataset.placeReading = "true";
        const label = currentCopy(document).backToPlace;
        close.setAttribute("aria-label", label);
        close.title = label;
        setState("half");
        content.scrollTop = 0;
        close.focus({ preventScroll: true });
      });
    },
    hide,
    setState,
    getState(): ExploreFlowBottomSheetState {
      return state;
    },
    setStatus,
    destroy(): void {
      featureStyles.cancel();
      if (destroyed) return;
      clearCompatibilityMessageSource();
      destroyed = true;
      dismissHandler = undefined;
      activeKind = undefined;
      sheet.remove();
    },
  });
}
