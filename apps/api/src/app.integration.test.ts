import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

vi.mock("./infra/event-store.js", () => ({
  loadStream: vi.fn(),
  appendEvent: vi.fn(),
  VersionConflictError: class VersionConflictError extends Error {}
}));

vi.mock("./application/command-runner.js", () => ({
  makeEnvelope: vi.fn((value) => value),
  appendAndPublish: vi.fn((envelope) => Promise.resolve(envelope)),
  withSingleVersionRetry: vi.fn((action) => action())
}));

vi.mock("./infra/idempotency.js", () => ({
  loadIdempotency: vi.fn(() => Promise.resolve(null)),
  saveIdempotency: vi.fn(() => Promise.resolve(null)),
  idempotencyDecision: vi.fn((_existing, _key, _content) => ({ kind: "new", contentHash: "x" }))
}));

vi.mock("./projections/store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./projections/store.js")>();
  return {
    ...original,
    getUserById: vi.fn(),
    getUserByEmail: vi.fn(() => Promise.resolve(null)),
    resourceNameTaken: vi.fn(() => Promise.resolve(false))
  };
});

describe("API integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rechaza solapamiento al crear reserva", async () => {
    const { createApp } = await import("./app.js");
    const { loadStream } = await import("./infra/event-store.js");
    const { getUserById } = await import("./projections/store.js");
    vi.mocked(loadStream).mockResolvedValue([
      {
        eventId: "e1",
        streamId: "11111111-1111-4111-8111-111111111111",
        streamType: "resource",
        version: 1,
        type: "ResourceCreated",
        occurredAtUtc: "2026-02-10T00:00:00.000Z",
        payload: { resourceId: "11111111-1111-4111-8111-111111111111", name: "Sala", details: "A" },
        meta: {}
      },
      {
        eventId: "e2",
        streamId: "11111111-1111-4111-8111-111111111111",
        streamType: "resource",
        version: 2,
        type: "ReservationAddedToResource",
        occurredAtUtc: "2026-02-10T00:01:00.000Z",
        payload: {
          resourceId: "11111111-1111-4111-8111-111111111111",
          reservationId: "res-1",
          userId: "u-1",
          fromUtc: "2026-02-12T10:00:00.000Z",
          toUtc: "2026-02-12T11:00:00.000Z",
          createdAtUtc: "2026-02-10T00:01:00.000Z"
        },
        meta: {}
      }
    ]);
    vi.mocked(getUserById).mockResolvedValue({
      userId: "u-2",
      email: "u2@test.com",
      passwordHash: "x",
      role: "user"
    });

    const token = jwt.sign(
      { sub: "u-2", role: "user", email: "u2@test.com" },
      config.jwtSecret
    );

    const response = await request(createApp())
      .post("/commands/resource")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", "idemp-1")
      .send({
        command: {
          type: "CreateReservationInResource",
          payload: {
            resourceId: "11111111-1111-4111-8111-111111111111",
            fromUtc: "2026-02-12T10:30:00.000Z",
            toUtc: "2026-02-12T11:30:00.000Z"
          }
        }
      });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("RESERVATION_OVERLAP");
  });
});
