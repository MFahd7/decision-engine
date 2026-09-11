import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'The Decision Engine',
  description:
    'A deterministic decision layer that judges whether to act on an instruction: execute, ask, defer, escalate or refuse. An LLM never makes the call.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
