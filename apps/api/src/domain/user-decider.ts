import { match, P } from "ts-pattern";
import { domainError } from "./types.js";
import type { Decision, UserCommand, UserEvent, UserState } from "./types.js";

export const foldUser = (
  state: UserState | null,
  event: UserEvent
): UserState | null =>
  match<[UserState | null, UserEvent], UserState | null>([state, event])
    .with([P.any, { type: "AdminBootstrapped" }], ([_, { payload }]) => ({
      userId: payload.userId,
      email: payload.email,
      passwordHash: payload.passwordHash,
      role: "admin"
    }))
    .with([P.any, { type: "UserRegistered" }], ([_, { payload }]) => ({
      userId: payload.userId,
      email: payload.email,
      passwordHash: payload.passwordHash,
      role: payload.role
    }))
    .with([P.any, { type: "UserLoggedIn" }], ([current]) => current)
    .exhaustive();

export const decideUser = (
  state: UserState | null,
  command: UserCommand
): Decision<UserEvent> =>
  match<UserCommand, Decision<UserEvent>>(command)
    .with({ type: "BootstrapAdmin" }, (cmd) =>
      state !== null
        ? {
            kind: "rejected",
            error: domainError("USER_ALREADY_EXISTS", "User stream already initialized", {
              userId: state.userId
            })
          }
        : {
            kind: "accepted",
            event: {
              type: "AdminBootstrapped",
              payload: {
                userId: cmd.userId,
                email: cmd.email,
                passwordHash: cmd.passwordHash
              }
            }
          }
    )
    .with({ type: "RegisterUser" }, (cmd) =>
      state !== null
        ? {
            kind: "rejected",
            error: domainError("USER_ALREADY_EXISTS", "User stream already initialized", {
              userId: state.userId
            })
          }
        : {
            kind: "accepted",
            event: {
              type: "UserRegistered",
              payload: {
                userId: cmd.userId,
                email: cmd.email,
                passwordHash: cmd.passwordHash,
                role: "user"
              }
            }
          }
    )
    .with({ type: "LoginUser" }, (cmd) =>
      state && state.email === cmd.email
        ? {
            kind: "accepted",
            event: {
              type: "UserLoggedIn",
              payload: {
                userId: cmd.userId,
                email: cmd.email
              }
            }
          }
        : {
            kind: "rejected",
            error: domainError("INVALID_CREDENTIALS", "Credentials are invalid", {})
          }
    )
    .exhaustive();
