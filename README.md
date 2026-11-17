# LiveKit Voice Agent

A real-time customer-support voice agent built with **LiveKit Agents** (Python) and a **Next.js** web client. The browser joins a LiveKit room, the agent is dispatched automatically, and the conversation runs through a speech-to-text, LLM, and text-to-speech pipeline with live transcripts, text chat, microphone controls, and agent handoff.

The agent currently uses **Groq** for all three model stages (STT, LLM, TTS), so a single `GROQ_API_KEY` is enough.

---

## Table of contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Backend agent](#backend-agent)
- [Frontend](#frontend)
- [Models and provider limits](#models-and-provider-limits)
- [Local development](#local-development)
- [CI/CD](#cicd)
- [Deployment](#deployment)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Known limitations and cleanup opportunities](#known-limitations-and-cleanup-opportunities)
- [Security notes](#security-notes)

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
| `frontend/src/app/api/token/route.ts` | Server-only LiveKit token endpoint. |
| `frontend/src/components/PreJoin.tsx` | Name, room, microphone selection, mic test, invite link. |
| `frontend/src/components/VoiceRoom.tsx` | In-room UI: transcript, chat, audio controls, handoff display. |
| `.github/workflows/agent.yml` | Agent CI and LiveKit Cloud deployment. |
| `.github/workflows/frontend.yml` | Frontend CI and Vercel deployment. |

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
npm install
npm run dev
```

Open `http://localhost:3000`, choose a microphone, and join a room. The agent joins automatically.

For a text-only smoke test without a microphone:

```powershell
lk agent debugger start
lk agent debugger say "yes"
lk agent debugger say "My internet keeps dropping. Can you help?"
lk agent debugger stop
```

---

## Environment variables

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
npm install
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

## CI/CD

GitHub Actions workflows live in `.github/workflows/`:

| Workflow | Triggers | What it does |
| --- | --- | --- |
| `agent.yml` | Pull requests and pushes touching agent files; manual dispatch | Runs `uv lock --check`, `uv sync --locked`, and `py_compile`; on `main` it deploys to LiveKit Cloud with `lk agent deploy`. |
| `frontend.yml` | Pull requests and pushes touching `frontend/**`; manual dispatch | Runs `npm ci` and `npm run build`. Deployment is handled by Vercel's GitHub integration on merge to `main`. |

The agent deploy job runs only for pushes to `main` or manual dispatches, uses the GitHub `production` environment, and is serialized with a concurrency group.

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

The Vercel project is connected to this GitHub repository. Because the frontend now lives in `frontend/`, set the Vercel project's **Root Directory** to `frontend`. If this is not updated, Vercel's Git deployment fails.

Vercel deploys the frontend automatically on pushes to `main`. No `VERCEL_TOKEN` is required for this flow. If you later want GitHub Actions to deploy Vercel as well, add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`, then restore a CLI deploy job; the org and project IDs are stored in `frontend/.vercel/project.json` locally and that file is gitignored.

Set the frontend runtime environment variables in Vercel for Production (and Preview if needed):

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

### Manual deployment

Agent: run **Actions → Agent CI/CD → Run workflow**, or run `lk agent deploy --yes` locally.

Frontend: push to `main` and let Vercel deploy, or run:

```powershell
cd frontend
npx vercel --prod
```

## Deployment

### Agent (LiveKit Cloud)

Run the deployment from the repository root, not from `frontend/`:

```powershell
lk agent deploy --yes
```

The `lk` CLI detects the Python/uv project from `livekit.toml` and builds the `Dockerfile`.

Useful deployment commands:

```powershell
lk agent status
lk agent secrets
lk agent logs
lk agent versions
lk agent rollback
```

The production image:

- Uses Python 3.14 on `python3.14-bookworm-slim`.
- Installs dependencies with `uv sync --locked` (`Dockerfile:47`).
- Pre-downloads plugin models with `livekit.agents download-files` (`Dockerfile:53`).
- Runs as the non-root `appuser` (`Dockerfile:83`).
- Starts with `uv run agent.py start` (`Dockerfile:88`).

### Frontend (Vercel or similar)

Set these server-side environment variables in the hosting project:

```dotenv
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

Build command: `npm run build`  
Output: standard Next.js output.

Do not expose `LIVEKIT_API_SECRET` to the browser.

---

## Operations

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

### Logs and status

```powershell
lk agent status
lk agent logs
```

The agent also logs usage summaries and time-to-first-audio in the process logs.

### Project configuration

`livekit.toml` stores the LiveKit project subdomain and agent ID used by the CLI. If you deploy to a different project, update this file or pass `--project` / `--subdomain` to `lk`.

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

---

## Known limitations and cleanup opportunities

- The consent prompt asks for permission to record, but no recording/egress pipeline is implemented. Add LiveKit Egress or reword the consent prompt to match the actual behaviour.
- `transfer_to_human` (`agent.py:26`) is an unused placeholder and calls an unsupported SIP method. Implement SIP transfer with the current LiveKit SIP API before exposing it.
- `CheckoutAgent`, `GetEmailTask`, and `GetAddressTask` are example workflows and are not connected to the main entrypoint.
- `agent.py` contains duplicate imports and an unused `httpx` import; these can be removed.
- `endpointing.max_delay` is `4.0` seconds; tune it for the desired latency versus turn-completeness tradeoff.
- `.env` is plaintext and local-only. Use LiveKit agent secrets for hosted deployments and rotate any key that has appeared in logs.
- There is no automated test suite in the repository; verification is currently done with the debugger, the agent console, and `npm run build`.

---

## Security notes

- Never commit `.env` or any file containing API keys.
- The GitHub repository is currently public. If the agent code or project metadata should not be public, change repository visibility or move the monorepo to a private repository before pushing.
- `LIVEKIT_API_SECRET` must remain server-side; the browser only receives a short-lived room JWT.
- Tokens are scoped to one room, expire after 2 hours, and grant only publish/subscribe/data permissions.
- Room names and display names are sanitized before token creation.
- Rotate any API key that has been pasted into logs, screenshots, or chat.
- Prefer `lk agent update-secrets` over baking secrets into the image or source files.
- The response from `/api/token` is marked `no-store` to avoid caching tokens.

---

## License

No license is specified for this repository.
