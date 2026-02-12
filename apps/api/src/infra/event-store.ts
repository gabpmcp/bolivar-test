import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { s3 } from "./aws.js";
import { config } from "../config.js";
import type { RecordedEvent, StreamType } from "../domain/types.js";

const keyOf = (streamType: StreamType, streamId: string, version: number) =>
  `${streamType}/${streamId}/${String(version).padStart(12, "0")}.json`;

export const snapshotKeyOf = (streamType: StreamType, streamId: string, snapshotVersion: number) =>
  `snapshots/${streamType}/${streamId}/${String(snapshotVersion).padStart(12, "0")}.json`;

const parseVersion = (key: string) =>
  Number(key.split("/").at(-1)?.replace(".json", "") ?? "0");

const toText = async (body: unknown) =>
  typeof body === "object" && body !== null && "transformToString" in body
    ? (body as { transformToString: () => Promise<string> }).transformToString()
    : "";

export class VersionConflictError extends Error {
  readonly type = "VERSION_CONFLICT";
}

export class StreamGapDetectedError extends Error {
  readonly type = "STREAM_GAP_DETECTED";
  readonly streamType: StreamType;
  readonly streamId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor({
    streamType,
    streamId,
    expectedVersion,
    actualVersion
  }: {
    streamType: StreamType;
    streamId: string;
    expectedVersion: number;
    actualVersion: number | null;
  }) {
    super("Detected non-sequential event versions in stream");
    this.streamType = streamType;
    this.streamId = streamId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export type SnapshotRecord<TState> = {
  streamType: StreamType;
  streamId: string;
  snapshotVersion: number;
  lastEventVersion: number;
  state: TState;
  createdAtUtc: string;
};

const listKeysByPrefix = async (prefix: string): Promise<string[]> => {
  const loop = async (
    continuationToken?: string,
    acc: string[] = []
  ): Promise<string[]> => {
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.s3BucketEvents,
        Prefix: prefix,
        ContinuationToken: continuationToken
      })
    );
    const keys = (listed.Contents ?? [])
      .map(({ Key }) => Key)
      .filter((key): key is string => Boolean(key));
    return listed.IsTruncated && listed.NextContinuationToken
      ? loop(listed.NextContinuationToken, [...acc, ...keys])
      : [...acc, ...keys];
  };
  return loop();
};

const loadJsonObject = async <T>(key: string): Promise<T> => {
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: config.s3BucketEvents,
      Key: key
    })
  );
  return JSON.parse(await toText(object.Body)) as T;
};

export const validateSequentialVersions = ({
  versions,
  expectedFromVersion
}: {
  versions: number[];
  expectedFromVersion: number;
}) =>
  versions.reduce(
    (state, currentVersion) =>
      state.ok && currentVersion === state.expected
        ? { ok: true as const, expected: state.expected + 1, actual: currentVersion }
        : {
            ok: false as const,
            expected: state.expected,
            actual: Number.isFinite(currentVersion) ? currentVersion : null
          },
    { ok: true as const, expected: expectedFromVersion, actual: null as number | null }
  );

export const loadStreamFromVersion = async <TType extends string, TPayload>(
  streamType: StreamType,
  streamId: string,
  fromVersionInclusive: number
): Promise<RecordedEvent<TType, TPayload>[]> => {
  const keys = (await listKeysByPrefix(`${streamType}/${streamId}/`))
    .map((key) => ({ key, version: parseVersion(key) }))
    .filter(({ version }) => Number.isFinite(version) && version >= fromVersionInclusive)
    .sort((a, b) => a.version - b.version)
    .map(({ key }) => key);

  return Promise.all(
    keys.map((key) => loadJsonObject<RecordedEvent<TType, TPayload>>(key))
  );
};

export const loadStreamWithGapRetry = async <TType extends string, TPayload>(
  streamType: StreamType,
  streamId: string,
  fromVersionInclusive: number
): Promise<RecordedEvent<TType, TPayload>[]> => {
  const loadAndValidate = async () => {
    const events = await loadStreamFromVersion<TType, TPayload>(
      streamType,
      streamId,
      fromVersionInclusive
    );
    const validation = validateSequentialVersions({
      versions: events.map((event) => event.version),
      expectedFromVersion: fromVersionInclusive
    });
    return validation.ok
      ? events
      : Promise.reject(
          new StreamGapDetectedError({
            streamType,
            streamId,
            expectedVersion: validation.expected,
            actualVersion: validation.actual
          })
        );
  };

  return loadAndValidate().catch((error) =>
    error instanceof StreamGapDetectedError ? loadAndValidate() : Promise.reject(error)
  );
};

export const loadStream = async <TType extends string, TPayload>(
  streamType: StreamType,
  streamId: string
): Promise<RecordedEvent<TType, TPayload>[]> =>
  loadStreamWithGapRetry<TType, TPayload>(streamType, streamId, 1);

export const putSnapshot = async <TState>(snapshot: SnapshotRecord<TState>) =>
  s3
    .send(
      new PutObjectCommand({
        Bucket: config.s3BucketEvents,
        Key: snapshotKeyOf(snapshot.streamType, snapshot.streamId, snapshot.snapshotVersion),
        Body: JSON.stringify(snapshot),
        ContentType: "application/json",
        Metadata: {
          snapshotversion: String(snapshot.snapshotVersion),
          lasteventversion: String(snapshot.lastEventVersion)
        },
        IfNoneMatch: "*"
      })
    )
    .then(() => snapshot)
    .catch((error: { name?: string }) =>
      error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict"
        ? Promise.resolve(snapshot)
        : Promise.reject(error)
    );

export const getLatestSnapshot = async <TState>(
  streamType: StreamType,
  streamId: string
): Promise<SnapshotRecord<TState> | null> => {
  const latest = (await listKeysByPrefix(`snapshots/${streamType}/${streamId}/`))
    .map((key) => ({ key, version: parseVersion(key) }))
    .filter(({ version }) => Number.isFinite(version))
    .sort((a, b) => b.version - a.version)[0];
  return latest ? loadJsonObject<SnapshotRecord<TState>>(latest.key) : null;
};

export const appendEvent = async <TType extends string, TPayload>(
  recordedEvent: RecordedEvent<TType, TPayload>,
  expectedVersion: number
) =>
  expectedVersion + 1 === recordedEvent.version
    ? s3
        .send(
          new PutObjectCommand({
            Bucket: config.s3BucketEvents,
            Key: keyOf(recordedEvent.streamType, recordedEvent.streamId, recordedEvent.version),
            Body: JSON.stringify(recordedEvent),
            ContentType: "application/json",
            IfNoneMatch: "*"
          })
        )
        .catch((error: { name?: string }) =>
          error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict"
            ? Promise.reject(new VersionConflictError("Version conflict while appending event"))
            : Promise.reject(error)
        )
    : Promise.reject(new VersionConflictError("Expected version does not match recorded event version"));
