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
```

## Tablas DynamoDB esperadas

- `users_projection` (PK: `userId`)
- `resources_projection` (PK: `resourceId`)
- `reservations_projection` (PK: `reservationId`)
- `idempotency_table` (PK: `idempotencyKey`)
- `projection_lag` (PK: `projection`)

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
