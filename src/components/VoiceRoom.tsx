'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  BarVisualizer,
  RoomAudioRenderer,
  useAudioPlayback,
  useChat,
  useConnectionQualityIndicator,
  useConnectionState,
  useLocalParticipant,
  useMediaDeviceSelect,
  useRoomContext,
  useTrackVolume,
  useTranscriptions,
  useVoiceAssistant,
  type TrackReference,
} from '@livekit/components-react';
import {
  ConnectionQuality,
  ConnectionState,
  supportsAudioOutputSelection,
  Track,
} from 'livekit-client';

type VoiceRoomProps = {
  roomName: string;
  displayName: string;
  connectionError: string | null;
  onDismissError: () => void;
  onLeave: () => void;
};

const STATE_LABELS: Record<string, string> = {
  'pre-connect-buffering': 'Listening',
  connecting: 'Connecting',
  initializing: 'Starting up',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  disconnected: 'Offline',
  failed: 'Connection failed',
};

const QUALITY_LABELS: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: 'Excellent',
  [ConnectionQuality.Good]: 'Good',
  [ConnectionQuality.Poor]: 'Poor',
  [ConnectionQuality.Lost]: 'Lost',
  [ConnectionQuality.Unknown]: 'Unknown',
};

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function VoiceRoom({
  roomName,
  displayName,
  connectionError,
  onDismissError,
  onLeave,
}: VoiceRoomProps) {
  const room = useRoomContext();
  const connectionState = useConnectionState(room);
  const { localParticipant, isMicrophoneEnabled, microphoneTrack } = useLocalParticipant();
  const { agent, state, audioTrack, agentTranscriptions } = useVoiceAssistant();
  const { canPlayAudio, startAudio } = useAudioPlayback(room);
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  const transcriptions = useTranscriptions();
  const { chatMessages, send, isSending } = useChat();

  const [panel, setPanel] = useState<'transcript' | 'chat'>('transcript');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [agentMuted, setAgentMuted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState('');
  const [pttActive, setPttActive] = useState(false);
  const [waitedLong, setWaitedLong] = useState(false);

  const pttHeld = useRef(false);
  const pttWasEnabled = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? null : current));
    }, 2200);
  }, []);

  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (agent) {
      setWaitedLong(false);
      return;
    }
    const id = window.setTimeout(() => setWaitedLong(true), 20000);
    return () => window.clearTimeout(id);
  }, [agent]);

  const copyInvite = useCallback(async () => {
    const link = `${window.location.origin}/?room=${encodeURIComponent(roomName)}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      flash('Invite link copied');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      flash('Could not copy the invite link');
    }
  }, [flash, roomName]);

  const toggleMic = useCallback(async () => {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch {
      flash('Could not change the microphone state');
    }
  }, [flash, isMicrophoneEnabled, localParticipant]);

  const startPtt = useCallback(async () => {
    if (pttHeld.current) return;
    pttHeld.current = true;
    pttWasEnabled.current = isMicrophoneEnabled;
    setPttActive(true);
    if (!isMicrophoneEnabled) {
      try {
        await localParticipant.setMicrophoneEnabled(true);
      } catch {
        flash('Could not open the microphone');
      }
    }
  }, [flash, isMicrophoneEnabled, localParticipant]);

  const endPtt = useCallback(async () => {
    if (!pttHeld.current) return;
    pttHeld.current = false;
    setPttActive(false);
    if (!pttWasEnabled.current) {
      try {
        await localParticipant.setMicrophoneEnabled(false);
      } catch {
        /* the track may already be gone */
      }
    }
  }, [localParticipant]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (!event.repeat) void startPtt();
      } else if (event.key.toLowerCase() === 'm' && !event.repeat) {
        event.preventDefault();
        void toggleMic();
      } else if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') void endPtt();
    };

    const onBlur = () => void endPtt();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [endPtt, startPtt, toggleMic]);

  const transcriptItems = useMemo(() => {
    const byStream = new Map<string, { id: string; identity: string; text: string; timestamp: number }>();
    for (const item of transcriptions) {
      const text = item.text?.trim();
      if (!text) continue;
      byStream.set(item.streamInfo.id, {
        id: item.streamInfo.id,
        identity: item.participantInfo.identity,
        text,
        timestamp: item.streamInfo.timestamp,
      });
    }
    return [...byStream.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [transcriptions]);

  const labelFor = useCallback(
    (identity: string) => {
      if (identity === localParticipant.identity) return displayName || 'You';
      if (agent && agent.identity === identity) return agent.name || 'AI agent';
      return identity;
    },
    [agent, displayName, localParticipant.identity],
  );

  const agentReplyItems = useMemo(() => {
    const bySegment = new Map<string, { id: string; text: string; timestamp: number }>();
    for (const segment of agentTranscriptions) {
      const text = segment.text?.trim();
      if (!text) continue;
      bySegment.set(segment.id, {
        id: `voice-${segment.id}`,
        text,
        timestamp: segment.receivedAt,
      });
    }
    return [...bySegment.values()];
  }, [agentTranscriptions]);

  const chatItems = useMemo(() => {
    const items: Array<{
      id: string;
      identity: string;
      name: string;
      text: string;
      timestamp: number;
    }> = [];

    for (const message of chatMessages) {
      items.push({
        id: `chat-${message.id}`,
        identity: message.from?.identity ?? 'agent',
        name:
          message.from?.identity === localParticipant.identity
            ? displayName || 'You'
            : message.from?.name || 'AI agent',
        text: message.message,
        timestamp: message.timestamp,
      });
    }

    for (const reply of agentReplyItems) {
      items.push({
        id: reply.id,
        identity: agent?.identity ?? 'agent',
        name: agent?.name || 'AI agent',
        text: reply.text,
        timestamp: reply.timestamp,
      });
    }

    return items.sort((a, b) => a.timestamp - b.timestamp);
  }, [agent, agentReplyItems, chatMessages, displayName, localParticipant.identity]);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [transcriptItems.length, panel]);

  useEffect(() => {
    const element = chatRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chatItems.length, panel]);

  const copyTranscript = useCallback(async () => {
    const text =
      transcriptItems.map((item) => `${labelFor(item.identity)}: ${item.text}`).join('\n') || 'No transcript yet.';
    try {
      await navigator.clipboard.writeText(text);
      flash('Transcript copied');
    } catch {
      flash('Could not copy the transcript');
    }
  }, [flash, labelFor, transcriptItems]);

  const downloadTranscript = useCallback(() => {
    const text =
      transcriptItems.map((item) => `${labelFor(item.identity)}: ${item.text}`).join('\n') || 'No transcript yet.';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${roomName}-transcript.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [labelFor, roomName, transcriptItems]);

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isSending) return;
    setDraft('');
    try {
      await send(text);
    } catch {
      setDraft(text);
      flash('Could not send the message');
    }
  };

  const micTrackRef = useMemo<TrackReference | undefined>(() => {
    if (!microphoneTrack) return undefined;
    return {
      participant: localParticipant,
      publication: microphoneTrack,
      source: Track.Source.Microphone,
    };
  }, [localParticipant, microphoneTrack]);

  const stateLabel = STATE_LABELS[state] ?? state;
  const qualityLabel = QUALITY_LABELS[quality] ?? 'Unknown';
  const reconnecting =
    connectionState === ConnectionState.Reconnecting || connectionState === ConnectionState.SignalReconnecting;

  return (
    <div className="room-shell lk-theme">
      <RoomAudioRenderer volume={volume} muted={agentMuted} />

      <header className="room-header">
        <div className="room-title">
          <span className="brand-mark" aria-hidden />
          <div>
            <strong>{roomName}</strong>
            <span className="subtle">
              {displayName} · {formatDuration(elapsed)}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <span className={`quality ${quality}`} title={`Connection quality: ${qualityLabel}`}>
            {qualityLabel}
          </span>
          <button type="button" className="btn ghost" onClick={() => void copyInvite()}>
            {copied ? 'Copied' : 'Invite'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setSettingsOpen(true)}>
            Audio
          </button>
          <button type="button" className="btn danger" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      <main className="room-main">
        <section className="stage">
          {reconnecting ? <div className="banner warn">Reconnecting to the room…</div> : null}
          {connectionError ? (
            <div className="banner error">
              <span>{connectionError}</span>
              <button type="button" onClick={onDismissError}>
                Dismiss
              </button>
            </div>
          ) : null}

          <div className="orb" data-state={state}>
            <div className="orb-ring" aria-hidden />
            <div className="orb-core">
              <BarVisualizer
                state={state}
                track={audioTrack}
                barCount={9}
                options={{ minHeight: 10, maxHeight: 100 }}
                className="orb-bars"
              />
            </div>
          </div>

          <div className="agent-meta">
            <span className={`agent-state ${state}`}>{stateLabel}</span>
            <span className="subtle">
              {agent
                ? agent.name || 'AI agent'
                : waitedLong
                  ? 'Still waiting for the agent to join…'
                  : 'Waiting for the agent to join…'}
            </span>
          </div>

          <MicMeter trackRef={micTrackRef} muted={!isMicrophoneEnabled} />

          {!canPlayAudio ? (
            <button type="button" className="audio-unlock" onClick={() => void startAudio()}>
              Enable audio playback
            </button>
          ) : null}
        </section>

        <aside className="side-panel">
          <div className="tabs" role="tablist" aria-label="Conversation views">
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'transcript'}
              onClick={() => setPanel('transcript')}
            >
              Transcript
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'chat'}
              onClick={() => setPanel('chat')}
            >
              Chat
            </button>
            <span className="spacer" />
            {panel === 'transcript' ? (
              <>
                <button
                  type="button"
                  className="mini"
                  onClick={() => void copyTranscript()}
                  disabled={transcriptItems.length === 0}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="mini"
                  onClick={downloadTranscript}
                  disabled={transcriptItems.length === 0}
                >
                  Save
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mini mute-agent"
                aria-pressed={agentMuted}
                onClick={() => setAgentMuted((current) => !current)}
                title="Mute or unmute the agent's voice"
              >
                {agentMuted ? 'Unmute agent' : 'Mute agent'}
              </button>
            )}
          </div>

          {panel === 'transcript' ? (
            <div className="transcript" ref={transcriptRef} role="tabpanel">
              {transcriptItems.length === 0 ? (
                <p className="empty">
                  Start speaking — the conversation will appear here in real time.
                </p>
              ) : (
                transcriptItems.map((item) => (
                  <div
                    key={item.id}
                    className={`bubble ${
                      item.identity === localParticipant.identity ? 'user' : 'agent'
                    }`}
                  >
                    <span className="who">{labelFor(item.identity)}</span>
                    <p>{item.text}</p>
                  </div>
                ))
              )}
            </div>
          ) : (
            <>
              <div className="transcript chat" ref={chatRef} role="tabpanel">
                {chatItems.length === 0 ? (
                  <p className="empty">
                    Send a text message — spoken replies from the agent appear here too.
                  </p>
                ) : (
                  chatItems.map((item) => {
                    const fromSelf = item.identity === localParticipant.identity;
                    return (
                      <div key={item.id} className={`bubble ${fromSelf ? 'user' : 'agent'}`}>
                        <span className="who">{item.name}</span>
                        <p>{item.text}</p>
                      </div>
                    );
                  })
                )}
              </div>
              <form className="composer" onSubmit={(event) => void sendChat(event)}>
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Message the agent…"
                  maxLength={1000}
                  aria-label="Chat message"
                />
                <button type="submit" disabled={!draft.trim() || isSending}>
                  Send
                </button>
              </form>
            </>
          )}
        </aside>
      </main>

      <footer className="controls">
        <button
          type="button"
          className={`ctrl ${isMicrophoneEnabled ? '' : 'off'}`}
          onClick={() => void toggleMic()}
          aria-pressed={isMicrophoneEnabled}
          title="Toggle microphone (M)"
        >
          {isMicrophoneEnabled ? 'Mute' : 'Unmute'}
        </button>
        <button
          type="button"
          className={`ctrl ptt ${pttActive ? 'holding' : ''}`}
          onPointerDown={(event) => {
            event.preventDefault();
            void startPtt();
          }}
          onPointerUp={() => void endPtt()}
          onPointerLeave={() => void endPtt()}
          onPointerCancel={() => void endPtt()}
          title="Push to talk (hold Space)"
        >
          {pttActive ? 'Talking…' : 'Hold to talk'}
        </button>
        <button type="button" className="ctrl" onClick={() => setSettingsOpen(true)}>
          Audio settings
        </button>
        <span className="spacer" />
        <span className="shortcut-hint">Space: talk · M: mute</span>
        <button type="button" className="ctrl danger" onClick={onLeave}>
          Leave room
        </button>
      </footer>

      {settingsOpen ? (
        <SettingsPanel
          volume={volume}
          onVolumeChange={setVolume}
          agentMuted={agentMuted}
          onToggleAgentMuted={() => setAgentMuted((current) => !current)}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {notice ? <div className="notice">{notice}</div> : null}
    </div>
  );
}

function MicMeter({ trackRef, muted }: { trackRef: TrackReference | undefined; muted: boolean }) {
  const level = useTrackVolume(trackRef);
  const width = muted ? 0 : Math.min(100, Math.round(level * 220));
  return (
    <div className={`mic-meter ${muted ? 'muted' : ''}`} title="Microphone level">
      <span className="mic-label">{muted ? 'Mic off' : 'Mic on'}</span>
      <div className="mic-bar">
        <div className="mic-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

type SettingsPanelProps = {
  volume: number;
  onVolumeChange: (value: number) => void;
  agentMuted: boolean;
  onToggleAgentMuted: () => void;
  onClose: () => void;
};

function SettingsPanel({
  volume,
  onVolumeChange,
  agentMuted,
  onToggleAgentMuted,
  onClose,
}: SettingsPanelProps) {
  const mic = useMediaDeviceSelect({ kind: 'audioinput', requestPermissions: true });
  const speaker = useMediaDeviceSelect({ kind: 'audiooutput' });
  const speakerSupported = supportsAudioOutputSelection();
  const [error, setError] = useState<string | null>(null);

  const changeDevice = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch {
      setError('Could not switch to that device.');
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Audio settings" onClick={onClose}>
      <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-head">
          <h2>Audio settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings">
            Close
          </button>
        </div>

        <label>
          Microphone
          <select
            value={mic.activeDeviceId}
            onChange={(event) => void changeDevice(() => mic.setActiveMediaDevice(event.target.value))}
          >
            {mic.devices.length === 0 ? <option value="">Default microphone</option> : null}
            {mic.devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
        </label>

        {speakerSupported ? (
          <label>
            Speaker
            <select
              value={speaker.activeDeviceId}
              onChange={(event) =>
                void changeDevice(() => speaker.setActiveMediaDevice(event.target.value))
              }
            >
              {speaker.devices.length === 0 ? <option value="">Default speaker</option> : null}
              {speaker.devices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Speaker ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label>
          Output volume
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(event) => onVolumeChange(Number(event.target.value))}
          />
        </label>

        <label className="check">
          <input type="checkbox" checked={agentMuted} onChange={onToggleAgentMuted} />
          Mute agent audio
        </label>

        {error ? <p className="hint error">{error}</p> : null}
        <p className="hint">Hold Space to talk. Press M to mute or unmute your microphone.</p>
      </div>
    </div>
  );
}
