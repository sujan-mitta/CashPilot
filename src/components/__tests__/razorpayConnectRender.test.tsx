import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { RazorpayConnect } from "../RazorpayConnect";

/**
 * What the connection walkthrough actually says at each stage.
 *
 * The setup is a genuine loop — Razorpay needs the webhook URL before it can be
 * configured, and the secret only exists once the merchant invents one there —
 * so a single form asking for all three at once cannot be completed in one
 * pass. It is staged, and each stage has to say the right thing.
 *
 * Rendered on the server, so the first paint is asserted: the state before any
 * fetch resolves. That is the screen a merchant actually meets.
 */

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
});

const render = () => renderToStaticMarkup(React.createElement(RazorpayConnect, {}));

describe("The first thing a merchant sees", () => {
  it("says where to get the keys, precisely", () => {
    const html = render();
    // Not "find your API keys" — the actual menu path, so nobody has to hunt.
    expect(html).toContain("Settings → API Keys");
    expect(html).toContain("Generate Test Key");
  });

  it("warns that the secret is shown only once", () => {
    // The single most common way this goes wrong: closing the dialog before
    // copying, then having to generate a new key.
    expect(render()).toMatch(/shows the secret once/i);
  });

  it("names both fields and what each one is", () => {
    const html = render();
    expect(html).toContain("Key ID");
    expect(html).toContain("Key Secret");
    expect(html).toContain("rzp_test_");
  });

  it("tells them what happens next rather than ending abruptly", () => {
    expect(render()).toMatch(/webhook comes next/i);
  });
});

describe("What it promises before any secret is typed", () => {
  it("states the three commitments up front", () => {
    const html = render();
    // Said before anything is entered, not buried under the form: a merchant is
    // about to hand over credentials that move their money.
    expect(html).toMatch(/test keys only/i);
    expect(html).toMatch(/encrypted/i);
    expect(html).toMatch(/disconnect/i);
  });

  it("explains why live keys are refused rather than just refusing", () => {
    expect(render()).toMatch(/not been audited/i);
  });

  it("says the keys are checked before they are saved", () => {
    // So a typo fails now, not when somebody is owed money.
    expect(render()).toMatch(/before saving/i);
  });
});

describe("Secrets are typed safely", () => {
  it("uses a password field for the secret and not for the key id", () => {
    const html = render();
    // A secret in a plain text field is a secret on a projector and in a screen
    // recording.
    expect(html).toContain('type="password"');
    expect(html).toMatch(/id="rzp-key-id"[^>]*type="text"|type="text"[^>]*id="rzp-key-id"/);
  });

  it("turns off autocomplete on the credential fields", () => {
    // Matched case-insensitively: renderToStaticMarkup emits the JSX prop name
    // (autoComplete) while a real DOM node carries the lowercase attribute.
    // Asserting one spelling passes or fails on a rendering artifact rather
    // than on whether the component sets it.
    expect(render()).toMatch(/autocomplete="off"/i);
  });
});

describe("It never displays a stored credential", () => {
  it("renders no secret value anywhere in the initial markup", () => {
    const html = render();
    // The API cannot return a secret, so nothing here can show one. This pins
    // that the component does not invent a place to try.
    expect(html).not.toMatch(/value="rzp_/);
  });
});
