import type { StreamType } from "./domain/types.js";

const parseSnapshotByStreamType = (
  value: string | undefined
): Partial<Record<StreamType, number>> =>
  value
    ? (JSON.parse(value) as Partial<Record<StreamType, number>>)
    : {
        resource: 500,
        user: 0
      };

const parseBool = (value: string | undefined) =>
  value === "1" || value === "true" || value === "TRUE" || value === "yes" || value === "YES";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: process.env.JWT_SECRET ?? "local-dev-secret",
  adminBootstrapKey: process.env.ADMIN_BOOTSTRAP_KEY ?? "bootstrap-local-key",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  s3Endpoint: process.env.S3_ENDPOINT,
  s3BucketEvents: process.env.S3_BUCKET_EVENTS ?? "reservations-events",
  sqsQueueUrl: process.env.SQS_QUEUE_URL ?? "",
  dynamoEndpoint: process.env.DYNAMO_ENDPOINT,
  usersProjectionTable: process.env.USERS_PROJECTION_TABLE ?? "users_projection",
  resourcesProjectionTable: process.env.RESOURCES_PROJECTION_TABLE ?? "resources_projection",
  reservationsProjectionTable:
    process.env.RESERVATIONS_PROJECTION_TABLE ?? "reservations_projection",
  idempotencyTable: process.env.IDEMPOTENCY_TABLE ?? "idempotency_table",
  projectionLagTable: process.env.PROJECTION_LAG_TABLE ?? "projection_lag",
  pageLimitDefault: Number(process.env.PAGE_LIMIT_DEFAULT ?? 20),
  snapshotEveryDefault: Number(process.env.SNAPSHOT_EVERY_DEFAULT ?? 500),
  snapshotByStreamType: parseSnapshotByStreamType(process.env.SNAPSHOT_BY_STREAM_TYPE),
  versionConflictMaxRetries: Number(process.env.VERSION_CONFLICT_MAX_RETRIES ?? 1),
  emitConcurrencyConflictUnresolvedEvent: parseBool(
    process.env.EMIT_CONCURRENCY_CONFLICT_UNRESOLVED_EVENT
  )
};
