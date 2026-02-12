import type { ErrorShape, Role } from "@app/shared";

export type { Role };
export type DomainError = ErrorShape;

export type Decision<T> =
  | { kind: "accepted"; event: T }
  | { kind: "rejected"; error: DomainError };

export type StreamType = "user" | "resource";

export type RecordedEvent<TType extends string, TPayload> = {
  eventId: string;
  streamId: string;
  streamType: StreamType;
  version: number;
  type: TType;
  occurredAtUtc: string;
  payload: TPayload;
  meta: Record<string, unknown>;
};

export const domainError = (
  code: string,
  reason: string,
  meta: Record<string, unknown> = {}
): DomainError => ({
  error: { code, reason, meta }
});

export type UserState = {
  userId: string;
  email: string;
  passwordHash: string;
  role: Role;
};

export type UserCommand =
  | {
      type: "BootstrapAdmin";
      userId: string;
      email: string;
      passwordHash: string;
    }
  | {
      type: "RegisterUser";
      userId: string;
      email: string;
      passwordHash: string;
    }
  | {
      type: "LoginUser";
      userId: string;
      email: string;
    };

export type UserEvent =
  | {
      type: "AdminBootstrapped";
      payload: { userId: string; email: string; passwordHash: string };
    }
  | {
      type: "UserRegistered";
      payload: { userId: string; email: string; passwordHash: string; role: Role };
    }
  | {
      type: "UserLoggedIn";
      payload: { userId: string; email: string };
    };

export type Reservation = {
  reservationId: string;
  userId: string;
  fromUtc: string;
  toUtc: string;
  status: "active" | "cancelled";
  createdAtUtc: string;
  cancelledAtUtc: string | null;
};

export type ResourceState = {
  resourceId: string;
  name: string;
  details: string;
  status: "active";
  reservations: Reservation[];
};

export type ResourceCommand =
  | {
      type: "CreateResource";
      resourceId: string;
      name: string;
      details: string;
      actorUserId: string;
      actorRole: Role;
    }
  | {
      type: "UpdateResourceMetadata";
      resourceId: string;
      details: string;
      actorUserId: string;
      actorRole: Role;
    }
  | {
      type: "CreateReservationInResource";
      resourceId: string;
      reservationId: string;
      fromUtc: string;
      toUtc: string;
      reservationUserId: string;
      actorUserId: string;
      actorRole: Role;
      nowUtc: string;
    }
  | {
      type: "CancelReservationInResource";
      resourceId: string;
      reservationId: string;
      actorUserId: string;
      actorRole: Role;
      nowUtc: string;
    };

export type ResourceEvent =
  | {
      type: "ResourceCreated";
      payload: { resourceId: string; name: string; details: string };
    }
  | {
      type: "ResourceMetadataUpdated";
      payload: { resourceId: string; details: string };
    }
  | {
      type: "ReservationAddedToResource";
      payload: {
        resourceId: string;
        reservationId: string;
        userId: string;
        fromUtc: string;
        toUtc: string;
        createdAtUtc: string;
      };
    }
  | {
      type: "ResourceReservationCancelled";
      payload: {
        resourceId: string;
        reservationId: string;
        cancelledAtUtc: string;
      };
    };
