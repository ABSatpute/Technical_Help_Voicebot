'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createLocalAudioTrack, type LocalAudioTrack } from 'livekit-client';
import { useTrackVolume } from '@livekit/components-react';

type PreJoinProps = {
  onJoin: (name: string, room: string, deviceId: string) => void | Promise<void>;
  joining: boolean;
  error: string | null;
};

function randomRoom() {
  return `voice-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRoom(value: string) {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || randomRoom()
  );
}

export function PreJoin({ onJoin, joining, error }: PreJoinProps) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micWarning, setMicWarning] = useState<string | null>(null);
  const [insecure, setInsecure] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!window.isSecureContext || !navigator.mediaDevices) setInsecure(true);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('room');
    const savedName = window.localStorage.getItem('voice.displayName') ?? '';
    const savedRoom = window.localStorage.getItem('voice.room') ?? '';
    setName(savedName || 'Guest');
    setRoom(fromUrl || savedRoom || randomRoom());
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!window.isSecureContext || !mediaDevices) {
      setMicWarning('Microphone access requires HTTPS (or localhost). See the note below.');
      return;
    }

    let cancelled = false;

    const enumerate = async () => {
      try {
        const list = await mediaDevices.enumerateDevices();
        if (cancelled) return;
        const mics = list.filter((device) => device.kind === 'audioinput');
        setDevices(mics);
        setDeviceId((current) => {
          if (current && mics.some((device) => device.deviceId === current)) return current;
          return mics[0]?.deviceId ?? '';
        });
      } catch {
        if (!cancelled) setMicWarning('Could not list microphones on this device.');
      }
    };

    mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        return enumerate();
      })
      .catch(() => {
        if (!cancelled) {
          setMicWarning('Microphone permission was not granted. You can allow it after joining.');
        }
        return enumerate();
      });

    mediaDevices.addEventListener('devicechange', enumerate);
    return () => {
      cancelled = true;
      mediaDevices.removeEventListener('devicechange', enumerate);
    };
  }, []);

  const copyInvite = useCallback(async () => {
    const roomName = normalizeRoom(room);
    const link = `${window.location.origin}/?room=${encodeURIComponent(roomName)}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setMicWarning('Could not copy the invite link. Copy it from the address bar instead.');
    }
  }, [room]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || joining || insecure) return;
    const roomName = normalizeRoom(room);
    window.localStorage.setItem('voice.displayName', name.trim());
    window.localStorage.setItem('voice.room', roomName);
    void onJoin(name.trim(), roomName, deviceId);
  };

  return (
    <main className="prejoin">
      <section className="prejoin-hero">
        <div className="brand">
          <img
            className="brand-icon"
            src="/voicebot-icon.png"
            alt=""
            width={32}
            height={32}
          />
          Technical Help Voicebot
        </div>
        <h1>
          Technical support that <span className="gradient-text">actually listens.</span>
        </h1>
        <p className="lede">
          Meet Technical Help Voicebot, a real-time AI support agent for LiveKit, WebRTC, SIP,
          API tokens, and connectivity issues. Speak naturally, interrupt any time, and follow
          every answer in live transcripts.
        </p>
        <ul className="feature-list">
          <li>Instant voice answers for technical and connectivity problems</li>
          <li>Live transcripts and chat you can copy or download</li>
          <li>Microphone, speaker, and push-to-talk controls in one place</li>
          <li>Escalate to a manager when you need a human</li>
        </ul>
        <p className="hero-foot">Powered by LiveKit Agents · Groq STT / LLM / TTS · WebRTC</p>
      </section>

      <section className="prejoin-card">
        <form className="join-form" onSubmit={submit}>
          <label>
            Your name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Guest"
              maxLength={48}
              autoComplete="name"
            />
          </label>

          <label>
            Support room
            <div className="room-row">
              <input
                value={room}
                onChange={(event) => setRoom(event.target.value)}
                onBlur={() => setRoom((current) => normalizeRoom(current))}
                placeholder="support room name"
                maxLength={64}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn ghost"
                onClick={() => setRoom(randomRoom())}
                title="Generate a new support room"
              >
                New room
              </button>
            </div>
          </label>

          <label>
            Microphone
            <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
              {devices.length === 0 ? <option value="">Default microphone</option> : null}
              {devices.map((device, index) => (
                <option key={device.deviceId || index} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
          </label>

          {insecure ? (
            <div className="insecure-note" role="alert">
              <strong>Microphone access needs HTTPS.</strong>
              <span>
                You opened this page over plain HTTP from another device. Open
                {' '}
                <code>http://localhost:3000</code>
                {' '}
                on this PC, or run <code>npm run dev:https</code> and accept the certificate warning.
              </span>
            </div>
          ) : (
            <MicPreview deviceId={deviceId} />
          )}

          {micWarning ? <p className="hint warn">{micWarning}</p> : null}
          {error ? (
            <p className="hint error" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            className="btn primary"
            disabled={!name.trim() || joining || insecure}
          >
            {insecure ? 'HTTPS required' : joining ? 'Starting session…' : 'Start voice session'}
          </button>

          <button type="button" className="btn ghost" onClick={() => void copyInvite()}>
            {copied ? 'Session link copied' : 'Copy session link'}
          </button>

          <p className="hint">
            The support agent joins automatically. Allow microphone access when prompted.
          </p>
        </form>
      </section>
    </main>
  );
}

function MicPreview({ deviceId }: { deviceId: string }) {
  const [track, setTrack] = useState<LocalAudioTrack | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let current: LocalAudioTrack | null = null;
    setFailed(false);

    if (!window.isSecureContext || !navigator.mediaDevices) {
      setFailed(true);
      return;
    }

    createLocalAudioTrack({
      deviceId: deviceId || undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
      .then((created) => {
        if (cancelled) {
          created.stop();
          return;
        }
        current = created;
        setTrack(created);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setTrack(null);
        }
      });

    return () => {
      cancelled = true;
      current?.stop();
      setTrack(null);
    };
  }, [deviceId]);

  return (
    <div className="mic-preview">
      <span className="caption">{failed ? 'Mic unavailable' : track ? 'Mic test' : 'Starting…'}</span>
      {track ? <LevelMeter track={track} /> : <div className="level-meter" />}
    </div>
  );
}

function LevelMeter({ track }: { track: LocalAudioTrack }) {
  const level = useTrackVolume(track);
  const width = Math.min(100, Math.round(level * 220));
  return (
    <div className="level-meter" aria-hidden>
      <div className="level-fill" style={{ width: `${width}%` }} />
    </div>
  );
}
