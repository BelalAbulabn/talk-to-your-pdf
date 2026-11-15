import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { APP_NAME } from '@/lib/brand';
// Fonts ship with the app: no request to Google at build time or in the browser.
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/cairo';
import './globals.scss';
import '../components/ChatApp.scss';

export const metadata: Metadata = {
  title: APP_NAME,
  description:
    'Upload a PDF, then talk or type to ask questions about it. Answers come only from your file, with the page number.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F4F1' },
    { media: '(prefers-color-scheme: dark)', color: '#0A0C0E' },
  ],
};

// Applies a saved light/dark choice before the first paint.
const themeScript = `try{var t=localStorage.getItem('vcp-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
