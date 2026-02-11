import { v7 as uuidv7 } from "uuid";
import type { EventEnvelope, StreamType } from "../domain/types.js";
import { appendEvent, VersionConflictError } from "../infra/event-store.js";
import { enqueueEvent } from "../infra/queue.js";

export const makeEnvelope = <TType extends string, TPayload>({
  streamId,
  streamType,
  version,
  type,
  payload,
  meta
}: {
  streamId: string;
  streamType: StreamType;
  version: number;
  type: TType;
  payload: TPayload;
  meta: Record<string, unknown>;
}): EventEnvelope<TType, TPayload> => ({
  eventId: uuidv7(),
  streamId,
  streamType,
  version,
  type,
  payload,
  occurredAtUtc: new Date().toISOString(),
  meta
});

export const appendAndPublish = <TType extends string, TPayload>(
  envelope: EventEnvelope<TType, TPayload>,
  expectedVersion: number
) =>
  appendEvent(envelope, expectedVersion)
    .then(() => enqueueEvent(envelope).then(() => undefined))
    .then(() => envelope);

export const withSingleVersionRetry = <T>(
  action: () => Promise<T>,
  retry: () => Promise<T>
) =>
  action().catch((error) =>
    error instanceof VersionConflictError ? retry() : Promise.reject(error)
  );
