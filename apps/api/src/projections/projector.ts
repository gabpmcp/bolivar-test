import { match } from "ts-pattern";
import type { RecordedEvent } from "../domain/types.js";

export type ProjectionOp =
  | {
      kind: "putUser";
      item: {
        userId: string;
        email: string;
        passwordHash: string;
        role: "admin" | "user";
        createdAtUtc: string;
      };
    }
  | { kind: "setUserLastLoginAtUtc"; userId: string; lastLoginAtUtc: string }
  | {
      kind: "putResource";
      item: {
        resourceId: string;
        name: string;
        details: string;
        status: "active";
        createdAtUtc: string;
        updatedAtUtc: string;
      };
    }
  | { kind: "updateResourceDetails"; resourceId: string; details: string; updatedAtUtc: string }
  | {
      kind: "putReservation";
      item: {
        reservationId: string;
        resourceId: string;
        userId: string;
        fromUtc: string;
        toUtc: string;
        status: "active";
        createdAtUtc: string;
        cancelledAtUtc: null;
      };
    }
  | { kind: "cancelReservation"; reservationId: string; cancelledAtUtc: string };

export const project = (recordedEvent: RecordedEvent<string, Record<string, unknown>>): ProjectionOp[] =>
  match(recordedEvent)
    .with({ type: "AdminBootstrapped" }, ({ payload, occurredAtUtc }) => [
      {
        kind: "putUser",
        item: {
          userId: payload.userId as string,
          email: payload.email as string,
          passwordHash: payload.passwordHash as string,
          role: "admin",
          createdAtUtc: occurredAtUtc
        }
      } satisfies ProjectionOp
    ])
    .with({ type: "UserRegistered" }, ({ payload, occurredAtUtc }) => [
      {
        kind: "putUser",
        item: {
          userId: payload.userId as string,
          email: payload.email as string,
          passwordHash: payload.passwordHash as string,
          role: payload.role as "admin" | "user",
          createdAtUtc: occurredAtUtc
        }
      } satisfies ProjectionOp
    ])
    .with({ type: "UserLoggedIn" }, ({ payload, occurredAtUtc }) => [
      {
        kind: "setUserLastLoginAtUtc",
        userId: payload.userId as string,
        lastLoginAtUtc: occurredAtUtc
      } satisfies ProjectionOp
    ])
    .with({ type: "ResourceCreated" }, ({ payload, occurredAtUtc }) => [
      {
        kind: "putResource",
        item: {
          resourceId: payload.resourceId as string,
          name: payload.name as string,
          details: payload.details as string,
          status: "active",
          createdAtUtc: occurredAtUtc,
          updatedAtUtc: occurredAtUtc
        }
      } satisfies ProjectionOp
    ])
    .with({ type: "ResourceMetadataUpdated" }, ({ payload, occurredAtUtc }) => [
      {
        kind: "updateResourceDetails",
        resourceId: payload.resourceId as string,
        details: payload.details as string,
        updatedAtUtc: occurredAtUtc
      } satisfies ProjectionOp
    ])
    .with({ type: "ReservationAddedToResource" }, ({ payload }) => [
      {
        kind: "putReservation",
        item: {
          reservationId: payload.reservationId as string,
          resourceId: payload.resourceId as string,
          userId: payload.userId as string,
          fromUtc: payload.fromUtc as string,
          toUtc: payload.toUtc as string,
          status: "active",
          createdAtUtc: payload.createdAtUtc as string,
          cancelledAtUtc: null
        }
      } satisfies ProjectionOp
    ])
    .with({ type: "ResourceReservationCancelled" }, ({ payload }) => [
      {
        kind: "cancelReservation",
        reservationId: payload.reservationId as string,
        cancelledAtUtc: payload.cancelledAtUtc as string
      } satisfies ProjectionOp
    ])
    .otherwise(() => []);
