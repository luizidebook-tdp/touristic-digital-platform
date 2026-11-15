import { createHmac } from "node:crypto";

import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createTicketInventoryOffer,
  createTicketReservationRequestKey,
} from "@touristic/ticketing/reservations";

import {
  TicketingCommerceHttpTransport,
  type TicketingCommerceHttpTransportDependencies,
} from "./commerce-public-http-transport.js";
import {
  applyTicketingM150ReservationSchema,
  createTicketingMySqlPoolFromEnvironment,
} from "./index.js";
import { MySqlTicketReservationRepository } from "./mysql-ticket-reservation-repository.js";
import { TicketingPublicHttpTransport } from "./public-http-transport.js";

const secret = "commerce-test-root-secret-000000000000000000000000";
const now = "2026-09-17T22:00:00.000Z";

function request(
  pathname: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return Object.freeze({
    method,
    pathname,
    headers: Object.freeze({
      host: "morro.example",
      "x-forwarded-proto": "https",
      "x-correlation-id": "commerce:test:0001",
      ...headers,
    }),
    body,
    correlationId: "commerce:test:0001",
  });
}

function dependencies(
  authorization: TicketingCommerceHttpTransportDependencies["authorization"] = {
    authorize: vi.fn().mockResolvedValue({
      allowed: false,
      reason: "authentication_required",
    }),
  },
  businessInventoryOverrides: Partial<
    TicketingCommerceHttpTransportDependencies["businessInventory"]
  > = {},
): TicketingCommerceHttpTransportDependencies {
  const businessInventory = {
    listByBusiness: vi.fn().mockResolvedValue([]),
    listCatalogBindings: vi.fn().mockResolvedValue([]),
    bindCatalogOffer: vi.fn(),
    createForBusiness: vi.fn(),
    disableForBusiness: vi.fn(),
    ...businessInventoryOverrides,
  };
  return {
    enabled: true,
    reservations: {
      availability: vi.fn(),
      findReservationById: vi.fn(),
    },
    reads: {
      listInventory: vi.fn().mockResolvedValue([]),
      listReservationsByHolderReference: vi.fn().mockResolvedValue([]),
    },
    holders: {},
    reservationOrders: {},
    checkoutHandoffs: {},
    tickets: {},
    ticketing: {},
    offlineDevices: {},
    offlineDeviceRegistry: {},
    authorization,
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    qrSigningSecret: secret,
    offlineProvisioningSecret: secret,
    clock: { now: () => now },
    businessInventory,
    destinationId: "morro-de-sao-paulo",
  } as unknown as TicketingCommerceHttpTransportDependencies;
}

function sessionCookie(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

function signedSessionCookie(claims: Record<string, unknown>): string {
  const key = createHmac("sha256", secret)
    .update("morro-digital:commerce-session:v1")
    .digest();
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");
  return `morro_commerce_session=${payload}.${signature}`;
}

describe("TicketingCommerceHttpTransport security boundary", () => {
  it("issues an HttpOnly Strict Secure guest session only for same-origin HTTPS", async () => {
    const transport = new TicketingCommerceHttpTransport(dependencies());
    const result = await transport.handle(
      request(
        "/api/ticketing/v1/consumer-session",
        "POST",
        {
          origin: "https://morro.example",
        },
        {},
      ),
    );

    expect(result.status).toBe(201);
    expect(result.headers["Set-Cookie"]).toContain("HttpOnly");
    expect(result.headers["Set-Cookie"]).toContain("SameSite=Strict");
    expect(result.headers["Set-Cookie"]).toContain("Secure");
    const data = result.body.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("INVALID_COMMERCE_SESSION_RESPONSE");
    }
    const session = data as Readonly<Record<string, unknown>>;
    expect(typeof session.subject).toBe("string");
    expect(String(session.subject)).toMatch(/^guest:[a-f0-9]{32}$/u);
    expect(typeof session.csrfToken).toBe("string");
  });

  it("rejects cross-origin guest session issuance", async () => {
    const transport = new TicketingCommerceHttpTransport(dependencies());
    const result = await transport.handle(
      request(
        "/api/ticketing/v1/consumer-session",
        "POST",
        {
          origin: "https://evil.example",
        },
        {},
      ),
    );
    expect(result.status).toBe(403);
    expect(result.body.error).toBe("ORIGIN_DENIED");
  });

  it("rejects tampered and expired guest sessions", async () => {
    const transport = new TicketingCommerceHttpTransport(dependencies());
    const issued = await transport.handle(
      request(
        "/api/ticketing/v1/consumer-session",
        "POST",
        {
          origin: "https://morro.example",
        },
        {},
      ),
    );
    const cookie = sessionCookie(String(issued.headers["Set-Cookie"]));
    const lastCharacter = cookie.at(-1);
    const tampered = `${cookie.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;
    const tamperedResult = await transport.handle(
      request("/api/ticketing/v1/reservations", "GET", { cookie: tampered }),
    );
    expect(tamperedResult.status).toBe(401);

    const expired = signedSessionCookie({
      version: 1,
      subject: "guest:0123456789abcdef0123456789abcdef",
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_000 + 30 * 24 * 60 * 60,
    });
    const expiredResult = await transport.handle(
      request("/api/ticketing/v1/reservations", "GET", { cookie: expired }),
    );
    expect(expiredResult.status).toBe(401);
  });

  it("requires CSRF for guest mutations and never elevates guest to operator routes", async () => {
    const transport = new TicketingCommerceHttpTransport(dependencies());
    const issued = await transport.handle(
      request(
        "/api/ticketing/v1/consumer-session",
        "POST",
        {
          origin: "https://morro.example",
        },
        {},
      ),
    );
    const cookie = sessionCookie(String(issued.headers["Set-Cookie"]));

    const mutation = await transport.handle(
      request(
        "/api/ticketing/v1/reservations",
        "POST",
        { cookie, origin: "https://morro.example" },
        {},
      ),
    );
    expect(mutation.status).toBe(403);
    expect(mutation.body.error).toBe("INVALID_CSRF");

    const operator = await transport.handle(
      request(
        "/api/ticketing/v1/operator/check-in",
        "POST",
        {
          cookie,
          origin: "https://morro.example",
          "x-csrf-token": String(
            (issued.body.data as { csrfToken: string }).csrfToken,
          ),
        },
        {},
      ),
    );
    expect(operator.status).toBe(401);
    expect(operator.body.error).toBe("AUTH_REQUIRED");
  });

  it("keeps the public catalog readable without creating guest privileges", async () => {
    const deps = dependencies();
    const transport = new TicketingCommerceHttpTransport(deps);
    const result = await transport.handle(
      request("/api/ticketing/v1/inventory", "GET"),
    );
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual([]);
  });

  it("fails closed for cross-tenant Morro Pro inventory reads", async () => {
    const listByBusiness = vi.fn().mockResolvedValue([]);
    const transport = new TicketingCommerceHttpTransport(
      dependencies(
        {
          authorize: vi.fn().mockResolvedValue({
            allowed: true,
            actor: {
              subject: "user:business-a",
              role: "editor",
              businessIds: ["business-a"],
            },
          }),
        },
        { listByBusiness },
      ),
    );
    const result = await transport.handle(
      request(
        "/api/ticketing/v1/operator/businesses/business-b/inventory",
        "GET",
      ),
    );
    expect(result.status).toBe(404);
    expect(listByBusiness).not.toHaveBeenCalled();
  });

  it("allows an authenticated tenant to list only its own Morro Pro inventory", async () => {
    const listByBusiness = vi.fn().mockResolvedValue([]);
    const transport = new TicketingCommerceHttpTransport(
      dependencies(
        {
          authorize: vi.fn().mockResolvedValue({
            allowed: true,
            actor: {
              subject: "user:business-a",
              role: "editor",
              businessIds: ["business-a"],
            },
          }),
        },
        { listByBusiness },
      ),
    );
    const result = await transport.handle(
      request(
        "/api/ticketing/v1/operator/businesses/business-a/inventory",
        "GET",
      ),
    );
    expect(result.status).toBe(200);
    expect(listByBusiness).toHaveBeenCalledWith("business-a");
  });

  it("binds Ticketing inventory to a canonical Catalog Offer under tenant authority", async () => {
    const bindCatalogOffer = vi.fn().mockResolvedValue({
      inventoryId: "mpi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      businessId: "business-a",
      offerId: "offer-a",
    });
    const transport = new TicketingCommerceHttpTransport(
      dependencies(
        {
          authorize: vi.fn().mockResolvedValue({
            allowed: true,
            actor: {
              subject: "user:business-a",
              role: "editor",
              businessIds: ["business-a"],
            },
          }),
        },
        { bindCatalogOffer },
      ),
    );
    const result = await transport.handle(
      request(
        "/api/ticketing/v1/operator/businesses/business-a/inventory/mpi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/catalog-offer",
        "POST",
        {},
        { offerId: "offer-a", productReference: "legacy:not-authority" },
      ),
    );

    expect(result.status).toBe(200);
    expect(bindCatalogOffer).toHaveBeenCalledWith({
      businessId: "business-a",
      inventoryId: "mpi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      offerId: "offer-a",
      actorSubject: "user:business-a",
      recordedAt: now,
    });
  });

  it("does not execute a Catalog binding for a cross-tenant inventory route", async () => {
    const bindCatalogOffer = vi.fn();
    const transport = new TicketingCommerceHttpTransport(
      dependencies(
        {
          authorize: vi.fn().mockResolvedValue({
            allowed: true,
            actor: {
              subject: "user:business-a",
              role: "editor",
              businessIds: ["business-a"],
            },
          }),
        },
        { bindCatalogOffer },
      ),
    );
    const result = await transport.handle(
      request(
        "/api/ticketing/v1/operator/businesses/business-b/inventory/mpi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/catalog-offer",
        "POST",
        {},
        { offerId: "offer-a" },
      ),
    );

    expect(result.status).toBe(404);
    expect(bindCatalogOffer).not.toHaveBeenCalled();
  });
});

function quoteInventory(
  destinationId = "morro-de-sao-paulo",
  id = "tin_a01_quote_test_0001",
) {
  const inventory = createTicketInventoryOffer({
    id,
    destinationId,
    product: { kind: "business_experience", reference: "a01-test-sunset" },
    label: "TEST quote inventory",
    unitAmount: { minorUnits: 5_000, currency: "BRL" },
    pricingVersion: "a01-test-v1",
    capacity: 20,
    maxPerReservation: 6,
    salesStartAt: "2026-09-17T21:00:00.000Z",
    salesEndAt: "2026-09-17T22:30:00.000Z",
    startsAt: "2026-09-17T23:00:00.000Z",
    endsAt: "2026-09-18T01:00:00.000Z",
    createdAt: "2026-09-17T20:00:00.000Z",
    updatedAt: "2026-09-17T20:00:00.000Z",
  });
  if (!inventory) throw new Error("INVALID_A01_QUOTE_FIXTURE");
  return inventory;
}

const authenticatedQuote = {
  authorize: vi.fn().mockResolvedValue({
    allowed: true,
    actor: { subject: "user:a01-test", role: "editor" },
  }),
};

function quoteScenario(
  authorization?: TicketingCommerceHttpTransportDependencies["authorization"],
  inventory = quoteInventory(),
) {
  const base = dependencies(authorization);
  const commercialEffect = vi.fn(() => {
    throw new Error("UNEXPECTED_A01_COMMERCIAL_EFFECT");
  });
  const reservations = {
    ...base.reservations,
    findInventoryById: vi.fn().mockResolvedValue(inventory),
    availability: vi.fn().mockResolvedValue({
      inventoryId: inventory.id,
      capacity: inventory.capacity,
      committedQuantity: 1,
      remainingQuantity: 19,
      sellable: true,
      observedAt: now,
    }),
    hold: commercialEffect,
    confirmAuthoritative: commercialEffect,
    cancelHold: commercialEffect,
  };
  return {
    reservations,
    commercialEffect,
    dependencies: {
      ...base,
      reservations,
      reservationOrders: { placeReservationOrder: commercialEffect },
      checkoutHandoffs: { issue: commercialEffect },
      tickets: { save: commercialEffect, findByOrderId: commercialEffect },
      ticketing: { checkInByQr: commercialEffect },
    } as unknown as TicketingCommerceHttpTransportDependencies,
  };
}

async function issueQuoteSession(transport: TicketingCommerceHttpTransport) {
  const issued = await transport.handle(
    request(
      "/api/ticketing/v1/consumer-session",
      "POST",
      { origin: "https://morro.example" },
      {},
    ),
  );
  expect(issued.status).toBe(201);
  return {
    cookie: sessionCookie(String(issued.headers["Set-Cookie"])),
    csrf: String((issued.body.data as { csrfToken: string }).csrfToken),
  };
}

function quoteHeaders(session: { cookie: string; csrf: string }) {
  return {
    cookie: session.cookie,
    origin: "https://morro.example",
    "x-csrf-token": session.csrf,
  } as Record<string, string>;
}

describe("A01 composed guest quote destination boundary", () => {
  it("quotes the same canonical price and validity for guest and authenticated actors", async () => {
    const guest = quoteScenario();
    const transport = new TicketingCommerceHttpTransport(guest.dependencies);
    const session = await issueQuoteSession(transport);
    const guestResult = await transport.handle(
      request("/api/ticketing/v1/quote", "POST", quoteHeaders(session), {
        inventoryId: quoteInventory().id,
        quantity: 2,
      }),
    );
    const authenticated = quoteScenario(authenticatedQuote);
    const authenticatedResult = await new TicketingCommerceHttpTransport(
      authenticated.dependencies,
    ).handle(
      request(
        "/api/ticketing/v1/quote",
        "POST",
        {},
        {
          inventoryId: quoteInventory().id,
          quantity: 2,
        },
      ),
    );
    expect(guestResult.status).toBe(200);
    expect(authenticatedResult.status).toBe(200);
    expect(guestResult.body.data).toEqual(authenticatedResult.body.data);
    expect(guestResult.body.data).toEqual({
      inventoryId: quoteInventory().id,
      quantity: 2,
      unitAmount: { minorUnits: 5_000, currency: "BRL" },
      totalAmount: { minorUnits: 10_000, currency: "BRL" },
      pricingVersion: "a01-test-v1",
      availableQuantity: 19,
      maxPerReservation: 6,
      observedAt: now,
      expiresAt: "2026-09-17T22:01:00.000Z",
    });
    expect(guest.commercialEffect).not.toHaveBeenCalled();
    expect(authenticated.commercialEffect).not.toHaveBeenCalled();
  });

  it("rejects foreign destination inventory before reading availability", async () => {
    const scenario = quoteScenario(
      authenticatedQuote,
      quoteInventory("itacare"),
    );
    const result = await new TicketingCommerceHttpTransport(
      scenario.dependencies,
    ).handle(
      request(
        "/api/ticketing/v1/quote",
        "POST",
        {},
        {
          inventoryId: quoteInventory().id,
          quantity: 2,
          destinationId: "itacare",
        },
      ),
    );
    expect(result.status).toBe(404);
    expect(result.body.error).toBe("INVENTORY_NOT_FOUND");
    expect(scenario.reservations.availability).not.toHaveBeenCalled();
    expect(scenario.commercialEffect).not.toHaveBeenCalled();
  });

  it.each(["itacare", "MORRO-DE-SAO-PAULO"])(
    "rejects a guest inventory outside the exact configured destination: %s",
    async (destination) => {
      const scenario = quoteScenario(undefined, quoteInventory(destination));
      const transport = new TicketingCommerceHttpTransport(
        scenario.dependencies,
      );
      const session = await issueQuoteSession(transport);
      const result = await transport.handle(
        request(
          "/api/ticketing/v1/quote",
          "POST",
          { ...quoteHeaders(session), "x-destination-id": destination },
          {
            inventoryId: quoteInventory().id,
            quantity: 2,
            destinationId: destination,
          },
        ),
      );
      expect(result.status).toBe(404);
      expect(result.body.error).toBe("INVENTORY_NOT_FOUND");
      expect(scenario.reservations.availability).not.toHaveBeenCalled();
      expect(scenario.commercialEffect).not.toHaveBeenCalled();
    },
  );

  it.each(["absent", "tampered", "expired"])(
    "denies a %s session before commercial reads",
    async (kind) => {
      const scenario = quoteScenario();
      const transport = new TicketingCommerceHttpTransport(
        scenario.dependencies,
      );
      const session = await issueQuoteSession(transport);
      const headers = quoteHeaders(session);
      if (kind === "absent") delete headers.cookie;
      if (kind === "tampered") headers.cookie = session.cookie + "tampered";
      if (kind === "expired")
        headers.cookie = signedSessionCookie({
          version: 1,
          subject: "guest:0123456789abcdef0123456789abcdef",
          issuedAt: 1_700_000_000,
          expiresAt: 1_700_000_000 + 30 * 24 * 60 * 60,
        });
      const result = await transport.handle(
        request("/api/ticketing/v1/quote", "POST", headers, {
          inventoryId: quoteInventory().id,
          quantity: 2,
        }),
      );
      expect(result.status).toBe(401);
      expect(scenario.reservations.findInventoryById).not.toHaveBeenCalled();
      expect(scenario.reservations.availability).not.toHaveBeenCalled();
      expect(scenario.commercialEffect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing CSRF", "x-csrf-token", null, "INVALID_CSRF"],
    ["invalid CSRF", "x-csrf-token", "invalid", "INVALID_CSRF"],
    ["missing origin", "origin", null, "ORIGIN_DENIED"],
    ["foreign origin", "origin", "https://foreign.example", "ORIGIN_DENIED"],
  ] as const)(
    "denies %s before commercial reads",
    async (_name, key, value, error) => {
      const scenario = quoteScenario();
      const transport = new TicketingCommerceHttpTransport(
        scenario.dependencies,
      );
      const session = await issueQuoteSession(transport);
      const headers = quoteHeaders(session);
      if (value === null) delete headers[key];
      else headers[key] = value;
      const result = await transport.handle(
        request("/api/ticketing/v1/quote", "POST", headers, {
          inventoryId: quoteInventory().id,
          quantity: 2,
        }),
      );
      expect(result.status).toBe(403);
      expect(result.body.error).toBe(error);
      expect(scenario.reservations.findInventoryById).not.toHaveBeenCalled();
      expect(scenario.reservations.availability).not.toHaveBeenCalled();
      expect(scenario.commercialEffect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["read_only_role", "READ_ONLY_ROLE"],
    ["invalid_csrf", "INVALID_CSRF"],
    ["cross_origin_request", "ORIGIN_DENIED"],
    ["admin_required", "ADMIN_REQUIRED"],
  ])("never overrides a base %s denial", async (reason, error) => {
    const scenario = quoteScenario({
      authorize: vi.fn().mockResolvedValue({ allowed: false, reason }),
    });
    const transport = new TicketingCommerceHttpTransport(scenario.dependencies);
    const session = await issueQuoteSession(transport);
    const result = await transport.handle(
      request("/api/ticketing/v1/quote", "POST", quoteHeaders(session), {
        inventoryId: quoteInventory().id,
        quantity: 2,
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.error).toBe(error);
    expect(scenario.reservations.findInventoryById).not.toHaveBeenCalled();
    expect(scenario.reservations.availability).not.toHaveBeenCalled();
    expect(scenario.commercialEffect).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/quote"],
    ["PUT", "/quote"],
    ["DELETE", "/quote"],
    ["POST", "/quote/"],
    ["POST", "/quote/suffix"],
    ["POST", "/QUOTE"],
    ["POST", "/operator/check-in"],
    ["GET", "/operator/inventory"],
    ["GET", "/operator/businesses/business-a/inventory"],
  ])("does not add guest authority to %s %s", async (method, path) => {
    const scenario = quoteScenario();
    const transport = new TicketingCommerceHttpTransport(scenario.dependencies);
    const session = await issueQuoteSession(transport);
    const result = await transport.handle(
      request("/api/ticketing/v1" + path, method, quoteHeaders(session), {
        inventoryId: quoteInventory().id,
        quantity: 2,
      }),
    );
    expect(result.status).toBe(401);
    expect(scenario.reservations.findInventoryById).not.toHaveBeenCalled();
    expect(scenario.reservations.availability).not.toHaveBeenCalled();
    expect(
      scenario.dependencies.businessInventory.listByBusiness,
    ).not.toHaveBeenCalled();
    expect(scenario.commercialEffect).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"])(
    "rejects invalid quantity %s without consulting inventory",
    async (quantity) => {
      const scenario = quoteScenario();
      const transport = new TicketingCommerceHttpTransport(
        scenario.dependencies,
      );
      const session = await issueQuoteSession(transport);
      const result = await transport.handle(
        request("/api/ticketing/v1/quote", "POST", quoteHeaders(session), {
          inventoryId: quoteInventory().id,
          quantity,
        }),
      );
      expect(result.status).toBe(400);
      expect(result.body.error).toBe("TICKETING_QUANTITY_INVALID");
      expect(scenario.reservations.findInventoryById).not.toHaveBeenCalled();
      expect(scenario.reservations.availability).not.toHaveBeenCalled();
      expect(scenario.commercialEffect).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["absent", 404, "INVENTORY_NOT_FOUND"],
    ["unavailable", 409, "TICKETING_INVENTORY_UNAVAILABLE"],
    ["exhausted", 409, "TICKETING_INVENTORY_EXHAUSTED"],
    ["limit", 409, "TICKETING_QUANTITY_LIMIT"],
  ])(
    "preserves the %s offer outcome without new commercial operations",
    async (kind, status, error) => {
      const scenario = quoteScenario();
      if (kind === "absent")
        scenario.reservations.findInventoryById.mockResolvedValue(null);
      if (kind === "unavailable" || kind === "exhausted") {
        scenario.reservations.availability.mockResolvedValue({
          sellable: kind !== "unavailable",
          remainingQuantity: kind === "exhausted" ? 0 : 19,
          observedAt: now,
        });
      }
      const transport = new TicketingCommerceHttpTransport(
        scenario.dependencies,
      );
      const session = await issueQuoteSession(transport);
      const result = await transport.handle(
        request("/api/ticketing/v1/quote", "POST", quoteHeaders(session), {
          inventoryId: quoteInventory().id,
          quantity: kind === "limit" ? 7 : 2,
        }),
      );
      expect(result.status).toBe(status);
      expect(result.body.error).toBe(error);
      expect(scenario.commercialEffect).not.toHaveBeenCalled();
      if (kind === "absent")
        expect(scenario.reservations.availability).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    null,
    "",
    " ",
    " morro-de-sao-paulo",
    "morro-de-sao-paulo ",
    "morro/dest",
    42,
  ])("fails closed for invalid configured destination %s", (destinationId) => {
    const scenario = quoteScenario();
    expect(
      () =>
        new TicketingCommerceHttpTransport({
          ...scenario.dependencies,
          destinationId: destinationId as unknown as string,
        }),
    ).toThrow("TICKETING_COMMERCE_DESTINATION_REQUIRED");
    expect(scenario.reservations.availability).not.toHaveBeenCalled();
  });

  it("preserves explicit legacy public transport compatibility without a configured destination", async () => {
    const scenario = quoteScenario(authenticatedQuote);
    const { destinationId, ...legacy } = scenario.dependencies;
    expect(destinationId).toBe("morro-de-sao-paulo");
    const result = await new TicketingPublicHttpTransport(legacy).handle(
      request(
        "/api/ticketing/v1/quote",
        "POST",
        {},
        {
          inventoryId: quoteInventory().id,
          quantity: 2,
        },
      ),
    );
    expect(result.status).toBe(200);
    expect(scenario.commercialEffect).not.toHaveBeenCalled();
  });
});

function validatedQuoteTestUrls(databaseUrl: string, adminUrl: string) {
  let target: URL;
  let adminTarget: URL;
  try {
    target = new URL(databaseUrl);
    adminTarget = new URL(adminUrl);
  } catch {
    throw new Error("A01_DISPOSABLE_TEST_DATABASE_REQUIRED");
  }
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    databaseUrl !== databaseUrl.trim() ||
    adminUrl !== adminUrl.trim() ||
    target.protocol !== "mysql:" ||
    adminTarget.protocol !== "mysql:" ||
    !localHosts.has(target.hostname) ||
    adminTarget.hostname !== target.hostname ||
    target.port !== adminTarget.port ||
    target.pathname !== "/ticketing_m147_test" ||
    adminTarget.pathname !== "/mysql" ||
    target.href.includes("?") ||
    target.href.includes("#") ||
    adminTarget.href.includes("?") ||
    adminTarget.href.includes("#")
  )
    throw new Error("A01_DISPOSABLE_TEST_DATABASE_REQUIRED");
  return Object.freeze({ target: target.href, admin: adminTarget.href });
}

describe("A01 disposable MySQL URL admission without I/O", () => {
  const target = "mysql://test@127.0.0.1:3306/ticketing_m147_test";
  const admin = "mysql://test@127.0.0.1:3306/mysql";

  it("accepts only the canonical option-free loopback test targets", () => {
    expect(validatedQuoteTestUrls(target, admin)).toEqual({ target, admin });
  });

  it.each(
    [
      "?socketPath=/tmp/a01-foreign.sock",
      "?host=foreign.example",
      "?port=3307",
      "?database=foreign",
      "?uri=mysql://foreign.example/foreign",
      "?ssl=true",
      "#foreign",
      "?",
      "#",
    ].flatMap(
      (suffix) =>
        [
          ["target", suffix],
          ["admin", suffix],
        ] as const,
    ),
  )("rejects %s URL options %s before any driver I/O", (side, suffix) => {
    const connection = vi
      .spyOn(mysql, "createConnection")
      .mockImplementation(() => {
        throw new Error("UNEXPECTED_A01_DRIVER_CONNECTION");
      });
    const pool = vi.spyOn(mysql, "createPool").mockImplementation(() => {
      throw new Error("UNEXPECTED_A01_DRIVER_POOL");
    });
    try {
      expect(() =>
        validatedQuoteTestUrls(
          target + (side === "target" ? suffix : ""),
          admin + (side === "admin" ? suffix : ""),
        ),
      ).toThrow("A01_DISPOSABLE_TEST_DATABASE_REQUIRED");
      expect(connection).not.toHaveBeenCalled();
      expect(pool).not.toHaveBeenCalled();
    } finally {
      connection.mockRestore();
      pool.mockRestore();
    }
  });
});

const quoteDatabaseUrl = process.env.TICKETING_DATABASE_URL;
const quoteAdminUrl = process.env.MYSQL_ADMIN_DATABASE_URL;
const describeQuoteMySql =
  quoteDatabaseUrl && quoteAdminUrl ? describe : describe.skip;

interface QuoteReservationRow extends RowDataPacket {
  readonly reservation_id: string;
  readonly order_id: string | null;
  readonly payment_id: string | null;
}

describeQuoteMySql.sequential("A01 guest quote real MySQL composition", () => {
  let pool: Pool;
  let disposableTargetVerified = false;
  const localId = "tin_a01_quote_mysql_local";
  const foreignId = "tin_a01_quote_mysql_foreign";
  const inventoryIds = [localId, foreignId];

  async function cleanup() {
    if (!disposableTargetVerified)
      throw new Error("A01_TEST_TARGET_NOT_VERIFIED");
    await pool.execute(
      "DELETE FROM ticketing_reservation_events WHERE inventory_id IN (?, ?)",
      inventoryIds,
    );
    await pool.execute(
      "DELETE FROM ticketing_reservations WHERE inventory_id IN (?, ?)",
      inventoryIds,
    );
    await pool.execute(
      "DELETE FROM ticketing_inventory WHERE inventory_id IN (?, ?)",
      inventoryIds,
    );
  }

  async function snapshot() {
    const [reservations] = await pool.query<QuoteReservationRow[]>(
      "SELECT * FROM ticketing_reservations WHERE inventory_id IN (?, ?) ORDER BY reservation_id",
      inventoryIds,
    );
    const [events] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM ticketing_reservation_events WHERE inventory_id IN (?, ?) ORDER BY event_id",
      inventoryIds,
    );
    const [inventory] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM ticketing_inventory WHERE inventory_id IN (?, ?) ORDER BY inventory_id",
      inventoryIds,
    );
    return { reservations, events, inventory };
  }

  async function hold(
    repository: MySqlTicketReservationRepository,
    inventoryId: string,
    reservationId: string,
    expiresAt: string,
    quantity = 1,
  ) {
    const key = createTicketReservationRequestKey(inventoryId, reservationId);
    if (!key) throw new Error("INVALID_A01_MYSQL_REQUEST_KEY");
    await repository.hold({
      reservationId,
      requestKey: key,
      inventoryId,
      holderReference: "a01_quote_fixture_holder",
      quantity,
      heldAt: "2026-09-17T21:40:00.000Z",
      expiresAt,
      actorReference: "a01_quote_fixture",
    });
  }

  beforeAll(async () => {
    if (!quoteDatabaseUrl || !quoteAdminUrl)
      throw new Error("A01_TEST_MYSQL_URLS_REQUIRED");
    const urls = validatedQuoteTestUrls(quoteDatabaseUrl, quoteAdminUrl);
    const admin = await mysql.createConnection(urls.admin);
    try {
      await admin.query(
        "CREATE DATABASE IF NOT EXISTS ticketing_m147_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
      );
    } finally {
      await admin.end();
    }
    pool = createTicketingMySqlPoolFromEnvironment({
      TICKETING_DATABASE_URL: urls.target,
    });
    const [identity] = await pool.query<RowDataPacket[]>(
      "SELECT DATABASE() AS database_name",
    );
    expect(identity[0]?.database_name).toBe("ticketing_m147_test");
    await applyTicketingM150ReservationSchema(pool);
    disposableTargetVerified = true;
  });

  beforeEach(async () => {
    await cleanup();
    const repository = new MySqlTicketReservationRepository(pool);
    await repository.saveInventory(
      quoteInventory("morro-de-sao-paulo", localId),
    );
    await repository.saveInventory(quoteInventory("itacare", foreignId));
  });

  afterAll(async () => {
    if (pool) {
      try {
        if (disposableTargetVerified) await cleanup();
      } finally {
        await pool.end();
      }
    }
  });

  it("quotes guest and authenticated parity while expiring only preexisting stale holds once", async () => {
    const repository = new MySqlTicketReservationRepository(pool);
    const validId = "trv_a01_quote_mysql_valid";
    const expiredId = "trv_a01_quote_mysql_expired";
    await hold(repository, localId, validId, "2026-09-17T22:10:00.000Z");
    await hold(repository, localId, expiredId, "2026-09-17T21:50:00.000Z", 2);
    const before = await snapshot();
    const validBefore = await repository.findReservationById(validId);
    const holdSpy = vi.spyOn(repository, "hold");
    const confirmSpy = vi.spyOn(repository, "confirmAuthoritative");
    const cancelSpy = vi.spyOn(repository, "cancelHold");
    const scenario = quoteScenario();
    const transport = new TicketingCommerceHttpTransport({
      ...scenario.dependencies,
      reservations: repository,
    });
    const session = await issueQuoteSession(transport);
    const input = { inventoryId: localId, quantity: 2 };
    const guest = await transport.handle(
      request("/api/ticketing/v1/quote", "POST", quoteHeaders(session), input),
    );
    const authenticated = await new TicketingCommerceHttpTransport({
      ...scenario.dependencies,
      reservations: repository,
      authorization: authenticatedQuote,
    }).handle(request("/api/ticketing/v1/quote", "POST", {}, input));
    const repeated = await transport.handle(
      request("/api/ticketing/v1/quote", "POST", quoteHeaders(session), input),
    );
    expect(guest.status).toBe(200);
    expect(authenticated.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(guest.body.data).toEqual(authenticated.body.data);
    expect(repeated.body.data).toEqual(guest.body.data);
    expect(guest.body.data).toMatchObject({
      inventoryId: localId,
      quantity: 2,
      unitAmount: { minorUnits: 5_000, currency: "BRL" },
      totalAmount: { minorUnits: 10_000, currency: "BRL" },
      pricingVersion: "a01-test-v1",
      availableQuantity: 19,
      maxPerReservation: 6,
      observedAt: now,
      expiresAt: "2026-09-17T22:01:00.000Z",
    });
    const after = await snapshot();
    expect(after.reservations.map((row) => row.reservation_id)).toEqual(
      before.reservations.map((row) => row.reservation_id),
    );
    expect(after.inventory).toEqual(before.inventory);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(await repository.findReservationById(validId)).toEqual(validBefore);
    expect(await repository.findReservationById(expiredId)).toMatchObject({
      status: "expired",
      expiredAt: now,
      updatedAt: now,
      orderId: null,
      paymentId: null,
    });
    const expiryEvents = (await repository.listEvents(expiredId)).filter(
      (event) => event.eventType === "expired",
    );
    expect(expiryEvents).toHaveLength(1);
    expect(expiryEvents[0]).toMatchObject({
      actorReference: "system_expiry",
      occurredAt: now,
    });
    expect(
      after.reservations.every(
        (row) => row.order_id === null && row.payment_id === null,
      ),
    ).toBe(true);
    expect(holdSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(scenario.commercialEffect).not.toHaveBeenCalled();
  });

  it("rejects foreign inventory for both actors before SQL availability or stale-hold maintenance", async () => {
    const repository = new MySqlTicketReservationRepository(pool);
    await hold(
      repository,
      foreignId,
      "trv_a01_quote_mysql_foreign",
      "2026-09-17T21:50:00.000Z",
    );
    const before = await snapshot();
    const availability = vi.spyOn(repository, "availability");
    const scenario = quoteScenario();
    const transport = new TicketingCommerceHttpTransport({
      ...scenario.dependencies,
      reservations: repository,
    });
    const session = await issueQuoteSession(transport);
    const input = {
      inventoryId: foreignId,
      quantity: 2,
      destinationId: "itacare",
    };
    const guest = await transport.handle(
      request("/api/ticketing/v1/quote", "POST", quoteHeaders(session), input),
    );
    const authenticated = await new TicketingCommerceHttpTransport({
      ...scenario.dependencies,
      reservations: repository,
      authorization: authenticatedQuote,
    }).handle(request("/api/ticketing/v1/quote", "POST", {}, input));
    expect(guest.status).toBe(404);
    expect(authenticated.status).toBe(404);
    expect(guest.body).toEqual(authenticated.body);
    expect(guest.body.error).toBe("INVENTORY_NOT_FOUND");
    expect(availability).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(scenario.commercialEffect).not.toHaveBeenCalled();
  });

  it("denies invalid session, CSRF and origin before any inventory read or SQL maintenance", async () => {
    const repository = new MySqlTicketReservationRepository(pool);
    await hold(
      repository,
      localId,
      "trv_a01_quote_mysql_unauth",
      "2026-09-17T21:50:00.000Z",
    );
    const before = await snapshot();
    const findInventory = vi.spyOn(repository, "findInventoryById");
    const availability = vi.spyOn(repository, "availability");
    const scenario = quoteScenario();
    const transport = new TicketingCommerceHttpTransport({
      ...scenario.dependencies,
      reservations: repository,
    });
    const session = await issueQuoteSession(transport);
    for (const key of ["cookie", "x-csrf-token", "origin"]) {
      const headers = quoteHeaders(session);
      delete headers[key];
      const result = await transport.handle(
        request("/api/ticketing/v1/quote", "POST", headers, {
          inventoryId: localId,
          quantity: 2,
        }),
      );
      expect(result.status).toBe(key === "cookie" ? 401 : 403);
    }
    expect(findInventory).not.toHaveBeenCalled();
    expect(availability).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect(scenario.commercialEffect).not.toHaveBeenCalled();
  });
});
