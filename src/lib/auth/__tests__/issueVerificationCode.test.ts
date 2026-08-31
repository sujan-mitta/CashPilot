import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Issuing a code, and knowing whether it actually went anywhere.
 *
 * THE BUG: `SIMULATED` was counted as delivery. The mailer returns it from its
 * local sandbox — the provider used when nothing is configured — which reports
 * success and sends no mail. Signup and login would then announce a code that
 * never left the process, and because the only route back in IS that code,
 * every account in such a deployment is locked out permanently, with no way to
 * recover from inside the product.
 *
 * A send that reports success and does nothing is the worst possible failure
 * shape here: it looks exactly like the working case.
 */

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  create: vi.fn(),
  transaction: vi.fn(),
  sendNotificationEmail: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailVerificationCode: {
      findFirst: mocks.findFirst,
      updateMany: mocks.updateMany,
      create: mocks.create,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/notifications/mailer", () => ({
  sendNotificationEmail: mocks.sendNotificationEmail,
  resolveMailerProvider: () => "SMTP",
}));

vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { issueVerificationCode } from "../issueVerificationCode";
import { RESEND_COOLDOWN_SECONDS } from "../emailVerification";

const USER = { id: "user_1", name: "Sujan", email: "sujan@example.com" };
const T0 = new Date("2026-09-10T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: "code_1" });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      emailVerificationCode: { deleteMany: mocks.deleteMany, create: mocks.create },
    })
  );
  mocks.sendNotificationEmail.mockResolvedValue({ status: "SENT", provider: "SMTP" });
});

describe("Delivery means delivery", () => {
  it("succeeds when the provider accepted the message", async () => {
    for (const status of ["SENT", "ACCEPTED"]) {
      mocks.sendNotificationEmail.mockResolvedValue({ status, provider: "SMTP" });
      const r = await issueVerificationCode(USER, T0);
      expect(r.ok).toBe(true);
    }
  });

  it("does NOT succeed on SIMULATED", async () => {
    // The sandbox reports success and sends nothing. Reporting this as sent is
    // what locks every account out: the user waits for a code that was never
    // dispatched, and the only way in is that code.
    mocks.sendNotificationEmail.mockResolvedValue({ status: "SIMULATED", provider: "LOCAL_SANDBOX" });

    const r = await issueVerificationCode(USER, T0);

    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "SEND_FAILED" });
  });

  it("does not succeed on an outright failure", async () => {
    mocks.sendNotificationEmail.mockResolvedValue({ status: "FAILED", provider: "SMTP" });
    const r = await issueVerificationCode(USER, T0);
    expect(r.ok).toBe(false);
  });
});

describe("The code is written before it is sent", () => {
  it("persists the code even when the send then fails", async () => {
    // Order matters. If the send came first, a delivered code could have no row
    // to check it against — unrecoverable for the user, who holds a valid-looking
    // code the system has never heard of. This way they simply request another.
    mocks.sendNotificationEmail.mockResolvedValue({ status: "FAILED", provider: "SMTP" });

    await issueVerificationCode(USER, T0);

    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("stores a hash, never the code itself", async () => {
    await issueVerificationCode(USER, T0);

    const data = mocks.create.mock.calls[0][0].data;
    expect(data.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toMatch(/\b\d{6}\b/);
  });

  it("removes outstanding codes for the address", async () => {
    // Several live codes multiply the guessing surface for free: press resend
    // five times and five different six-digit codes are each acceptable.
    //
    // They are deleted rather than flagged. A flagged code is unusable but its
    // hash sits in the table forever, one per resend, read by nothing.
    await issueVerificationCode(USER, T0);

    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    const arg = mocks.deleteMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ userId: USER.id, email: USER.email });
  });

  it("also sweeps expired codes for the address", async () => {
    await issueVerificationCode(USER, T0);

    const where = mocks.deleteMany.mock.calls[0][0].where;
    // Already inert, and this is the natural moment to clear them.
    expect(JSON.stringify(where)).toContain("expiresAt");
  });
});

describe("Resend cooldown", () => {
  it("refuses a second code inside the window", async () => {
    mocks.findFirst.mockResolvedValue({ id: "code_0", createdAt: T0 });

    const r = await issueVerificationCode(USER, T0);

    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "COOLDOWN" });
    // Nothing was sent, so the endpoint cannot be used to flood an inbox.
    expect(mocks.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it("allows one once the window passes", async () => {
    mocks.findFirst.mockResolvedValue({ id: "code_0", createdAt: T0 });
    const later = new Date(T0.getTime() + (RESEND_COOLDOWN_SECONDS + 1) * 1000);

    const r = await issueVerificationCode(USER, later);

    expect(r.ok).toBe(true);
  });
});

describe("The code never reaches a log", () => {
  it("sends it in the email body and nowhere else", async () => {
    await issueVerificationCode(USER, T0);

    const sent = mocks.sendNotificationEmail.mock.calls[0][0];
    const code = sent.text.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeTruthy();

    // A verification code in an application log is a verification code an
    // operator can read.
    expect(sent.subject).toContain(code as string);
    expect(sent.html).toContain(code as string);
  });
});
