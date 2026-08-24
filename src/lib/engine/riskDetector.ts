import { FINANCIAL_CONFIG } from "./financialConfig";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

// Single source of truth lives in financialConfig.ts (Phase 14, PART 37).
const SAFETY_THRESHOLD = FINANCIAL_CONFIG.SAFETY_THRESHOLD;

export function calculateRisk(
  minProjectedBalance: number,
  safetyThreshold: number = SAFETY_THRESHOLD
): RiskLevel {
  if (minProjectedBalance < 0) return "HIGH";
  if (minProjectedBalance < safetyThreshold) return "MEDIUM";
  return "LOW";
}
