import type {
  DomainError,
  ResourceCommand,
  ResourceEvent,
  ResourceState,
  UserEvent,
  UserState
} from "../domain/types.js";
import { decideResource, foldResource, foldUser } from "../domain/index.js";
import { foldFromEvents } from "../infra/stream-state.js";
import { getLatestSnapshot, loadStream, loadStreamWithGapRetry, putSnapshot } from "../infra/event-store.js";
import { appendAndPublish, makeEnvelope, withSingleVersionRetry } from "./command-runner.js";
import { domainErrorResponse, type HttpResponse } from "./pipeline.js";
import { config } from "../config.js";

export const buildUserState = (
  events: Awaited<ReturnType<typeof loadStream<UserEvent["type"], UserEvent["payload"]>>>
) =>
  foldFromEvents<UserState | null, UserEvent>(events, null, (state, event) => foldUser(state, event));

export const buildResourceState = (
  events: Awaited<ReturnType<typeof loadStream<ResourceEvent["type"], ResourceEvent["payload"]>>>
) =>
  foldFromEvents<ResourceState | null, ResourceEvent>(events, null, (state, event) =>
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
    (acc, envelope) =>
      fold(
        acc,
        {
          type: envelope.type,
          payload: envelope.payload
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
  appendAndPublish(
    makeEnvelope({
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
  appendAndPublish(
    makeEnvelope({
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

  return withSingleVersionRetry(runResourceAttempt, runResourceAttempt);
};
