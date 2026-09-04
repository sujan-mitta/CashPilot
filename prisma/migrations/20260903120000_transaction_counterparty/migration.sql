-- Link a transaction to the counterparty it belongs to.
--
-- Strictly additive: one nullable column and one index. No existing column is
-- altered, dropped or backfilled, and every existing row reads NULL — which
-- means "nobody has resolved this", not "no counterparty exists".
--
-- WHY IT WAS MISSING AND WHY IT MATTERS
--
-- The behavioural forecast keys a learned payment delay on counterpartyId, and
-- TransactionRecord already declared the field. The table never had it, so the
-- value was always undefined and a learned delay could never reach a forecast
-- however good the model was. This is the missing link, not a new feature.
--
-- No foreign key constraint on purpose. A Counterparty is never deleted — merges
-- record mergedIntoId and keep history auditable — so a dangling reference is
-- not a case this needs to defend against, and the existing counterparty columns
-- elsewhere in this schema follow the same convention.

ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "counterpartyId" TEXT;

CREATE INDEX IF NOT EXISTS "Transaction_counterpartyId_idx" ON "Transaction"("counterpartyId");
