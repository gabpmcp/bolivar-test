import { v7 as uuidv7 } from "uuid";
import bcrypt from "bcryptjs";
import { domainError } from "../domain/error.js";
import type { ResourceCommand, UserCommand, UserState } from "../domain/types.js";

export type BuildResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "error"; error: ReturnType<typeof domainError> };

export const buildBootstrapAdminCommand = ({
  email,
  password,
  actorBootstrapKey,
  expectedBootstrapKey,
  emailExists
}: {
  email: string;
  password: string;
  actorBootstrapKey: string;
  expectedBootstrapKey: string;
  emailExists: boolean;
}): BuildResult<UserCommand> =>
  actorBootstrapKey !== expectedBootstrapKey
    ? {
        kind: "error",
        error: domainError("BOOTSTRAP_FORBIDDEN", "Bootstrap key is invalid", {})
      }
    : emailExists
      ? {
          kind: "error",
          error: domainError("EMAIL_ALREADY_EXISTS", "Email is already registered", { email })
        }
      : {
          kind: "ok",
          value: {
            type: "BootstrapAdmin",
            userId: uuidv7(),
            email,
            passwordHash: bcrypt.hashSync(password, 10)
          }
        };

export const buildRegisterUserCommand = ({
  email,
  password,
  emailExists
}: {
  email: string;
  password: string;
  emailExists: boolean;
}): BuildResult<UserCommand> =>
  emailExists
    ? {
        kind: "error",
        error: domainError("EMAIL_ALREADY_EXISTS", "Email is already registered", { email })
      }
    : {
        kind: "ok",
        value: {
          type: "RegisterUser",
          userId: uuidv7(),
          email,
          passwordHash: bcrypt.hashSync(password, 10)
        }
      };

export const buildLoginUserCommand = ({
  state,
  userId,
  email,
  password
}: {
  state: UserState | null;
  userId: string;
  email: string;
  password: string;
}): BuildResult<UserCommand> =>
  state === null || !bcrypt.compareSync(password, state.passwordHash)
    ? {
        kind: "error",
        error: domainError("INVALID_CREDENTIALS", "Credentials are invalid", {})
      }
    : {
        kind: "ok",
        value: {
          type: "LoginUser",
          userId,
          email
        }
      };

export const buildCreateResourceCommand = ({
  nameTaken,
  resourceId,
  name,
  details,
  actorUserId,
  actorRole
}: {
  nameTaken: boolean;
  resourceId: string;
  name: string;
  details: string;
  actorUserId: string;
  actorRole: "admin" | "user";
}): BuildResult<ResourceCommand> =>
  nameTaken
    ? {
        kind: "error",
        error: domainError("RESOURCE_NAME_TAKEN", "Resource name already exists", { name })
      }
    : {
        kind: "ok",
        value: {
          type: "CreateResource",
          resourceId,
          name,
          details,
          actorUserId,
          actorRole
        }
      };

export const buildUpdateResourceMetadataCommand = ({
  resourceId,
  details,
  actorUserId,
  actorRole
}: {
  resourceId: string;
  details: string;
  actorUserId: string;
  actorRole: "admin" | "user";
}): ResourceCommand => ({
  type: "UpdateResourceMetadata",
  resourceId,
  details,
  actorUserId,
  actorRole
});

export const buildCreateReservationCommand = ({
  resourceId,
  fromUtc,
  toUtc,
  reservationUserId,
  reservationUserExists,
  actorUserId,
  actorRole,
  nowUtc
}: {
  resourceId: string;
  fromUtc: string;
  toUtc: string;
  reservationUserId: string;
  reservationUserExists: boolean;
  actorUserId: string;
  actorRole: "admin" | "user";
  nowUtc: string;
}): BuildResult<ResourceCommand> =>
  !reservationUserExists
    ? {
        kind: "error",
        error: domainError("USER_NOT_FOUND", "Reservation user does not exist", {
          reservationUserId
        })
      }
    : {
        kind: "ok",
        value: {
          type: "CreateReservationInResource",
          resourceId,
          reservationId: uuidv7(),
          fromUtc,
          toUtc,
          reservationUserId,
          actorUserId,
          actorRole,
          nowUtc
        }
      };

export const buildCancelReservationCommand = ({
  resourceId,
  reservationId,
  actorUserId,
  actorRole,
  nowUtc
}: {
  resourceId: string;
  reservationId: string;
  actorUserId: string;
  actorRole: "admin" | "user";
  nowUtc: string;
}): ResourceCommand => ({
  type: "CancelReservationInResource",
  resourceId,
  reservationId,
  actorUserId,
  actorRole,
  nowUtc
});
