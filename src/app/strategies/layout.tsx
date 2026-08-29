import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = { title: 'Strategies — CashPilot' };

export default function StrategiesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
