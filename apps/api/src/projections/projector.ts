import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { match } from "ts-pattern";
import { ddb } from "../infra/aws.js";
import { config } from "../config.js";
import { upsertProjectionLag } from "./store.js";
import type { EventEnvelope } from "../domain/types.js";

export const projectEvent = (
  envelope: EventEnvelope<string, Record<string, unknown>>
) =>
  match(envelope)
    .with({ type: "AdminBootstrapped" }, ({ payload, occurredAtUtc }) =>
      ddb.send(
        new PutCommand({
          TableName: config.usersProjectionTable,
          Item: {
            userId: payload.userId,
            email: payload.email,
            passwordHash: payload.passwordHash,
            role: "admin",
            createdAtUtc: occurredAtUtc
          }
        })
      )
    )
    .with({ type: "UserRegistered" }, ({ payload, occurredAtUtc }) =>
      ddb.send(
        new PutCommand({
          TableName: config.usersProjectionTable,
          Item: {
            userId: payload.userId,
            email: payload.email,
            passwordHash: payload.passwordHash,
            role: payload.role,
            createdAtUtc: occurredAtUtc
          }
        })
      )
    )
    .with({ type: "UserLoggedIn" }, ({ payload, occurredAtUtc }) =>
      ddb.send(
        new UpdateCommand({
          TableName: config.usersProjectionTable,
          Key: { userId: payload.userId },
          UpdateExpression: "SET lastLoginAtUtc = :at",
          ExpressionAttributeValues: {
            ":at": occurredAtUtc
          }
        })
      )
    )
    .with({ type: "ResourceCreated" }, ({ payload, occurredAtUtc }) =>
      ddb.send(
        new PutCommand({
          TableName: config.resourcesProjectionTable,
          Item: {
            resourceId: payload.resourceId,
            name: payload.name,
            details: payload.details,
            status: "active",
            createdAtUtc: occurredAtUtc,
            updatedAtUtc: occurredAtUtc
          }
        })
      )
    )
    .with({ type: "ResourceMetadataUpdated" }, ({ payload, occurredAtUtc }) =>
      ddb.send(
        new UpdateCommand({
          TableName: config.resourcesProjectionTable,
          Key: { resourceId: payload.resourceId },
          UpdateExpression: "SET details = :details, updatedAtUtc = :updatedAt",
          ExpressionAttributeValues: {
            ":details": payload.details,
            ":updatedAt": occurredAtUtc
          }
        })
      )
    )
    .with({ type: "ReservationAddedToResource" }, ({ payload }) =>
      ddb.send(
        new PutCommand({
          TableName: config.reservationsProjectionTable,
          Item: {
            reservationId: payload.reservationId,
            resourceId: payload.resourceId,
            userId: payload.userId,
            fromUtc: payload.fromUtc,
            toUtc: payload.toUtc,
            status: "active",
            createdAtUtc: payload.createdAtUtc,
            cancelledAtUtc: null
          }
        })
      )
    )
    .with({ type: "ResourceReservationCancelled" }, ({ payload }) =>
      ddb.send(
        new UpdateCommand({
          TableName: config.reservationsProjectionTable,
          Key: { reservationId: payload.reservationId },
          UpdateExpression: "SET #status = :cancelled, cancelledAtUtc = :cancelledAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":cancelled": "cancelled",
            ":cancelledAt": payload.cancelledAtUtc
          }
        })
      )
    )
    .otherwise(() => Promise.resolve());

export const projectAndTrackLag = (
  envelope: EventEnvelope<string, Record<string, unknown>>
) =>
  projectEvent(envelope).then(() =>
    upsertProjectionLag({
      lastProjectedAtUtc: envelope.occurredAtUtc,
      eventsBehind: 0
    })
  );
