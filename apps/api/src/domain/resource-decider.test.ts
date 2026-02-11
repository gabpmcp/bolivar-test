import { describe, expect, it } from "vitest";
import { decideResource } from "./resource-decider.js";
import type { ResourceState } from "./types.js";

const baseState: ResourceState = {
  resourceId: "r1",
  name: "Sala 1",
  details: "Sala principal",
  status: "active",
  reservations: []
};

describe("decideResource", () => {
  it("rechaza solapamiento en el mismo recurso", () => {
    const decision = decideResource(
      {
        ...baseState,
        reservations: [
          {
            reservationId: "res-1",
            userId: "u1",
            fromUtc: "2026-02-12T10:00:00.000Z",
            toUtc: "2026-02-12T11:00:00.000Z",
            status: "active",
            createdAtUtc: "2026-02-11T10:00:00.000Z",
            cancelledAtUtc: null
          }
        ]
      },
      {
        type: "CreateReservationInResource",
        resourceId: "r1",
        reservationId: "res-2",
        fromUtc: "2026-02-12T10:30:00.000Z",
        toUtc: "2026-02-12T11:30:00.000Z",
        reservationUserId: "u2",
        actorUserId: "u2",
        actorRole: "user",
        nowUtc: "2026-02-11T10:00:00.000Z"
      }
    );

    expect(decision.kind).toBe("rejected");
    expect(decision.kind === "rejected" ? decision.error.error.code : "").toBe("RESERVATION_OVERLAP");
  });

  it("permite intervalos semiabiertos [inicio, fin)", () => {
    const decision = decideResource(
      {
        ...baseState,
        reservations: [
          {
            reservationId: "res-1",
            userId: "u1",
            fromUtc: "2026-02-12T10:00:00.000Z",
            toUtc: "2026-02-12T11:00:00.000Z",
            status: "active",
            createdAtUtc: "2026-02-11T10:00:00.000Z",
            cancelledAtUtc: null
          }
        ]
      },
      {
        type: "CreateReservationInResource",
        resourceId: "r1",
        reservationId: "res-2",
        fromUtc: "2026-02-12T11:00:00.000Z",
        toUtc: "2026-02-12T12:00:00.000Z",
        reservationUserId: "u2",
        actorUserId: "u2",
        actorRole: "user",
        nowUtc: "2026-02-11T10:00:00.000Z"
      }
    );

    expect(decision.kind).toBe("accepted");
  });

  it("solo admin o creador pueden cancelar", () => {
    const decision = decideResource(
      {
        ...baseState,
        reservations: [
          {
            reservationId: "res-1",
            userId: "u1",
            fromUtc: "2026-02-12T10:00:00.000Z",
            toUtc: "2026-02-12T11:00:00.000Z",
            status: "active",
            createdAtUtc: "2026-02-11T10:00:00.000Z",
            cancelledAtUtc: null
          }
        ]
      },
      {
        type: "CancelReservationInResource",
        resourceId: "r1",
        reservationId: "res-1",
        actorUserId: "u2",
        actorRole: "user",
        nowUtc: "2026-02-11T12:00:00.000Z"
      }
    );

    expect(decision.kind).toBe("rejected");
    expect(decision.kind === "rejected" ? decision.error.error.code : "").toBe("UNAUTHORIZED_CANCEL");
  });
});
