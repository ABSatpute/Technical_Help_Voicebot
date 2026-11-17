import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Technical Help Voicebot — LiveKit AI Support Agent',
  description:
    'Talk to a real-time AI voice agent for technical support across LiveKit, WebRTC, SIP, and connectivity issues.',
  applicationName: 'Technical Help Voicebot',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-48x48.png', type: 'image/png', sizes: '48x48' },
      { url: '/voicebot-icon.png', type: 'image/png', sizes: '512x512' },
    ],
    shortcut: '/favicon.ico',
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' }],
  },
  openGraph: {
    title: 'Technical Help Voicebot',
    description:
      'Real-time technical support voice agent powered by LiveKit Agents and Groq.',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Technical Help Voicebot',
    description:
      'Real-time technical support voice agent powered by LiveKit Agents and Groq.',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#07080d',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
