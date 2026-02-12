import type {
  DomainError,
  ResourceCommand,
  ResourceEvent,
  ResourceState,
  RecordedEvent,
  UserEvent,
  UserState
} from "../domain/types.js";
import { domainError } from "../domain/types.js";
import { foldUser } from "../domain/user-decider.js";
import { decideResource, foldResource } from "../domain/resource-decider.js";
import { getLatestSnapshot, loadStream, loadStreamWithGapRetry, putSnapshot } from "../infra/event-store.js";
import { domainErrorResponse, type HttpResponse } from "./pipeline.js";
import { config } from "../config.js";
import { v7 as uuidv7 } from "uuid";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs } from "../infra/aws.js";
import { appendEvent, VersionConflictError } from "../infra/event-store.js";

const foldFromRecordedEvents = <TState, TEvent extends { type: string; payload: unknown }>(
  events: Awaited<ReturnType<typeof loadStream<TEvent["type"], TEvent["payload"]>>>,
  initial: TState,
  fold: (state: TState, event: TEvent) => TState
) =>
  events.reduce(
    (state, recordedEvent) =>
      fold(
        state,
        {
          type: recordedEvent.type,
          payload: recordedEvent.payload
        } as TEvent
      ),
    initial
  );

const enqueueRecordedEvent = (recordedEvent: unknown) =>
  config.sqsQueueUrl
    ? sqs.send(
        new SendMessageCommand({
          QueueUrl: config.sqsQueueUrl,
          MessageBody: JSON.stringify(recordedEvent)
        })
      )
    : Promise.resolve();

const recordEvent = <TType extends string, TPayload>({
  streamId,
  streamType,
  version,
  type,
  payload,
  meta
}: {
  streamId: string;
  streamType: "user" | "resource";
  version: number;
  type: TType;
  payload: TPayload;
  meta: Record<string, unknown>;
}): RecordedEvent<TType, TPayload> => ({
  eventId: uuidv7(),
  streamId,
  streamType,
  version,
  type,
  payload,
  occurredAtUtc: new Date().toISOString(),
  meta
});

const appendAndPublishRecordedEvent = <TType extends string, TPayload>(
  recordedEvent: RecordedEvent<TType, TPayload>,
  expectedVersion: number
) =>
  appendEvent(recordedEvent, expectedVersion)
    .then(() => enqueueRecordedEvent(recordedEvent).then(() => undefined))
    .then(() => recordedEvent);

const withVersionConflictRetries =
  (remainingRetries: number) =>
  <T>(action: () => Promise<T>): Promise<T> =>
    action().catch((error) =>
      error instanceof VersionConflictError && remainingRetries > 0
        ? withVersionConflictRetries(remainingRetries - 1)(action)
        : Promise.reject(error)
    );

const maybeEmitConcurrencyConflictUnresolved = ({
  resourceId,
  commandName,
  actorUserId,
  attempts
}: {
  resourceId: string;
  commandName: string;
  actorUserId: string;
  attempts: number;
}) =>
  config.emitConcurrencyConflictUnresolvedEvent
    ? loadStateFromSnapshotAndTail<ResourceState | null, ResourceEvent>({
        streamType: "resource",
        streamId: resourceId,
        initialState: null,
        fold: (state, event) => foldResource(state, event)
      })
        .then(({ lastEventVersion }) =>
          appendAndPublishRecordedEvent(
            recordEvent({
              streamId: resourceId,
              streamType: "resource",
              version: lastEventVersion + 1,
              type: "ConcurrencyConflictUnresolved",
              payload: {
                resourceId,
                commandName,
                actorUserId,
                attempts,
                lastKnownVersion: lastEventVersion
              },
              meta: { command: commandName, actorUserId }
            }),
            lastEventVersion
          )
        )
        .then(() => undefined)
        .catch(() => undefined)
    : Promise.resolve();

export const buildUserState = (
  events: Awaited<ReturnType<typeof loadStream<UserEvent["type"], UserEvent["payload"]>>>
) =>
  foldFromRecordedEvents<UserState | null, UserEvent>(events, null, (state, event) =>
    foldUser(state, event)
  );

export const buildResourceState = (
  events: Awaited<ReturnType<typeof loadStream<ResourceEvent["type"], ResourceEvent["payload"]>>>
) =>
  foldFromRecordedEvents<ResourceState | null, ResourceEvent>(events, null, (state, event) =>
    foldResource(state, event)
  );

const snapshotThresholdOf = (streamType: "user" | "resource") =>
  config.snapshotByStreamType[streamType] ?? config.snapshotEveryDefault;

const shouldSnapshot = (streamType: "user" | "resource", nextVersion: number) => {
  const threshold = snapshotThresholdOf(streamType);
  return threshold > 0 && nextVersion % threshold === 0;
};

const maybeWriteSnapshot = <TState>({
  streamType,
  streamId,
  lastEventVersion,
  state
}: {
  streamType: "user" | "resource";
  streamId: string;
  lastEventVersion: number;
  state: TState;
}) =>
  shouldSnapshot(streamType, lastEventVersion)
    ? putSnapshot({
        streamType,
        streamId,
        snapshotVersion: lastEventVersion,
        lastEventVersion,
        state,
        createdAtUtc: new Date().toISOString()
      }).then(() => undefined)
    : Promise.resolve();

export const loadStateFromSnapshotAndTail = async <TState, TEvent extends { type: string; payload: unknown }>({
  streamType,
  streamId,
  initialState,
  fold
}: {
  streamType: "user" | "resource";
  streamId: string;
  initialState: TState;
  fold: (state: TState, event: TEvent) => TState;
}): Promise<{ state: TState; lastEventVersion: number }> => {
  const snapshot = await getLatestSnapshot<TState>(streamType, streamId);
  const fromVersion = snapshot ? snapshot.lastEventVersion + 1 : 1;
  const tail = await loadStreamWithGapRetry<TEvent["type"], TEvent["payload"]>(
    streamType,
    streamId,
    fromVersion
  );
  const state = tail.reduce(
    (acc, recordedEvent) =>
      fold(
        acc,
        {
          type: recordedEvent.type,
          payload: recordedEvent.payload
        } as TEvent
      ),
    snapshot ? snapshot.state : initialState
  );
  const lastEventVersion =
    tail.length > 0
      ? tail[tail.length - 1]!.version
      : snapshot
        ? snapshot.lastEventVersion
        : 0;
  return { state, lastEventVersion };
};

export const toCommandResult = <TEvent extends { type: string; payload: Record<string, unknown> }>(
  decision: { kind: "accepted"; event: TEvent } | { kind: "rejected"; error: DomainError },
  accepted: (event: TEvent) => Promise<HttpResponse>
) => (decision.kind === "rejected" ? Promise.resolve(domainErrorResponse(decision.error)) : accepted(decision.event));

export const applyUserEvent = ({
  event,
  stateBefore,
  expectedVersion,
  commandName,
  success
}: {
  event: UserEvent;
  stateBefore: UserState | null;
  expectedVersion: number;
  commandName: string;
  success: (event: UserEvent) => HttpResponse;
}) =>
  appendAndPublishRecordedEvent(
    recordEvent({
      streamId: event.payload.userId,
      streamType: "user",
      version: expectedVersion + 1,
      type: event.type,
      payload: event.payload,
      meta: { command: commandName }
    }),
    expectedVersion
  )
    .then(() =>
      maybeWriteSnapshot({
        streamType: "user",
        streamId: event.payload.userId,
        lastEventVersion: expectedVersion + 1,
        state: foldUser(stateBefore, event)
      })
    )
    .then(() => success(event));

export const applyResourceEvent = ({
  stateBefore,
  resourceId,
  expectedVersion,
  event,
  commandName,
  actorUserId,
  success
}: {
  stateBefore: ResourceState | null;
  resourceId: string;
  expectedVersion: number;
  event: ResourceEvent;
  commandName: string;
  actorUserId: string;
  success: (event: ResourceEvent) => HttpResponse;
}) =>
  appendAndPublishRecordedEvent(
    recordEvent({
      streamId: resourceId,
      streamType: "resource",
      version: expectedVersion + 1,
      type: event.type,
      payload: event.payload,
      meta: { command: commandName, actorUserId }
    }),
    expectedVersion
  )
    .then(() =>
      maybeWriteSnapshot({
        streamType: "resource",
        streamId: resourceId,
        lastEventVersion: expectedVersion + 1,
        state: foldResource(stateBefore, event)
      })
    )
    .then(() => success(event));

export const applyResourceCommand = ({
  resourceId,
  commandOf,
  commandName,
  actorUserId,
  onAccepted
}: {
  resourceId: string;
  commandOf: (state: ResourceState | null) => ResourceCommand;
  commandName: string;
  actorUserId: string;
  onAccepted: (event: ResourceEvent) => HttpResponse;
}) => {
  const runResourceAttempt = () =>
    loadStateFromSnapshotAndTail<ResourceState | null, ResourceEvent>({
      streamType: "resource",
      streamId: resourceId,
      initialState: null,
      fold: (state, event) => foldResource(state, event)
    }).then(({ state, lastEventVersion }) => {
      return toCommandResult(decideResource(state, commandOf(state)), (event) =>
        applyResourceEvent({
          stateBefore: state,
          resourceId,
          expectedVersion: lastEventVersion,
          event,
          commandName,
          actorUserId,
          success: onAccepted
        })
      );
    });

  const retries =
    Number.isFinite(config.versionConflictMaxRetries) && config.versionConflictMaxRetries >= 0
      ? config.versionConflictMaxRetries
      : 1;
  const attempts = retries + 1;

  return withVersionConflictRetries(retries)(runResourceAttempt).catch((error) =>
    error instanceof VersionConflictError
      ? maybeEmitConcurrencyConflictUnresolved({
          resourceId,
          commandName,
          actorUserId,
          attempts
        }).then(() =>
          domainErrorResponse(
            domainError("VERSION_CONFLICT", "Version conflict while appending event", {
              resourceId,
              commandName,
              actorUserId,
              attempts
            })
          )
        )
      : Promise.reject(error)
  );
};
