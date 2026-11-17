# Technical Help Voicebot

A real-time technical-support voice agent built with **LiveKit Agents** (Python) and a **Next.js** web client. The browser joins a LiveKit room, the agent is dispatched automatically, and the conversation runs through a speech-to-text, LLM, and text-to-speech pipeline with live transcripts, text chat, microphone controls, and agent handoff.

The production experience is branded **Technical Help Voicebot** and focuses on LiveKit, WebRTC, SIP, API-token, and connectivity support. The agent currently uses **Groq** for all three model stages (STT, LLM, TTS), so a single `GROQ_API_KEY` is enough.

---

## Table of contents

- [Production topology](#production-topology)
- [Architecture](#architecture)
- [End-to-end runtime flow](#end-to-end-runtime-flow)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Environment variables and secrets](#environment-variables-and-secrets)
- [Backend agent](#backend-agent)
- [Frontend](#frontend)
- [Models and provider limits](#models-and-provider-limits)
- [Local development](#local-development)
- [Testing and verification](#testing-and-verification)
- [CI/CD](#cicd)
- [Deployment details](#deployment-details)
- [Operations runbook](#operations-runbook)
- [Command cheat sheet](#command-cheat-sheet)
- [Troubleshooting](#troubleshooting)
- [Known limitations and cleanup opportunities](#known-limitations-and-cleanup-opportunities)
- [Security notes](#security-notes)

---

## Production topology

The project is deployed as a **monorepo**: one GitHub repository contains both the Python agent and the Next.js frontend.

| Component | Value |
| --- | --- |
| GitHub repository | `ABSatpute/Technical_Help_Voicebot` (public) |
| Production branch | `main` |
| LiveKit project subdomain | `dangding-4s8gvz1g` |
| LiveKit agent ID | `CA_3EHBXZnTfm5v` |
| LiveKit deployment | `production`, region `us-east` |
| Last verified agent version | `nLTKAPrP8PRX` |
| Agent status | `Running` |
| Vercel project | `technical-help-voicebot` |
| Vercel root directory | `frontend` |
| Frontend deployment | Vercel GitHub integration, status `success` |

Deployment identifiers change over time. Use `lk agent status` and the Vercel dashboard to get the current values.

---

## Architecture

```text
┌─────────────────────────────┐
│ Browser (Next.js client)    │
│  PreJoin → LiveKitRoom      │
│  Transcript / Chat / Mic    │
└──────────────┬──────────────┘
               │ 1. GET /api/token?room=...&name=...
               ▼
┌─────────────────────────────┐
│ Next.js token route         │
│  LIVEKIT_API_KEY/SECRET     │
│  creates a 2h JWT           │
└──────────────┬──────────────┘
               │ 2. JWT + server URL
               ▼
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ LiveKit Cloud room          │◀──────▶│ Python agent worker         │
│  WebRTC audio + data        │        │  AgentServer / AgentSession │
└─────────────────────────────┘        │  Groq STT → LLM → TTS       │
                                       │  Silero VAD + turn detector │
                                       │  BVC noise cancellation     │
                                       └─────────────────────────────┘
```

Request flow:

1. The user opens the frontend, selects a microphone, and enters a room name.
2. `frontend/src/app/page.tsx` calls `GET /api/token` to mint a room token.
3. The browser connects to LiveKit Cloud with that token.
4. LiveKit dispatches the Python agent to the room.
5. The agent starts an `AgentSession` and asks for recording consent.
6. Audio flows browser → noise cancellation → VAD → Groq Whisper → Groq GPT-OSS → Groq Orpheus → browser.
7. Transcripts and chat events are rendered in the side panel; the user can interrupt, mute, or escalate to a manager.

---

## End-to-end runtime flow

This is the full production path, from opening the page to the final usage metric.

### 1. Browser bootstrap

1. The browser loads the Next.js app from Vercel.
2. `PreJoin` verifies `window.isSecureContext`; microphone APIs are only available on HTTPS or `localhost`.
3. The user grants microphone permission.
4. `PreJoin` enumerates audio input devices and renders a live level meter.
5. The display name and room name are restored from `localStorage`; a random `voice-xxxxxxxx` room is generated if none exists.

### 2. Token creation

1. The user submits the join form.
2. `frontend/src/app/page.tsx` calls `GET /api/token?room=<room>&name=<name>`.
3. The Next.js route reads `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` on the server.
4. The route sanitizes the room to `[A-Za-z0-9_-]{1,64}`, truncates the name to 48 characters, and generates a unique identity.
5. `livekit-server-sdk` creates a JWT with a 2-hour TTL and grants `roomJoin`, `canPublish`, `canSubscribe`, and `canPublishData`.
6. The route returns `{ token, serverUrl, room, identity }` with `Cache-Control: no-store`.

### 3. Room connection and agent dispatch

1. `LiveKitRoom` connects with the token and the selected microphone.
2. The browser publishes microphone audio and data-channel messages.
3. LiveKit Cloud sees the participant join and dispatches the registered agent worker.
4. The agent runs in the LiveKit Cloud `production` deployment in `us-east`.

### 4. Agent session startup

1. `entrypoint` checks that `GROQ_API_KEY` exists.
2. It constructs an `AgentSession` with Groq STT, Groq LLM, Groq TTS, Silero VAD, and LiveKit's turn detector.
3. It registers usage and agent-state listeners.
4. It starts `Assistant()` and enables BVC noise cancellation on the inbound audio track.
5. `Assistant.on_enter` creates a `CollectConsent` task and asks for recording consent.

### 5. Conversation loop

1. The caller speaks; BVC removes background noise.
2. Silero VAD detects speech; the turn detector decides when the utterance is complete.
3. Groq Whisper transcribes the audio.
4. Groq GPT-OSS generates a short reply using the agent instructions.
5. Groq Orpheus synthesizes the reply with the `hannah` voice.
6. The audio is published back into the room and played by `RoomAudioRenderer`.
7. Transcript events and chat messages are rendered in the side panel.
8. The caller can interrupt, mute, use push-to-talk, or switch audio devices at any time.

### 6. Escalation

1. The caller asks for a manager, or the assistant decides it cannot resolve the issue.
2. The `escalate_to_manager` tool returns a `ManagerAgent` plus a transfer message.
3. The session switches to the manager agent.
4. The manager introduces itself and continues the conversation with the `troy` voice.
5. The manager has authority to offer refunds, credits, or accommodations.

### 7. Shutdown and metrics

1. The session stops when the participant leaves, the agent errors, or the worker shuts down.
2. `UsageCollector` prints aggregated token, audio, and cost data.
3. `agent_state_changed` logs time-to-first-audio based on the last end-of-utterance metric.
4. LiveKit Cloud keeps the agent deployment running and ready for the next room.

---

## Repository layout

This is a monorepo: the Python agent lives at the repository root and the Next.js client lives in `frontend/`. GitHub Actions uses path filters so agent changes and frontend changes are tested and deployed independently.

| Path | Purpose |
| --- | --- |
| `agent.py` | Python agent: `AgentServer`, `AgentSession`, agents, tasks, metrics, entrypoint. |
| `pyproject.toml` | Python dependencies and LiveKit plugin extras. |
| `uv.lock` | Locked Python dependency graph used by `uv sync --locked`. |
| `Dockerfile` | Multi-stage production image for the agent (`uv`, Python 3.14, non-root user). |
| `.dockerignore` | Excludes local environments, secrets, and build artifacts from the image context. |
| `livekit.toml` | LiveKit Cloud project subdomain and agent ID used by the `lk` CLI. |
| `.env` | Local secrets. Never commit this file. |
| `frontend/` | Next.js 16 App Router client. |
| `frontend/public/voicebot-icon.png` | Voicebot brand mark; favicon assets live in the same folder. |
| `frontend/src/app/layout.tsx` | Page title, description, social metadata, and favicon links. |
| `frontend/src/app/api/token/route.ts` | Server-only LiveKit token endpoint. |
| `frontend/src/components/PreJoin.tsx` | Technical Help Voicebot join screen, name/room/mic selection, mic test, invite link. |
| `frontend/src/components/VoiceRoom.tsx` | In-room UI: transcript, chat, audio controls, handoff display. |
| `.github/workflows/agent.yml` | Agent CI and LiveKit Cloud deployment. |
| `.github/workflows/frontend.yml` | Frontend CI; Vercel's GitHub integration performs deployment. |

---

## Quick start

Prerequisites:

- Python **3.14**
- [`uv`](https://docs.astral.sh/uv/)
- Node.js **20+**
- A LiveKit Cloud project
- A Groq API key
- Groq Orpheus model terms accepted once by the organisation admin

Backend:

```powershell
uv sync
uv run python -m py_compile agent.py
uv run agent.py dev
```

Frontend:

```powershell
cd frontend
npm ci
npm run dev
```

Open `http://localhost:3000`, choose a microphone, and join a room. The agent joins automatically.

For production deployment, see [CI/CD](#cicd) and [Deployment details](#deployment-details).

For a text-only smoke test without a microphone:

```powershell
lk agent debugger start
lk agent debugger say "yes"
lk agent debugger say "My internet keeps dropping. Can you help?"
lk agent debugger stop
```

---

## Environment variables and secrets

Create a `.env` in the repository root for the agent:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
GROQ_API_KEY=your-groq-api-key
```

The frontend token route needs the same LiveKit credentials as server-side environment variables:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

Do **not** prefix these with `NEXT_PUBLIC_`. They are only read by the Next.js server route.

For LiveKit Cloud-hosted agents, `LIVEKIT_*` credentials are injected by the platform. Store `GROQ_API_KEY` as an agent secret:

```powershell
lk agent update-secrets --secrets "GROQ_API_KEY=your-groq-api-key"
```

### Where each value lives

| Value | Local agent (`/.env`) | GitHub Actions | Hosted agent | Vercel frontend |
| --- | --- | --- | --- | --- |
| `LIVEKIT_URL` | Yes | `LIVEKIT_URL` secret | Injected by LiveKit Cloud | Production env var |
| `LIVEKIT_API_KEY` | Yes | `LIVEKIT_API_KEY` secret | Injected by LiveKit Cloud | Production env var |
| `LIVEKIT_API_SECRET` | Yes | `LIVEKIT_API_SECRET` secret | Injected by LiveKit Cloud | Production env var |
| `GROQ_API_KEY` | Yes | `GROQ_API_KEY` secret | Agent secret, updated by deploy | Not used |

Local frontend credentials belong in `frontend/.env.local`; it is gitignored by `frontend/.gitignore`.

Never use `NEXT_PUBLIC_` for `LIVEKIT_API_SECRET` or `GROQ_API_KEY`. The browser must never receive either value.

---

## Backend agent

### Entrypoint

`agent.py:204` defines the `rtc_session` entrypoint:

- Validates that `GROQ_API_KEY` is present.
- Builds an `AgentSession` with Groq STT, Groq LLM, Groq TTS, Silero VAD, and turn handling.
- Starts the session with `Assistant()` and enables BVC noise cancellation on the audio input.
- Registers metric and state-change listeners.

The module is started with:

```python
if __name__ == "__main__":
    agents.cli.run_app(server)
```

`AgentServer` is created at `agent.py:199`.

### Session lifecycle

1. `AgentServer` registers the agent worker with LiveKit Cloud.
2. LiveKit dispatches a job when a participant joins a room.
3. `entrypoint` validates `GROQ_API_KEY`, builds one `AgentSession`, and starts it with `Assistant()`.
4. `Assistant.on_enter` blocks on `CollectConsent` until the caller answers.
5. Each caller turn is processed by VAD and the turn detector, then STT, LLM, and TTS.
6. Tool calls such as `escalate_to_manager` can replace the active agent inside the same session.
7. When the session ends, usage metrics are flushed and the worker returns to the ready state.

### Model pipeline

| Stage | Provider / model | Configuration |
| --- | --- | --- |
| STT | Groq `whisper-large-v3-turbo` | English, technical-support prompt for LiveKit/WebRTC/SIP terms (`agent.py:214`). |
| LLM | Groq `openai/gpt-oss-120b` | `temperature=0.4` (`agent.py:219`). |
| TTS | Groq `canopylabs/orpheus-v1-english` | Frontline voice `hannah` (`agent.py:223`); manager voice `troy` (`agent.py:151`). |
| VAD | Silero | `silero.VAD.load()` (`agent.py:226`). |
| Turn detection | LiveKit Inference turn detector | `inference.TurnDetector()` (`agent.py:228`). |
| Noise cancellation | LiveKit BVC | `noise_cancellation.BVC()` (`agent.py:285`). |

Turn handling is configured at `agent.py:227`:

- `endpointing.mode = "dynamic"` so the agent learns the caller's pause length.
- `min_delay = 0.6`, `max_delay = 4.0`.
- `preemptive_generation.preemptive_tts = False` to avoid unnecessary TTS work.

### Agents and workflows

**`CollectConsent`** (`agent.py:109`) is an `AgentTask[bool]`:

- `on_enter` introduces the agent and asks for recording consent.
- `consent_given()` completes with `True`.
- `consent_denied()` completes with `False`.
- `Assistant.on_enter` awaits the task and replies according to the result.

**`Assistant`** (`agent.py:167`) is the frontline agent:

- Handles general inquiries.
- Exposes `escalate_to_manager` (`agent.py:180`), which returns a `ManagerAgent` and a transfer message.
- Keeps replies short and voice-friendly: 1–3 sentences, under 200 characters per sentence, no markdown or lists.

**`ManagerAgent`** (`agent.py:138`) is the escalation target:

- Has its own persona and authority to offer refunds, credits, or accommodations.
- Uses a different Orpheus voice (`troy`) to distinguish it from the frontline agent.
- Its `on_enter` introduces itself and asks how it can help.

**Experimental checkout tasks** (`agent.py:52`–`agent.py:101`):

- `GetEmailTask` and `GetAddressTask` collect structured data via `AgentTask`.
- `CheckoutAgent` runs them in a `TaskGroup` and confirms the order.
- These are not wired into `entrypoint`; they are example/reference code.

**`transfer_to_human`** (`agent.py:26`):

- A placeholder SIP-transfer tool.
- It is not wired into any agent and calls `publish_sip_participant`, which is not a valid method on the current LiveKit participant API.
- Do not rely on it without replacing it with a supported SIP transfer flow.

### Metrics and observability

`agent.py:243` creates a `metrics.UsageCollector` and listens for `metrics_collected`:

- Every metric is logged with `metrics.log_metrics`.
- Usage is aggregated and printed at shutdown via `ctx.add_shutdown_callback(log_usage)`.
- EOU metrics are stored so `agent_state_changed` can log **time to first audio** when the agent starts speaking (`agent.py:270`).

### Privacy and media

- BVC noise cancellation is applied to the inbound audio track (`agent.py:283`).
- The agent does not store audio recordings in this repository.
- Consent is collected before the main conversation continues.

---

## Frontend

The frontend is a Next.js 16 App Router application using React 19 and LiveKit Components.

### Join flow

`frontend/src/app/page.tsx`:

1. Shows `PreJoin` until a session exists.
2. Calls `/api/token` with the sanitized room and display name.
3. Stores the returned token, server URL, room, identity, display name, and selected microphone.
4. Renders `LiveKitRoom` with the token and audio device settings.
5. Clears the session on disconnect or explicit leave.

`LiveKitRoom` is configured at `frontend/src/app/page.tsx:74` with:

- `connect`
- the selected microphone `deviceId`
- echo cancellation, noise suppression, and auto gain control
- disconnect/error/media-failure handlers

### Token endpoint

`frontend/src/app/api/token/route.ts`:

- Runs server-side only (`force-dynamic`).
- Requires `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.
- Sanitizes room names to `[A-Za-z0-9_-]{1,64}`.
- Truncates names to 48 characters and strips control characters.
- Generates a unique identity from the display name plus a random suffix.
- Creates an `AccessToken` with a **2-hour TTL**.
- Grants `roomJoin`, `canPublish`, `canSubscribe`, and `canPublishData`.
- Returns `{ token, serverUrl, room, identity }` with `Cache-Control: no-store`.

Request and response contract:

```http
GET /api/token?room=voice-demo&name=Alex
```

```json
{
  "token": "<short-lived-livekit-jwt>",
  "serverUrl": "wss://your-project.livekit.cloud",
  "room": "voice-demo",
  "identity": "alex-a1b2c3"
}
```

Failure contract:

```json
{ "error": "LiveKit credentials are not configured on the server." }
```

The failure response uses HTTP 500 and is returned only by the server route, never the browser bundle.

### Pre-join

`frontend/src/components/PreJoin.tsx`:

- Checks `window.isSecureContext` and shows an HTTPS warning if microphone access is unavailable.
- Enumerates audio input devices after requesting permission.
- Persists display name and room name in `localStorage`.
- Generates random room names (`voice-xxxxxxxx`).
- Provides a live microphone level meter using `useTrackVolume`.
- Copies an invite link for the current room.
- Disables joining when the page is insecure or the name is empty.

### In-room UI

`frontend/src/components/VoiceRoom.tsx` uses:

- `useVoiceAssistant` for agent state, audio track, and agent transcriptions.
- `useTranscriptions` for stream-level transcript segments.
- `useChat` for text messages.
- `useLocalParticipant` for microphone state and track.
- `useConnectionQualityIndicator` for connection quality.
- `useMediaDeviceSelect` for microphone and speaker switching.
- `RoomAudioRenderer` for agent audio playback with volume and mute.

Key behaviors:

- **Transcript tab**: merges transcript streams and attributes them to the local user or agent using `lk.transcribed_track_id` (`VoiceRoom.tsx:199`).
- **Agent reply merge**: uses `agentTranscriptions` as the canonical agent text, then adds transcript stream items that do not overlap (`VoiceRoom.tsx:234`).
- **Chat tab**: merges `useChat` messages, local spoken transcripts, and agent replies into one chronological list (`VoiceRoom.tsx:274`).
- **Mute**: toggles the local microphone (`VoiceRoom.tsx:130`).
- **Push-to-talk**: hold **Space** to open the microphone and release to close it (`VoiceRoom.tsx:138`).
- **Keyboard shortcuts**: **M** toggles the microphone, **Escape** closes settings.
- **Audio settings**: microphone, speaker (when supported), output volume, and agent mute (`VoiceRoom.tsx:634`).
- **Transcript tools**: copy or download the transcript.
- **Agent state**: displays Listening, Thinking, Speaking, Connecting, Offline, etc.
- **Playback unlock**: shows an “Enable audio playback” button if the browser blocks autoplay.

Styling is custom CSS in `frontend/src/app/globals.css`; the project does not use Tailwind.

### Data and persistence

- There is no application database.
- Display name and room name are stored in browser `localStorage`.
- Transcript and chat state live in browser memory; they are lost on refresh or leave.
- The agent does not write audio recordings to disk or object storage.
- LiveKit rooms are ephemeral; tokens expire after 2 hours.
- Agent usage metrics are logged, not persisted by this repository.

### Branding and favicon

The production brand is **Technical Help Voicebot**.

- `frontend/public/voicebot-icon.png` is the shared 512x512 brand mark. Generated favicon assets in the same folder: `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `favicon-48x48.png`, and `apple-touch-icon.png`.
- `frontend/src/app/layout.tsx` sets the browser tab title, description, Open Graph/Twitter metadata, and favicon links to these assets.
- `frontend/src/components/PreJoin.tsx` uses the icon in the join-screen brand and updates the support-focused headline, feature list, room labels, and call-to-action text.
- `frontend/src/components/VoiceRoom.tsx` uses the same icon in the in-room header.

To replace the brand mark, update `voicebot-icon.png` and regenerate the favicon assets; the browser tab and both UI placements follow automatically.

---

## Models and provider limits

### Groq free plan

The agent is designed around Groq's free-plan limits:

| Stage | Model | Free-plan limits |
| --- | --- | --- |
| LLM | `openai/gpt-oss-120b` | 30 RPM, 1K RPD, 8K TPM, 200K TPD |
| STT | `whisper-large-v3-turbo` | 20 RPM, 2K RPD, 7.2K audio seconds/hour, 28.8K audio seconds/day |
| TTS | `canopylabs/orpheus-v1-english` | 10 RPM, 100 requests/day, 1.2K TPM |

Orpheus TTS constraints:

- Maximum **200 characters per request**.
- English voices: `autumn`, `diana`, `hannah`, `austin`, `daniel`, `troy`.
- A one-time **model terms acceptance** is required by the Groq organisation admin.
- The agent prompts are intentionally short to stay under the character limit and reduce TTS request count.

If the TTS limit is exceeded, the API returns a rate-limit error and the agent cannot speak until the limit resets.

### Why Groq for everything?

LiveKit Inference credits were exhausted, and Gemini TTS required a paid Google Cloud billing account. The agent was moved to direct Groq keys to keep the stack simple and free-plan friendly:

- One provider and one API key.
- Groq STT, LLM, and TTS all speak the same OpenAI-compatible API.
- No MCP tools are attached to the LLM, which keeps request tokens low on the 8K TPM free limit.

The only remaining LiveKit Inference component is the turn detector, which is used for end-of-utterance detection.

---

## Local development

### Agent

```powershell
uv sync
uv run python -m py_compile agent.py
uv run agent.py dev
```

Other useful modes:

```powershell
# Voice console with a local agent
lk agent console

# Scripted text conversation
lk agent debugger start
lk agent debugger say "yes"
lk agent debugger say "Can I speak to a manager?"
lk agent debugger logs
lk agent debugger stop
```

### Frontend

```powershell
cd frontend
npm ci
npm run dev
```

If you open the frontend from another device on your LAN, browsers require HTTPS for microphone access:

```powershell
npm run dev:https
```

Alternatively, open `http://localhost:3000` on the same machine.

### Build checks

```powershell
uv lock --check
uv run python -m py_compile agent.py

cd frontend
npm run build
```

---

## Testing and verification

### Automated checks

The agent workflow runs:

```powershell
uv lock --check
uv sync --locked
uv run python -m py_compile agent.py
```

The frontend workflow runs:

```powershell
cd frontend
npm ci --no-audit --no-fund
npm run build
```

`npm run build` includes Next.js compilation and TypeScript checking.

### Text-only agent test

```powershell
uv run agent.py dev
```

In another terminal:

```powershell
lk agent debugger start
lk agent debugger say "yes"
lk agent debugger say "My internet keeps dropping. Can you help?"
lk agent debugger say "Can I speak to a manager?"
lk agent debugger logs
lk agent debugger stop
```

Expected behavior:

1. The agent asks for consent.
2. After consent, it gives a short answer.
3. Asking for a manager transfers to `ManagerAgent`.

### Voice test

```powershell
lk agent console
```

Speak into the microphone and verify that the agent responds with audio, the transcript updates, and the agent can be interrupted.

### Test matrix

| Area | Test | Expected result |
| --- | --- | --- |
| Consent | Say “yes” | Consent task completes and the assistant proceeds. |
| Consent | Say “no” | The agent acknowledges and continues without recording. |
| STT | Ask a technical question | Transcript accurately captures LiveKit/WebRTC terms. |
| LLM | Ask a general support question | Short, conversational reply under the voice-style limits. |
| TTS | Listen to a reply | `hannah` voice, no truncation, no rate-limit error. |
| Handoff | Ask for a manager | `ManagerAgent` speaks with the `troy` voice. |
| Barge-in | Interrupt while the agent is speaking | Agent stops or adapts and listens again. |
| Mute | Press `M` or the mute button | Local microphone stops publishing. |
| Push-to-talk | Hold `Space` | Microphone opens only while held. |
| Chat | Send a text message | Message appears in the chat panel and reaches the agent. |
| Transcript | Copy/download transcript | Combined transcript is exported. |
| Tokens | Open `/api/token` without credentials | Returns a clear server error, not a secret. |

### Production verification

Run these checks after a deployment:

```powershell
lk agent status
lk agent logs
```

Then:

1. Open the Vercel deployment.
2. Join a room with a microphone.
3. Accept or decline consent.
4. Speak one short sentence and confirm audio + transcript.
5. Ask for a manager and confirm the handoff.
6. Open the GitHub Actions run and confirm both workflows are green.
7. Open the Vercel deployment and confirm the latest status is `Ready`.

---

## CI/CD

### Delivery model

This project uses two deployment mechanisms:

| Component | CI | CD |
| --- | --- | --- |
| Python agent | GitHub Actions (`agent.yml`) | GitHub Actions runs `lk agent deploy` on `main`. |
| Next.js frontend | GitHub Actions (`frontend.yml`) | Vercel's GitHub integration deploys on `main`. |

Vercel is used for frontend CD because it is already connected to the repository and provides preview deployments for pull requests. The agent uses GitHub Actions because LiveKit Cloud has no equivalent native GitHub deployment integration.

### End-to-end CI/CD flow

```text
git push / pull request
        │
        ├── agent paths ──▶ Agent CI/CD
        │                      ├─ uv lock --check
        │                      ├─ uv sync --locked
        │                      ├─ py_compile agent.py
        │                      └─ on main: lk agent deploy → LiveKit Cloud
        │
        └── frontend paths ─▶ Frontend CI
                               ├─ npm ci
                               └─ npm run build

git push to main + frontend paths
        └──▶ Vercel GitHub integration
                ├─ Root Directory: frontend
                ├─ npm ci
                ├─ npm run build
                └─ production deployment
```

### Path filters

| Workflow | Runs when these paths change |
| --- | --- |
| `agent.yml` | `agent.py`, `pyproject.toml`, `uv.lock`, `Dockerfile`, `livekit.toml`, `.github/workflows/agent.yml` |
| `frontend.yml` | `frontend/**`, `.github/workflows/frontend.yml` |

Consequences:

- Agent-only changes do not rebuild the frontend.
- Frontend-only changes do not deploy the agent.
- Documentation-only changes do not trigger either workflow.
- Both workflows can be started manually from the GitHub **Actions** tab.

### Trigger matrix

| Event | Agent workflow | Frontend workflow | Vercel |
| --- | --- | --- | --- |
| Pull request touching agent files | Test only | Not triggered | Preview if frontend files changed |
| Pull request touching `frontend/**` | Not triggered | Build only | Preview deployment |
| Push to `main` touching agent files | Test + deploy | Not triggered | Not triggered |
| Push to `main` touching `frontend/**` | Not triggered | Build | Production deployment |
| `workflow_dispatch` | Test + deploy | Build | Existing Vercel integration still applies |
| Docs-only change | Not triggered | Not triggered | Not triggered |

### Agent workflow details

`.github/workflows/agent.yml`:

1. Checks out the repository.
2. Installs `uv` **0.12.18** and caches based on `uv.lock`.
3. Runs `uv lock --check`.
4. Runs `uv sync --locked`.
5. Runs `uv run python -m py_compile agent.py`.
6. On `main` or manual dispatch, installs LiveKit CLI **2.19.4**.
7. Runs `lk agent deploy --yes --secrets "GROQ_API_KEY=..."`.
8. Runs `lk agent status` to confirm the deployment.

The deploy job uses the GitHub `production` environment and a `agent-deploy-production` concurrency group. Two agent deploys cannot overlap.

### Frontend workflow details

`.github/workflows/frontend.yml`:

1. Checks out the repository.
2. Sets up Node.js **24** with npm caching.
3. Runs `npm ci --no-audit --no-fund` in `frontend/`.
4. Runs `npm run build` in `frontend/`.

The workflow is CI only. Vercel performs the actual deployment when the same push reaches GitHub.

### Required GitHub secrets

Add these in **Settings → Secrets and variables → Actions**. You can also scope them to the `production` environment.

| Secret | Used by | Purpose |
| --- | --- | --- |
| `LIVEKIT_URL` | Agent workflow | LiveKit Cloud WebSocket URL for the `lk` CLI, e.g. `wss://your-project.livekit.cloud`. |
| `LIVEKIT_API_KEY` | Agent workflow | LiveKit API key for deploying the agent. |
| `LIVEKIT_API_SECRET` | Agent workflow | LiveKit API secret for deploying the agent. |
| `GROQ_API_KEY` | Agent workflow | Passed to `lk agent deploy --secrets` so the hosted agent has the Groq key. |

`GROQ_API_KEY` is written to the agent secrets on every agent deploy. The LiveKit credentials are used only by the CLI; LiveKit Cloud injects the runtime LiveKit credentials into the agent.

### Vercel project settings

The Vercel project is connected to this GitHub repository.

| Setting | Value |
| --- | --- |
| Project | `technical-help-voicebot` |
| Root Directory | `frontend` |
| Framework | Next.js |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output | Next.js default (`.next`) |
| Production branch | `main` |

The Root Directory must be `frontend`; otherwise Vercel tries to build the repository root and fails because the Next.js app is in `frontend/`.

Set the frontend runtime environment variables in Vercel for Production (and Preview if needed):

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

No `VERCEL_TOKEN` is required for this flow. If you later want GitHub Actions to deploy Vercel as well, add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`, then add a CLI deploy job. The org and project IDs are stored in `frontend/.vercel/project.json` locally and that file is gitignored.

### Manual deployment

Agent: run **Actions → Agent CI/CD → Run workflow**, or run:

```powershell
lk agent deploy --yes
```

Frontend: push to `main` and let Vercel deploy, or run:

```powershell
cd frontend
npx vercel --prod
```

### Rollback

Agent:

```powershell
lk agent versions
lk agent rollback
```

Vercel:

1. Open **Deployments**.
2. Select the previous healthy deployment.
3. Use **Promote to Production** or **Redeploy**.

Code:

```powershell
git revert <commit>
git push origin main
```

A revert triggers the same path-filtered CI/CD flow as any other commit.

### Recommended repository protection

For production use, enable these GitHub branch protection rules on `main`:

- Require pull requests before merging.
- Require the `Agent CI/CD / Validate agent` and `Frontend CI / Build frontend` checks.
- Require branches to be up to date before merging.
- Restrict who can push to `main`.

These settings are not required for the current single-maintainer workflow, but they prevent untested changes from reaching production.

## Deployment details

### Agent deployment mechanics

Run the deployment from the repository root, not from `frontend/`:

```powershell
lk agent deploy --yes
```

The `lk` CLI:

1. Reads the project subdomain and agent ID from `livekit.toml`.
2. Packages the repository root as the build context.
3. Builds the `Dockerfile` on LiveKit Cloud.
4. Injects the `GROQ_API_KEY` secret passed by the workflow.
5. Creates a new agent version and promotes it to the `production` deployment.
6. Starts one replica and reports it as `Running`.

The production image:

- Uses Python 3.14 on `python3.14-bookworm-slim`.
- Installs dependencies with `uv sync --locked` (`Dockerfile:47`).
- Pre-downloads plugin models with `livekit.agents download-files` (`Dockerfile:53`).
- Excludes `frontend/` from the build context via `.dockerignore`.
- Runs as the non-root `appuser` (`Dockerfile:83`).
- Starts with `uv run agent.py start` (`Dockerfile:88`).

Agent runtime credentials:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are injected by LiveKit Cloud.
- `GROQ_API_KEY` is an agent secret, updated by the deploy workflow.
- No `.env` file is shipped in the image; `.dockerignore` excludes it.

Useful deployment commands:

```powershell
lk agent status
lk agent secrets
lk agent logs
lk agent versions
lk agent rollback
```

### Frontend deployment mechanics

Vercel builds and deploys the frontend from `frontend/`.

| Step | Value |
| --- | --- |
| Trigger | Push to `main` that changes `frontend/**` |
| Root Directory | `frontend` |
| Install | `npm ci` |
| Build | `npm run build` |
| Output | Next.js default output |
| Node.js | 24 |
| Framework | Next.js 16 |

The frontend server route needs these Vercel environment variables:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

These are read only by `/api/token`. Do not expose `LIVEKIT_API_SECRET` to the browser and do not prefix it with `NEXT_PUBLIC_`.

Vercel creates a deployment status on the GitHub commit. A successful production deployment is visible as a green **Vercel** check on `main`.

---

## Operations runbook

### Agent secrets

List secrets:

```powershell
lk agent secrets
```

Update or add a secret:

```powershell
lk agent update-secrets --secrets "GROQ_API_KEY=your-groq-api-key"
```

Replace all existing secrets with only the required one:

```powershell
lk agent update-secrets --overwrite --yes --secrets "GROQ_API_KEY=your-groq-api-key"
```

The GitHub Actions deploy workflow also writes `GROQ_API_KEY` on each deploy, so the secret and the workflow secret should stay in sync.

### Agent status and logs

```powershell
lk agent status
lk agent logs
```

The agent logs:

- Per-metric values from `metrics.log_metrics`.
- A usage summary at shutdown.
- Time to first audio when the agent starts speaking.
- Startup and provider errors.

### Frontend status

1. Open the Vercel project.
2. Check **Deployments** for the latest production deployment.
3. Confirm the deployment is **Ready**.
4. Check the GitHub commit shows a green **Vercel** status.

### GitHub Actions status

```powershell
gh run list --limit 10
gh run view <run-id> --log-failed
```

Workflow names:

- `Agent CI/CD`
- `Frontend CI`

### Key rotation

If a key is exposed:

1. Rotate it at the provider (LiveKit or Groq).
2. Update the local `.env`.
3. Update GitHub Actions secrets:

```powershell
gh secret set GROQ_API_KEY
gh secret set LIVEKIT_API_KEY
gh secret set LIVEKIT_API_SECRET
```

4. Update the hosted agent secret:

```powershell
lk agent update-secrets --overwrite --yes --secrets "GROQ_API_KEY=..."
```

5. Update the Vercel environment variables for `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.
6. Redeploy the agent and frontend.
7. Revoke the old key.

### Incident checklist

1. Check `lk agent status`; confirm the agent is `Running`.
2. Check `lk agent logs` for provider errors, rate limits, or missing secrets.
3. Check the latest GitHub Actions runs.
4. Check the latest Vercel deployment.
5. Test `/api/token` directly; a 500 means the frontend environment variables are missing.
6. Join a test room and verify consent, audio, transcript, and handoff.
7. If a deploy caused the incident, roll back with `lk agent rollback` or Vercel **Promote to Production**.

### Project configuration

`livekit.toml` stores the LiveKit project subdomain and agent ID used by the CLI. If you deploy to a different project, update this file or pass `--project` / `--subdomain` to `lk`.

---

## Command cheat sheet

| Goal | Command |
| --- | --- |
| Install Python deps | `uv sync --locked` |
| Verify lock file | `uv lock --check` |
| Compile agent | `uv run python -m py_compile agent.py` |
| Run local agent | `uv run agent.py dev` |
| Text-only test | `lk agent debugger start` |
| Voice test | `lk agent console` |
| Deploy agent | `lk agent deploy --yes` |
| Agent status | `lk agent status` |
| Agent logs | `lk agent logs` |
| Agent versions | `lk agent versions` |
| Roll back agent | `lk agent rollback` |
| List agent secrets | `lk agent secrets` |
| Update agent secret | `lk agent update-secrets --secrets "GROQ_API_KEY=..."` |
| Install frontend deps | `cd frontend; npm ci` |
| Run frontend | `cd frontend; npm run dev` |
| Build frontend | `cd frontend; npm run build` |
| Deploy frontend manually | `cd frontend; npx vercel --prod` |
| List GitHub runs | `gh run list --limit 10` |
| View failed logs | `gh run view <run-id> --log-failed` |
| Update GitHub secret | `gh secret set <NAME>` |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `400 model_terms_required` | Groq Orpheus terms not accepted for the org | Org admin accepts the terms in the Groq playground for `canopylabs/orpheus-v1-english`. |
| `429` on LLM requests | Groq free TPM limit exceeded | Shorten replies, remove tools/MCP, wait for the minute to reset. |
| `400` from TTS with a long input | Orpheus 200-character limit | Keep agent replies short; split long text before synthesis. |
| `400` / `403` from Google Gemini TTS | Old Gemini configuration / no billing | This project no longer uses Gemini; ensure `google` is not in `pyproject.toml` and no Gemini TTS is constructed. |
| `lk agent deploy` says it detected Node | Command run from `frontend/` | Run `lk agent deploy` from the repository root. |
| Microphone access blocked | Page served over plain HTTP on a LAN IP | Use `http://localhost:3000` or `npm run dev:https`. |
| Agent joins but no audio | Browser autoplay blocked | Click “Enable audio playback”; check the output volume and agent mute state. |
| Token endpoint returns 500 | Frontend LiveKit env vars missing | Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` on the frontend server. |
| Agent not dispatched | Agent worker not running or wrong project | Start `uv run agent.py dev` or deploy with `lk agent deploy`; check `lk agent status`. |
| Transcripts missing | Browser permission, STT failure, or agent not publishing transcriptions | Check agent logs and browser console; confirm `useTranscriptions` is receiving events. |
| Vercel build fails after the monorepo move | Vercel **Root Directory** is not `frontend` | Set Root Directory to `frontend` in Vercel project settings and redeploy. |
| Vercel deploys but `/api/token` returns 500 | LiveKit env vars are missing in Vercel | Add `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` to the Vercel project. |
| GitHub Actions agent deploy says `no projects configured` | GitHub Actions secrets are missing | Add `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `GROQ_API_KEY` secrets. |
| Agent deploy succeeded but behavior is unchanged | The deploy ran on a different path or version | Check `lk agent status`, the Actions run, and the deployed version. |
| Frontend did not deploy on a docs-only change | Path filters intentionally skip docs | Trigger a manual deployment if needed. |

---

## Known limitations and cleanup opportunities

- The consent prompt asks for permission to record, but no recording/egress pipeline is implemented. Add LiveKit Egress or reword the consent prompt to match the actual behaviour.
- `transfer_to_human` (`agent.py:26`) is an unused placeholder and calls an unsupported SIP method. Implement SIP transfer with the current LiveKit SIP API before exposing it.
- `CheckoutAgent`, `GetEmailTask`, and `GetAddressTask` are example workflows and are not connected to the main entrypoint.
- `agent.py` contains duplicate imports and an unused `httpx` import; these can be removed.
- `endpointing.max_delay` is `4.0` seconds; tune it for the desired latency versus turn-completeness tradeoff.
- `.env` is plaintext and local-only. Use LiveKit agent secrets for hosted deployments and rotate any key that has appeared in logs.
- There is no automated end-to-end test suite; CI validates compilation and the production build, while voice behavior is verified with the debugger, agent console, and manual production checks.

---

## Security notes

- Never commit `.env` or any file containing API keys.
- `frontend/.env.local` is gitignored and must remain local.
- The GitHub repository is currently public. If the agent code or project metadata should not be public, change repository visibility or move the monorepo to a private repository before pushing.
- `LIVEKIT_API_SECRET` must remain server-side; the browser only receives a short-lived room JWT.
- Tokens are scoped to one room, expire after 2 hours, and grant only publish/subscribe/data permissions.
- Room names and display names are sanitized before token creation.
- Rotate any API key that has been pasted into logs, screenshots, or chat.
- Prefer `lk agent update-secrets` over baking secrets into the image or source files.
- GitHub Actions secrets are the only deployment credentials stored in GitHub.
- Vercel environment variables are server-side and are not exposed through `NEXT_PUBLIC_`.
- The agent image excludes `.env` through `.dockerignore`, and `GROQ_API_KEY` is injected as an agent secret.
- The response from `/api/token` is marked `no-store` to avoid caching tokens.

---

## License

No license is specified for this repository.
