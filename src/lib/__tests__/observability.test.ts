import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, generateRequestId, isSafeRequestId, withCorrelationId } from "../observability";
import { classifyProviderError } from "../razorpay/client";

describe("Observability & Safe Logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("scrubs secrets recursively from log metadata", () => {
    logger.info("Test log", {
      RAZORPAY_KEY_SECRET: "rzp_live_secret123",
      webhook_secret: "whsec_abcd",
      session_secret: "somesecretkey",
      authorization: "Bearer some_token",
      cookies: "session=xyz",
      signature: "abcdef",
      nested: {
        password: "my-password",
        safeValue: "safe-info"
      }
    });

    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.RAZORPAY_KEY_SECRET).toBe("[REDACTED]");
    expect(output.webhook_secret).toBe("[REDACTED]");
    expect(output.session_secret).toBe("[REDACTED]");
    expect(output.authorization).toBe("[REDACTED]");
    expect(output.cookies).toBe("[REDACTED]");
    expect(output.signature).toBe("[REDACTED]");
    expect(output.nested.password).toBe("[REDACTED]");
    expect(output.nested.safeValue).toBe("safe-info");
  });

  it("generates random valid correlation IDs", () => {
    const id = generateRequestId();
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(10);
  });

  it("validates request ID safety patterns correctly", () => {
    expect(isSafeRequestId("safe-id-123_abc")).toBe(true);
    expect(isSafeRequestId("unsafe id with spaces")).toBe(false);
    expect(isSafeRequestId("unsafe;inject=true")).toBe(false);
  });

  it("handles existing correlation IDs safely and issues new ones if unsafe", async () => {
    const safeHandler = async () => new Response("ok");
    const wrapped = withCorrelationId(safeHandler);

    // Case 1: Safe correlation ID passed
    const req1 = new Request("http://localhost/api/health", {
      headers: { "x-request-id": "safe-req-id" }
    });
    const res1 = await wrapped(req1);
    expect(res1.headers.get("x-request-id")).toBe("safe-req-id");

    // Case 2: Unsafe/injection correlation ID passed
    const req2 = new Request("http://localhost/api/health", {
      headers: { "x-request-id": "unsafe; injection" }
    });
    const res2 = await wrapped(req2);
    const issuedId = res2.headers.get("x-request-id");
    expect(issuedId).not.toBe("unsafe; injection");
    expect(isSafeRequestId(issuedId!)).toBe(true);
  });

  it("classifies Razorpay errors safely and logs them without credentials", () => {
    const rawError = {
      statusCode: 429,
      error: {
        code: "BAD_REQUEST_ERROR",
        description: "Rate limit exceeded"
      }
    };
    classifyProviderError(rawError);
    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.level).toBe("INFO");
    expect(output.message).toBe("Razorpay error classified");
    expect(output.classification).toBe("rate limited");
    expect(output.httpStatus).toBe(429);
  });
});
