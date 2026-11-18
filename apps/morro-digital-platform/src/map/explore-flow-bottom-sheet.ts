import type { AssistantLocale } from "@touristic/assistant";
import type { PublicPlaceDetail } from "@touristic/business";
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
  readonly card: HTMLElement;
  /** The active controller keeps Close available across the place and its actions. */
  readonly close?: HTMLElement;
  readonly categoryLabel?: string;
  /** The controller supplies its actual, already-bound actions for this selection. */
  readonly actions: HTMLElement;
}

export interface PublishedPlaceActionReading {
  readonly placeId: string;
  readonly revisionId: string;
  /** Pure presentation from the active publication, including subsequent locale changes. */
  readonly content: (
    detail: PublicPlaceDetail,
    locale: AssistantLocale,
  ) => Readonly<{ title: string; text: string }> | null;
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
  showPlace(reading: PublishedPlaceReading): boolean;
  showPlaceAction(action: PublishedPlaceActionReading): boolean;
  backToPlace(): boolean;
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

function samePlacePresentation(
  previous: PublishedPlaceReading,
  next: PublishedPlaceReading,
): boolean {
  // A publication revision fixes the profile and media; locale and partial readiness affect their display.
  return (
    previous.locale === next.locale &&
    previous.categoryLabel === next.categoryLabel &&
    previous.actions === next.actions &&
    previous.detail.profile.name === next.detail.profile.name &&
    previous.detail.profile.description === next.detail.profile.description &&
    previous.detail.profile.shortDescription ===
      next.detail.profile.shortDescription &&
    previous.detail.partial.media === next.detail.partial.media &&
    previous.detail.media?.placeId === next.detail.media?.placeId
  );
}

function createPublishedPlaceReading(
  document: Document,
  reading: PublishedPlaceReading,
): HTMLElement {
  const { placeId, detail, locale } = reading;
  const article = document.createElement("article");
  article.dataset.placeId = placeId;
  article.dataset.publicationRevision = detail.revision.id;
  article.dataset.placeDetailVisual = "true";
  const heading = document.createElement("h2");
  heading.className = "md-assistant-place-detail-title";
  heading.textContent = detail.profile.name;
  article.append(heading);
  const media =
    detail.partial.media === "ready" && detail.media?.placeId === placeId
      ? detail.media
      : null;
  article.append(
    reading.renderMedia(document, media, placeId, detail.profile.name, locale),
  );
  if (reading.categoryLabel) {
    const category = document.createElement("span");
    category.className = "md-assistant-place-detail-meta";
    category.textContent = reading.categoryLabel;
    article.append(category);
  }
  const description =
    detail.profile.description?.trim() ||
    detail.profile.shortDescription?.trim();
  if (description) {
    const body = document.createElement("p");
    body.className = "md-assistant-place-detail-description";
    body.textContent = description;
    article.append(body);
  }
  article.append(reading.actions);
  return article;
}

function showPublishedPlaceView(
  { card, close }: PublishedPlaceReading,
  article: HTMLElement,
): void {
  if (close && card.firstChild !== close)
    card.insertBefore(close, card.firstChild);
  for (const child of Array.from(card.childNodes)) {
    if (child !== close && child !== article) child.remove();
  }
  if (article.parentNode !== card) card.append(article);
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

  let place:
    | {
        reading: PublishedPlaceReading;
        article: HTMLElement;
        actionHome: { parent: Node; next: ChildNode | null } | null;
      }
    | undefined;
  let actionView:
    | {
        article: HTMLElement;
        returnFocus: HTMLElement;
        refresh: (reading: PublishedPlaceReading) => boolean;
      }
    | undefined;

  const currentPlaceCard = (): boolean => {
    if (!place) return false;
    const { card, close, placeId, detail } = place.reading;
    const article = actionView?.article ?? place.article;
    return (
      card.isConnected &&
      card.dataset.placeId === placeId &&
      card.dataset.publicationRevision === detail.revision.id &&
      (close
        ? card.firstChild === close && close.nextSibling === article
        : card.firstChild === article)
    );
  };

  const currentControl = (
    actions: HTMLElement,
    previous: HTMLElement,
  ): HTMLElement | undefined => {
    if (
      actions.contains(previous) &&
      !(previous instanceof HTMLButtonElement && previous.disabled)
    )
      return previous;
    const value = previous.dataset.value;
    return value
      ? Array.from(
          actions.querySelectorAll<HTMLButtonElement>("button[data-value]"),
        ).find((button) => !button.disabled && button.dataset.value === value)
      : undefined;
  };

  const backToPlace = (): boolean => {
    if (!place || !actionView || !currentPlaceCard()) return false;
    const { returnFocus } = actionView;
    actionView = undefined;
    showPublishedPlaceView(place.reading, place.article);
    (
      currentControl(place.reading.actions, returnFocus) ?? place.reading.card
    ).focus({
      preventScroll: true,
    });
    return true;
  };

  const restoreActionHome = (): void => {
    if (!place) return;
    const { reading, article, actionHome } = place;
    if (actionHome && article.contains(reading.actions)) {
      const { parent, next } = actionHome;
      parent.insertBefore(
        reading.actions,
        next?.parentNode === parent ? next : null,
      );
    }
  };

  const releasePlace = (): void => {
    if (!place) return;
    const { reading } = place;
    const ownsCard = currentPlaceCard();
    restoreActionHome();
    if (ownsCard) {
      reading.card.replaceChildren();
      delete reading.card.dataset.publishedPlaceCard;
      delete reading.card.dataset.publicationRevision;
    }
    place = undefined;
    actionView = undefined;
  };

  const render = (presentation: ExploreFlowBottomSheetPresentation): void => {
    releasePlace();
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
    releasePlace();
  };

  close.addEventListener("click", () => dismissHandler?.());

  return Object.freeze({
    show(presentation: ExploreFlowBottomSheetPresentation): void {
      if (destroyed) return;
      featureStyles.run(() => {
        if (!destroyed) render(presentation);
      });
    },
    showPlace(reading: PublishedPlaceReading): boolean {
      const { card, placeId, detail } = reading;
      if (
        destroyed ||
        !card.isConnected ||
        !placeId ||
        card.dataset.placeId !== placeId ||
        detail.profile.id !== placeId ||
        detail.actions.placeId !== placeId ||
        typeof detail.profile.destinationId !== "string" ||
        !detail.profile.destinationId.trim() ||
        detail.actions.destinationId !== detail.profile.destinationId ||
        !detail.revision.id.trim() ||
        !Number.isSafeInteger(detail.revision.number) ||
        detail.revision.number < 1
      )
        return false;
      if (place?.reading.card === card && place.reading.placeId === placeId) {
        const previous = place.reading.detail.revision;
        if (
          detail.revision.number < previous.number ||
          (detail.revision.number === previous.number) !==
            (detail.revision.id === previous.id)
        )
          return false;
      }
      const previous = place?.reading;
      const samePublication =
        !!previous &&
        previous.card === card &&
        previous.placeId === placeId &&
        previous.detail.revision.id === detail.revision.id &&
        currentPlaceCard();
      // A generic card can receive restored focus without adding another tab stop.
      if (card.tabIndex < 0) card.tabIndex = -1;
      const focused = document.activeElement as HTMLElement | null;
      const hadFocus = !!focused && card.contains(focused);
      if (
        samePublication &&
        place &&
        samePlacePresentation(place.reading, reading)
      ) {
        place.reading = reading;
      } else {
        const keepActionHome =
          samePublication && previous?.actions === reading.actions;
        const oldHome = keepActionHome ? place?.actionHome : undefined;
        if (!samePublication) hide();
        else if (!keepActionHome) restoreActionHome();
        const actionParent = reading.actions.parentNode;
        const actionHome =
          oldHome !== undefined
            ? oldHome
            : actionParent && !card.contains(actionParent)
              ? { parent: actionParent, next: reading.actions.nextSibling }
              : null;
        const article = createPublishedPlaceReading(document, reading);
        place = { reading, article, actionHome };
        card.dataset.publishedPlaceCard = "true";
        card.dataset.publicationRevision = detail.revision.id;
      }
      if (actionView && !actionView.refresh(reading)) actionView = undefined;
      showPublishedPlaceView(reading, actionView?.article ?? place.article);
      if (
        hadFocus &&
        focused &&
        (!card.contains(focused) || document.activeElement !== focused)
      ) {
        const control =
          focused === previous?.close || focused === reading.close
            ? reading.close
            : currentControl(reading.actions, focused);
        (control ?? card).focus({ preventScroll: true });
      }
      return true;
    },
    showPlaceAction(action: PublishedPlaceActionReading): boolean {
      if (
        !place ||
        actionView ||
        !currentPlaceCard() ||
        action.placeId !== place.reading.placeId ||
        action.revisionId !== place.reading.detail.revision.id ||
        !place.reading.actions.contains(action.returnFocus)
      )
        return false;
      const article = document.createElement("article");
      article.dataset.placeId = action.placeId;
      article.dataset.publicationRevision = action.revisionId;
      const heading = document.createElement("h2");
      heading.className = "md-assistant-place-detail-title";
      const body = document.createElement("div");
      const back = document.createElement("button");
      back.type = "button";
      back.className = "md-button md-button--secondary";
      article.append(heading, body, back);
      let displayedText: string | undefined;
      const view = {
        article,
        returnFocus: action.returnFocus,
        refresh(reading: PublishedPlaceReading): boolean {
          const control = currentControl(reading.actions, view.returnFocus);
          const presentation =
            control && action.content(reading.detail, reading.locale);
          if (!control || !presentation) return false;
          view.returnFocus = control;
          if (heading.textContent !== presentation.title)
            heading.textContent = presentation.title;
          if (displayedText !== presentation.text) {
            displayedText = presentation.text;
            body.replaceChildren(
              ...presentation.text
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const paragraph = document.createElement("p");
                  paragraph.textContent = line;
                  return paragraph;
                }),
            );
          }
          const label = copyByLanguage[reading.locale]!.backToPlace;
          if (back.textContent !== label) back.textContent = label;
          return true;
        },
      };
      if (!view.refresh(place.reading)) return false;
      const returnFromAction = (): boolean =>
        actionView?.article === article && backToPlace();
      back.addEventListener("click", returnFromAction);
      article.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && returnFromAction()) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      actionView = view;
      showPublishedPlaceView(place.reading, article);
      back.focus({ preventScroll: true });
      return true;
    },
    backToPlace,
    hide,
    setState,
    getState(): ExploreFlowBottomSheetState {
      return state;
    },
    setStatus,
    destroy(): void {
      featureStyles.cancel();
      if (destroyed) return;
      releasePlace();
      clearCompatibilityMessageSource();
      destroyed = true;
      dismissHandler = undefined;
      activeKind = undefined;
      sheet.remove();
    },
  });
}
