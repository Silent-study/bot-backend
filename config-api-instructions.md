# Bot Config & eNotes — API Reference

All endpoints require a **Bearer token** in the `Authorization` header:

```
Authorization: Bearer <jwt_token>
```

The JWT is obtained from `POST /api/auth/login` (existing auth flow). It expires after **7 days**.

Base URL (production TBD, local dev): `http://127.0.0.1:3000`

---

## 1. Get Bot Config

Fetch the current bot configuration and whether the bot is currently active.

**`GET /api/config`**

### Request

No body required.

```http
GET /api/config
Authorization: Bearer <token>
```

### Response `200 OK`

```json
{
  "config": {
    "autoAdvance":        true,
    "autoSubmit":         true,
    "autoAssessment":     true,
    "assessmentAccuracy": 75,
    "autoAssignment":     true,
    "autoWrite":          true,
    "autoProject":        true,
    "autoVocab":          true
  },
  "botActive": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `config.autoAdvance` | boolean | Automatically moves to the next activity |
| `config.autoSubmit` | boolean | Automatically submits answers |
| `config.autoAssessment` | boolean | Automatically handles assessment/quiz activities |
| `config.assessmentAccuracy` | number | Target accuracy % for assessments. Range: **40–90**. Default: `75` |
| `config.autoAssignment` | boolean | Automatically completes assignment activities |
| `config.autoWrite` | boolean | Automatically handles written response activities |
| `config.autoProject` | boolean | Automatically handles project activities |
| `config.autoVocab` | boolean | Automatically handles vocab/vocabulary activities |
| `botActive` | boolean | `true` if the bot is currently running. **Config cannot be changed while this is `true`.** |

---

## 2. Save Bot Config

Update the bot configuration. **Blocked (403) if the bot is currently active.**

**`POST /api/config`**

### Request

Send only the fields you want to update — any omitted fields are left unchanged.

```http
POST /api/config
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "autoAdvance":        true,
  "autoSubmit":         false,
  "autoAssessment":     true,
  "assessmentAccuracy": 80,
  "autoAssignment":     true,
  "autoWrite":          true,
  "autoProject":        false,
  "autoVocab":          true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `autoAdvance` | boolean | No | |
| `autoSubmit` | boolean | No | |
| `autoAssessment` | boolean | No | |
| `assessmentAccuracy` | number | No | Clamped to 40–90 server-side |
| `autoAssignment` | boolean | No | |
| `autoWrite` | boolean | No | |
| `autoProject` | boolean | No | |
| `autoVocab` | boolean | No | |

### Response `200 OK`

```json
{ "ok": true }
```

### Response `403 Forbidden` — bot is active

```json
{ "error": "Cannot update config while bot is active. Stop the bot first." }
```

---

## 3. eNotes — Get Answered Questions

Returns a paginated list of all questions the bot has answered for the authenticated user, newest first.

**`GET /api/notes`**

### Query Parameters

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `page` | number | `1` | — | Page number (1-based) |
| `limit` | number | `50` | `100` | Records per page |

### Request

```http
GET /api/notes?page=1&limit=20
Authorization: Bearer <token>
```

### Response `200 OK`

```json
{
  "notes": [
    {
      "_id":          "665f1a2b3c4d5e6f7a8b9c0d",
      "userId":       "6a0c2e34bc57401bef598a8f",
      "questionText": "What is the primary function of the mitochondria?",
      "answer":       "To produce energy (ATP) for the cell through cellular respiration.",
      "activityType": "mcq",
      "source":       "ai",
      "timestamp":    "2026-05-22T14:30:00.000Z"
    }
  ],
  "total": 142,
  "page":  1,
  "pages": 8
}
```

| Field | Type | Description |
|-------|------|-------------|
| `notes` | array | Array of note objects for this page |
| `notes[].questionText` | string | The full question text |
| `notes[].answer` | string | The answer the bot used |
| `notes[].activityType` | string | One of: `mcq`, `essay`, `vocab`, `dropdown`, `checkbox` |
| `notes[].source` | string | `"ai"` = answered by OpenAI, `"db"` = pulled from answer database |
| `notes[].timestamp` | ISO 8601 | When the question was answered |
| `total` | number | Total number of notes for this user |
| `page` | number | Current page |
| `pages` | number | Total number of pages |

---

## 4. Bot Active Status (Extension-Only)

> **Note:** This endpoint is called automatically by the Chrome extension when the bot toggle is switched on or off. The frontend does **not** need to call this directly — it is documented here for completeness.

**`POST /api/bot-status`**

```http
POST /api/bot-status
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "active": true }
```

Response:

```json
{ "ok": true, "botActive": true }
```

---

## UI Behaviour Guidelines

1. **On page/component load**: Call `GET /api/config`. Store the `botActive` flag.
2. **If `botActive === true`**: Render all config inputs as `disabled`. Show a warning banner (e.g. *"Stop the bot to edit configuration"*).
3. **If `botActive === false`**: Allow editing. On save, call `POST /api/config`.
4. **Handle 403 on save**: Display the error message from the response body — the user activated the bot in another tab/device between load and save.
5. **eNotes tab**: Call `GET /api/notes?page=1&limit=20` on load. Implement next/prev pagination using the `page` and `pages` fields from the response.
