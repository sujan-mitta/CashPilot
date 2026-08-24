import { NextResponse } from "next/server";
import { withCorrelationId } from "@/lib/observability";

export const GET = withCorrelationId(async () => {
  return NextResponse.json({ status: "ok" });
});
