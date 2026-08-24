import { cookies } from "next/headers";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

export interface UserSession {
  userId: string;
  name: string;
  email: string;
  businessId: string;
  businessName: string;
}

const SECRET = process.env.SESSION_SECRET || "default_super_secret_cashpilot_session_key_32_chars";

function assertSafeSecret() {
  const secret = process.env.SESSION_SECRET;
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    if (!secret || secret.trim().length === 0 || secret.includes("placeholder") || secret === "default_super_secret_cashpilot_session_key_32_chars") {
      throw new Error("CRITICAL: SESSION_SECRET is not configured or is a development default in production environment. Refusing to operate.");
    }
  }
}

/**
 * Signs the session payload with an HMAC-SHA256 signature, embedding an expiration timestamp.
 */
export function signSession(payload: Record<string, unknown>): string {
  assertSafeSecret();
  const payloadWithExp = {
    ...payload,
    exp: Date.now() + 604800000, // 7 days in milliseconds
  };
  const payloadStr = JSON.stringify(payloadWithExp);
  const signature = crypto.createHmac("sha256", SECRET).update(payloadStr).digest("hex");
  return `${Buffer.from(payloadStr).toString("base64")}.${signature}`;
}

/**
 * Verifies and parses the signed session token, checking the expiration timestamp.
 * Returns null if the signature is invalid or if the session has expired.
 */
export function verifySession(token: string): Record<string, unknown> | null {
  assertSafeSecret();
  try {
    const [payloadBase64, signature] = token.split(".");
    if (!payloadBase64 || !signature) return null;
    const payloadStr = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const expectedSignature = crypto.createHmac("sha256", SECRET).update(payloadStr).digest("hex");
    
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (signatureBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
      const parsed = JSON.parse(payloadStr);
      if (parsed && typeof parsed.exp === "number") {
        if (Date.now() > parsed.exp) {
          console.warn("Session expired cryptographically.");
          return null;
        }
      }
      return parsed;
    }
  } catch (error) {
    console.error("Session verification error:", error);
  }
  return null;
}

/**
 * Retrieves the current authenticated user session from the secure cookies.
 * Returns null if the session is not found, signature is invalid, or the user/business no longer exists/is linked.
 */
export async function getSession(): Promise<UserSession | null> {
  try {
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get("cashpilot_session");

    if (!sessionCookie || !sessionCookie.value) {
      return null;
    }

    const payload = verifySession(sessionCookie.value) as Partial<UserSession> | null;
    if (!payload || !payload.userId || !payload.businessId) {
      return null;
    }

    // Verify user and business access in database
    const hasAccess = await requireBusinessAccess(payload.userId, payload.businessId);
    if (!hasAccess) {
      return null;
    }

    return payload as UserSession;
  } catch (error) {
    console.error("Authentication session retrieval error:", error);
  }
  return null;
}

/**
 * Verifies that the user exists and is authorized to access the requested business.
 */
export async function requireBusinessAccess(userId: string, businessId: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        businesses: {
          where: { id: businessId },
        },
      },
    });
    return !!(user && user.businesses.length > 0);
  } catch (error) {
    console.error("Business access check error:", error);
    return false;
  }
}
