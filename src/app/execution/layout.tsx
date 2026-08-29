import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = { title: 'Execution — CashPilot' };

export default function ExecutionLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
