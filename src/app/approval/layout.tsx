import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = { title: 'Approval — CashPilot' };

export default function ApprovalLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
