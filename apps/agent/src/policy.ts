export interface Charge {
  payTo: string;
  /** Atomic units of the payment asset. */
  amount: string;
  asset: string;
}

export interface SpendPolicyOptions {
  perCallCap: bigint;
  totalBudget: bigint;
  allowedPayTo: readonly string[];
  asset: string;
}

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export interface SpendPolicy {
  check(charge: Charge): PolicyDecision;
  /** Counts a payment the service accepted. */
  record(charge: Charge): void;
  spent(): bigint;
}

/** Hard limits on what the agent will pay, so a malicious 402 can't drain it (FR-26). */
export function createSpendPolicy(options: SpendPolicyOptions): SpendPolicy {
  let spent = 0n;

  return {
    check({ payTo, amount, asset }) {
      if (!options.allowedPayTo.includes(payTo)) {
        return { allowed: false, reason: `${payTo} is not an allowed payment account` };
      }
      if (asset !== options.asset) return { allowed: false, reason: `unexpected payment asset ${asset}` };
      const value = BigInt(amount);
      if (value > options.perCallCap) return { allowed: false, reason: `charge ${amount} is over the per-call cap` };
      if (spent + value > options.totalBudget) {
        return { allowed: false, reason: `charge ${amount} would exceed the remaining budget` };
      }
      return { allowed: true };
    },

    record({ amount }) {
      spent += BigInt(amount);
    },

    spent: () => spent,
  };
}
