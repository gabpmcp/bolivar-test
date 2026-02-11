import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { config } from "../config.js";

const endpointConfig = (endpoint: string | undefined) =>
  endpoint
    ? {
        endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test"
        }
      }
    : {};

export const s3 = new S3Client({
  region: config.awsRegion,
  ...endpointConfig(config.s3Endpoint)
});

export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: config.awsRegion,
    ...endpointConfig(config.dynamoEndpoint)
  })
);

export const sqs = new SQSClient({
  region: config.awsRegion,
  ...endpointConfig(process.env.SQS_ENDPOINT)
});
