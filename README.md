# MVP Reservas (Event Sourcing + React + Express)

Monorepo con:

- `apps/api`: backend Node.js + TypeScript + Express.
- `apps/web`: frontend React (Vite).
- `packages/shared`: tipos compartidos mínimos.

## Requisitos

- Node 20+
- S3 compatible (o AWS S3)
- DynamoDB
- SQS

## Variables de entorno API

```bash
PORT=3000
JWT_SECRET=local-dev-secret
ADMIN_BOOTSTRAP_KEY=bootstrap-local-key
AWS_REGION=us-east-1

S3_ENDPOINT=http://localhost:4566
S3_BUCKET_EVENTS=reservations-events

DYNAMO_ENDPOINT=http://localhost:8000
USERS_PROJECTION_TABLE=users_projection
RESOURCES_PROJECTION_TABLE=resources_projection
RESERVATIONS_PROJECTION_TABLE=reservations_projection
IDEMPOTENCY_TABLE=idempotency_table
PROJECTION_LAG_TABLE=projection_lag

SQS_ENDPOINT=http://localhost:4566
SQS_QUEUE_URL=http://localhost:4566/000000000000/reservations-events

SNAPSHOT_EVERY_DEFAULT=500
SNAPSHOT_BY_STREAM_TYPE={"resource":500,"user":0}
```

## Tablas DynamoDB esperadas

- `users_projection` (PK: `userId`)
- `resources_projection` (PK: `resourceId`)
- `reservations_projection` (PK: `reservationId`)
- `idempotency_table` (PK: `idempotencyKey`)
- `projection_lag` (PK: `projection`)

## Snapshots en S3

- Ruta:
  - `snapshots/{streamType}/{streamId}/{snapshotVersionPad12}.json`
- JSON snapshot:
  - `streamType`, `streamId`, `snapshotVersion`, `lastEventVersion`, `state`, `createdAtUtc`
- Metadata S3 snapshot:
  - `snapshotversion`, `lasteventversion`
- Política:
  - se crea snapshot sincrónico cada `N` eventos según `SNAPSHOT_BY_STREAM_TYPE`
  - fallback por stream: `SNAPSHOT_EVERY_DEFAULT`
- `SNAPSHOT_BY_STREAM_TYPE`:
  - `0` deshabilita snapshots para ese streamType
  - ejemplo: `{"resource":500,"user":0}`

## Detección de gaps de versión

- Al leer eventos de un stream, se valida continuidad de versiones (`v, v+1, ...`).
- Si se detecta hueco, se reintenta lectura una vez.
- Si persiste, se retorna error serializable:
  - `error.code = "STREAM_GAP_DETECTED"`

## Desarrollo

```bash
npm install
npm run dev:api
npm run dev:worker
npm run dev:web
```

## Pruebas y build

```bash
npm run test
npm run build
```

## API principal

- `POST /commands/user` (`Idempotency-Key`)
- `POST /commands/resource` (`Authorization` + `Idempotency-Key`)
- `GET /resources`
- `GET /resources/:resourceId`
- `GET /reservations/active?scope=me|global&limit&nextCursor`
- `GET /reservations/history?scope=me|global&limit&nextCursor`

### Comandos soportados

- `/commands/user`
  - `BootstrapAdmin` (requiere header `x-admin-bootstrap-key`)
  - `RegisterUser`
  - `LoginUser`
- `/commands/resource`
  - `CreateResource`
  - `UpdateResourceMetadata`
  - `CreateReservationInResource`
  - `CancelReservationInResource`

Errores de negocio siempre en:

```json
{
  "error": {
    "code": "SOME_CODE",
    "reason": "Human readable reason",
    "meta": {}
  }
}
```

## Smoke test manual (curl)

### 1) Bootstrap admin y token

```bash
curl -s -X POST http://localhost:3000/commands/user \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: bootstrap-admin-1" \
  -H "x-admin-bootstrap-key: bootstrap-local-key" \
  -d '{
    "command": {
      "type": "BootstrapAdmin",
      "payload": {
        "email": "admin@test.com",
        "password": "Password123"
      }
    }
  }'
```

Guardar token en variable:

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/commands/user \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: bootstrap-admin-1" \
  -H "x-admin-bootstrap-key: bootstrap-local-key" \
  -d '{"command":{"type":"BootstrapAdmin","payload":{"email":"admin@test.com","password":"Password123"}}}' \
  | jq -r '.token')
```

Si el admin ya existe, usa login:

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:3000/commands/user \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: login-admin-1" \
  -d '{"command":{"type":"LoginUser","payload":{"email":"admin@test.com","password":"Password123"}}}' \
  | jq -r '.token')
```

### 2) Crear recurso

```bash
RESOURCE_ID=$(curl -s -X POST http://localhost:3000/commands/resource \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Idempotency-Key: create-resource-1" \
  -d '{
    "command": {
      "type": "CreateResource",
      "payload": {
        "name": "SalaA",
        "details": "Piso 1"
      }
    }
  }' | jq -r '.resourceId')
```

### 3) Crear reserva válida

```bash
RESERVATION_ID=$(curl -s -X POST http://localhost:3000/commands/resource \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Idempotency-Key: create-res-1" \
  -d "{
    \"command\": {
      \"type\": \"CreateReservationInResource\",
      \"payload\": {
        \"resourceId\": \"$RESOURCE_ID\",
        \"fromUtc\": \"2026-12-01T10:00:00.000Z\",
        \"toUtc\": \"2026-12-01T11:00:00.000Z\"
      }
    }
  }" | jq -r '.reservationId')
```

### 4) Probar solapamiento (espera HTTP 409)

```bash
curl -i -X POST http://localhost:3000/commands/resource \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Idempotency-Key: create-res-overlap-1" \
  -d "{
    \"command\": {
      \"type\": \"CreateReservationInResource\",
      \"payload\": {
        \"resourceId\": \"$RESOURCE_ID\",
        \"fromUtc\": \"2026-12-01T10:30:00.000Z\",
        \"toUtc\": \"2026-12-01T11:30:00.000Z\"
      }
    }
  }"
```

### 5) Idempotencia (mismo key y mismo body)

Repite exactamente el comando exitoso de creación de reserva con el mismo `Idempotency-Key` (`create-res-1`) y no se duplica el efecto.

### 6) Consultas con projection lag

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:3000/resources?limit=20"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:3000/reservations/active?scope=global&limit=20"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:3000/reservations/history?scope=global&limit=20"
```

### 7) Cancelar reserva

```bash
curl -s -X POST http://localhost:3000/commands/resource \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Idempotency-Key: cancel-res-1" \
  -d "{
    \"command\": {
      \"type\": \"CancelReservationInResource\",
      \"payload\": {
        \"resourceId\": \"$RESOURCE_ID\",
        \"reservationId\": \"$RESERVATION_ID\"
      }
    }
  }"
```
