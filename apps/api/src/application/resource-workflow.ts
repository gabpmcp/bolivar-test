import type {
  DomainError,
  ResourceCommand,
  ResourceEvent,
  ResourceState,
  RecordedEvent,
  StreamType,
  UserEvent,
  UserState
} from "../domain/types.js";
import { domainError } from "../domain/types.js";
import { foldUser } from "../domain/user-decider.js";
import { decideResource, foldResource } from "../domain/resource-decider.js";
import {
  VersionConflictError,
  appendEvent,
  getLatestSnapshot,
  loadStream,
  loadStreamWithGapRetry,
  putSnapshot
} from "../infra/event-store.js";
import { domainErrorResponse, type HttpResponse } from "./pipeline.js";
import { config } from "../config.js";
import { v7 as uuidv7 } from "uuid";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs } from "../infra/aws.js";

type ResourceWorkflowDeps = {
  eventStore: {
    getLatestSnapshot: typeof getLatestSnapshot;
    loadStream: typeof loadStream;
    loadStreamWithGapRetry: typeof loadStreamWithGapRetry;
    putSnapshot: typeof putSnapshot;
    appendEvent: typeof appendEvent;
    VersionConflictError: typeof VersionConflictError;
  };
  uuid: () => string;
  nowUtc: () => string;
  enqueueRecordedEvent: (recordedEvent: unknown) => Promise<unknown>;
  snapshotEveryDefault: number;
  snapshotByStreamType: Partial<Record<StreamType, number>>;
  versionConflictMaxRetries: number;
  emitConcurrencyConflictUnresolvedEvent: boolean;
};

export const makeResourceWorkflow = (deps: ResourceWorkflowDeps) => {
  const foldFromRecordedEvents = <TState, TEvent extends { type: string; payload: unknown }>(
    events: RecordedEvent<TEvent["type"], TEvent["payload"]>[],
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

  const recordEvent = <TType extends string, TPayload>({
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
  }): RecordedEvent<TType, TPayload> => ({
    eventId: deps.uuid(),
    streamId,
    streamType,
    version,
    type,
    payload,
    occurredAtUtc: deps.nowUtc(),
    meta
  });

  const appendAndPublishRecordedEvent = <TType extends string, TPayload>(
    recordedEvent: RecordedEvent<TType, TPayload>,
    expectedVersion: number
  ) =>
    deps.eventStore
      .appendEvent(recordedEvent, expectedVersion)
      .then(() => deps.enqueueRecordedEvent(recordedEvent).then(() => undefined))
      .then(() => recordedEvent);

  const snapshotThresholdOf = (streamType: StreamType) =>
    deps.snapshotByStreamType[streamType] ?? deps.snapshotEveryDefault;

  const shouldSnapshot = (streamType: StreamType, nextVersion: number) => {
    const threshold = snapshotThresholdOf(streamType);
    return threshold > 0 && nextVersion % threshold === 0;
  };

  const maybeWriteSnapshot = <TState>({
    streamType,
    streamId,
    lastEventVersion,
    state
  }: {
    streamType: StreamType;
    streamId: string;
    lastEventVersion: number;
    state: TState;
  }) =>
    shouldSnapshot(streamType, lastEventVersion)
      ? deps.eventStore
          .putSnapshot({
            streamType,
            streamId,
            snapshotVersion: lastEventVersion,
            lastEventVersion,
            state,
            createdAtUtc: deps.nowUtc()
          })
          .then(() => undefined)
      : Promise.resolve();

  const loadStateFromSnapshotAndTail = async <TState, TEvent extends { type: string; payload: unknown }>({
    streamType,
    streamId,
    initialState,
    fold
  }: {
    streamType: StreamType;
    streamId: string;
    initialState: TState;
    fold: (state: TState, event: TEvent) => TState;
  }): Promise<{ state: TState; lastEventVersion: number }> => {
    const snapshot = await deps.eventStore.getLatestSnapshot<TState>(streamType, streamId);
    const fromVersion = snapshot ? snapshot.lastEventVersion + 1 : 1;
    const tail = await deps.eventStore.loadStreamWithGapRetry<TEvent["type"], TEvent["payload"]>(
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

  const buildUserState = (events: RecordedEvent<UserEvent["type"], UserEvent["payload"]>[]) =>
    foldFromRecordedEvents<UserState | null, UserEvent>(events, null, (state, event) =>
      foldUser(state, event)
    );

  const buildResourceState = (
    events: RecordedEvent<ResourceEvent["type"], ResourceEvent["payload"]>[]
  ) =>
    foldFromRecordedEvents<ResourceState | null, ResourceEvent>(events, null, (state, event) =>
      foldResource(state, event)
    );

  const toCommandResult = <TEvent extends { type: string; payload: Record<string, unknown> }>(
    decision: { kind: "accepted"; event: TEvent } | { kind: "rejected"; error: DomainError },
    accepted: (event: TEvent) => Promise<HttpResponse>
  ): Promise<HttpResponse> =>
    decision.kind === "rejected"
      ? Promise.resolve(domainErrorResponse(decision.error))
      : accepted(decision.event);

  const applyUserEvent = ({
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

  const applyResourceEvent = ({
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

  const withVersionConflictRetries =
    (remainingRetries: number) =>
    <T>(action: () => Promise<T>): Promise<T> =>
      action().catch((error) =>
        error instanceof deps.eventStore.VersionConflictError && remainingRetries > 0
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
    deps.emitConcurrencyConflictUnresolvedEvent
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

  const applyResourceCommand = ({
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
      }).then(({ state, lastEventVersion }) =>
        toCommandResult(decideResource(state, commandOf(state)), (event) =>
          applyResourceEvent({
            stateBefore: state,
            resourceId,
            expectedVersion: lastEventVersion,
            event,
            commandName,
            actorUserId,
            success: onAccepted
          })
        )
      );

    const retries =
      Number.isFinite(deps.versionConflictMaxRetries) && deps.versionConflictMaxRetries >= 0
        ? deps.versionConflictMaxRetries
        : 1;
    const attempts = retries + 1;

    return withVersionConflictRetries(retries)(runResourceAttempt).catch((error) =>
      error instanceof deps.eventStore.VersionConflictError
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

  return {
    buildUserState,
    buildResourceState,
    loadStateFromSnapshotAndTail,
    toCommandResult,
    applyUserEvent,
    applyResourceEvent,
    applyResourceCommand
  };
};

const enqueueRecordedEventDefault = (recordedEvent: unknown) =>
  config.sqsQueueUrl
    ? sqs.send(
        new SendMessageCommand({
          QueueUrl: config.sqsQueueUrl,
          MessageBody: JSON.stringify(recordedEvent)
        })
      )
    : Promise.resolve();

const defaultWorkflow = makeResourceWorkflow({
  eventStore: {
    getLatestSnapshot,
    loadStream,
    loadStreamWithGapRetry,
    putSnapshot,
    appendEvent,
    VersionConflictError
  },
  uuid: uuidv7,
  nowUtc: () => new Date().toISOString(),
  enqueueRecordedEvent: enqueueRecordedEventDefault,
  snapshotEveryDefault: config.snapshotEveryDefault,
  snapshotByStreamType: config.snapshotByStreamType,
  versionConflictMaxRetries: config.versionConflictMaxRetries,
  emitConcurrencyConflictUnresolvedEvent: config.emitConcurrencyConflictUnresolvedEvent
});

export const buildUserState = defaultWorkflow.buildUserState;
export const buildResourceState = defaultWorkflow.buildResourceState;
export const loadStateFromSnapshotAndTail = defaultWorkflow.loadStateFromSnapshotAndTail;
export const toCommandResult = defaultWorkflow.toCommandResult;
export const applyUserEvent = defaultWorkflow.applyUserEvent;
export const applyResourceEvent = defaultWorkflow.applyResourceEvent;
export const applyResourceCommand = defaultWorkflow.applyResourceCommand;

