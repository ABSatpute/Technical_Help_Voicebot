'use client';

import { useCallback, useState } from 'react';
import { LiveKitRoom } from '@livekit/components-react';
import { PreJoin } from '@/components/PreJoin';
import { VoiceRoom } from '@/components/VoiceRoom';

type Session = {
  token: string;
  serverUrl: string;
  room: string;
  identity: string;
  displayName: string;
  deviceId: string;
};

export default function HomePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);

  const join = useCallback(async (displayName: string, roomName: string, deviceId: string) => {
    setJoining(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/token?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(displayName)}`,
        { cache: 'no-store' },
      );
      const data = (await response.json()) as {
        token?: string;
        serverUrl?: string;
        room?: string;
        identity?: string;
        error?: string;
      };
      if (!response.ok || !data.token || !data.serverUrl || !data.room || !data.identity) {
        throw new Error(data.error ?? 'Could not create a room token.');
      }

      const url = new URL(window.location.href);
      url.searchParams.set('room', data.room);
      window.history.replaceState({}, '', url);

      setSession({
        token: data.token,
        serverUrl: data.serverUrl,
        room: data.room,
        identity: data.identity,
        displayName,
        deviceId,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong while joining.');
    } finally {
      setJoining(false);
    }
  }, []);

  const leave = useCallback(() => {
    setSession(null);
    setRoomError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
  }, []);

  if (!session) {
    return <PreJoin onJoin={join} joining={joining} error={error} />;
  }

  return (
    <LiveKitRoom
      token={session.token}
      serverUrl={session.serverUrl}
      connect
      audio={
        session.deviceId
          ? {
              deviceId: session.deviceId,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : true
      }
      onDisconnected={leave}
      onError={(cause) => setRoomError(cause.message)}
      onMediaDeviceFailure={(failure, kind) =>
        setRoomError(
          `Could not access your ${kind ?? 'media device'}${failure ? ` (${failure})` : ''}.`,
        )
      }
      style={{ height: '100dvh' }}
    >
      <VoiceRoom
        roomName={session.room}
        displayName={session.displayName}
        connectionError={roomError}
        onDismissError={() => setRoomError(null)}
        onLeave={leave}
      />
    </LiveKitRoom>
  );
}
