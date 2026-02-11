import { decideResource, decideUser, foldUser } from "../domain/index.js";
import { getUserByEmail, getUserById, resourceNameTaken } from "../projections/store.js";
import { config } from "../config.js";
import type { HttpResponse } from "./pipeline.js";
import { domainErrorResponse, nowUtc, response } from "./pipeline.js";
import {
  appendResourceEventAndMaybeSnapshot,
  appendUserEventAndMaybeSnapshot,
  executeResourceTransition,
  loadStateFromSnapshotAndTail
} from "./resource-workflow.js";
import {
  buildBootstrapAdminCommand,
  buildCancelReservationCommand,
  buildCreateReservationCommand,
  buildCreateResourceCommand,
  buildLoginUserCommand,
  buildRegisterUserCommand,
  buildUpdateResourceMetadataCommand,
  type BuildResult
} from "./command-builders.js";
import type { Decision, ResourceCommand, ResourceEvent, UserCommand, UserEvent, UserState } from "../domain/types.js";

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

const fromBuild = <T>(
  built: BuildResult<T>,
  onOk: (value: T) => Promise<HttpResponse>
) => (built.kind === "error" ? Promise.resolve(domainErrorResponse(built.error)) : onOk(built.value));

const fromDecision = <TEvent extends { type: string; payload: Record<string, unknown> }>(
  decision: Decision<TEvent>,
  onAccepted: (event: TEvent) => Promise<HttpResponse>
) => (decision.kind === "rejected" ? Promise.resolve(domainErrorResponse(decision.error)) : onAccepted(decision.event));

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
        fromBuild<UserCommand>(built, (validCommand) =>
          fromDecision(decideUser(null, validCommand), (event) =>
            appendUserEventAndMaybeSnapshot({
              event: event as UserEvent,
              stateBefore: null,
              expectedVersion: 0,
              commandName: "BootstrapAdmin",
              success: () =>
                response(201, {
                  token: signToken({
                    sub: event.payload.userId,
                    role: "admin",
                    email: event.payload.email
                  })
                })
            })
          )
        )
      );
  },
  RegisterUser: (command, { signToken }) => {
    const { email, password } = (command as Extract<UserCommandInput, { type: "RegisterUser" }>).payload;
    return getUserByEmail(email)
      .then((existing) => buildRegisterUserCommand({ email, password, emailExists: existing !== null }))
      .then((built) =>
        fromBuild<UserCommand>(built, (validCommand) =>
          fromDecision(decideUser(null, validCommand), (event) =>
            appendUserEventAndMaybeSnapshot({
              event: event as UserEvent,
              stateBefore: null,
              expectedVersion: 0,
              commandName: "RegisterUser",
              success: () =>
                response(201, {
                  token: signToken({
                    sub: event.payload.userId,
                    role: "user",
                    email: event.payload.email
                  })
                })
            })
          )
        )
      );
  },
  LoginUser: (command, { signToken }) => {
    const { email, password } = (command as Extract<UserCommandInput, { type: "LoginUser" }>).payload;
    return getUserByEmail(email).then((projection) =>
      projection === null
        ? response(401, { error: { code: "INVALID_CREDENTIALS", reason: "Credentials are invalid", meta: {} } })
        : loadStateFromSnapshotAndTail<UserState | null, UserEvent>({
            streamType: "user",
            streamId: projection.userId,
            initialState: null,
            fold: (state, event) => foldUser(state, event)
          })
            .then(({ state, lastEventVersion }) => ({
              state,
              lastEventVersion,
              built: buildLoginUserCommand({ state, userId: projection.userId, email, password })
            }))
            .then(({ state, lastEventVersion, built }) =>
              fromBuild<UserCommand>(built, (validCommand) =>
                fromDecision(decideUser(state, validCommand), (event) =>
                  appendUserEventAndMaybeSnapshot({
                    event: event as UserEvent,
                    stateBefore: state,
                    expectedVersion: lastEventVersion,
                    commandName: "LoginUser",
                    success: () =>
                      response(200, {
                        token: signToken({
                          sub: event.payload.userId,
                          role: projection.role,
                          email: event.payload.email
                        })
                      })
                  })
                )
              )
            )
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
          resourceId: crypto.randomUUID(),
          name,
          details,
          actorUserId: auth.sub,
          actorRole: auth.role
        })
      )
      .then((built) =>
        fromBuild<ResourceCommand>(built, (validCommand) =>
          fromDecision(decideResource(null, validCommand), (event) =>
            appendResourceEventAndMaybeSnapshot({
              stateBefore: null,
              resourceId: event.payload.resourceId,
              expectedVersion: 0,
              event: event as ResourceEvent,
              commandName: "CreateResource",
              actorUserId: auth.sub,
              success: () => response(201, { resourceId: event.payload.resourceId })
            })
          )
        )
      );
  },
  UpdateResourceMetadata: (command, auth) => {
    const { resourceId, details } = (command as Extract<ResourceCommandInput, { type: "UpdateResourceMetadata" }>).payload;
    return executeResourceTransition({
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
    return getUserById(reservationUserId).then((user) => {
      const built = buildCreateReservationCommand({
        resourceId,
        fromUtc,
        toUtc,
        reservationUserId,
        reservationUserExists: user !== null,
        actorUserId: auth.sub,
        actorRole: auth.role,
        nowUtc: nowUtc()
      });
      return fromBuild<ResourceCommand>(built, (validCommand) =>
        executeResourceTransition({
          resourceId,
          commandOf: () => validCommand,
          commandName: "CreateReservationInResource",
          actorUserId: auth.sub,
          onAccepted: (event) =>
            event.type === "ReservationAddedToResource"
              ? response(201, { reservationId: event.payload.reservationId })
              : response(500, {
                  error: {
                    code: "EVENT_TYPE_MISMATCH",
                    reason: "Unexpected event type for reservation creation",
                    meta: { eventType: event.type }
                  }
                })
        })
      );
    });
  },
  CancelReservationInResource: (command, auth) => {
    const { resourceId, reservationId } = (
      command as Extract<ResourceCommandInput, { type: "CancelReservationInResource" }>
    ).payload;
    return executeResourceTransition({
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
  (userCommandHandlers[command.type] as (
    value: UserCommandInput,
    context: { actorBootstrapKey: string; signToken: (claims: { sub: string; role: "admin" | "user"; email: string }) => string }
  ) => Promise<HttpResponse>)(command, context);

export const executeResourceCommand = (command: ResourceCommandInput, auth: AuthContext) =>
  (resourceCommandHandlers[command.type] as (
    value: ResourceCommandInput,
    auth: AuthContext
  ) => Promise<HttpResponse>)(command, auth);
