import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Living Reader',
  description: 'Pre-generated, narrated reading experiences.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
