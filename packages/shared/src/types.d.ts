export type Role = "admin" | "user";
export type ErrorShape = {
    error: {
        code: string;
        reason: string;
        meta: Record<string, unknown>;
    };
};
export type JwtClaims = {
    sub: string;
    role: Role;
    email: string;
};
export type CursorPage<T> = {
    items: T[];
    nextCursor: string | null;
    projectionLag: {
        eventsBehind: number;
        lastProjectedAtUtc: string | null;
    };
};
