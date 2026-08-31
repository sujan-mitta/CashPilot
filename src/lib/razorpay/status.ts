/**
 * What the Razorpay integration is currently capable of.
 *
 * Reported so onboarding can tell someone the truth about whether recovery
 * links will actually reach a payer, instead of offering a "connect Razorpay"
 * button that leads to a provider nobody configured.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN
 *
 * The key id and the key secret, neither in full nor partially. A key id is not
 * as sensitive as a secret, but it identifies the merchant account and there is
 * no reason onboarding needs it — the only question a user is asking is "will
 * this work, and am I pointed at test or live money". Mode answers that. A
 * masked key would answer it too while creating a value that gets logged,
 * screenshotted and pasted into issue trackers.
 */

export type RazorpayMode = "TEST" | "LIVE" | "NOT_CONFIGURED";

export interface RazorpayIntegrationStatus {
  /** Whether real provider calls will be made. */
  connected: boolean;
  mode: RazorpayMode;
  /** True when the deployment is wired to real money. */
  handlesRealMoney: boolean;
  /** One sentence, safe to render. */
  detail: string;
}

/**
 * Placeholder credentials count as absent.
 *
 * The repo ships placeholder values so a checkout runs without secrets, and
 * treating those as configured would report a working integration to someone
 * who has set nothing up.
 */
function isPlaceholder(value: string | undefined): boolean {
  return !value || value.includes("placeholder");
}

export function describeRazorpayIntegration(
  keyId: string | undefined = process.env.RAZORPAY_KEY_ID,
  keySecret: string | undefined = process.env.RAZORPAY_KEY_SECRET
): RazorpayIntegrationStatus {
  if (isPlaceholder(keyId) || isPlaceholder(keySecret)) {
    return {
      connected: false,
      mode: "NOT_CONFIGURED",
      handlesRealMoney: false,
      detail:
        "No Razorpay credentials are configured for this deployment, so recovery links cannot be issued to a real payer yet.",
    };
  }

  // Razorpay key ids carry their environment in the prefix. Anything else is
  // reported as unconfigured rather than guessed at: claiming TEST for a key we
  // cannot classify is the one error here that could move real money by
  // accident.
  if (keyId!.startsWith("rzp_test_")) {
    return {
      connected: true,
      mode: "TEST",
      handlesRealMoney: false,
      detail:
        "Razorpay is connected in TEST mode. Recovery links are real and payable with Razorpay's test instruments, and no real money moves.",
    };
  }

  if (keyId!.startsWith("rzp_live_")) {
    return {
      connected: true,
      mode: "LIVE",
      handlesRealMoney: true,
      detail:
        "Razorpay is connected in LIVE mode. Recovery links issued from here charge real money.",
    };
  }

  return {
    connected: false,
    mode: "NOT_CONFIGURED",
    handlesRealMoney: false,
    detail:
      "The configured Razorpay key could not be identified as test or live, so it is treated as unconfigured rather than assumed safe.",
  };
}
