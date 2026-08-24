export interface RootCause {
  type: "OVERDUE_RECEIVABLES" | "FAILED_PAYMENTS" | "UPCOMING_PAYOUTS" | "PAYROLL_TIMING";
  amount: number; // in paise
  detail: string;
}

export function identifyRootCauses(input: {
  overdueInvoicesTotal: number;
  failedPaymentsTotal: number;
  payoutsBeforeCollectionsTotal: number;
  payrollBeforeCollections: boolean;
  payrollAmount: number;
}): RootCause[] {
  const causes: RootCause[] = [];

  if (input.overdueInvoicesTotal > 0) {
    const formattedAmount = (input.overdueInvoicesTotal / 10000000).toFixed(1);
    causes.push({
      type: "OVERDUE_RECEIVABLES",
      amount: input.overdueInvoicesTotal,
      detail: `₹${formattedAmount}L in overdue customer invoices remain uncollected.`,
    });
  }

  if (input.failedPaymentsTotal > 0) {
    const formattedAmount = (input.failedPaymentsTotal / 10000000).toFixed(1);
    causes.push({
      type: "FAILED_PAYMENTS",
      amount: input.failedPaymentsTotal,
      detail: `₹${formattedAmount}L in customer payments failed and are potentially recoverable.`,
    });
  }

  if (input.payoutsBeforeCollectionsTotal > 0) {
    const formattedAmount = (input.payoutsBeforeCollectionsTotal / 10000000).toFixed(1);
    causes.push({
      type: "UPCOMING_PAYOUTS",
      amount: input.payoutsBeforeCollectionsTotal,
      detail: `₹${formattedAmount}L in vendor payouts are scheduled before matching collections arrive.`,
    });
  }

  if (input.payrollBeforeCollections && input.payrollAmount > 0) {
    const formattedAmount = (input.payrollAmount / 10000000).toFixed(1);
    causes.push({
      type: "PAYROLL_TIMING",
      amount: input.payrollAmount,
      detail: `Payroll of ₹${formattedAmount}L is scheduled before major expected customer payments land.`,
    });
  }

  // Sort biggest impact first (largest amount first)
  return causes.sort((a, b) => b.amount - a.amount);
}
