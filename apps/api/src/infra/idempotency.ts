import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.js";
import { config } from "../config.js";

export type IdempotencyRecord = {
  idempotencyKey: string;
  contentHash: string;
  statusCode: number;
  responseBody: unknown;
  createdAtUtc: string;
};

const hashContent = (content: unknown) =>
  createHash("sha256").update(JSON.stringify(content)).digest("hex");

export const loadIdempotency = (idempotencyKey: string) =>
  ddb
    .send(
      new GetCommand({
        TableName: config.idempotencyTable,
        Key: { idempotencyKey }
      })
    )
    .then((result) => (result.Item as IdempotencyRecord | undefined) ?? null);

export const saveIdempotency = (record: IdempotencyRecord) =>
  ddb
    .send(
      new PutCommand({
        TableName: config.idempotencyTable,
        Item: record,
        ConditionExpression: "attribute_not_exists(idempotencyKey)"
      })
    )
    .then(() => record)
    .catch((error: { name?: string }) =>
      error.name === "ConditionalCheckFailedException"
        ? Promise.reject(new Error("IDEMPOTENCY_ALREADY_EXISTS"))
        : Promise.reject(error)
    );

export const idempotencyDecision = (
  existing: IdempotencyRecord | null,
  idempotencyKey: string,
  content: unknown
) => {
  const contentHash = hashContent(content);
  return existing === null
    ? { kind: "new" as const, contentHash }
    : existing.contentHash === contentHash
      ? { kind: "replay" as const, record: existing }
      : {
          kind: "mismatch" as const,
          error: {
            error: {
              code: "IDEMPOTENCY_HASH_MISMATCH",
              reason: "Idempotency-Key was used with a different payload",
              meta: { idempotencyKey }
            }
          }
        };
};
