import { domainError } from "./error.js";
import type {
  Decision,
  Reservation,
  ResourceCommand,
  ResourceEvent,
  ResourceState
} from "./types.js";

const toMs = (isoUtc: string) => new Date(isoUtc).getTime();

const isIntervalValid = (fromUtc: string, toUtc: string) => toMs(fromUtc) < toMs(toUtc);

const overlaps = (
  { fromUtc, toUtc }: { fromUtc: string; toUtc: string },
  existing: Reservation
) =>
  existing.status === "active" &&
  toMs(fromUtc) < toMs(existing.toUtc) &&
  toMs(existing.fromUtc) < toMs(toUtc);

const canCancel = (
  reservation: Reservation,
  actor: { actorUserId: string; actorRole: "admin" | "user" }
) => actor.actorRole === "admin" || reservation.userId === actor.actorUserId;

export const foldResource = (
  state: ResourceState | null,
  event: ResourceEvent
): ResourceState | null => {
  if (event.type === "ResourceCreated") {
    return {
      resourceId: event.payload.resourceId,
      name: event.payload.name,
      details: event.payload.details,
      status: "active",
      reservations: []
    };
  }
  if (state === null) {
    return state;
  }
  if (event.type === "ResourceMetadataUpdated") {
    return { ...state, details: event.payload.details };
  }
  if (event.type === "ReservationAddedToResource") {
    return {
      ...state,
      reservations: [
        ...state.reservations,
        {
          reservationId: event.payload.reservationId,
          userId: event.payload.userId,
          fromUtc: event.payload.fromUtc,
          toUtc: event.payload.toUtc,
          status: "active",
          createdAtUtc: event.payload.createdAtUtc,
          cancelledAtUtc: null
        }
      ]
    };
  }
  if (event.type === "ResourceReservationCancelled") {
    return {
      ...state,
      reservations: state.reservations.map((reservation) =>
        reservation.reservationId === event.payload.reservationId
          ? {
              ...reservation,
              status: "cancelled",
              cancelledAtUtc: event.payload.cancelledAtUtc
            }
          : reservation
      )
    };
  }
  return state;
};

export const decideResource = (
  state: ResourceState | null,
  command: ResourceCommand
): Decision<ResourceEvent> => {
  if (command.type === "CreateResource") {
    return command.actorRole !== "admin"
      ? {
          kind: "rejected",
          error: domainError("FORBIDDEN", "Only admin can create resources", {})
        }
      : state !== null
        ? {
            kind: "rejected",
            error: domainError("RESOURCE_ALREADY_EXISTS", "Resource stream already initialized", {
              resourceId: state.resourceId
            })
          }
        : {
            kind: "accepted",
            event: {
              type: "ResourceCreated",
              payload: {
                resourceId: command.resourceId,
                name: command.name,
                details: command.details
              }
            }
          };
  }
  if (command.type === "UpdateResourceMetadata") {
    return command.actorRole !== "admin"
      ? {
          kind: "rejected",
          error: domainError("FORBIDDEN", "Only admin can edit resource metadata", {})
        }
      : state === null
        ? {
            kind: "rejected",
            error: domainError("RESOURCE_NOT_FOUND", "Resource does not exist", {
              resourceId: command.resourceId
            })
          }
        : {
            kind: "accepted",
            event: {
              type: "ResourceMetadataUpdated",
              payload: {
                resourceId: command.resourceId,
                details: command.details
              }
            }
          };
  }
  if (command.type === "CreateReservationInResource") {
    return state === null
      ? {
          kind: "rejected",
          error: domainError("RESOURCE_NOT_FOUND", "Resource does not exist", {
            resourceId: command.resourceId
          })
        }
      : !isIntervalValid(command.fromUtc, command.toUtc)
        ? {
            kind: "rejected",
            error: domainError("INVALID_INTERVAL", "Reservation interval is invalid", {
              fromUtc: command.fromUtc,
              toUtc: command.toUtc
            })
          }
        : toMs(command.fromUtc) < toMs(command.nowUtc)
          ? {
              kind: "rejected",
              error: domainError("RESERVATION_IN_PAST", "Reservation cannot start in the past", {
                nowUtc: command.nowUtc,
                fromUtc: command.fromUtc
              })
            }
          : state.reservations.some((reservation) =>
              overlaps({ fromUtc: command.fromUtc, toUtc: command.toUtc }, reservation)
            )
            ? {
                kind: "rejected",
                error: domainError("RESERVATION_OVERLAP", "Reservation overlaps existing active reservation", {
                  resourceId: command.resourceId
                })
              }
            : {
                kind: "accepted",
                event: {
                  type: "ReservationAddedToResource",
                  payload: {
                    resourceId: command.resourceId,
                    reservationId: command.reservationId,
                    userId: command.reservationUserId,
                    fromUtc: command.fromUtc,
                    toUtc: command.toUtc,
                    createdAtUtc: command.nowUtc
                  }
                }
              };
  }
  if (command.type === "CancelReservationInResource") {
    if (state === null) {
      return {
        kind: "rejected",
        error: domainError("RESOURCE_NOT_FOUND", "Resource does not exist", {
          resourceId: command.resourceId
        })
      };
    }
    const reservation = state.reservations.find(
      (candidate) => candidate.reservationId === command.reservationId
    );
    return reservation === undefined
      ? {
          kind: "rejected",
          error: domainError("RESERVATION_NOT_FOUND", "Reservation does not exist", {
            reservationId: command.reservationId
          })
        }
      : reservation.status === "cancelled"
        ? {
            kind: "rejected",
            error: domainError("RESERVATION_ALREADY_CANCELLED", "Reservation is already cancelled", {
              reservationId: command.reservationId
            })
          }
        : canCancel(reservation, {
              actorUserId: command.actorUserId,
              actorRole: command.actorRole
            })
          ? {
              kind: "accepted",
              event: {
                type: "ResourceReservationCancelled",
                payload: {
                  resourceId: command.resourceId,
                  reservationId: command.reservationId,
                  cancelledAtUtc: command.nowUtc
                }
              }
            }
          : {
              kind: "rejected",
              error: domainError(
                "UNAUTHORIZED_CANCEL",
                "Only reservation owner or admin can cancel reservation",
                { reservationId: command.reservationId }
              )
            };
  }
  return {
    kind: "rejected",
    error: domainError("INVALID_COMMAND", "Unsupported command", {})
  };
};
