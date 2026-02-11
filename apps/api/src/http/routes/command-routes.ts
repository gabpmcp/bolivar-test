import type { Express, Request } from "express";
import type { z } from "zod";
import { decideResource, decideUser } from "../../domain/index.js";
import { loadStream } from "../../infra/event-store.js";
import { getUserByEmail, getUserById, resourceNameTaken } from "../../projections/store.js";
import { requireAuth, type AuthedRequest, signToken } from "../security.js";
import { resourceCommandEnvelopeSchema, userCommandEnvelopeSchema } from "../schemas.js";
import {
  buildUserState,
  executeResourceMutation,
  persistResourceEvent,
  persistUserEvent
} from "../../application/resource-workflow.js";
import { domainErrorResponse, nowUtc, response, runIdempotent, safe, send, validated } from "../../application/pipeline.js";
import type { HttpResponse } from "../../application/pipeline.js";
import {
  buildBootstrapAdminCommand,
  buildCancelReservationCommand,
  buildCreateReservationCommand,
  buildCreateResourceCommand,
  buildLoginUserCommand,
  buildRegisterUserCommand,
  buildUpdateResourceMetadataCommand,
  type BuildResult
} from "../../application/command-builders.js";
import { config } from "../../config.js";
import type { Decision, ResourceCommand, ResourceEvent, UserCommand, UserEvent } from "../../domain/types.js";

type UserCommandEnvelope = z.infer<typeof userCommandEnvelopeSchema>;
type ResourceCommandEnvelope = z.infer<typeof resourceCommandEnvelopeSchema>;

const requireIdempotencyKey = (value: string | undefined) => (value && value.length > 0 ? value : null);

const fromBuild = <T>(
  built: BuildResult<T>,
  onOk: (value: T) => Promise<HttpResponse>
) => (built.kind === "error" ? Promise.resolve(domainErrorResponse(built.error)) : onOk(built.value));

const fromDecision = <TEvent extends { type: string; payload: Record<string, unknown> }>(
  decision: Decision<TEvent>,
  onAccepted: (event: TEvent) => Promise<HttpResponse>
) => (decision.kind === "rejected" ? Promise.resolve(domainErrorResponse(decision.error)) : onAccepted(decision.event));

const executeUserCommand = (command: UserCommandEnvelope["command"], req: Request): Promise<HttpResponse> => {
  if (command.type === "BootstrapAdmin") {
    const { email, password } = command.payload;
    return getUserByEmail(email)
      .then((existing) =>
        buildBootstrapAdminCommand({
          email,
          password,
          actorBootstrapKey: req.header("x-admin-bootstrap-key") ?? "",
          expectedBootstrapKey: config.adminBootstrapKey,
          emailExists: existing !== null
        })
      )
      .then((built) =>
        fromBuild<UserCommand>(built, (validCommand) =>
          fromDecision(decideUser(null, validCommand), (event) =>
            persistUserEvent({
              event: event as UserEvent,
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
  }

  if (command.type === "RegisterUser") {
    const { email, password } = command.payload;
    return getUserByEmail(email)
      .then((existing) => buildRegisterUserCommand({ email, password, emailExists: existing !== null }))
      .then((built) =>
        fromBuild<UserCommand>(built, (validCommand) =>
          fromDecision(decideUser(null, validCommand), (event) =>
            persistUserEvent({
              event: event as UserEvent,
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
  }

  if (command.type === "LoginUser") {
    const { email, password } = command.payload;
    return getUserByEmail(email).then((projection) =>
      projection === null
        ? response(401, { error: { code: "INVALID_CREDENTIALS", reason: "Credentials are invalid", meta: {} } })
        : loadStream<UserEvent["type"], UserEvent["payload"]>("user", projection.userId)
            .then((events) => ({ events, state: buildUserState(events) }))
            .then(({ events, state }) => ({
              events,
              built: buildLoginUserCommand({ state, userId: projection.userId, email, password })
            }))
            .then(({ events, built }) =>
              fromBuild<UserCommand>(built, (validCommand) =>
                fromDecision(decideUser(buildUserState(events), validCommand), (event) =>
                  persistUserEvent({
                    event: event as UserEvent,
                    expectedVersion: events.length,
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

  return Promise.resolve(response(400, { error: { code: "UNKNOWN_COMMAND", reason: "Unsupported user command", meta: {} } }));
};

const executeResourceCommand = (
  command: ResourceCommandEnvelope["command"],
  auth: { sub: string; role: "admin" | "user" }
): Promise<HttpResponse> => {
  if (command.type === "CreateResource") {
    const { name, details } = command.payload;
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
            persistResourceEvent({
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
  }

  if (command.type === "UpdateResourceMetadata") {
    const { resourceId, details } = command.payload;
    return executeResourceMutation({
      resourceId,
      commandOf: () => buildUpdateResourceMetadataCommand({ resourceId, details, actorUserId: auth.sub, actorRole: auth.role }),
      commandName: "UpdateResourceMetadata",
      actorUserId: auth.sub,
      onAccepted: () => response(200, { ok: true })
    });
  }

  if (command.type === "CreateReservationInResource") {
    const { resourceId, fromUtc, toUtc, reservationUserId: explicitReservationUserId } = command.payload;
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
        executeResourceMutation({
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
  }

  if (command.type === "CancelReservationInResource") {
    const { resourceId, reservationId } = command.payload;
    return executeResourceMutation({
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

  return Promise.resolve(response(400, { error: { code: "UNKNOWN_COMMAND", reason: "Unsupported resource command", meta: {} } }));
};

export const registerCommandRoutes = (app: Express) => {
  app.post("/commands/user", (req, res) =>
    safe(
      validated(userCommandEnvelopeSchema, req.body, "Invalid user command payload").then((parsed) => {
        if ("statusCode" in parsed) {
          return parsed;
        }
        const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
        return idempotencyKey === null
          ? response(400, {
              error: {
                code: "MISSING_IDEMPOTENCY_KEY",
                reason: "Idempotency-Key header is required",
                meta: {}
              }
            })
          : runIdempotent({
              idempotencyKey,
              content: { path: req.path, body: parsed },
              action: () => executeUserCommand(parsed.command, req)
            });
      })
    ).then(send(res))
  );

  app.post("/commands/resource", requireAuth, (req, res) => {
    const auth = (req as AuthedRequest).auth;
    return safe(
      validated(resourceCommandEnvelopeSchema, req.body, "Invalid resource command payload").then((parsed) => {
        if ("statusCode" in parsed) {
          return parsed;
        }
        const idempotencyKey = requireIdempotencyKey(req.header("Idempotency-Key") ?? undefined);
        return idempotencyKey === null
          ? response(400, {
              error: {
                code: "MISSING_IDEMPOTENCY_KEY",
                reason: "Idempotency-Key header is required",
                meta: {}
              }
            })
          : runIdempotent({
              idempotencyKey,
              content: { path: req.path, body: parsed, actor: auth.sub },
              action: () => executeResourceCommand(parsed.command, auth)
            });
      })
    ).then(send(res));
  });
};
