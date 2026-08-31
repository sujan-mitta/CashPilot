import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveMailerProvider } from "../mailer";

/**
 * Choosing a mail provider on credentials it actually has.
 *
 * THE BUG: the gate checked SMTP_HOST and SMTP_USER, while the transport
 * authenticates with SMTP_PASSWORD. A deployment with host and user but no
 * password selected SMTP and then failed at authentication on every single
 * send. Verification codes never arrived, and nothing about the configuration
 * looked wrong — the provider had been chosen on credentials nobody checked
 * for.
 *
 * Falling through to the sandbox is strictly better, because the sandbox is a
 * state the rest of the system understands: `verificationCanBeRequired()` sees
 * it and stands the sign-in gate down, so a half-configured deployment leaves
 * people signed in rather than stranded behind a code that cannot be sent.
 */

const MAIL_VARS = ["RESEND_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of MAIL_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MAIL_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("SMTP is chosen only when it can authenticate", () => {
  it("selects SMTP when host, user and password are all present", () => {
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "someone@example.com";
    process.env.SMTP_PASSWORD = "app-password";
    expect(resolveMailerProvider()).toBe("SMTP");
  });

  it("does NOT select SMTP when the password is missing", () => {
    // This is the bug. Host and user alone chose SMTP, and every send then
    // failed at auth — silently, from the operator's point of view.
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "someone@example.com";
    expect(resolveMailerProvider()).toBe("LOCAL_SANDBOX");
  });

  it("does not select SMTP on an empty-string password", () => {
    // A variable that exists but was set to nothing is the same as absent, and
    // is a common shape for a half-finished deployment config.
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "someone@example.com";
    process.env.SMTP_PASSWORD = "";
    expect(resolveMailerProvider()).toBe("LOCAL_SANDBOX");
  });

  it("does not select SMTP with a password but no host", () => {
    process.env.SMTP_USER = "someone@example.com";
    process.env.SMTP_PASSWORD = "app-password";
    expect(resolveMailerProvider()).toBe("LOCAL_SANDBOX");
  });
});

describe("Provider precedence", () => {
  it("prefers Resend when its key is set", () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.SMTP_HOST = "smtp.gmail.com";
    process.env.SMTP_USER = "someone@example.com";
    process.env.SMTP_PASSWORD = "app-password";
    expect(resolveMailerProvider()).toBe("RESEND");
  });

  it("falls back to the sandbox when nothing is configured", () => {
    expect(resolveMailerProvider()).toBe("LOCAL_SANDBOX");
  });
});
