import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../infra/aws.js";
import { config } from "../config.js";

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

export const getUserById = (userId: string) =>
  ddb
    .send(
      new GetCommand({
        TableName: config.usersProjectionTable,
        Key: { userId }
      })
    )
    .then((result) => (result.Item as UserProjection | undefined) ?? null);

export const getUserByEmail = (email: string) =>
  ddb
    .send(
      new ScanCommand({
        TableName: config.usersProjectionTable,
        FilterExpression: "email = :email",
        ExpressionAttributeValues: {
          ":email": email
        },
        Limit: 1
      })
    )
    .then((result) => ((result.Items ?? [])[0] as UserProjection | undefined) ?? null);

export const resourceNameTaken = (name: string) =>
  ddb
    .send(
      new ScanCommand({
        TableName: config.resourcesProjectionTable,
        FilterExpression: "#name = :name",
        ExpressionAttributeNames: {
          "#name": "name"
        },
        ExpressionAttributeValues: {
          ":name": name
        },
        Limit: 1
      })
    )
    .then((result) => (result.Items ?? []).length > 0);

export const getResourceById = (resourceId: string) =>
  ddb
    .send(
      new GetCommand({
        TableName: config.resourcesProjectionTable,
        Key: { resourceId }
      })
    )
    .then((result) => (result.Item as ResourceProjection | undefined) ?? null);

export const listResources = (limit: number, nextCursor?: string) =>
  ddb
    .send(
      new ScanCommand({
        TableName: config.resourcesProjectionTable,
        Limit: limit,
        ExclusiveStartKey: decodeCursor(nextCursor)
      })
    )
    .then((result) => ({
      items: (result.Items ?? []) as ResourceProjection[],
      nextCursor: encodeCursor(result.LastEvaluatedKey as Record<string, unknown> | undefined)
    }));

export const listReservations = ({
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
  ddb
    .send(
      new ScanCommand({
        TableName: config.reservationsProjectionTable,
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
    )
    .then((result) => ({
      items: (result.Items ?? []) as ReservationProjection[],
      nextCursor: encodeCursor(result.LastEvaluatedKey as Record<string, unknown> | undefined)
    }));

export const getProjectionLag = () =>
  ddb
    .send(
      new GetCommand({
        TableName: config.projectionLagTable,
        Key: { projection: "main" }
      })
    )
    .then((result) =>
      (result.Item as { projection: string; lastProjectedAtUtc: string; eventsBehind: number } | undefined) ?? {
        projection: "main",
        lastProjectedAtUtc: null,
        eventsBehind: 0
      }
    );

export const upsertProjectionLag = (lag: { lastProjectedAtUtc: string; eventsBehind: number }) =>
  ddb.send(
    new PutCommand({
      TableName: config.projectionLagTable,
      Item: {
        projection: "main",
        ...lag
      }
    })
  );
