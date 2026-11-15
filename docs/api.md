# API: PDF Voice (`/v1/pdf`)

Server: `server/`. Client: `web/` (any other frontend can use the same contract).

A visitor uploads PDFs, then asks questions by **voice** (OpenAI Realtime over WebRTC) or
**text** (streamed). Answers come only from the visitor's own PDFs and cite document and page.
Voice and text emit the **same event types**, so one UI can render both.

## Basics

- Base URL: `https://<api-host>/v1/pdf`
- JSON in, JSON out, except `/chat` and `/voice/call/{id}/events`, which stream
  [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events).
- **Session:** anonymous, stored in an httpOnly cookie. Call `POST /session` once on page
  load. All other endpoints need the cookie and return `session_required` without it.
- **CORS:** the frontend origin must be listed in the backend's `WEB_ORIGIN`. Send every
  request with credentials: `fetch(url, { credentials: 'include' })`.
- Frontend and API should share one registrable domain (e.g. `app.example.de` and
  `api.example.de`); then the default `SameSite=Lax` cookie works. Different domains need
  `COOKIE_SAMESITE=none` on the backend (HTTPS only).

## Errors

Every error response has this body:

```json
{
  "error": {
    "code": "file_too_large",
    "message": "The file is too large. The maximum is 10 MB."
  }
}
```

`message` is safe to show to visitors. The frontend should switch on `code`.

| Code                  | HTTP | When                                                         |
| --------------------- | ---- | ------------------------------------------------------------ |
| `file_too_large`      | 413  | PDF over 10 MB or over 50 pages                              |
| `not_pdf`             | 415  | Not a PDF, or a damaged / password-protected PDF             |
| `no_text_found`       | 422  | No extractable text (scanned PDF)                            |
| `upload_limit`        | 429  | Daily upload limit reached                                   |
| `file_limit`          | 409  | Already 3 files; delete one first                            |
| `upload_in_progress`  | 409  | Another upload from this session is still being processed    |
| `no_documents`        | 409  | `/chat` called before any PDF was uploaded                   |
| `voice_minutes_used`  | 429  | Daily voice minutes used up                                  |
| `call_limit`          | 429  | Too many calls started today                                 |
| `chat_limit`          | 429  | Too many text questions today                                |
| `call_in_progress`    | 409  | A call from this visitor is already running                  |
| `service_busy`        | 503  | Too many calls running right now; try again in a few minutes |
| `service_daily_limit` | 503  | The service's daily budget is used up; back tomorrow         |
| `session_required`    | 401  | Missing or expired session cookie; call `POST /session`      |
| `forbidden_origin`    | 403  | Request from an origin not in `WEB_ORIGIN`                   |
| `invalid_request`     | 400  | Malformed body or parameters                                 |
| `not_found`           | 404  | Unknown document, call or route                              |
| `internal`            | 500  | Unexpected error (details only in server logs)               |

## Limits

- 3 files per session, 10 MB and 50 pages each. Files are deleted after 24 hours.
- Calls end after 5 minutes. 15 voice minutes per day.
- Daily upload, call and chat counts, and a global daily cost cap for the whole service.
- Daily limits are counted per visitor IP, so starting a new session does not reset them.
- All values are configurable in the backend `.env`.

## Endpoints

### `POST /session`

Creates the session cookie, or keeps the existing one.

`200` → `{ "sessionId": "0b6a8f5e-1c1d-4e8a-9b1f-2a3b4c5d6e7f" }`

### `GET /documents`

`200` →

```json
{
  "documents": [
    {
      "id": "30418630cbad6eca66eb9514",
      "name": "contract.pdf",
      "pages": 3,
      "sizeBytes": 1396,
      "createdAt": 1794429143391,
      "expiresAt": 1794515543391
    }
  ],
  "quota": {
    "files": 1,
    "maxFiles": 3,
    "voiceMinutesLeft": 12,
    "voiceMinutesPerDay": 15,
    "maxUploadMb": 10,
    "maxPages": 50,
    "uploadsLeftToday": 9,
    "maxCallSeconds": 300,
    "serviceAvailable": true
  }
}
```

Times are Unix milliseconds.

### `POST /documents`

`multipart/form-data` with one field `file` (the PDF). Indexing takes a few seconds.

`201` → `{ "id": "…", "name": "contract.pdf", "pages": 3, "sizeBytes": 1396, "createdAt": …, "expiresAt": … }`

Errors: `file_too_large`, `not_pdf`, `no_text_found`, `upload_limit`, `file_limit`,
`upload_in_progress`, `service_daily_limit`.

### `DELETE /documents/{id}`

`204`, or `404 not_found`.

### `POST /chat`

Asks a text question about the session's PDFs. The answer streams back.

Request:

```json
{
  "question": "When is invoice 4711 due?",
  "history": [
    { "role": "user", "content": "What is the delivery time?" },
    {
      "role": "assistant",
      "content": "Five working days (contract.pdf, p. 1)."
    }
  ]
}
```

`history` is optional (last 10 messages, used for follow-up questions).

Response: `text/event-stream`. Validation errors (`no_documents`, `chat_limit`, …) are returned
as normal JSON errors **before** the stream starts. Events:

| Event    | Data                                          | Meaning                                                          |
| -------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `search` | `{ "query": "When is invoice 4711 due?" }`    | Searching the PDFs                                               |
| `source` | `{ "document": "contract.pdf", "page": "2" }` | A passage the answer is based on. `page` may be a range: `"3-4"` |
| `token`  | `{ "text": "Invoice 4711 is due" }`           | Next piece of the answer; append in order                        |
| `done`   | `{}`                                          | Answer complete                                                  |
| `error`  | `{ "code": "internal", "message": "…" }`      | Failed mid-stream; the stream ends                               |

### `POST /voice/call`

Starts a voice call. The browser opens a WebRTC connection **directly to OpenAI**. The backend
creates the call with its own API key (never sent to the browser), runs the PDF search and
enforces time and cost limits.

Request: `{ "sdp": "<WebRTC SDP offer>" }`

`201` → `{ "callId": "rtc_…", "sdp": "<SDP answer>", "maxSeconds": 300 }`

Errors: `voice_minutes_used`, `call_limit`, `call_in_progress`, `service_busy`,
`service_daily_limit`, `invalid_request`.

Browser side (minimal):

```js
const pc = new RTCPeerConnection();
const audio = new Audio();
audio.autoplay = true;
pc.ontrack = (e) => {
  audio.srcObject = e.streams[0];
};
const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
pc.addTrack(mic.getAudioTracks()[0], mic);
pc.createDataChannel('oai-events'); // raw OpenAI events; optional to read
await pc.setLocalDescription(await pc.createOffer());

const res = await fetch(`${API}/v1/pdf/voice/call`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sdp: pc.localDescription.sdp }),
});
const { callId, sdp, maxSeconds } = await res.json();
await pc.setRemoteDescription({ type: 'answer', sdp });
const events = new EventSource(`${API}/v1/pdf/voice/call/${callId}/events`, {
  withCredentials: true,
});
```

Typed questions **during** a call can be sent over the data channel as OpenAI Realtime events
(`conversation.item.create` + `response.create`); their answers appear in the event stream.

### `GET /voice/call/{callId}/events`

`text/event-stream` with the call's events. Only the session that started the call can open it.
Events that happened before you subscribed (up to 100) are replayed.

| Event        | Data                                                                                                    | Meaning                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `transcript` | `{ "itemId": "item_…", "role": "user" \| "assistant", "text": "…", "final": false }`                    | Live transcript. `text` is the **full text so far**: replace, don't append. `final: true` when complete |
| `search`     | `{ "query": "delivery time" }`                                                                          | The assistant searches the PDFs                                                                         |
| `source`     | `{ "document": "contract.pdf", "page": "1" }`                                                           | Passage the next answer is based on                                                                     |
| `ended`      | `{ "reason": "time_limit" \| "ended_by_user" \| "daily_limit" \| "disconnected" \| "server_shutdown" }` | Call over; the stream ends                                                                              |

### `DELETE /voice/call/{callId}`

Ends the call immediately. `204`, or `404 not_found`.

### `GET /health` (no `/v1/pdf` prefix)

`200` → `{ "ok": true }`
