import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reliable Webhook Processor — Ops Console',
  description:
    'Operational dashboard for monitoring webhook ingestion, retries, and worker leases.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
