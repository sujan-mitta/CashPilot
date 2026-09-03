import {
  ActionStatus,
  ExecutionOperation,
  PayoutStatus,
  RecoveryStatus,
  TransactionStatus,
  Prisma,
  AgentAction,
  PrismaClient,
} from "../../../generated/prisma/client";
import { addDays } from "date-fns";
import { createRecoveryPaymentLink, fetchPaymentLink } from "../razorpay/client";
import { executeWithDurableIntent, ExecuteResult } from "./executor";
import { validateRecoveryTransition } from "../engine/stateTransitions";
import { formatLakhs } from "../format";
import { FINANCIAL_CONFIG } from "../engine/financialConfig";

export interface ActionExecutionOutcome {
  status: ActionStatus;
  result: string;
  /** Intent ids touched by this action - the observability trail (PART 30). */
  intentIds: string[];
  externalRefs: string[];
  /** Where a payer is sent, when this action produced a single payable link. */
  shortUrl?: string;
  unknownReason?: string;
}

/** Hooks used by crash-simulation tests to interrupt at a precise boundary. */
export interface ExecutionHooks {
  onIntentRecorded?: (intentId: string) => Promise<void> | void;
}

/**
 * Maps a durable execution result onto the action status it justifies.
 *
 * The mapping is deliberately conservative: only SUCCEEDED yields a positive
 * action state, and anything ambiguous yields EXECUTION_UNKNOWN rather than
 * FAILED, because a FAILED action is retryable and retrying an operation that
 * may already have landed is how duplicate payments happen.
 */
function statusForOutcome(outcome: ExecuteResult["outcome"], settledImmediately: boolean): ActionStatus {
  switch (outcome) {
    case "SUCCEEDED":
    case "ALREADY_SUCCEEDED":
      // A payment link is issued, not settled. COMPLETED is reserved for money
      // we have actually observed arriving.
      return settledImmediately ? ActionStatus.COMPLETED : ActionStatus.EXECUTING;
    case "FAILED":
    case "ALREADY_FAILED":
      return ActionStatus.FAILED;
    case "UNKNOWN":
    case "BLOCKED_UNKNOWN":
      return ActionStatus.EXECUTION_UNKNOWN;
    default:
      return ActionStatus.EXECUTION_UNKNOWN;
  }
}

/**
 * Appends `actionId` to a checkout URL, choosing the right separator.
 *
 * The previous version always used `&`, which is only correct for a URL that
 * already carries a query string. Our own `/sandbox/checkout?...` links do, but
 * a provider `short_url` does not - so a stored Razorpay link became
 * `https://rzp.io/rzp/XXXX&actionId=...`, a different PATH rather than the link
 * plus a parameter. Observed live: a PAYMENT_PENDING recovery whose stored
 * shortUrl was exactly that, handed to the operator as a dead link.
 *
 * The corrupted value also persisted: the old guard skipped any URL already
 * containing "actionId=", so once written it was never repaired.
 */
export function withActionId(shortUrl: string | null | undefined, actionId: string): string {
  if (!shortUrl) return shortUrl ?? "";

  // Already carries an actionId - but it may be a previously corrupted value,
  // so repair the separator rather than trusting it.
  const corrupted = /^([^?]*?)&(actionId=|paymentLinkId=)/.exec(shortUrl);
  if (corrupted) {
    return shortUrl.replace(/^([^?]*?)&/, "$1?");
  }
  if (shortUrl.includes("actionId=")) return shortUrl;

  return `${shortUrl}${shortUrl.includes("?") ? "&" : "?"}actionId=${actionId}`;
}

/**
 * Where to actually send a payer.
 *
 * THE BUG THIS CLOSES: `createRecoveryPaymentLink` returns the provider's own
 * `short_url`, and the executor discarded it — keeping only the link id and
 * hardcoding `/sandbox/checkout?...`. So with Razorpay live in TEST mode a
 * genuine, payable link was created at the provider and then nobody was ever
 * sent to it. The customer landed on our simulation page instead.
 *
 * Worse in production specifically: the simulation refuses to run there at all,
 * because `simulatePaid` is gated on NODE_ENV and a query parameter must never
 * be able to assert that money arrived. So the payer reached a dead end while a
 * real obligation to pay sat unpaid at Razorpay. Observed live as
 * "Checkout Session Failure" on a real plink_ id.
 *
 * The provider's URL wins whenever we have one. The sandbox path is the
 * fallback for the simulated provider, which returns exactly that as its own
 * short_url anyway.
 */
export function checkoutUrlFor(
  providerShortUrl: string | null | undefined,
  storedShortUrl: string | null | undefined,
  linkId: string
): string {
  if (providerShortUrl) return providerShortUrl;
  // A duplicate create (ALREADY_SUCCEEDED) does not re-run the provider call,
  // so nothing fresh came back; whatever was stored the first time still stands.
  if (storedShortUrl) return storedShortUrl;
  return `/sandbox/checkout?paymentLinkId=${linkId}`;
}

/** A link the provider minted, as opposed to our own simulation. */
function isRealProviderLink(linkId: string): boolean {
  return linkId.startsWith("plink_") && !linkId.startsWith("plink_sim_");
}

/**
 * The same decision, but allowed to ASK the provider.
 *
 * Re-running an action whose links already exist short-circuits on
 * ALREADY_SUCCEEDED, so the dispatch never runs and no fresh short_url comes
 * back. The synchronous fallback then produced a /sandbox/checkout path for a
 * REAL Razorpay link — which is a dead end in production, because the
 * simulation is gated on NODE_ENV and refuses to run there.
 *
 * Observed live: two collection links and a recovery link all pointing at the
 * sandbox after a re-run, on links that were live and payable at Razorpay the
 * whole time.
 *
 * A short_url cannot be derived from a link id — only the provider knows it —
 * so when we hold neither a fresh nor a stored URL for a real link, we ask. It
 * is a read, and it fails soft: if the provider cannot answer we keep the
 * sandbox path rather than inventing an address for money that is owed.
 */
export async function resolveCheckoutUrl(
  providerShortUrl: string | null | undefined,
  storedShortUrl: string | null | undefined,
  linkId: string,
  /**
   * Whose account to ask.
   *
   * A link created on a merchant's account does not exist on the deployment's,
   * so asking the wrong one returns nothing and the payer is left with the
   * sandbox dead end for a link that is perfectly real.
   */
  businessId?: string
): Promise<string> {
  if (providerShortUrl) return providerShortUrl;
  if (storedShortUrl && !storedShortUrl.includes("/sandbox/checkout")) return storedShortUrl;

  if (isRealProviderLink(linkId)) {
    const link = await fetchPaymentLink(linkId, businessId);
    if (link?.short_url) return link.short_url;
  }

  return checkoutUrlFor(providerShortUrl, storedShortUrl, linkId);
}

/**
 * RECOVER_FAILED_PAYMENTS - issues one recovery payment link.
 *
 * The PaymentRecovery row is moved to RECOVERY_INITIATED before the external
 * call and only to PAYMENT_PENDING once a link genuinely exists, so an
 * interrupted run leaves an initiated-but-unlinked recovery rather than a
 * recovery claiming a link it never received.
 */
export async function executeRecoverFailedPayments(
  client: Prisma.TransactionClient,
  ctx: { businessId: string; strategyId: string; action: AgentAction },
  hooks: ExecutionHooks = {}
): Promise<ActionExecutionOutcome> {
  // States from which the recovery state machine permits RECOVERY_INITIATED.
  //
  // Searching for RECOVERY_CANDIDATE alone was narrower than what
  // validateRecoveryTransition already allows, so a recovery whose link was
  // cancelled or expired could never be re-attempted - the debt was real, the
  // link was dead, and nothing could issue a replacement. Observed live: a
  // cancelled link on a genuine failed payment left six actions wedged.
  //
  // This is the same mismatch as the execute route claiming only APPROVED while
  // the action machine allowed FAILED -> EXECUTING: when a guard is stricter
  // than the state machine it is supposed to enforce, the stricter one wins
  // silently and the documented recovery path becomes unreachable.
  // A fresh debt is always preferred over re-attempting a previously dead one,
  // so the two are queried in explicit precedence rather than relying on the
  // enum's declaration order to sort them.
  //
  // TARGETING (fixed): the action carries `targetTransactionId` - the exact
  // failed payment the strategy was scored and approved against - and this
  // used to ignore it completely, taking whichever RECOVERY_CANDIDATE an
  // unordered `findFirst` happened to return. With more than one failed
  // payment on the ledger, the debt the operator approved and the debt the
  // system recovered could be different rows for different amounts. The
  // approved target is now preferred, and the untargeted fallback is ordered
  // deterministically (largest debt first) instead of relying on row order.
  const findRecovery = async (statuses: RecoveryStatus[]) => {
    if (ctx.action.targetTransactionId) {
      const targeted = await client.paymentRecovery.findFirst({
        where: {
          status: { in: statuses },
          transactionId: ctx.action.targetTransactionId,
          transaction: { businessId: ctx.businessId },
        },
        include: { transaction: true },
      });
      if (targeted) return targeted;
    }
    return client.paymentRecovery.findFirst({
      where: {
        status: { in: statuses },
        transaction: { businessId: ctx.businessId },
      },
      include: { transaction: true },
      orderBy: [{ amount: "desc" }, { id: "asc" }],
    });
  };

  const recovery =
    (await findRecovery([RecoveryStatus.RECOVERY_CANDIDATE])) ??
    (await findRecovery([RecoveryStatus.FAILED, RecoveryStatus.EXPIRED]));

  if (!recovery) {
    const activePending = await client.paymentRecovery.findFirst({
      where: {
        status: RecoveryStatus.PAYMENT_PENDING,
        transaction: { businessId: ctx.businessId },
      },
    });
    if (activePending) {
      const url = withActionId(activePending.shortUrl, ctx.action.id);
      return {
        status: ActionStatus.EXECUTING,
        result: `Razorpay link generated: ${url}`,
        intentIds: [],
        externalRefs: activePending.paymentLinkId ? [activePending.paymentLinkId] : [],
        shortUrl: url,
      };
    }
    return {
      status: ActionStatus.FAILED,
      result: "No candidate failed payment found to recover.",
      intentIds: [],
      externalRefs: [],
    };
  }

  if (!validateRecoveryTransition(recovery.status, RecoveryStatus.RECOVERY_INITIATED)) {
    return {
      status: ActionStatus.FAILED,
      result: `Invalid recovery transition from ${recovery.status} to RECOVERY_INITIATED`,
      intentIds: [],
      externalRefs: [],
    };
  }

  await client.paymentRecovery.update({
    where: { id: recovery.id },
    data: { status: RecoveryStatus.RECOVERY_INITIATED },
  });

  // Captured from the provider call so the real checkout URL survives; the
  // outcome object carries only the reference id.
  let providerShortUrl: string | null = null;
  const outcome = await executeWithDurableIntent(client, {
    businessId: ctx.businessId,
    strategyId: ctx.strategyId,
    actionId: ctx.action.id,
    operation: ExecutionOperation.CREATE_PAYMENT_LINK,
    amount: ctx.action.amount,
    targetType: "PAYMENT_RECOVERY",
    targetId: recovery.id,
    onIntentRecorded: hooks.onIntentRecorded,
    dispatch: async (idempotencyKey) => {
      // The link is for what the RECOVERY is worth, not what the action says.
      //
      // `ctx.action.amount` is the simulated figure. When the two disagree -
      // which they do the moment the targeted recovery is not the one the
      // simulation assumed - issuing a link for the action amount asks the
      // customer for the wrong sum, and settlement then flags a
      // RECONCILIATION_MISMATCH that the system itself caused.
      const link = await createRecoveryPaymentLink(
        recovery.amount,
        recovery.transaction?.description || "Failed payment recovery",
        idempotencyKey,
        undefined,
        // Issued on this business's own Razorpay account when it has connected
        // one, so the money lands with the merchant rather than with us.
        ctx.businessId
      );
      providerShortUrl = link.short_url;
      return { externalRef: link.id, externalStatus: link.status };
    },
  });

  if (outcome.outcome === "SUCCEEDED" || outcome.outcome === "ALREADY_SUCCEEDED") {
    const linkId = outcome.externalRef as string;
    const shortUrl = withActionId(
      await resolveCheckoutUrl(providerShortUrl, recovery.shortUrl, linkId, ctx.businessId),
      ctx.action.id
    );
    await client.paymentRecovery.update({
      where: { id: recovery.id },
      data: {
        status: RecoveryStatus.PAYMENT_PENDING,
        paymentLinkId: linkId,
        shortUrl,
      },
    });
    return {
      status: ActionStatus.EXECUTING,
      result: `Razorpay link generated: ${shortUrl}`,
      intentIds: [outcome.intentId],
      externalRefs: [linkId],
      shortUrl,
    };
  }

  return {
    status: statusForOutcome(outcome.outcome, false),
    result:
      outcome.outcome === "FAILED" || outcome.outcome === "ALREADY_FAILED"
        ? `Recovery link could not be created: ${outcome.error}`
        : `Recovery link status is indeterminate: ${outcome.unknownReason}. Verify at the provider before retrying.`,
    intentIds: [outcome.intentId],
    externalRefs: [],
    unknownReason: outcome.unknownReason,
  };
}

/**
 * PRIORITIZE_COLLECTIONS - one link per overdue invoice.
 *
 * Each invoice gets its OWN intent keyed by (action, invoice), so a crash
 * partway through a five-invoice run resumes without re-issuing links for the
 * invoices already done.
 */
export interface CollectionsLinkDetails {
  invoiceId: string;
  customerName: string;
  paymentLinkId: string;
  shortUrl: string;
  amount: number;
}

export async function executePrioritizeCollections(
  client: Prisma.TransactionClient,
  ctx: { businessId: string; strategyId: string; action: AgentAction },
  hooks: ExecutionHooks = {}
): Promise<ActionExecutionOutcome> {
  const overdueInvoices = await client.invoice.findMany({
    where: { status: "OVERDUE", businessId: ctx.businessId },
  });

  if (!overdueInvoices || overdueInvoices.length === 0) {
    return {
      status: ActionStatus.FAILED,
      result: "No overdue invoices found to prioritize.",
      intentIds: [],
      externalRefs: [],
    };
  }

  const links: CollectionsLinkDetails[] = [];
  const intentIds: string[] = [];
  const externalRefs: string[] = [];
  let anyUnknown: string | undefined;
  let anyFailed: string | undefined;

  for (const inv of overdueInvoices) {
    // Captured from the provider call so the real checkout URL survives; the
    // outcome object carries only the reference id.
    let providerShortUrl: string | null = null;
    const outcome = await executeWithDurableIntent(client, {
      businessId: ctx.businessId,
      strategyId: ctx.strategyId,
      actionId: ctx.action.id,
      operation: ExecutionOperation.CREATE_PAYMENT_LINK,
      amount: inv.amount,
      targetType: "INVOICE",
      targetId: inv.id,
      onIntentRecorded: hooks.onIntentRecorded,
      dispatch: async (idempotencyKey) => {
        const link = await createRecoveryPaymentLink(
          inv.amount,
          `Invoice Collection for ${inv.customerName}`,
          idempotencyKey,
          undefined,
          ctx.businessId
        );
        providerShortUrl = link.short_url;
        return { externalRef: link.id, externalStatus: link.status };
      },
    });

    intentIds.push(outcome.intentId);

    if (outcome.outcome === "SUCCEEDED" || outcome.outcome === "ALREADY_SUCCEEDED") {
      const linkId = outcome.externalRef as string;
      externalRefs.push(linkId);
      links.push({
        invoiceId: inv.id,
        customerName: inv.customerName,
        paymentLinkId: linkId,
        shortUrl: withActionId(
          await resolveCheckoutUrl(providerShortUrl, null, linkId, ctx.businessId),
          ctx.action.id
        ),
        amount: inv.amount,
      });
    } else if (
      outcome.outcome === "UNKNOWN" ||
      outcome.outcome === "BLOCKED_UNKNOWN" ||
      // A prior attempt still claims this invoice and its provider outcome is
      // not established. That is an ambiguity, not a failure, so it must not
      // fall through to the FAILED branch below - which reads `outcome.error`,
      // a field the blocked path never sets, and so reported nothing at all.
      outcome.outcome === "BLOCKED_BY_PRIOR_ATTEMPT"
    ) {
      anyUnknown = outcome.unknownReason ?? `Invoice ${inv.id}: ${outcome.outcome}.`;
    } else {
      // Never leave the caller with a bare count and no reason: every branch
      // that produces no link owes an explanation.
      anyFailed =
        outcome.error ??
        outcome.unknownReason ??
        `Invoice ${inv.id}: attempt ended as ${outcome.outcome} without a reported reason.`;
    }
  }

  // Raise priority ONLY on the invoices that actually received a link.
  //
  // This used to be `updateMany({ where: { status: "OVERDUE", businessId } })`,
  // which rewrote priority on every overdue invoice in the tenant - including
  // ones this run failed to issue a link for, and ones no strategy had ever
  // touched. It also destroyed the previous value with no record, so the
  // operator's own prioritisation was irrecoverable after a single run.
  if (links.length > 0) {
    await client.invoice.updateMany({
      where: {
        id: { in: links.map((l) => l.invoiceId) },
        businessId: ctx.businessId,
      },
      data: { priority: "HIGH" },
    });
  }

  // Any ambiguity anywhere in the fan-out makes the whole action ambiguous.
  const status = anyUnknown
    ? ActionStatus.EXECUTION_UNKNOWN
    : links.length === 0
    ? ActionStatus.FAILED
    : ActionStatus.EXECUTING;

  return {
    status,
    result: JSON.stringify({
      message: `Generated payment links for ${links.length} of ${overdueInvoices.length} overdue invoices.`,
      links,
      ...(anyUnknown ? { unknown: anyUnknown } : {}),
      ...(anyFailed ? { failed: anyFailed } : {}),
    }),
    intentIds,
    externalRefs,
    unknownReason: anyUnknown,
  };
}

/**
 * RESCHEDULE_PAYOUT - a purely local ledger mutation.
 *
 * No external provider is involved, so this genuinely can be atomic. The intent
 * is still recorded because it gives every action a uniform audit trail and a
 * stable identity, but the operation runs inside a transaction and its outcome
 * is never ambiguous.
 */
export async function executeReschedulePayout(
  client: PrismaClient,
  ctx: { businessId: string; strategyId: string; action: AgentAction },
  hooks: ExecutionHooks = {}
): Promise<ActionExecutionOutcome> {
  // The post-condition is computed BEFORE the intent is recorded, so
  // reconciliation has a concrete expectation to compare persisted state
  // against rather than having to infer one (PART 3).
  // One source of truth, shared with the simulation and the approval screen.
  // This was `FORECAST_HORIZON_DAYS + 6` while the simulation defaulted to 15
  // and the UI said "day 15" in prose, so the operator approved one date and
  // the ledger received another.
  const rescheduledDate = addDays(new Date(), FINANCIAL_CONFIG.RESCHEDULE_DELAY_DAYS);
  const existingPayout = ctx.action.targetPayoutId
    ? await client.payout.findFirst({
        where: { id: ctx.action.targetPayoutId, businessId: ctx.businessId },
      })
    : null;

  const outcome = await executeWithDurableIntent(client, {
    expectedState: {
      kind: "PAYOUT_RESCHEDULE",
      originalDueDate: existingPayout
        ? new Date(existingPayout.scheduledDate).toISOString().split("T")[0]
        : "unknown",
      expectedDueDate: rescheduledDate.toISOString().split("T")[0],
      expectedStatus: PayoutStatus.RESCHEDULED,
    },
    businessId: ctx.businessId,
    strategyId: ctx.strategyId,
    actionId: ctx.action.id,
    operation: ExecutionOperation.RESCHEDULE_PAYOUT,
    amount: ctx.action.amount,
    targetType: "PAYOUT",
    targetId: ctx.action.targetPayoutId ?? null,
    onIntentRecorded: hooks.onIntentRecorded,
    dispatch: async () => {
      return await client.$transaction(async (tx: Prisma.TransactionClient) => {
        const lowPayout = ctx.action.targetPayoutId
          ? await tx.payout.findFirst({
              where: { id: ctx.action.targetPayoutId, businessId: ctx.businessId },
            })
          : await tx.payout.findFirst({
              where: {
                vendor: "Packaging Co",
                status: PayoutStatus.SCHEDULED,
                businessId: ctx.businessId,
              },
            });

        if (!lowPayout) {
          // A definite negative: there is nothing to move.
          const err = new Error("No scheduled payout found to reschedule.") as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err;
        }

        await tx.payout.update({
          where: { id: lowPayout.id },
          data: { scheduledDate: rescheduledDate, status: PayoutStatus.RESCHEDULED },
        });

        const transactionRecord = ctx.action.targetTransactionId
          ? await tx.transaction.findFirst({
              where: { id: ctx.action.targetTransactionId, businessId: ctx.businessId },
            })
          : await tx.transaction.findFirst({
              where: {
                businessId: ctx.businessId,
                type: "OUTFLOW",
                amount: lowPayout.amount,
                description: { contains: "Packaging" },
              },
            });

        if (transactionRecord) {
          await tx.transaction.update({
            where: { id: transactionRecord.id },
            data: { expectedDate: rescheduledDate },
          });
        }

        return {
          externalRef: `payout:${lowPayout.id}`,
          externalStatus: `RESCHEDULED:${formatLakhs(lowPayout.amount)}`,
        };
      });
    },
  });

  if (outcome.outcome === "SUCCEEDED" || outcome.outcome === "ALREADY_SUCCEEDED") {
    return {
      status: ActionStatus.COMPLETED,
      result: `Rescheduled vendor payout (${outcome.externalStatus ?? "done"}).`,
      intentIds: [outcome.intentId],
      externalRefs: outcome.externalRef ? [outcome.externalRef] : [],
    };
  }

  return {
    status: statusForOutcome(outcome.outcome, true),
    result:
      outcome.outcome === "FAILED" || outcome.outcome === "ALREADY_FAILED"
        ? outcome.error ?? "Reschedule failed."
        : `Reschedule outcome indeterminate: ${outcome.unknownReason}`,
    intentIds: [outcome.intentId],
    externalRefs: [],
    unknownReason: outcome.unknownReason,
  };
}

/** PAUSE_EXPENSE - local ledger mutation, same shape as reschedule. */
export async function executePauseExpense(
  client: PrismaClient,
  ctx: { businessId: string; strategyId: string; action: AgentAction },
  hooks: ExecutionHooks = {}
): Promise<ActionExecutionOutcome> {
  const existingTx = ctx.action.targetTransactionId
    ? await client.transaction.findFirst({
        where: { id: ctx.action.targetTransactionId, businessId: ctx.businessId },
      })
    : null;

  const outcome = await executeWithDurableIntent(client, {
    expectedState: {
      kind: "EXPENSE_PAUSE",
      originalStatus: existingTx?.status ?? "unknown",
      expectedStatus: TransactionStatus.FAILED,
    },
    businessId: ctx.businessId,
    strategyId: ctx.strategyId,
    actionId: ctx.action.id,
    operation: ExecutionOperation.PAUSE_EXPENSE,
    amount: ctx.action.amount,
    targetType: "TRANSACTION",
    targetId: ctx.action.targetTransactionId ?? null,
    onIntentRecorded: hooks.onIntentRecorded,
    dispatch: async () => {
      return await client.$transaction(async (tx: Prisma.TransactionClient) => {
        const saasTx = ctx.action.targetTransactionId
          ? await tx.transaction.findFirst({
              where: { id: ctx.action.targetTransactionId, businessId: ctx.businessId },
            })
          : await tx.transaction.findFirst({
              where: {
                businessId: ctx.businessId,
                type: "OUTFLOW",
                description: { contains: "SaaS" },
                status: TransactionStatus.PENDING,
              },
            });

        if (!saasTx) {
          const err = new Error("No pending subscription found to pause.") as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err;
        }

        await tx.transaction.update({
          where: { id: saasTx.id },
          data: { status: TransactionStatus.FAILED },
        });

        return {
          externalRef: `transaction:${saasTx.id}`,
          externalStatus: `PAUSED:${formatLakhs(saasTx.amount)}`,
        };
      });
    },
  });

  if (outcome.outcome === "SUCCEEDED" || outcome.outcome === "ALREADY_SUCCEEDED") {
    return {
      status: ActionStatus.COMPLETED,
      result: `Paused recurring subscription (${outcome.externalStatus ?? "done"}).`,
      intentIds: [outcome.intentId],
      externalRefs: outcome.externalRef ? [outcome.externalRef] : [],
    };
  }

  return {
    status: statusForOutcome(outcome.outcome, true),
    result:
      outcome.outcome === "FAILED" || outcome.outcome === "ALREADY_FAILED"
        ? outcome.error ?? "Pause failed."
        : `Pause outcome indeterminate: ${outcome.unknownReason}`,
    intentIds: [outcome.intentId],
    externalRefs: [],
    unknownReason: outcome.unknownReason,
  };
}

/** Dispatches to the executor for an action type. */
export async function executeAction(
  client: PrismaClient,
  ctx: { businessId: string; strategyId: string; action: AgentAction },
  hooks: ExecutionHooks = {}
): Promise<ActionExecutionOutcome> {
  switch (ctx.action.actionType) {
    case "RECOVER_FAILED_PAYMENTS":
      return executeRecoverFailedPayments(client, ctx, hooks);
    case "PRIORITIZE_COLLECTIONS":
      return executePrioritizeCollections(client, ctx, hooks);
    case "RESCHEDULE_PAYOUT":
      return executeReschedulePayout(client, ctx, hooks);
    case "PAUSE_EXPENSE":
      return executePauseExpense(client, ctx, hooks);
    default:
      return {
        status: ActionStatus.FAILED,
        result: `Unsupported action type ${ctx.action.actionType}`,
        intentIds: [],
        externalRefs: [],
      };
  }
}
