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

type DdbSend = (command: unknown) => Promise<unknown>;

export const makeIdempotencyStore = ({
  ddbSend,
  tableName,
  hashContent
}: {
  ddbSend: DdbSend;
  tableName: string;
  hashContent: (content: unknown) => string;
}) => {
  const loadIdempotency = (idempotencyKey: string) =>
    ddbSend(
      new GetCommand({
        TableName: tableName,
        Key: { idempotencyKey }
      })
    ).then((result) => ((result as { Item?: unknown }).Item as IdempotencyRecord | undefined) ?? null);

  const saveIdempotency = (record: IdempotencyRecord) =>
    ddbSend(
      new PutCommand({
        TableName: tableName,
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

  const idempotencyDecision = (
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

  return { loadIdempotency, saveIdempotency, idempotencyDecision };
};

const defaultIdempotencyStore = makeIdempotencyStore({
  ddbSend: (command) => ddb.send(command as never) as Promise<unknown>,
  tableName: config.idempotencyTable,
  hashContent
});

export const loadIdempotency = defaultIdempotencyStore.loadIdempotency;
export const saveIdempotency = defaultIdempotencyStore.saveIdempotency;
export const idempotencyDecision = defaultIdempotencyStore.idempotencyDecision;
