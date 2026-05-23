# Bot Config, Logs & eNotes — API Reference

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

## 3. Activity Logs

### 3a. Get Paginated Logs

Returns a paginated list of all activity log entries for the authenticated user, newest first.

**`GET /api/logs`**

#### Query Parameters

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `page` | number | `1` | — | Page number (1-based) |
| `limit` | number | `50` | `100` | Records per page |

#### Request

```http
GET /api/logs?page=1&limit=50
Authorization: Bearer <token>
```

#### Response `200 OK`

```json
{
  "logs": [
    {
      "_id":       "665f1a2b3c4d5e6f7a8b9c0d",
      "userId":    "6a0c2e34bc57401bef598a8f",
      "event":     "MCQ_ANSWERED",
      "detail":    "",
      "timestamp": "2026-05-22T14:30:00.000Z"
    }
  ],
  "total": 318,
  "page":  1,
  "pages": 7
}
```

| Field | Type | Description |
|-------|------|-------------|
| `logs` | array | Log entries for this page, newest first |
| `logs[].event` | string | Event type (see table in Section 5) |
| `logs[].detail` | string | Optional extra context for the event |
| `logs[].timestamp` | ISO 8601 | When the event occurred |
| `total` | number | Total log entries for this user |
| `page` | number | Current page |
| `pages` | number | Total pages |

---

### 3b. Post Activity Log (Extension-Only)

> **Note:** Called automatically by the Chrome extension after each bot action. The web frontend must **not** call this — listen for the `activity-log` Socket.IO event (Section 5) to receive log entries in real-time instead.

**`POST /api/log`**

```http
POST /api/log
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "event": "MCQ_ANSWERED", "detail": "" }
```

When this endpoint is called, the server **automatically emits an `activity-log` Socket.IO event** to all of the user's connected dashboard sessions (see Section 5).

#### Response `200 OK`

```json
{ "ok": true }
```

---

## 4. eNotes — Get Answered Questions

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

## 5. Bot Active Status

Two endpoints for reading and writing the bot's active state.

### 5a. Get Bot Status

Returns only the current `botActive` flag. Use this for a lightweight status poll or on initial load when you don't need the full config.

**`GET /api/bot-status`**

```http
GET /api/bot-status
Authorization: Bearer <token>
```

#### Response `200 OK`

```json
{ "botActive": false }
```

---

### 5b. Set Bot Status (Extension-Only)

> **Note:** This is called automatically by the Chrome extension when the bot toggle is switched on or off. The web frontend must **not** call this — use the Socket.IO event (Section 5) to react to status changes instead.

**`POST /api/bot-status`**

```http
POST /api/bot-status
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{ "active": true }
```

#### Response `200 OK`

```json
{ "ok": true, "botActive": true }
```

When this endpoint is called, the server **automatically emits a `bot-status` Socket.IO event** to all of the user's connected dashboard sessions (see Section 5).

---

## 6. Real-Time Updates — Socket.IO

The server uses **Socket.IO** for real-time push updates. When the user toggles the bot from the Chrome extension, all open dashboard sessions receive an instant update — no polling required.

### Connection & Authentication

Connect to the same origin as the API. After connecting, send an `authenticate` event with the JWT. The server will add the socket to a private room scoped to that user.

```js
const socket = io(); // same origin

socket.on('connect', () => {
  socket.emit('authenticate', jwtToken);
});

socket.on('authenticated', ({ userId, plan }) => {
  // Socket is now in the user's private room.
  // Proceed to load initial state via REST.
});

socket.on('auth-error', () => {
  // Token is invalid or expired. Redirect to login.
});
```

### `bot-status` Event

Emitted to the user's room whenever the extension toggles the bot on or off.

```js
socket.on('bot-status', ({ botActive }) => {
  // botActive: boolean
  // Update your UI immediately — lock/unlock config form,
  // show/hide warning banners, etc.
});
```

#### Payload

| Field | Type | Description |
|-------|------|-------------|
| `botActive` | boolean | `true` = bot just started, `false` = bot just stopped |

### `activity-log` Event

Emitted whenever the Chrome extension completes a bot action. Use this to append entries to a live log feed in real-time — **do not poll `GET /api/logs` for this**.

```js
socket.on('activity-log', ({ event, detail, timestamp }) => {
  // event:     string       — e.g. "MCQ_ANSWERED", "VIDEO_SKIP_DONE"
  // detail:    string       — optional extra context (may be empty)
  // timestamp: ISO 8601     — when the action occurred
  appendToLogFeed(event, detail, timestamp);
});
```

#### Payload

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Event type (see table below) |
| `detail` | string | Optional extra context, may be an empty string |
| `timestamp` | ISO 8601 | Server-side time of the event |

#### `event` values

| `event` | Meaning | Stat counter |
|---------|---------|-------------|
| `MCQ_ANSWERED` | Multiple-choice question answered | questions |
| `CHECKBOX_ANSWERED` | Multi-select question answered | questions |
| `ESSAY_ANSWERED` | Essay written | questions |
| `TEXTAREA_ANSWERED` | Short answer written | questions |
| `CONTENTEDITABLE_ANSWERED` | Rich-text response written | questions |
| `DROPDOWN_ANSWERED` | Dropdown answered | questions |
| `VIDEO_SKIP_START` | Video skip in progress | — |
| `VIDEO_SKIP_DONE` | Video fully skipped | videos |
| `VOCAB_START` | Vocab activity started | — |
| `VOCAB_DONE` | Vocab activity completed | vocab |
| `NEXT_ACTIVITY_CLICKED` | Moved to next activity | activities |
| `DONE_CLICKED` | Answer submitted | — |
| `ACTIVITY_FRAME_READY` | Activity iframe loaded | — |
| `TOP_FRAME_READY` | Page ready | — |

---

## UI Behaviour Guidelines

1. **On login / page load**
   - Establish a Socket.IO connection and authenticate immediately after receiving the JWT (Section 6).
   - Call `GET /api/config` to get the full config and the initial `botActive` state.

2. **Live log feed**
   - On initial load, call `GET /api/logs?page=1&limit=50` to populate the log feed with historical entries.
   - From then on, **only use the `activity-log` Socket.IO event** to append new entries as they arrive — do not re-poll the REST endpoint.
   - Prepend new entries to the top of the feed so the most recent action is always visible.

3. **Stat counters** (questions, videos, vocab, activities)
   - Increment the relevant counter each time an `activity-log` event arrives, based on the `event` field (see the stat counter column in Section 6).
   - Seed initial counts from `GET /api/stats` on load (last-24h window).

4. **Rendering config inputs**
   - `botActive === true` → disable all inputs, show a warning banner (e.g. *"Stop the bot from the extension to edit settings"*).
   - `botActive === false` → enable all inputs, hide the banner.

5. **Reacting to real-time bot status changes (critical)**
   - Listen for the `bot-status` Socket.IO event (Section 6).
   - When received, immediately re-apply the lock/unlock logic from step 4 **without** making a new REST call.
   - This ensures the config form locks instantly when the user starts the bot from the extension — even if the dashboard is open in another tab.

6. **Saving config**
   - Call `POST /api/config` only when `botActive === false`.
   - Handle `403 Forbidden`: display the error from the response body — the bot was activated between the user loading the page and pressing Save.

7. **eNotes tab**
   - Call `GET /api/notes?page=1&limit=20` on tab load.
   - Implement next/prev pagination using the `page` and `pages` fields from the response.

8. **Logs tab / history**
   - Call `GET /api/logs?page=1&limit=50` for historical log browsing with pagination.
   - The live feed (step 2) and the paginated history tab are separate concerns — keep them independent.
