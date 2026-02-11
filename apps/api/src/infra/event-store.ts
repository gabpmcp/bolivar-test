import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { s3 } from "./aws.js";
import { config } from "../config.js";
import type { EventEnvelope, StreamType } from "../domain/types.js";

const keyOf = (streamType: StreamType, streamId: string, version: number) =>
  `${streamType}/${streamId}/${String(version).padStart(12, "0")}.json`;

const parseVersion = (key: string) =>
  Number(key.split("/").at(-1)?.replace(".json", "") ?? "0");

const toText = async (body: unknown) =>
  typeof body === "object" && body !== null && "transformToString" in body
    ? (body as { transformToString: () => Promise<string> }).transformToString()
    : "";

export class VersionConflictError extends Error {
  readonly type = "VERSION_CONFLICT";
}

export const loadStream = async <TType extends string, TPayload>(
  streamType: StreamType,
  streamId: string
): Promise<EventEnvelope<TType, TPayload>[]> => {
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: config.s3BucketEvents,
      Prefix: `${streamType}/${streamId}/`
    })
  );
  const keys = (listed.Contents ?? [])
    .map(({ Key }) => Key)
    .filter((key): key is string => Boolean(key))
    .sort((a, b) => parseVersion(a) - parseVersion(b));

  return Promise.all(
    keys.map(async (key) => {
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: config.s3BucketEvents,
          Key: key
        })
      );
      return JSON.parse(await toText(object.Body)) as EventEnvelope<TType, TPayload>;
    })
  );
};

export const appendEvent = async <TType extends string, TPayload>(
  envelope: EventEnvelope<TType, TPayload>,
  expectedVersion: number
) =>
  expectedVersion + 1 === envelope.version
    ? s3
        .send(
          new PutObjectCommand({
            Bucket: config.s3BucketEvents,
            Key: keyOf(envelope.streamType, envelope.streamId, envelope.version),
            Body: JSON.stringify(envelope),
            ContentType: "application/json",
            IfNoneMatch: "*"
          })
        )
        .catch((error: { name?: string }) =>
          error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict"
            ? Promise.reject(new VersionConflictError("Version conflict while appending event"))
            : Promise.reject(error)
        )
    : Promise.reject(new VersionConflictError("Expected version does not match envelope version"));
