import { describe, it, expect, vi } from "vitest";
import { appendAuditToActions, appendAuditEntry, type AuditEntry } from "../auditTrail";

/**
 * APPEND-ONLY ACTION AUDIT
 *
 * `AgentAction.auditLog` is documented as append-only and every write path
 * honoured that except /api/approve, which ASSIGNED a fresh single-entry array
 * because `updateMany` cannot append per row. Approving or rejecting therefore
 * erased whatever history the action already had.
 *
 * It was harmless in practice - approve only touched PENDING rows, which have
 * no history yet - but a guarantee that holds by coincidence is not a
 * guarantee, and STALE -> re-approval would have hit it for real.
 */
function makeTx() {
  const rows = new Map<string, { id: string; auditLog: unknown }>();
  const tx = {
    agentAction: {
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row) throw new Error(`no such action ${where.id}`);
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return { tx: tx as any, rows };
}

const entry = (what: string): AuditEntry => ({
  who: "user-1",
  what,
  when: "2026-08-27T10:00:00.000Z",
  why: "test",
  result: "SUCCESS",
});

describe("appendAuditToActions", () => {
  it("THE BUG: preserves existing history instead of replacing it", () => {
    // The old approve route wrote `auditLog: [oneEntry]`, discarding this.
    const { tx, rows } = makeTx();
    rows.set("a1", { id: "a1", auditLog: [entry("Transition X -> Y")] });

    return appendAuditToActions(tx, [{ id: "a1", auditLog: rows.get("a1")!.auditLog }], entry("Transition Y -> Z")).then(
      () => {
        const log = rows.get("a1")!.auditLog as AuditEntry[];
        expect(log).toHaveLength(2);
        expect(log[0].what).toBe("Transition X -> Y");
        expect(log[1].what).toBe("Transition Y -> Z");
      }
    );
  });

  it("starts a log when the action has none", async () => {
    const { tx, rows } = makeTx();
    rows.set("a1", { id: "a1", auditLog: null });
    await appendAuditToActions(tx, [{ id: "a1", auditLog: null }], entry("first"));
    expect(rows.get("a1")!.auditLog).toHaveLength(1);
  });

  it("treats a non-array auditLog as empty rather than throwing", async () => {
    // Legacy rows and hand-edited JSON both exist in the wild.
    const { tx, rows } = makeTx();
    for (const corrupt of [{ not: "an array" }, "a string", 42]) {
      rows.set("a1", { id: "a1", auditLog: corrupt });
      await appendAuditToActions(tx, [{ id: "a1", auditLog: corrupt }], entry("recovered"));
      expect(rows.get("a1")!.auditLog).toHaveLength(1);
    }
  });

  it("appends to EVERY action, one update each", async () => {
    const { tx, rows } = makeTx();
    for (const id of ["a1", "a2", "a3"]) rows.set(id, { id, auditLog: [] });
    await appendAuditToActions(
      tx,
      [...rows.values()].map((r) => ({ id: r.id, auditLog: r.auditLog })),
      entry("bulk")
    );
    expect(tx.agentAction.update).toHaveBeenCalledTimes(3);
    for (const row of rows.values()) expect(row.auditLog).toHaveLength(1);
  });

  it("does not share one entry object across rows", async () => {
    // A shared reference means mutating the entry afterwards rewrites history
    // on every row that holds it.
    const { tx, rows } = makeTx();
    rows.set("a1", { id: "a1", auditLog: [] });
    rows.set("a2", { id: "a2", auditLog: [] });
    const shared = entry("shared");
    await appendAuditToActions(
      tx,
      [
        { id: "a1", auditLog: [] },
        { id: "a2", auditLog: [] },
      ],
      shared
    );
    const one = (rows.get("a1")!.auditLog as AuditEntry[])[0];
    const two = (rows.get("a2")!.auditLog as AuditEntry[])[0];
    expect(one).not.toBe(two);
    expect(one).not.toBe(shared);
  });

  it("is a no-op for an empty action list", async () => {
    const { tx } = makeTx();
    await appendAuditToActions(tx, [], entry("nothing"));
    expect(tx.agentAction.update).not.toHaveBeenCalled();
  });

  it("PROPAGATES a write failure rather than swallowing it", async () => {
    // This runs in the same transaction as the status change it describes. A
    // status change whose audit entry silently failed to write is exactly the
    // divergence the append-only rule exists to prevent.
    const tx = {
      agentAction: { update: vi.fn(async () => { throw new Error("db down"); }) },
    } as any;
    await expect(
      appendAuditToActions(tx, [{ id: "a1", auditLog: [] }], entry("x"))
    ).rejects.toThrow("db down");
  });
});

describe("appendAuditEntry", () => {
  it("returns a new array and never mutates the input", () => {
    const existing = [entry("one")];
    const result = appendAuditEntry(existing, entry("two")) as AuditEntry[];
    expect(existing).toHaveLength(1);
    expect(result).toHaveLength(2);
  });

  it("handles null, undefined and non-arrays", () => {
    for (const value of [null, undefined, "nope", 7, {}]) {
      expect(appendAuditEntry(value, entry("x"))).toHaveLength(1);
    }
  });
});
