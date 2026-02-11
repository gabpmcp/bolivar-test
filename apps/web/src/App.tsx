import { useEffect, useMemo, useState } from "react";
import { request, type ApiError } from "./api.js";

type Role = "admin" | "user";

type Claims = {
  sub: string;
  role: Role;
  email: string;
  exp: number;
};

type Resource = {
  resourceId: string;
  name: string;
  details: string;
  status: "active";
};

type Reservation = {
  reservationId: string;
  resourceId: string;
  userId: string;
  fromUtc: string;
  toUtc: string;
  status: "active" | "cancelled";
  createdAtUtc: string;
  cancelledAtUtc: string | null;
};

const decodeClaims = (token: string | null): Claims | null =>
  token
    ? (JSON.parse(atob(token.split(".")[1])) as Claims)
    : null;

const useSession = () => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  const claims = useMemo(() => decodeClaims(token), [token]);
  const logout = () => (localStorage.removeItem("token"), setToken(null));
  const login = (nextToken: string) => (localStorage.setItem("token", nextToken), setToken(nextToken));
  return { token, claims, login, logout };
};

const ErrorView = ({ error }: { error: ApiError | null }) =>
  error ? (
    <pre style={{ background: "#300", color: "#faa", padding: 12 }}>
      {JSON.stringify(error, null, 2)}
    </pre>
  ) : null;

const AuthPanel = ({ onToken }: { onToken: (token: string) => void }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<ApiError | null>(null);
  const submit = () =>
    request<{ token: string }>({
      path: "/commands/user",
      method: "POST",
      token: null,
      body: {
        command:
          mode === "login"
            ? { type: "LoginUser", payload: { email, password } }
            : { type: "RegisterUser", payload: { email, password } }
      },
      idempotent: true
    })
      .then(({ token }) => onToken(token))
      .catch((nextError: ApiError) => setError(nextError));

  return (
    <section>
      <h2>{mode === "login" ? "Login" : "Registro"}</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input placeholder="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input
          placeholder="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button onClick={submit}>{mode}</button>
        <button onClick={() => setMode(mode === "login" ? "register" : "login")}>switch</button>
      </div>
      <ErrorView error={error} />
    </section>
  );
};

const ResourcesPanel = ({ token, role }: { token: string; role: Role }) => {
  const [resources, setResources] = useState<Resource[]>([]);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<ApiError | null>(null);

  const refresh = () =>
    request<{ items: Resource[] }>({
      path: "/resources?limit=30",
      token
    })
      .then(({ items }) => setResources(items))
      .catch((nextError: ApiError) => setError(nextError));

  const createResource = () =>
    request<{ resourceId: string }>({
      path: "/commands/resource",
      method: "POST",
      token,
      body: {
        command: {
          type: "CreateResource",
          payload: { name, details }
        }
      },
      idempotent: true
    })
      .then(() => refresh())
      .catch((nextError: ApiError) => setError(nextError));

  const updateResource = () =>
    selectedResourceId
      ? request<{ ok: true }>({
          path: "/commands/resource",
          method: "POST",
          token,
          body: {
            command: {
              type: "UpdateResourceMetadata",
              payload: { resourceId: selectedResourceId, details }
            }
          },
          idempotent: true
        })
          .then(() => refresh())
          .catch((nextError: ApiError) => setError(nextError))
      : Promise.resolve();

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section>
      <h2>Recursos</h2>
      {role === "admin" ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input placeholder="name" value={name} onChange={(event) => setName(event.target.value)} />
          <input
            placeholder="details"
            value={details}
            onChange={(event) => setDetails(event.target.value)}
          />
          <button onClick={createResource}>crear</button>
          <button onClick={updateResource} disabled={!selectedResourceId}>
            editar detalle
          </button>
        </div>
      ) : null}
      <ul>
        {resources.map((resource) => (
          <li key={resource.resourceId}>
            <button onClick={() => setSelectedResourceId(resource.resourceId)}>
              {resource.name} - {resource.details}
            </button>
          </li>
        ))}
      </ul>
      <ReservationEditor token={token} role={role} resourceId={selectedResourceId} />
      <ErrorView error={error} />
    </section>
  );
};

const ReservationEditor = ({
  token,
  role,
  resourceId
}: {
  token: string;
  role: Role;
  resourceId: string | null;
}) => {
  const [fromUtc, setFromUtc] = useState("");
  const [toUtc, setToUtc] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [cancelResourceId, setCancelResourceId] = useState("");
  const [cancelReservationId, setCancelReservationId] = useState("");
  const [error, setError] = useState<ApiError | null>(null);

  const create = () =>
    resourceId
      ? request({
          path: "/commands/resource",
          method: "POST",
          token,
          body: {
            command: {
              type: "CreateReservationInResource",
              payload: {
                resourceId,
                fromUtc,
                toUtc,
                ...(role === "admin" && targetUserId ? { reservationUserId: targetUserId } : {})
              }
            }
          },
          idempotent: true
        }).catch((nextError: ApiError) => setError(nextError))
      : Promise.resolve();

  const cancel = () =>
    cancelResourceId && cancelReservationId
      ? request({
          path: "/commands/resource",
          method: "POST",
          token,
          body: {
            command: {
              type: "CancelReservationInResource",
              payload: {
                resourceId: cancelResourceId,
                reservationId: cancelReservationId
              }
            }
          },
          idempotent: true
        }).catch((nextError: ApiError) => setError(nextError))
      : Promise.resolve();

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Reservas</h3>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          placeholder="fromUtc"
          value={fromUtc}
          onChange={(event) => setFromUtc(event.target.value)}
        />
        <input placeholder="toUtc" value={toUtc} onChange={(event) => setToUtc(event.target.value)} />
        {role === "admin" ? (
          <input
            placeholder="targetUserId (opcional)"
            value={targetUserId}
            onChange={(event) => setTargetUserId(event.target.value)}
          />
        ) : null}
        <button onClick={create} disabled={!resourceId}>
          crear reserva
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          placeholder="resourceId"
          value={cancelResourceId}
          onChange={(event) => setCancelResourceId(event.target.value)}
        />
        <input
          placeholder="reservationId"
          value={cancelReservationId}
          onChange={(event) => setCancelReservationId(event.target.value)}
        />
        <button onClick={cancel}>cancelar</button>
      </div>
      <ErrorView error={error} />
    </div>
  );
};

const ReservationsPanel = ({ token, role }: { token: string; role: Role }) => {
  const [scope, setScope] = useState<"me" | "global">(role === "admin" ? "global" : "me");
  const [active, setActive] = useState<Reservation[]>([]);
  const [history, setHistory] = useState<Reservation[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const refresh = () =>
    Promise.all([
      request<{ items: Reservation[] }>({
        path: `/reservations/active?scope=${scope}&limit=30`,
        token
      }),
      request<{ items: Reservation[] }>({
        path: `/reservations/history?scope=${scope}&limit=30`,
        token
      })
    ])
      .then(([activePage, historyPage]) => (setActive(activePage.items), setHistory(historyPage.items)))
      .catch((nextError: ApiError) => setError(nextError));

  useEffect(() => {
    refresh();
  }, [scope]);

  return (
    <section>
      <h2>Reservas activas / historial</h2>
      {role === "admin" ? (
        <select value={scope} onChange={(event) => setScope(event.target.value as "me" | "global")}>
          <option value="global">global</option>
          <option value="me">me</option>
        </select>
      ) : null}
      <button onClick={refresh}>refresh</button>
      <h3>Activas</h3>
      <ul>
        {active.map((reservation) => (
          <li key={reservation.reservationId}>
            {reservation.reservationId} | {reservation.resourceId} | {reservation.userId} |{" "}
            {reservation.fromUtc} - {reservation.toUtc}
          </li>
        ))}
      </ul>
      <h3>Historial</h3>
      <ul>
        {history.map((reservation) => (
          <li key={reservation.reservationId}>
            {reservation.reservationId} | {reservation.status} | {reservation.resourceId}
          </li>
        ))}
      </ul>
      <ErrorView error={error} />
    </section>
  );
};

export const App = () => {
  const { token, claims, login, logout } = useSession();
  return (
    <main style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>MVP Reservas</h1>
      {!token || !claims ? (
        <AuthPanel onToken={login} />
      ) : (
        <>
          <p>
            {claims.email} ({claims.role})
          </p>
          <button onClick={logout}>logout</button>
          <ResourcesPanel token={token} role={claims.role} />
          <ReservationsPanel token={token} role={claims.role} />
        </>
      )}
    </main>
  );
};
