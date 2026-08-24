import { describe, it, expect } from "vitest";
import { validateActionTransition, validateRecoveryTransition } from "../stateTransitions";
import { ActionStatus, RecoveryStatus } from "../../../../generated/prisma/client";

describe("State Transitions Machine", () => {
  describe("validateActionTransition", () => {
    it("permits standard valid action transitions", () => {
      expect(validateActionTransition(ActionStatus.PENDING, ActionStatus.APPROVED)).toBe(true);
      expect(validateActionTransition(ActionStatus.APPROVED, ActionStatus.EXECUTING)).toBe(true);
      expect(validateActionTransition(ActionStatus.EXECUTING, ActionStatus.COMPLETED)).toBe(true);
      expect(validateActionTransition(ActionStatus.EXECUTING, ActionStatus.FAILED)).toBe(true);
    });

    it("prevents invalid action transitions", () => {
      expect(validateActionTransition(ActionStatus.PENDING, ActionStatus.EXECUTING)).toBe(false);
      expect(validateActionTransition(ActionStatus.COMPLETED, ActionStatus.EXECUTING)).toBe(false);
      expect(validateActionTransition(ActionStatus.COMPLETED, ActionStatus.PENDING)).toBe(false);
    });

    it("allows identical state identity transitions", () => {
      expect(validateActionTransition(ActionStatus.PENDING, ActionStatus.PENDING)).toBe(true);
      expect(validateActionTransition(ActionStatus.COMPLETED, ActionStatus.COMPLETED)).toBe(true);
    });
  });

  describe("validateRecoveryTransition", () => {
    it("permits standard valid recovery transitions", () => {
      expect(validateRecoveryTransition(RecoveryStatus.RECOVERY_CANDIDATE, RecoveryStatus.RECOVERY_INITIATED)).toBe(true);
      expect(validateRecoveryTransition(RecoveryStatus.RECOVERY_INITIATED, RecoveryStatus.PAYMENT_PENDING)).toBe(true);
      expect(validateRecoveryTransition(RecoveryStatus.PAYMENT_PENDING, RecoveryStatus.RECOVERED)).toBe(true);
    });

    it("allows error fallback transitions to FAILED", () => {
      expect(validateRecoveryTransition(RecoveryStatus.RECOVERY_INITIATED, RecoveryStatus.FAILED)).toBe(true);
      expect(validateRecoveryTransition(RecoveryStatus.PAYMENT_PENDING, RecoveryStatus.FAILED)).toBe(true);
    });

    it("prevents regression from terminal states", () => {
      expect(validateRecoveryTransition(RecoveryStatus.RECOVERED, RecoveryStatus.RECOVERY_INITIATED)).toBe(false);
      expect(validateRecoveryTransition(RecoveryStatus.RECOVERED, RecoveryStatus.FAILED)).toBe(false);
    });
  });
});
