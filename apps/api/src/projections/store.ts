import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../infra/aws.js";
import { config } from "../config.js";
import { match } from "ts-pattern";
import type { ProjectionOp } from "./projector.js";

const decodeCursor = (cursor: string | undefined) =>
  cursor ? (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>) : undefined;

const encodeCursor = (key: Record<string, unknown> | undefined) =>
  key ? Buffer.from(JSON.stringify(key)).toString("base64url") : null;

export type UserProjection = {
  userId: string;
  email: string;
  passwordHash: string;
  role: "admin" | "user";
};

export type ResourceProjection = {
  resourceId: string;
  name: string;
  details: string;
  status: "active";
};

export type ReservationProjection = {
  reservationId: string;
  resourceId: string;
  userId: string;
  fromUtc: string;
  toUtc: string;
  status: "active" | "cancelled";
  createdAtUtc: string;
  cancelledAtUtc: string | null;
};

type DdbSend = (command: unknown) => Promise<unknown>;

export const makeProjectionStore = ({
  ddbSend,
  tables
}: {
  ddbSend: DdbSend;
  tables: {
    users: string;
    resources: string;
    reservations: string;
    projectionLag: string;
  };
}) => {
  const getUserById = (userId: string) =>
    ddbSend(
      new GetCommand({
        TableName: tables.users,
        Key: { userId }
      })
    ).then((result) => ((result as { Item?: unknown }).Item as UserProjection | undefined) ?? null);

  const getUserByEmail = (email: string) =>
    ddbSend(
      new ScanCommand({
        TableName: tables.users,
        FilterExpression: "email = :email",
        ExpressionAttributeValues: {
          ":email": email
        },
        Limit: 1
      })
    ).then((result) => (((result as { Items?: unknown[] }).Items ?? [])[0] as UserProjection | undefined) ?? null);

  const resourceNameTaken = (name: string) =>
    ddbSend(
      new ScanCommand({
        TableName: tables.resources,
        FilterExpression: "#name = :name",
        ExpressionAttributeNames: {
          "#name": "name"
        },
        ExpressionAttributeValues: {
          ":name": name
        },
        Limit: 1
      })
    ).then((result) => (((result as { Items?: unknown[] }).Items ?? []) as unknown[]).length > 0);

  const getResourceById = (resourceId: string) =>
    ddbSend(
      new GetCommand({
        TableName: tables.resources,
        Key: { resourceId }
      })
    ).then((result) => ((result as { Item?: unknown }).Item as ResourceProjection | undefined) ?? null);

  const listResources = (limit: number, nextCursor?: string) =>
    ddbSend(
      new ScanCommand({
        TableName: tables.resources,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(nextCursor)
      })
    ).then((result) => ({
      items: (((result as { Items?: unknown[] }).Items ?? []) as ResourceProjection[]),
      nextCursor: encodeCursor((result as { LastEvaluatedKey?: unknown }).LastEvaluatedKey as Record<string, unknown> | undefined)
    }));

  const listReservations = ({
    scope,
    userId,
    status,
    limit,
    nextCursor
  }: {
    scope: "me" | "global";
    userId: string;
    status?: "active" | "cancelled";
    limit: number;
    nextCursor?: string;
  }) =>
    ddbSend(
      new ScanCommand({
        TableName: tables.reservations,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(nextCursor),
        FilterExpression:
          scope === "me"
            ? status
              ? "userId = :userId AND #status = :status"
              : "userId = :userId"
            : status
              ? "#status = :status"
              : undefined,
        ExpressionAttributeValues:
          scope === "me"
            ? status
              ? {
                  ":userId": userId,
                  ":status": status
                }
              : {
                  ":userId": userId
                }
            : status
              ? { ":status": status }
              : undefined,
        ExpressionAttributeNames: status ? { "#status": "status" } : undefined
      })
    ).then((result) => ({
      items: (((result as { Items?: unknown[] }).Items ?? []) as ReservationProjection[]),
      nextCursor: encodeCursor((result as { LastEvaluatedKey?: unknown }).LastEvaluatedKey as Record<string, unknown> | undefined)
    }));

  const getProjectionLag = () =>
    ddbSend(
      new GetCommand({
        TableName: tables.projectionLag,
        Key: { projection: "main" }
      })
    ).then((result) =>
      ((result as { Item?: unknown }).Item as { projection: string; lastProjectedAtUtc: string; eventsBehind: number } | undefined) ?? {
        projection: "main",
        lastProjectedAtUtc: null,
        eventsBehind: 0
      }
    );

  const upsertProjectionLag = (lag: { lastProjectedAtUtc: string; eventsBehind: number }) =>
    ddbSend(
      new PutCommand({
        TableName: tables.projectionLag,
        Item: {
          projection: "main",
          ...lag
        }
      })
    );

  const applyProjectionOps = (ops: ProjectionOp[]) =>
    ops.reduce(
      (promise, op) =>
        promise.then(() =>
          match(op)
            .with({ kind: "putUser" }, ({ item }) =>
              ddbSend(
                new PutCommand({
                  TableName: tables.users,
                  Item: item
                })
              ).then(() => undefined)
            )
            .with({ kind: "setUserLastLoginAtUtc" }, ({ userId, lastLoginAtUtc }) =>
              ddbSend(
                new UpdateCommand({
                  TableName: tables.users,
                  Key: { userId },
                  UpdateExpression: "SET lastLoginAtUtc = :at",
                  ExpressionAttributeValues: {
                    ":at": lastLoginAtUtc
                  }
                })
              ).then(() => undefined)
            )
            .with({ kind: "putResource" }, ({ item }) =>
              ddbSend(
                new PutCommand({
                  TableName: tables.resources,
                  Item: item
                })
              ).then(() => undefined)
            )
            .with({ kind: "updateResourceDetails" }, ({ resourceId, details, updatedAtUtc }) =>
              ddbSend(
                new UpdateCommand({
                  TableName: tables.resources,
                  Key: { resourceId },
                  UpdateExpression: "SET details = :details, updatedAtUtc = :updatedAt",
                  ExpressionAttributeValues: {
                    ":details": details,
                    ":updatedAt": updatedAtUtc
                  }
                })
              ).then(() => undefined)
            )
            .with({ kind: "putReservation" }, ({ item }) =>
              ddbSend(
                new PutCommand({
                  TableName: tables.reservations,
                  Item: item
                })
              ).then(() => undefined)
            )
            .with({ kind: "cancelReservation" }, ({ reservationId, cancelledAtUtc }) =>
              ddbSend(
                new UpdateCommand({
                  TableName: tables.reservations,
                  Key: { reservationId },
                  UpdateExpression: "SET #status = :cancelled, cancelledAtUtc = :cancelledAt",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":cancelled": "cancelled",
                    ":cancelledAt": cancelledAtUtc
                  }
                })
              ).then(() => undefined)
            )
            .exhaustive()
        ),
      Promise.resolve(undefined)
    );

  return {
    getUserById,
    getUserByEmail,
    resourceNameTaken,
    getResourceById,
    listResources,
    listReservations,
    getProjectionLag,
    upsertProjectionLag,
    applyProjectionOps
  };
};

const defaultProjectionStore = makeProjectionStore({
  ddbSend: (command) => ddb.send(command as never) as Promise<unknown>,
  tables: {
    users: config.usersProjectionTable,
    resources: config.resourcesProjectionTable,
    reservations: config.reservationsProjectionTable,
    projectionLag: config.projectionLagTable
  }
});

export const getUserById = defaultProjectionStore.getUserById;
export const getUserByEmail = defaultProjectionStore.getUserByEmail;
export const resourceNameTaken = defaultProjectionStore.resourceNameTaken;
export const getResourceById = defaultProjectionStore.getResourceById;
export const listResources = defaultProjectionStore.listResources;
export const listReservations = defaultProjectionStore.listReservations;
export const getProjectionLag = defaultProjectionStore.getProjectionLag;
export const upsertProjectionLag = defaultProjectionStore.upsertProjectionLag;
export const applyProjectionOps = defaultProjectionStore.applyProjectionOps;
