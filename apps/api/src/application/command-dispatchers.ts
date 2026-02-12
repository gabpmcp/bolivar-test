import { decideUser, foldUser } from "../domain/user-decider.js";
import { decideResource } from "../domain/resource-decider.js";
import { getUserByEmail, getUserById, resourceNameTaken } from "../projections/store.js";
import { match } from "ts-pattern";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { HttpResponse } from "./pipeline.js";
import { domainErrorResponse, nowUtc, response } from "./pipeline.js";
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

const resolveOutcome = <T extends { kind: string }, K extends T["kind"], R>(
  value: T,
  successKind: K,
  onSuccess: (matched: Extract<T, { kind: K }>) => R,
  onFailure: (other: Exclude<T, { kind: K }>) => R
): R =>
  value.kind === successKind
    ? onSuccess(value as Extract<T, { kind: K }>)
    : onFailure(value as Exclude<T, { kind: K }>);

const invalidCredentialsResponse = () =>
  response(401, { error: { code: "INVALID_CREDENTIALS", reason: "Credentials are invalid", meta: {} } });

const reservationCreatedResponse = (event: ResourceEvent) =>
  match(event)
    .with({ type: "ReservationAddedToResource" }, ({ payload }) =>
      response(201, { reservationId: payload.reservationId })
    )
    .otherwise(({ type }) =>
      response(500, {
        error: {
          code: "EVENT_TYPE_MISMATCH",
          reason: "Unexpected event type for reservation creation",
          meta: { eventType: type }
        }
      })
    );

export type CommandDispatchersDeps = {
  adminBootstrapKey: string;
  randomUUID: () => string;
  nowUtc: () => string;

  getUserByEmail: (email: string) => Promise<{ userId: string; role: "admin" | "user" } | null>;
  getUserById: (userId: string) => Promise<{ userId: string } | null>;
  resourceNameTaken: (name: string) => Promise<boolean>;

  applyUserEvent: typeof applyUserEvent;
  applyResourceEvent: typeof applyResourceEvent;
  applyResourceCommand: typeof applyResourceCommand;
  loadStateFromSnapshotAndTail: typeof loadStateFromSnapshotAndTail;

  decideUser: typeof decideUser;
  decideResource: typeof decideResource;
  foldUser: typeof foldUser;
};

export const makeCommandDispatchers = (deps: CommandDispatchersDeps) => {
  const userCommandHandlers = {
    BootstrapAdmin: (
      command: Extract<UserCommandInput, { type: "BootstrapAdmin" }>,
      context: {
        actorBootstrapKey: string;
        signToken: (claims: { sub: string; role: "admin" | "user"; email: string }) => string;
      }
    ) => {
      const { email, password } = command.payload;
      return deps
        .getUserByEmail(email)
        .then((existing) =>
          buildBootstrapAdminCommand({
            email,
            password,
            actorBootstrapKey: context.actorBootstrapKey,
            expectedBootstrapKey: deps.adminBootstrapKey,
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
                deps.decideUser(null, next),
                "accepted",
                ({ event }) => event as UserEvent | HttpResponse,
                ({ error }) => domainErrorResponse(error)
              )
        )
        .then((next: UserEvent | HttpResponse) =>
          isHttpResponse(next)
            ? next
            : deps.applyUserEvent({
                event: next,
                stateBefore: null,
                expectedVersion: 0,
                commandName: "BootstrapAdmin",
                success: () =>
                  response(201, {
                    token: context.signToken({
                      sub: next.payload.userId,
                      role: "admin",
                      email: next.payload.email
                    })
                  })
              })
        );
    },
    RegisterUser: (
      command: Extract<UserCommandInput, { type: "RegisterUser" }>,
      context: { signToken: (claims: { sub: string; role: "admin" | "user"; email: string }) => string }
    ) => {
      const { email, password } = command.payload;
      return deps
        .getUserByEmail(email)
        .then((existing) =>
          buildRegisterUserCommand({ email, password, emailExists: existing !== null })
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
                deps.decideUser(null, next),
                "accepted",
                ({ event }) => event as UserEvent | HttpResponse,
                ({ error }) => domainErrorResponse(error)
              )
        )
        .then((next: UserEvent | HttpResponse) =>
          isHttpResponse(next)
            ? next
            : deps.applyUserEvent({
                event: next,
                stateBefore: null,
                expectedVersion: 0,
                commandName: "RegisterUser",
                success: () =>
                  response(201, {
                    token: context.signToken({
                      sub: next.payload.userId,
                      role: "user",
                      email: next.payload.email
                    })
                  })
              })
        );
    },
    LoginUser: (
      command: Extract<UserCommandInput, { type: "LoginUser" }>,
      context: { signToken: (claims: { sub: string; role: "admin" | "user"; email: string }) => string }
    ) => {
      const { email, password } = command.payload;
      type Projection = { userId: string; role: "admin" | "user" };
      type LoginContext = {
        projection: Projection;
        state: UserState | null;
        lastEventVersion: number;
      };
      return deps
        .getUserByEmail(email)
        .then((projection) =>
          resolveOutcome(
            projection === null
              ? { kind: "missing" as const }
              : { kind: "found" as const, value: projection as Projection },
            "found",
            ({ value }) =>
              deps
                .loadStateFromSnapshotAndTail<UserState | null, UserEvent>({
                  streamType: "user",
                  streamId: value.userId,
                  initialState: null,
                  fold: (state, event) => deps.foldUser(state, event)
                })
                .then(({ state, lastEventVersion }) => ({
                  projection: value,
                  state,
                  lastEventVersion
                })),
            () => Promise.resolve(invalidCredentialsResponse())
          )
        )
        .then((next: HttpResponse | LoginContext) =>
          isHttpResponse(next)
            ? next
            : ({
                ...next,
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
              } as const)
        )
        .then((next) =>
          isHttpResponse(next)
            ? next
            : ({
                ...next,
                next: isHttpResponse(next.next)
                  ? next.next
                  : resolveOutcome(
                      deps.decideUser(next.state, next.next),
                      "accepted",
                      ({ event }) => event as UserEvent | HttpResponse,
                      ({ error }) => domainErrorResponse(error)
                    )
              } as const)
        )
        .then((next) => {
          if (isHttpResponse(next)) return next;
          if (isHttpResponse(next.next)) return next.next;
          const acceptedEvent = next.next;
          return deps.applyUserEvent({
            event: acceptedEvent,
            stateBefore: next.state,
            expectedVersion: next.lastEventVersion,
            commandName: "LoginUser",
            success: () =>
              response(200, {
                token: context.signToken({
                  sub: acceptedEvent.payload.userId,
                  role: next.projection.role,
                  email: acceptedEvent.payload.email
                })
              })
          });
        });
    }
  } as const;

  const resourceCommandHandlers = {
    CreateResource: (command: Extract<ResourceCommandInput, { type: "CreateResource" }>, auth: AuthContext) => {
      const { name, details } = command.payload;
      return deps
        .resourceNameTaken(name)
        .then((nameTaken) =>
          buildCreateResourceCommand({
            nameTaken,
            resourceId: deps.randomUUID(),
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
                deps.decideResource(null, next),
                "accepted",
                ({ event }) => event as ResourceEvent | HttpResponse,
                ({ error }) => domainErrorResponse(error)
              )
        )
        .then((next: ResourceEvent | HttpResponse) =>
          isHttpResponse(next)
            ? next
            : deps.applyResourceEvent({
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
    UpdateResourceMetadata: (
      command: Extract<ResourceCommandInput, { type: "UpdateResourceMetadata" }>,
      auth: AuthContext
    ) => {
      const { resourceId, details } = command.payload;
      return deps.applyResourceCommand({
        resourceId,
        commandOf: () =>
          buildUpdateResourceMetadataCommand({
            resourceId,
            details,
            actorUserId: auth.sub,
            actorRole: auth.role
          }),
        commandName: "UpdateResourceMetadata",
        actorUserId: auth.sub,
        onAccepted: () => response(200, { ok: true })
      });
    },
    CreateReservationInResource: (
      command: Extract<ResourceCommandInput, { type: "CreateReservationInResource" }>,
      auth: AuthContext
    ) => {
      const { resourceId, fromUtc, toUtc, reservationUserId: explicitReservationUserId } = command.payload;
      const reservationUserId = auth.role === "admin" ? explicitReservationUserId ?? auth.sub : auth.sub;
      return deps
        .getUserById(reservationUserId)
        .then((user) =>
          buildCreateReservationCommand({
            resourceId,
            fromUtc,
            toUtc,
            reservationUserId,
            reservationUserExists: user !== null,
            actorUserId: auth.sub,
            actorRole: auth.role,
            nowUtc: deps.nowUtc()
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
            : deps.applyResourceCommand({
                resourceId,
                commandOf: () => next,
                commandName: "CreateReservationInResource",
                actorUserId: auth.sub,
                onAccepted: (event) => reservationCreatedResponse(event)
              })
        );
    },
    CancelReservationInResource: (
      command: Extract<ResourceCommandInput, { type: "CancelReservationInResource" }>,
      auth: AuthContext
    ) => {
      const { resourceId, reservationId } = command.payload;
      return deps.applyResourceCommand({
        resourceId,
        commandOf: () =>
          buildCancelReservationCommand({
            resourceId,
            reservationId,
            actorUserId: auth.sub,
            actorRole: auth.role,
            nowUtc: deps.nowUtc()
          }),
        commandName: "CancelReservationInResource",
        actorUserId: auth.sub,
        onAccepted: () => response(200, { ok: true })
      });
    }
  } as const;

  const executeUserCommand = (
    command: UserCommandInput,
    context: {
      actorBootstrapKey: string;
      signToken: (claims: { sub: string; role: "admin" | "user"; email: string }) => string;
    }
  ) =>
    match(command)
      .with({ type: "BootstrapAdmin" }, (value) => userCommandHandlers.BootstrapAdmin(value, context))
      .with({ type: "RegisterUser" }, (value) => userCommandHandlers.RegisterUser(value, context))
      .with({ type: "LoginUser" }, (value) => userCommandHandlers.LoginUser(value, context))
      .exhaustive();

  const executeResourceCommand = (command: ResourceCommandInput, auth: AuthContext) =>
    match(command)
      .with({ type: "CreateResource" }, (value) => resourceCommandHandlers.CreateResource(value, auth))
      .with({ type: "UpdateResourceMetadata" }, (value) => resourceCommandHandlers.UpdateResourceMetadata(value, auth))
      .with({ type: "CreateReservationInResource" }, (value) => resourceCommandHandlers.CreateReservationInResource(value, auth))
      .with({ type: "CancelReservationInResource" }, (value) => resourceCommandHandlers.CancelReservationInResource(value, auth))
      .exhaustive();

  return { executeUserCommand, executeResourceCommand };
};

const defaultDispatchers = makeCommandDispatchers({
  adminBootstrapKey: config.adminBootstrapKey,
  randomUUID,
  nowUtc,
  getUserByEmail,
  getUserById,
  resourceNameTaken,
  applyUserEvent,
  applyResourceEvent,
  applyResourceCommand,
  loadStateFromSnapshotAndTail,
  decideUser,
  decideResource,
  foldUser
});

export const executeUserCommand = defaultDispatchers.executeUserCommand;
export const executeResourceCommand = defaultDispatchers.executeResourceCommand;

