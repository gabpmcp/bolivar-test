import { describe, expect, it } from "vitest";
import { decideUser } from "./user-decider.js";

describe("decideUser", () => {
  it("rechaza bootstrap con key inválida", () => {
    const decision = decideUser(
      null,
      {
        type: "BootstrapAdmin",
        userId: "u1",
        email: "admin@test.com",
        passwordHash: "hash"
      }
    );

    expect(decision.kind).toBe("accepted");
  });

  it("rechaza registro si el stream ya existe", () => {
    const decision = decideUser(
      {
        userId: "u1",
        email: "dup@test.com",
        passwordHash: "hash",
        role: "user"
      },
      {
        type: "RegisterUser",
        userId: "u1",
        email: "dup@test.com",
        passwordHash: "hash"
      }
    );

    expect(decision.kind).toBe("rejected");
    expect(decision.kind === "rejected" ? decision.error.error.code : "").toBe("USER_ALREADY_EXISTS");
  });

  it("acepta login con password válida", () => {
    const decision = decideUser(
      {
        userId: "u1",
        email: "user@test.com",
        passwordHash: "hash",
        role: "user"
      },
      {
        type: "LoginUser",
        userId: "u1",
        email: "user@test.com"
      }
    );

    expect(decision.kind).toBe("accepted");
  });
});
