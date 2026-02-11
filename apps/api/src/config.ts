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
  pageLimitDefault: Number(process.env.PAGE_LIMIT_DEFAULT ?? 20)
};
