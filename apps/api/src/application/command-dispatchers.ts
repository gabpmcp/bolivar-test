import { decideResource, decideUser, foldUser } from "../domain/index.js";
import { getUserByEmail, getUserById, resourceNameTaken } from "../projections/store.js";
import { match } from "ts-pattern";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { HttpResponse } from "./pipeline.js";
import { domainErrorResponse, nowUtc, response } from "./pipeline.js";
import { resolveOutcome } from "./outcome-resolver.js";
import {
  applyResourceEvent,
  applyResourceCommand,
  applyUserEvent,
  loadStateFromSnapshotAndTail
} from "./resource-workflow.js";
import {
  buildBootstrapAdminCommand,
  buildCancelReservationCommand,
  buildCreateReservationCommand,
  buildCreateResourceCommand,
  buildLoginUserCommand,
  buildRegisterUserCommand,
  buildUpdateResourceMetadataCommand
} from "./command-builders.js";
import type { ResourceCommand, ResourceEvent, UserCommand, UserEvent, UserState } from "../domain/types.js";

export type UserCommandInput =
  | { type: "BootstrapAdmin"; payload: { email: string; password: string } }
  | { type: "RegisterUser"; payload: { email: string; password: string } }
  | { type: "LoginUser"; payload: { email: string; password: string } };

export type ResourceCommandInput =
  | { type: "CreateResource"; payload: { name: string; details: string } }
  | { type: "UpdateResourceMetadata"; payload: { resourceId: string; details: string } }
  | {
      type: "CreateReservationInResource";
      payload: { resourceId: string; fromUtc: string; toUtc: string; reservationUserId?: string };
    }
  | {
      type: "CancelReservationInResource";
      payload: { resourceId: string; reservationId: string };
    };

type AuthContext = { sub: string; role: "admin" | "user" };
const isHttpResponse = (value: unknown): value is HttpResponse =>
  typeof value === "object" && value !== null && "statusCode" in value && "body" in value;
const invalidCredentialsResponse = () =>
  response(401, { error: { code: "INVALID_CREDENTIALS", reason: "Credentials are invalid", meta: {} } });
const reservationCreatedResponse = (event: ResourceEvent) =>
  match(event)
    .with({ type: "ReservationAddedToResource" }, ({ payload }) => response(201, { reservationId: payload.reservationId }))
    .otherwise(({ type }) =>
      response(500, {
        error: {
          code: "EVENT_TYPE_MISMATCH",
          reason: "Unexpected event type for reservation creation",
          meta: { eventType: type }
        }
      })
    );

type UserCommandHandlers = Record<
  UserCommandInput["type"],
  (
    command: UserCommandInput,
    context: { actorBootstrapKey: string; signToken: (claims: { sub: string; role: "admin" | "user"; email: string }) => string }
  ) => Promise<HttpResponse>
>;

type ResourceCommandHandlers = Record<
  ResourceCommandInput["type"],
  (command: ResourceCommandInput, auth: AuthContext) => Promise<HttpResponse>
>;

const userCommandHandlers: UserCommandHandlers = {
  BootstrapAdmin: (command, { actorBootstrapKey, signToken }) => {
    const { email, password } = (command as Extract<UserCommandInput, { type: "BootstrapAdmin" }>).payload;
    return getUserByEmail(email)
      .then((existing) =>
        buildBootstrapAdminCommand({
          email,
          password,
          actorBootstrapKey,
          expectedBootstrapKey: config.adminBootstrapKey,
          emailExists: existing !== null
        })
      )
      .then((built) =>
        resolveOutcome(
          built,
          "ok",
          ({ value }) => value as UserCommand | HttpResponse,
          ({ error }) => domainErrorResponse(error)
        )
      )
      .then((next: UserCommand | HttpResponse) =>
        isHttpResponse(next)
          ? next
          : resolveOutcome(
              decideUser(null, next),
              "accepted",
              ({ event }) => event as UserEvent | HttpResponse,
              ({ error }) => domainErrorResponse(error)
            )
      )
      .then((next: UserEvent | HttpResponse) =>
        isHttpResponse(next)
          ? next
          : applyUserEvent({
              event: next,
              stateBefore: null,
              expectedVersion: 0,
              commandName: "BootstrapAdmin",
              success: () =>
                response(201, {
                  token: signToken({
                    sub: next.payload.userId,
                    role: "admin",
                    email: next.payload.email
                  })
                })
            })
      );
  },
  RegisterUser: (command, { signToken }) => {
    const { email, password } = (command as Extract<UserCommandInput, { type: "RegisterUser" }>).payload;
    return getUserByEmail(email)
      .then((existing) => buildRegisterUserCommand({ email, password, emailExists: existing !== null }))
      .then((built) =>
        resolveOutcome(
          built,
          "ok",
          ({ value }) => value as UserCommand | HttpResponse,
          ({ error }) => domainErrorResponse(error)
        )
      )
      .then((next: UserCommand | HttpResponse) =>
        isHttpResponse(next)
          ? next
          : resolveOutcome(
              decideUser(null, next),
              "accepted",
              ({ event }) => event as UserEvent | HttpResponse,
              ({ error }) => domainErrorResponse(error)
            )
      )
      .then((next: UserEvent | HttpResponse) =>
        isHttpResponse(next)
          ? next
          : applyUserEvent({
              event: next,
              stateBefore: null,
              expectedVersion: 0,
              commandName: "RegisterUser",
              success: () =>
                response(201, {
                  token: signToken({
                    sub: next.payload.userId,
                    role: "user",
                    email: next.payload.email
                  })
                })
            })
      );
  },
  LoginUser: (command, { signToken }) => {
    const { email, password } = (command as Extract<UserCommandInput, { type: "LoginUser" }>).payload;
    return getUserByEmail(email)
      .then((projection) =>
        resolveOutcome(
          projection === null ? { kind: "missing" as const } : { kind: "found" as const, value: projection },
          "found",
          ({ value }) => value as { userId: string; role: "admin" | "user" } | HttpResponse,
          () => invalidCredentialsResponse()
        )
      )
      .then(
        (
          next: { userId: string; role: "admin" | "user" } | HttpResponse
        ): Promise<
          | HttpResponse
          | {
              projection: { userId: string; role: "admin" | "user" };
              state: UserState | null;
              lastEventVersion: number;
            }
        > =>
          isHttpResponse(next)
            ? Promise.resolve(next)
            : loadStateFromSnapshotAndTail<UserState | null, UserEvent>({
                streamType: "user",
                streamId: next.userId,
                initialState: null,
                fold: (state, event) => foldUser(state, event)
              }).then(({ state, lastEventVersion }) => ({
                projection: next,
                state,
                lastEventVersion
              }))
      )
      .then(
        (
          next:
            | HttpResponse
            | {
                projection: { userId: string; role: "admin" | "user" };
                state: UserState | null;
                lastEventVersion: number;
              }
        ) =>
          isHttpResponse(next)
            ? next
            : {
                projection: next.projection,
                state: next.state,
                lastEventVersion: next.lastEventVersion,
                next: resolveOutcome(
                  buildLoginUserCommand({
                    state: next.state,
                    userId: next.projection.userId,
                    email,
                    password
                  }),
                  "ok",
                  ({ value }) => value as UserCommand | HttpResponse,
                  ({ error }) => domainErrorResponse(error)
                )
              }
      )
      .then(
        (
          next:
            | HttpResponse
            | {
                projection: { userId: string; role: "admin" | "user" };
                state: UserState | null;
                lastEventVersion: number;
                next: UserCommand | HttpResponse;
              }
        ) =>
          isHttpResponse(next)
            ? next
            : {
                projection: next.projection,
                state: next.state,
                lastEventVersion: next.lastEventVersion,
                next: isHttpResponse(next.next)
                  ? next.next
                  : resolveOutcome(
                      decideUser(next.state, next.next),
                      "accepted",
                      ({ event }) => event as UserEvent | HttpResponse,
                      ({ error }) => domainErrorResponse(error)
                    )
              }
      )
      .then(
        (
          next:
            | HttpResponse
            | {
                projection: { userId: string; role: "admin" | "user" };
                state: UserState | null;
                lastEventVersion: number;
                next: UserEvent | HttpResponse;
              }
        ) => {
          if (isHttpResponse(next)) return next;
          if (isHttpResponse(next.next)) return next.next;
          const acceptedEvent = next.next;
          return applyUserEvent({
            event: acceptedEvent,
            stateBefore: next.state,
            expectedVersion: next.lastEventVersion,
            commandName: "LoginUser",
            success: () =>
              response(200, {
                token: signToken({
                  sub: acceptedEvent.payload.userId,
                  role: next.projection.role,
                  email: acceptedEvent.payload.email
                })
              })
          });
        }
      );
  }
};

const resourceCommandHandlers: ResourceCommandHandlers = {
  CreateResource: (command, auth) => {
    const { name, details } = (command as Extract<ResourceCommandInput, { type: "CreateResource" }>).payload;
    return resourceNameTaken(name)
      .then((nameTaken) =>
        buildCreateResourceCommand({
          nameTaken,
          resourceId: randomUUID(),
          name,
          details,
          actorUserId: auth.sub,
          actorRole: auth.role
        })
      )
      .then((built) =>
        resolveOutcome(
          built,
          "ok",
          ({ value }) => value as ResourceCommand | HttpResponse,
          ({ error }) => domainErrorResponse(error)
        )
      )
      .then((next: ResourceCommand | HttpResponse) =>
        isHttpResponse(next)
          ? next
          : resolveOutcome(
              decideResource(null, next),
              "accepted",
              ({ event }) => event as ResourceEvent | HttpResponse,
              ({ error }) => domainErrorResponse(error)
            )
      )
      .then((next: ResourceEvent | HttpResponse) =>
        isHttpResponse(next)
          ? next
          : applyResourceEvent({
              stateBefore: null,
              resourceId: next.payload.resourceId,
              expectedVersion: 0,
              event: next,
              commandName: "CreateResource",
              actorUserId: auth.sub,
              success: () => response(201, { resourceId: next.payload.resourceId })
            })
      );
  },
  UpdateResourceMetadata: (command, auth) => {
    const { resourceId, details } = (command as Extract<ResourceCommandInput, { type: "UpdateResourceMetadata" }>).payload;
    return applyResourceCommand({
      resourceId,
      commandOf: () => buildUpdateResourceMetadataCommand({ resourceId, details, actorUserId: auth.sub, actorRole: auth.role }),
      commandName: "UpdateResourceMetadata",
      actorUserId: auth.sub,
      onAccepted: () => response(200, { ok: true })
    });
  },
  CreateReservationInResource: (command, auth) => {
    const { resourceId, fromUtc, toUtc, reservationUserId: explicitReservationUserId } = (
      command as Extract<ResourceCommandInput, { type: "CreateReservationInResource" }>
    ).payload;
    const reservationUserId = auth.role === "admin" ? explicitReservationUserId ?? auth.sub : auth.sub;
    return getUserById(reservationUserId)
      .then((user) =>
        buildCreateReservationCommand({
          resourceId,
          fromUtc,
          toUtc,
          reservationUserId,
          reservationUserExists: user !== null,
          actorUserId: auth.sub,
          actorRole: auth.role,
          nowUtc: nowUtc()
        })
      )
      .then((built) =>
        resolveOutcome(
          built,
          "ok",
          ({ value }) => value as ResourceCommand | HttpResponse,
          ({ error }) => domainErrorResponse(error)
        )
      )
      .then((next: ResourceCommand | HttpResponse) =>
        isHttpResponse(next)
          ? next
          : applyResourceCommand({
              resourceId,
              commandOf: () => next,
              commandName: "CreateReservationInResource",
              actorUserId: auth.sub,
              onAccepted: (event) => reservationCreatedResponse(event)
            })
      );
  },
  CancelReservationInResource: (command, auth) => {
    const { resourceId, reservationId } = (
      command as Extract<ResourceCommandInput, { type: "CancelReservationInResource" }>
    ).payload;
    return applyResourceCommand({
      resourceId,
      commandOf: () =>
        buildCancelReservationCommand({
          resourceId,
          reservationId,
          actorUserId: auth.sub,
          actorRole: auth.role,
          nowUtc: nowUtc()
        }),
      commandName: "CancelReservationInResource",
      actorUserId: auth.sub,
      onAccepted: () => response(200, { ok: true })
    });
  }
};

export const executeUserCommand = (
  command: UserCommandInput,
  context: { actorBootstrapKey: string; signToken: (claims: { sub: string; role: "admin" | "user"; email: string }) => string }
) =>
  match(command)
    .with({ type: "BootstrapAdmin" }, (value) => userCommandHandlers.BootstrapAdmin(value, context))
    .with({ type: "RegisterUser" }, (value) => userCommandHandlers.RegisterUser(value, context))
    .with({ type: "LoginUser" }, (value) => userCommandHandlers.LoginUser(value, context))
    .exhaustive();

export const executeResourceCommand = (command: ResourceCommandInput, auth: AuthContext) =>
  match(command)
    .with({ type: "CreateResource" }, (value) => resourceCommandHandlers.CreateResource(value, auth))
    .with({ type: "UpdateResourceMetadata" }, (value) => resourceCommandHandlers.UpdateResourceMetadata(value, auth))
    .with({ type: "CreateReservationInResource" }, (value) =>
      resourceCommandHandlers.CreateReservationInResource(value, auth)
    )
    .with({ type: "CancelReservationInResource" }, (value) =>
      resourceCommandHandlers.CancelReservationInResource(value, auth)
    )
    .exhaustive();
