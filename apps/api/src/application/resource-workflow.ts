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
import { loadStream } from "../infra/event-store.js";
import { appendAndPublish, makeEnvelope, withSingleVersionRetry } from "./command-runner.js";
import { domainErrorResponse, type HttpResponse } from "./pipeline.js";

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

export const toCommandResult = <TEvent extends { type: string; payload: Record<string, unknown> }>(
  decision: { kind: "accepted"; event: TEvent } | { kind: "rejected"; error: DomainError },
  accepted: (event: TEvent) => Promise<HttpResponse>
) => (decision.kind === "rejected" ? Promise.resolve(domainErrorResponse(decision.error)) : accepted(decision.event));

export const persistUserEvent = ({
  event,
  expectedVersion,
  commandName,
  success
}: {
  event: UserEvent;
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
  ).then(() => success(event));

export const persistResourceEvent = ({
  resourceId,
  expectedVersion,
  event,
  commandName,
  actorUserId,
  success
}: {
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
  ).then(() => success(event));

export const executeResourceMutation = ({
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
    loadStream<ResourceEvent["type"], ResourceEvent["payload"]>("resource", resourceId).then((events) => {
      const state = buildResourceState(events);
      return toCommandResult(decideResource(state, commandOf(state)), (event) =>
        persistResourceEvent({
          resourceId,
          expectedVersion: events.length,
          event,
          commandName,
          actorUserId,
          success: onAccepted
        })
      );
    });

  return withSingleVersionRetry(runResourceAttempt, runResourceAttempt);
};
