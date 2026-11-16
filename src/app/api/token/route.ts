import { NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';

export const dynamic = 'force-dynamic';

const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX_LENGTH = 48;

function sanitizeRoom(value: string | null): string {
  if (value && ROOM_PATTERN.test(value)) return value;
  return `voice-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeName(value: string | null): string {
  const cleaned = (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, NAME_MAX_LENGTH);
  return cleaned || 'Guest';
}

function createIdentity(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'guest';
  return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function GET(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const serverUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !serverUrl) {
    return NextResponse.json(
      { error: 'LiveKit credentials are not configured on the server.' },
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  const room = sanitizeRoom(url.searchParams.get('room'));
  const name = sanitizeName(url.searchParams.get('name'));
  const identity = createIdentity(name);

  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    ttl: '2h',
  });
  token.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return NextResponse.json(
    { token: await token.toJwt(), serverUrl, room, identity },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
