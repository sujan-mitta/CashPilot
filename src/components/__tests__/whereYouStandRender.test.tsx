import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { WhereYouStand, type StandingData } from "../WhereYouStand";

/**
 * What this panel actually puts on screen.
 *
 * The arithmetic behind it is tested separately, and passing arithmetic proves
 * nothing about whether the right sentence reaches the operator. These render
 * the real component to HTML and read the result — no browser, no session, no
 * new dependencies, using the react-dom/server this app already ships.
 *
 * What they do NOT cover, stated plainly: layout, colour and anything visual.
 * A test can confirm the words and figures are present and correct; it cannot
 * confirm the panel looks right.
 */

const render = (props: Parameters<typeof WhereYouStand>[0]) =>
  renderToStaticMarkup(React.createElement(WhereYouStand, props));

const shortfall: StandingData = {
  currentCash: 124_000_00,
  totalReceived: 240_000_00,
  outstandingCount: 1,
  received: [
    {
      id: "r1",
      amount: 240_000_00,
      description: "Failed payment - Order #4790",
      settledAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  outstanding: [
    {
      id: "o1",
      amount: 140_000_00,
      description: "Distributor B invoice",
      shortUrl: "https://rzp.io/rzp/abc123",
      paymentLinkId: "plink_abc",
    },
  ],
  progress: {
    status: "SHORTFALL",
    projectedLow: 40_000_00,
    safeFloor: 321_428_00,
    recovered: 240_000_00,
    outstanding: 140_000_00,
    shortfall: 281_428_00,
    outstandingCoversShortfall: false,
    stillNeededBeyondOutstanding: 141_428_00,
    headline: "More is needed to clear your safe floor",
    detail: "Your projection still dips below your safe floor.",
  },
};

const safe: StandingData = {
  ...shortfall,
  // Deliberately keeps its outstanding links. If this were empty, the "shows
  // none of it when already safe" test would pass whether or not the guard
  // exists — the list would be empty either way. Caught by mutation testing.
  outstandingCount: 1,
  progress: {
    ...shortfall.progress,
    status: "SAFE",
    projectedLow: 400_000_00,
    shortfall: 0,
    stillNeededBeyondOutstanding: 0,
    headline: "You are above your safe floor",
    detail: "The money you recovered was enough.",
  },
};

describe("Nothing to say, nothing rendered", () => {
  it("renders nothing without data", () => {
    expect(render({ data: null })).toBe("");
  });

  it("renders nothing when progress is missing", () => {
    // A malformed payload must not produce a half-drawn panel making claims.
    expect(render({ data: { ...shortfall, progress: undefined } as unknown as StandingData })).toBe("");
  });
});

describe("Money that arrived", () => {
  it("states the amount and the resulting balance", () => {
    const html = render({ data: shortfall });
    expect(html).toContain("Payment received");
    expect(html).toContain("₹2,40,000");
    expect(html).toContain("₹1,24,000");
    expect(html).toContain("Failed payment - Order #4790");
  });

  it("pluralises honestly", () => {
    const two = {
      ...shortfall,
      received: [
        shortfall.received[0],
        { id: "r2", amount: 100_00, description: "Second", settledAt: "2026-09-01T13:00:00.000Z" },
      ],
    };
    expect(render({ data: two })).toContain("2 payments received");
    expect(render({ data: shortfall })).toContain("Payment received");
  });

  it("shows no receipt block when nothing has arrived", () => {
    // An empty "you have received nothing" box is worse than no box.
    const none = { ...shortfall, received: [], totalReceived: 0 };
    expect(render({ data: none })).not.toContain("Payment received");
  });
});

describe("Where that leaves you", () => {
  it("shows the shortfall headline and the three figures", () => {
    const html = render({ data: shortfall });
    expect(html).toContain("More is needed to clear your safe floor");
    expect(html).toContain("Lowest it will get");
    expect(html).toContain("Safe minimum to hold");
    expect(html).toContain("Still short by");
  });

  it("renders figures compactly with the exact value on hover", () => {
    const html = render({ data: shortfall });

    // The safe floor and the shortfall are both over a lakh, which is where
    // compacting applies at all. Asserting on a figure BELOW a lakh would pass
    // whether or not the component compacts anything, because formatINRCompact
    // deliberately falls through to the exact form there — a mutation survived
    // exactly that mistake.
    expect(html).toContain("₹3.21L"); // safe floor
    expect(html).toContain("₹2.81L"); // shortfall

    // ...and the exact value stays reachable. A summary must never be the only
    // available number.
    expect(html).toContain('title="₹3,21,428"');
    expect(html).toContain('title="₹2,81,428"');
  });

  it("does not compact a figure below one lakh", () => {
    // Rounding there would discard precision people track to the rupee.
    const html = render({ data: shortfall });
    expect(html).toContain("₹40,000");
    expect(html).not.toContain("₹0.4L");
  });

  it("switches the label when safe", () => {
    const html = render({ data: safe });
    expect(html).toContain("You are above your safe floor");
    expect(html).toContain("Clear by");
    expect(html).not.toContain("Still short by");
  });
});

describe("What is still available", () => {
  it("lists outstanding links with a way to open each", () => {
    const html = render({ data: shortfall });
    expect(html).toContain("Still waiting to be paid");
    expect(html).toContain("Distributor B invoice");
    expect(html).toContain("https://rzp.io/rzp/abc123");
    expect(html).toContain("Open link");
  });

  it("names what is still needed beyond every link", () => {
    expect(render({ data: shortfall })).toContain("Even if every link above is paid");
  });

  it("shows none of it when already safe", () => {
    // A business above its floor should not be handed a list of things to
    // worry about.
    const html = render({ data: safe });
    expect(html).not.toContain("Still waiting to be paid");
    expect(html).not.toContain("Even if every link above is paid");
  });

  it("omits the link when there is no usable URL", () => {
    // Offering a button that goes nowhere is worse than offering none.
    const noUrl = {
      ...shortfall,
      outstanding: [{ ...shortfall.outstanding[0], shortUrl: null }],
    };
    const html = render({ data: noUrl });
    expect(html).toContain("Distributor B invoice");
    expect(html).not.toContain("Open link");
  });
});

describe("A plan overtaken by a payment", () => {
  it("says so when money landed after the plan was built", () => {
    const html = render({ data: shortfall, planCreatedAt: "2026-09-01T09:00:00.000Z" });
    expect(html).toContain("This plan is out of date");
    expect(html).toContain("arrived after it was built");
  });

  it("stays quiet when the plan is newer than every payment", () => {
    const html = render({ data: shortfall, planCreatedAt: "2026-09-01T18:00:00.000Z" });
    expect(html).not.toContain("This plan is out of date");
  });

  it("stays quiet on a page showing no plan at all", () => {
    // The dashboard passes nothing; there is no plan to invalidate.
    expect(render({ data: shortfall })).not.toContain("This plan is out of date");
  });
});
