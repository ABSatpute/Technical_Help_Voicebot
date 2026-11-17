import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Technical Help Voicebot — LiveKit AI Support Agent',
  description:
    'Talk to a real-time AI voice agent for technical support across LiveKit, WebRTC, SIP, and connectivity issues.',
  applicationName: 'Technical Help Voicebot',
  icons: {
    icon: '/voicebot-icon.svg',
    shortcut: '/voicebot-icon.svg',
    apple: '/voicebot-icon.svg',
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
