# Atlas Backend API – Frontend Integration Notes (Phase 2)

Base URL (current Railway):
- `https://atlasbackendapi-production.up.railway.app`

API prefix:
- All authenticated endpoints are under: `/api/v1/*`

## Auth

### Login

**POST** `/api/v1/auth/login`

Body:
```json
{ "email": "admin@example.com", "password": "password" }
```

Response:
```json
{ "token": "<jwt>", "user": { /* user */ }, "org": { /* organization */ } }
```

### Use token
Send header on all authenticated requests:

`Authorization: Bearer <token>`

### Session context

**GET** `/api/v1/me`

Response:
```json
{ "user": { /* user */ }, "org": { /* org */ } }
```

## Voters

### List voters (paginated)

**GET** `/api/v1/voters?limit=50&offset=0&q=<optional search>`

Response:
```json
{ "voters": [ /* Voter */ ], "limit": 50, "offset": 0 }
```

### Create voter

**POST** `/api/v1/voters`

Body (minimum viable fields):
```json
{
  "externalId": "EXT-123",
  "firstName": "Test",
  "lastName": "Voter",
  "address": "123 Main St",
  "city": "Baton Rouge",
  "state": "LA",
  "zip": "70801"
}
```

## Walk Lists (Relational Model)

Lists are stored as:
- `walk_lists` (list metadata)
- `list_members` (join table)

### Create list

**POST** `/api/v1/lists`

Body:
```json
{ "name": "My Walk List", "voterIds": ["<voter_uuid>"] }
```

### Get lists

**GET** `/api/v1/lists`

Returns array of:
- `id`, `orgId`, `name`, `voterIds`, `createdAt`, `createdByUserId`

## Assignments

### Create assignment (admin only)

**POST** `/api/v1/assignments`

Body:
```json
{ "listId": "<list_uuid>", "canvasserId": "<user_uuid>" }
```

### List assignments

**GET** `/api/v1/assignments?scope=me|org`

- `scope=me` returns assignments for the current user
- `scope=org` requires admin

## Interactions (Idempotent)

### Create interaction

**POST** `/api/v1/interactions`

Body:
```json
{
  "voter_id": "<voter_uuid>",
  "assignment_id": "<assignment_uuid>",
  "occurred_at": "2026-02-16T00:00:00.000Z",
  "channel": "canvass",
  "result_code": "contacted",
  "notes": "Optional notes",
  "client_interaction_uuid": "<uuid>",
  "survey_responses": { "support": "yes" }
}
```

Idempotency rule:
- Submitting the same `client_interaction_uuid` again returns the original interaction.

## Jobs / Imports

### JSON import (queues worker)

**POST** `/api/v1/jobs/import-voters`

Body: JSON array (shape is currently flexible; worker maps fields)

Response:
```json
{ "id": "<job_uuid>", "status": "pending" }
```

### CSV upload import

**POST** `/api/v1/imports/voters` (multipart form-data: `file`)

Response: job info

## Useful health endpoints

- `GET /health` → `OK`
- `GET /ready` → `{ "status": "ready" }`
- `GET /openapi.yaml` → raw OpenAPI spec
