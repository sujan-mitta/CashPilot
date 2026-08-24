import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";
import { NextResponse } from "next/server";

export interface LogContext {
  requestId: string;
}

export const logStorage = new AsyncLocalStorage<LogContext>();

export function getRequestId(): string {
  return logStorage.getStore()?.requestId ?? "system-background";
}

export function generateRequestId(): string {
  return crypto.randomUUID();
}

export function isSafeRequestId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

function sanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitize);
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("secret") ||
      lowerKey.includes("key") ||
      lowerKey.includes("password") ||
      lowerKey.includes("token") ||
      lowerKey.includes("authorization") ||
      lowerKey.includes("cookie") ||
      lowerKey.includes("signature")
    ) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = sanitize(val);
    }
  }
  return result;
}

export const logger = {
  info(message: string, meta: Record<string, unknown> = {}) {
    const rid = getRequestId();
    console.log(JSON.stringify({ level: "INFO", requestId: rid, message, ...sanitize(meta) as Record<string, unknown> }));
  },
  warn(message: string, meta: Record<string, unknown> = {}) {
    const rid = getRequestId();
    console.warn(JSON.stringify({ level: "WARN", requestId: rid, message, ...sanitize(meta) as Record<string, unknown> }));
  },
  error(message: string, meta: Record<string, unknown> = {}) {
    const rid = getRequestId();
    console.error(JSON.stringify({ level: "ERROR", requestId: rid, message, ...sanitize(meta) as Record<string, unknown> }));
  }
};

export function withCorrelationId(
  handler: (req: Request) => Promise<Response>
) {
  return async (req: Request) => {
    const incomingId = req.headers.get("x-request-id") || req.headers.get("x-correlation-id");
    const requestId = incomingId && isSafeRequestId(incomingId) ? incomingId : generateRequestId();

    const response = await logStorage.run({ requestId }, async () => {
      try {
        const res = await handler(req);
        return res;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error("Unhandled API error", { error: errMsg });
        return NextResponse.json(
          { error: "Internal Server Error", requestId },
          { status: 500 }
        );
      }
    });

    response.headers.set("x-request-id", requestId);
    return response;
  };
}
