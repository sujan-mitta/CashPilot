import { NextResponse, type NextRequest } from "next/server";

/**
 * ===========================================================================
 * ROUTE PROTECTION
 * ===========================================================================
 *
 * Before this there was no middleware at all. Every page was a client
 * component whose only gate was:
 *
 *     const checkUser = localStorage.getItem("cashpilot_user");
 *     if (!checkUser) router.push("/login");
 *
 * No data leaked - the API routes have always enforced the session server-side
 * - but the consequences were real:
 *
 *   1. The whole app shell rendered for a signed-out visitor before the client
 *      bounced them, so the first thing anyone saw was a flash of a financial
 *      dashboard that was not theirs to see.
 *   2. `localStorage.cashpilot_user = "{}"` in a console passed the gate, and
 *      the visitor then sat inside the app watching every request 401.
 *   3. When the 7-day cookie lapsed while localStorage persisted, the UI still
 *      believed the operator was signed in. Only the dashboard handled a 401
 *      by signing out; every other page just rendered errors.
 *
 * This checks for the SESSION COOKIE, which is the thing that actually
 * authenticates. It deliberately does NOT verify the signature: the Edge
 * runtime has no access to Prisma, and a forged cookie gets past here only to
 * be rejected by `getSession()` on the first API call, which is the real
 * boundary. This removes the flash and the impossible states; it does not
 * replace server-side authorisation and is not trying to.
 */

const SESSION_COOKIE = "cashpilot_session";

/** Pages that require a session. */
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/onboarding",
  "/investigation",
  "/strategies",
  "/approval",
  "/execution",
  "/history",
  "/profile",
];

/** Pages that make no sense while already signed in. */
const AUTH_ONLY_PREFIXES = ["/login"];

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  if (!hasSession && PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Where they were headed, so sign-in can return them there. Only ever a
    // same-origin PATH - never a full URL, which would make this an open
    // redirect.
    if (pathname !== "/dashboard") {
      url.searchParams.set("next", `${pathname}${search}`);
    }
    return NextResponse.redirect(url);
  }

  if (hasSession && AUTH_ONLY_PREFIXES.some((p) => pathname.startsWith(p))) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Pages only.
   *
   * API routes are excluded on purpose: they must answer 401 so the client can
   * react, and a redirect to an HTML page in response to a fetch is worse than
   * useless. Static assets and the image optimiser are excluded because
   * redirecting them would break the login page's own styling.
   */
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sandbox|auth|.*\\.).*)"],
};
