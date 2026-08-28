"use client";

import React, { createContext, useContext, useState, ReactNode, useEffect } from "react";

export interface Action {
  id: string;
  actionType: string;
  amount: number;
  status: string;
  result: string | null;
  label?: string;
}

export interface Strategy {
  id: string;
  name: string;
  actions: {
    id: string;
    type: string;
    sourceEntityId: string;
    amount: number;
    effectiveDate: string;
    status: string;
    label: string;
  }[];
  forecast: {
    date: string;
    openingBalance: number;
    expectedInflows: number;
    expectedOutflows: number;
    projectedBalance: number;
  }[];
  result: {
    projectedBalance: number;
    minimumProjectedBalance: number;
    crisisDay: number | null;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
  };
  scoring: {
    liquiditySafety: number;
    deficitElimination: number;
    criticalObligationProtection: number;
    lowDisruption: number;
    executionConfidence: number;
    finalScore: number;
    strengths?: string[];
    tradeoffs?: string[];
    // Present on the fuller payloads; absent on some cached shapes, hence the
    // object itself is optional. When present it is complete.
    counterfactual?: {
      baselineMinimumBalance: number;
      strategyMinimumBalance: number;
      minimumBalanceDelta: number;
      baselineDeficitDays: number;
      strategyDeficitDays: number;
      deficitDaysDelta: number;
      baselineCoverageRatio: number;
      strategyCoverageRatio: number;
      coverageRatioDelta: number;
      baselineCriticalObligationsProtected: number;
      strategyCriticalObligationsProtected: number;
      criticalObligationsProtectedDelta: number;
      effectiveness: string;
    };
    deferredObligations?: {
      count: number;
      amount: number;
      latestDueDate?: string | null;
      items?: {
        sourceId: string;
        amount: number;
        originalDueDate: string;
        newDueDate: string;
      }[];
    };
  };
  /** Top-level balance on the single-strategy GET payload (result carries it too). */
  projectedBalance?: number;
  /** Obligations this strategy pushed beyond the forecast horizon. */
  deferredObligations?: {
    sourceId?: string;
    amount: number;
    originalDueDate: string;
    newDueDate: string;
    daysBeyondHorizon: number;
  }[];
  recommended: boolean;
  agentActions?: Action[];
}

export interface ForecastDayPoint {
  date: string;
  openingBalance: number;
  expectedInflows: number;
  expectedOutflows: number;
  projectedBalance: number;
}

/** The adaptive per-business buffer, as /api/forecast returns it. */
export interface SafetyRequirement {
  requiredBuffer: number;
  coverageDays: number;
  averageDailyOutflow: number;
  absoluteFloorApplied: boolean;
  methodology: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  dataWarnings: string[];
}

/**
 * The COMPLETE shape of GET /api/forecast.
 *
 * This type declared only five fields of `forecast`, while the dashboard read
 * `safetyRequirement`, `criticalObligations` and `temporalRisk` off it through
 * `as any`. Because the type was a fiction, the compiler could not see that the
 * strategies page was writing a partial object into this same cache and
 * silently removing three cards from the dashboard. Every field the API
 * actually returns is declared here so that class of bug becomes a type error.
 */
export interface ForecastResponse {
  status: "SUCCESS" | "NO_DATA" | "ERROR";
  business: {
    id: string;
    name: string;
    currentCash: number;
  } | null;
  forecast: {
    horizonDays: number;
    safetyThreshold: number;
    safetyRequirement: SafetyRequirement;
    days: ForecastDayPoint[];
    runway: {
      firstBelowSafetyThreshold: string | null;
      firstNegativeDay: string | null;
      minimumProjectedBalance: number;
    };
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    criticalObligations: {
      count: number;
      amount: number;
      protected: number;
    };
    temporalRisk: {
      firstCriticalDate: string | null;
      criticalAmount: number;
    };
    /**
     * Phase 10/13. Optional because a cached response from an earlier session
     * predates them; every consumer must handle their absence rather than
     * assuming a deploy has rolled everywhere at once.
     */
    scenarios?: ScenarioBand;
    confidence?: ForecastConfidenceSummary;
  } | null;
}

/** One scenario, reduced to the numbers worth showing. */
export interface ScenarioSummary {
  closingBalance: number;
  minimumBalance: number;
  minimumBalanceDay: number;
  firstDayBelowSafety: number | null;
}

export interface ScenarioBand {
  /**
   * True when all three coincide. That means no timing uncertainty has been
   * MEASURED - not that there is none - which is why it drives confidence down.
   */
  degenerate: boolean;
  optimistic: ScenarioSummary;
  base: ScenarioSummary;
  conservative: ScenarioSummary;
}

export interface ForecastConfidenceSummary {
  level: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";
  eventsTotal: number;
  eventsWithMeasuredTiming: number;
  widestBandDays: number;
  outcomeSpread: number;
  reasons: string[];
}

export interface InvestigationResponse {
  status: "SUCCESS";
  summary: {
    projectedDeficit: number;
    crisisDay: number | null;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
  };
  causes: {
    id: string;
    rank: number;
    type: "TIMING_MISMATCH" | "FAILED_PAYMENT" | "OVERDUE_RECEIVABLE";
    severity: "LOW" | "MEDIUM" | "HIGH";
    amount: number;
    classification: "ROOT_CAUSE" | "INTERVENTION_OPPORTUNITY";
    title: string;
    deterministicExplanation: string;
    evidence: {
      events?: { description: string; amount: number; expectedDate: string }[];
      transactions?: { id: string; description: string | null; amount: number; expectedDate: string }[];
      invoices?: { id: string; customerName: string; amount: number; dueDate: string }[];
    };
  }[];
  opportunities: {
    failedPaymentRecovery: number;
    overdueReceivables: number;
    totalPotentialLiquidity: number;
  };
  aiNarrative: string;
}

interface UserSession {
  userId: string;
  name: string;
  email: string;
  businessId: string;
  businessName: string;
}

interface CashPilotState {
  user: UserSession | null;
  login: (session: UserSession) => void;
  logout: () => void;
  selectedStrategyId: string | null;
  setSelectedStrategyId: (id: string | null) => void;
  cachedForecast: ForecastResponse | null;
  setCachedForecast: (f: ForecastResponse | null) => void;
  cachedStrategies: Strategy[] | null;
  setCachedStrategies: (s: Strategy[] | null) => void;
  cachedRecommendationNarration: string | null;
  setCachedRecommendationNarration: (n: string | null) => void;
  cachedInvestigation: InvestigationResponse | null;
  setCachedInvestigation: (i: InvestigationResponse | null) => void;
}

const CashPilotContext = createContext<CashPilotState | null>(null);

export function CashPilotProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserSession | null>(null);
  const [selectedStrategyId, setSelectedStrategyId] = useState<string | null>(null);
  const [cachedForecast, setCachedForecast] = useState<ForecastResponse | null>(null);
  const [cachedStrategies, setCachedStrategies] = useState<Strategy[] | null>(null);
  const [cachedRecommendationNarration, setCachedRecommendationNarration] = useState<string | null>(null);
  const [cachedInvestigation, setCachedInvestigation] = useState<InvestigationResponse | null>(null);

  // Load session from localStorage on client-side mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("cashpilot_user");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setTimeout(() => {
            setUser(parsed);
          }, 0);
        } catch {
          localStorage.removeItem("cashpilot_user");
        }
      }
    }
  }, []);

  const login = (session: UserSession) => {
    setUser(session);
    localStorage.setItem("cashpilot_user", JSON.stringify(session));
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("cashpilot_user");
    // Securely trigger server-side logout to clear httpOnly cookie
    fetch("/api/auth/logout", { method: "POST" }).catch((err) => {
      console.error("Failed to execute logout on server:", err);
    });
    // Clear other caches too
    setCachedForecast(null);
    setCachedStrategies(null);
    setCachedRecommendationNarration(null);
    setCachedInvestigation(null);
  };

  return (
    <CashPilotContext.Provider
      value={{
        user,
        login,
        logout,
        selectedStrategyId,
        setSelectedStrategyId,
        cachedForecast,
        setCachedForecast,
        cachedStrategies,
        setCachedStrategies,
        cachedRecommendationNarration,
        setCachedRecommendationNarration,
        cachedInvestigation,
        setCachedInvestigation,
      }}
    >
      {children}
    </CashPilotContext.Provider>
  );
}

export function useCashPilot() {
  const ctx = useContext(CashPilotContext);
  if (!ctx) {
    throw new Error("useCashPilot must be used within CashPilotProvider");
  }
  return ctx;
}
