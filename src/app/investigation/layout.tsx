import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = { title: 'Investigation — CashPilot' };

export default function InvestigationLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
