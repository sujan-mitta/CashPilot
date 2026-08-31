import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Signing up again with an email that never finished verifying.
 *
 * THE DEAD END: signup creates the account and then waits for a code. Close the
 * tab, lose the email, or let the code expire, and you own an account you
 * cannot reach — signing up again answered "already exists, please sign in",
 * and signing in asked for the code you never had. Two refusals, each correct
 * on its own, that together lock the door from both sides.
 *
 * The fix is to RESUME, not to delete the half-made account. Deleting on an
 * incomplete verification would destroy an account because somebody closed a
 * tab, and would release their email and business name for anyone else to claim
 * in the window before they came back.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  transaction: vi.fn(),
  issueVerificationCode: vi.fn(),
  verificationCanBeRequired: vi.fn(() => true),
  rateLimit: vi.fn(() => ({ ok: true })),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.findUnique },
    business: { findFirst: mocks.findFirst },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/auth/issueVerificationCode", () => ({
  issueVerificationCode: mocks.issueVerificationCode,
}));

vi.mock("@/lib/auth/verificationPolicy", () => ({
  verificationCanBeRequired: mocks.verificationCanBeRequired,
}));

vi.mock("@/lib/auth/rateLimit", () => ({
  rateLimit: mocks.rateLimit,
  clientKey: () => "test-client",
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));
vi.mock("@/lib/auth", () => ({ signSession: () => "signed.token" }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: async () => "hashed" }));
vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "../signup/route";

const body = (over: Record<string, unknown> = {}) => ({
  name: "Sujan",
  email: "pending@example.com",
  businessName: "Brand New Co",
  password: "a-good-password",
  ...over,
});

const post = (payload: Record<string, unknown> = body()) =>
  POST(
    new Request("https://app.test/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );

const unverified = {
  id: "user_1",
  name: "Sujan",
  email: "pending@example.com",
  emailVerified: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockReturnValue({ ok: true });
  mocks.verificationCanBeRequired.mockReturnValue(true);
  mocks.issueVerificationCode.mockResolvedValue({ ok: true, expiresAt: new Date() });
  mocks.findFirst.mockResolvedValue(null);
});

describe("An unfinished signup can be resumed", () => {
  it("re-sends a code instead of refusing", async () => {
    mocks.findUnique.mockResolvedValue(unverified);

    const res = await post();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.requiresVerification).toBe(true);
    expect(data.email).toBe("pending@example.com");
    expect(mocks.issueVerificationCode).toHaveBeenCalledTimes(1);
  });

  it("does not create a second account", async () => {
    mocks.findUnique.mockResolvedValue(unverified);

    await post();

    // The account already exists. Making another would either collide on the
    // unique email or quietly orphan the first.
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("changes nothing about the existing account", async () => {
    // Anyone can type someone else's address into a signup form. Resuming must
    // therefore be inert: it re-sends a code to the address on file and touches
    // nothing, so the worst a stranger achieves is one email to its owner.
    mocks.findUnique.mockResolvedValue(unverified);

    await post(body({ password: "attacker-chosen", businessName: "Attacker Co" }));

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("issues no session", async () => {
    // The whole point is that the address is still unproven.
    mocks.findUnique.mockResolvedValue(unverified);

    await post();

    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("still reports the pending state when the code cannot be sent", async () => {
    mocks.findUnique.mockResolvedValue(unverified);
    mocks.issueVerificationCode.mockResolvedValue({ ok: false, reason: "SEND_FAILED" });

    const data = await (await post()).json();

    // Silence would leave them retrying signup forever.
    expect(data.requiresVerification).toBe(true);
    expect(data.error).toMatch(/could not send/i);
  });
});

describe("A finished account is still refused", () => {
  it("tells a verified account to sign in", async () => {
    mocks.findUnique.mockResolvedValue({ ...unverified, emailVerified: new Date() });

    const res = await post();
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/already exists/i);
    expect(mocks.issueVerificationCode).not.toHaveBeenCalled();
  });

  it("refuses rather than resumes when verification is not required at all", async () => {
    // With no mailer there is no pending-verification state to resume, so the
    // account is simply an existing account.
    mocks.findUnique.mockResolvedValue(unverified);
    mocks.verificationCanBeRequired.mockReturnValue(false);

    const res = await post();

    expect(res.status).toBe(409);
    expect(mocks.issueVerificationCode).not.toHaveBeenCalled();
  });
});

describe("A member-less business does not reserve its name", () => {
  beforeEach(() => mocks.findUnique.mockResolvedValue(null));

  it("queries only businesses that still have members", () => {
    // A business with no members is unreachable — there is no path to join an
    // existing business — so it exists only as a tombstone left behind when its
    // last member was deleted. Letting it hold the name meant deleting an
    // account blocked its own business name forever, and the refusal advised
    // asking "an existing member" of a business that has none.
    mocks.findFirst.mockResolvedValue(null);
    mocks.transaction.mockResolvedValue({
      user: { id: "u", name: "S", email: "new@example.com" },
      business: { id: "b", name: "Brand New Co" },
    });

    return post().then(() => {
      const where = mocks.findFirst.mock.calls[0][0].where;
      expect(where.users).toEqual({ some: {} });
    });
  });

  it("still refuses a name held by a business with members", async () => {
    mocks.findFirst.mockResolvedValue({ id: "b_existing", name: "Brand New Co" });

    const res = await post();
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/already registered/i);
  });
});
