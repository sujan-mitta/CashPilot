import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = { title: 'Dashboard — CashPilot' };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
