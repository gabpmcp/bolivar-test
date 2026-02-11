import { v4 as uuidv4 } from "uuid";

export type ApiError = {
  error: {
    code: string;
    reason: string;
    meta: Record<string, unknown>;
  };
};

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

const authHeaders = (token: string | null) =>
  token
    ? {
        Authorization: `Bearer ${token}`
      }
    : {};

const asJson = (response: Response) => response.json().catch(() => ({}));

export const request = <T>({
  path,
  method = "GET",
  token,
  body,
  idempotent = false
}: {
  path: string;
  method?: "GET" | "POST" | "PATCH";
  token: string | null;
  body?: unknown;
  idempotent?: boolean;
}) =>
  fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotent ? { "Idempotency-Key": uuidv4() } : {}),
      ...authHeaders(token)
    },
    body: body ? JSON.stringify(body) : undefined
  })
    .then((response) =>
      asJson(response).then((json) =>
        response.ok
          ? (json as T)
          : Promise.reject(
              (json as ApiError).error
                ? json
                : ({
                    error: {
                      code: "HTTP_ERROR",
                      reason: "Unexpected API error",
                      meta: { status: response.status }
                    }
                  } as ApiError)
            )
      )
    );
