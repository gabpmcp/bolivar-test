import type { StreamType } from "./domain/types.js";

type Env = Record<string, string | undefined>;

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

export const makeConfig = (env: Env) => ({
  port: Number(env.PORT ?? 3000),
  jwtSecret: env.JWT_SECRET ?? "local-dev-secret",
  adminBootstrapKey: env.ADMIN_BOOTSTRAP_KEY ?? "bootstrap-local-key",
  awsRegion: env.AWS_REGION ?? "us-east-1",
  s3Endpoint: env.S3_ENDPOINT,
  s3BucketEvents: env.S3_BUCKET_EVENTS ?? "reservations-events",
  sqsQueueUrl: env.SQS_QUEUE_URL ?? "",
  dynamoEndpoint: env.DYNAMO_ENDPOINT,
  usersProjectionTable: env.USERS_PROJECTION_TABLE ?? "users_projection",
  resourcesProjectionTable: env.RESOURCES_PROJECTION_TABLE ?? "resources_projection",
  reservationsProjectionTable: env.RESERVATIONS_PROJECTION_TABLE ?? "reservations_projection",
  idempotencyTable: env.IDEMPOTENCY_TABLE ?? "idempotency_table",
  projectionLagTable: env.PROJECTION_LAG_TABLE ?? "projection_lag",
  pageLimitDefault: Number(env.PAGE_LIMIT_DEFAULT ?? 20),
  snapshotEveryDefault: Number(env.SNAPSHOT_EVERY_DEFAULT ?? 500),
  snapshotByStreamType: parseSnapshotByStreamType(env.SNAPSHOT_BY_STREAM_TYPE),
  versionConflictMaxRetries: Number(env.VERSION_CONFLICT_MAX_RETRIES ?? 1),
  emitConcurrencyConflictUnresolvedEvent: parseBool(env.EMIT_CONCURRENCY_CONFLICT_UNRESOLVED_EVENT)
});

export const config = makeConfig(process.env);
