import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Google sign-in records the proof it already demanded.
 *
 * THE BUG: the callback refuses a Google account whose email Google itself has
 * not verified — that check IS a completed round trip, and stronger evidence
 * than our own six-digit code. But nothing wrote it down, so a Google user
 * stayed `emailVerified: null` forever. Every alert to them was suppressed as
 * "unverified", and there was no way out: they sign in through Google, so they
 * never reach the code screen that would set it.
 *
 * The failure is silent in the worst way — sign-in works perfectly, and the
 * alerts simply never arrive.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  exchangeCodeForIdentity: vi.fn(),
  isGoogleConfigured: vi.fn(() => true),
  resolveRedirectUri: vi.fn(() => "https://app.test/api/auth/google/callback"),
  cookieGet: vi.fn(),
  cookieDelete: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique, update: mocks.update } },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: mocks.cookieGet,
    delete: mocks.cookieDelete,
    set: mocks.cookieSet,
  }),
}));

vi.mock("@/lib/auth/googleOAuth", () => ({
  exchangeCodeForIdentity: mocks.exchangeCodeForIdentity,
  isGoogleConfigured: mocks.isGoogleConfigured,
  resolveRedirectUri: mocks.resolveRedirectUri,
  OAUTH_STATE_COOKIE: "cp_oauth_state",
}));

vi.mock("@/lib/auth", () => ({ signSession: () => "signed.session.token" }));

vi.mock("@/lib/observability", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "../google/callback/route";

const STATE = "state-value-abc";

const callback = () =>
  GET(new Request(`https://app.test/api/auth/google/callback?code=xyz&state=${STATE}`));

const account = (over: Record<string, unknown> = {}) => ({
  id: "user_1",
  email: "sujan@example.com",
  name: "Sujan",
  emailVerified: null,
  businesses: [{ id: "biz_1", name: "ABC Electronics" }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isGoogleConfigured.mockReturnValue(true);
  mocks.resolveRedirectUri.mockReturnValue("https://app.test/api/auth/google/callback");
  mocks.cookieGet.mockReturnValue({ value: STATE });
  mocks.exchangeCodeForIdentity.mockResolvedValue({
    email: "sujan@example.com",
    emailVerified: true,
  });
  mocks.findUnique.mockResolvedValue(account());
  mocks.update.mockResolvedValue({});
});

describe("A Google identity counts as a verified address", () => {
  it("marks a previously unverified account as verified", async () => {
    await callback();

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const arg = mocks.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "user_1" });
    expect(arg.data.emailVerified).toBeInstanceOf(Date);
  });

  it("still signs the user in", async () => {
    // The write must not have displaced the thing the route exists to do.
    const res = await callback();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("does not rewrite a timestamp that is already set", async () => {
    // Re-stamping on every sign-in would destroy the record of WHEN the address
    // was first proven, which is the only audit value the column carries.
    mocks.findUnique.mockResolvedValue(
      account({ emailVerified: new Date("2026-01-01T00:00:00.000Z") })
    );

    await callback();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("It does not manufacture verification", () => {
  it("verifies nothing when Google says the email is unverified", async () => {
    // Google's own refusal is the evidence. Without it there is no round trip,
    // and writing the flag anyway would be inventing the proof.
    mocks.exchangeCodeForIdentity.mockResolvedValue({
      email: "sujan@example.com",
      emailVerified: false,
    });

    const res = await callback();

    expect(mocks.update).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("google_email_unverified");
  });

  it("verifies nothing when no account exists", async () => {
    // This route signs in existing users only; there is nobody to verify.
    mocks.findUnique.mockResolvedValue(null);

    const res = await callback();

    expect(mocks.update).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("google_no_account");
  });

  it("verifies nothing when the CSRF state does not match", async () => {
    mocks.cookieGet.mockReturnValue({ value: "a-different-state" });

    const res = await callback();

    expect(mocks.update).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("google_state");
  });
});
