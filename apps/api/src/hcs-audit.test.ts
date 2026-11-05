import { describe, expect, it, vi } from "vitest";
import { createHcsAudit } from "./hcs-audit.ts";

describe("HCS audit log", () => {
  it("submits the payer, endpoint, amount, quote and transaction", async () => {
    const submit = vi.fn(async (_message: string) => {});
    await createHcsAudit(submit).log({
      payer: "0.0.51234",
      endpoint: "POST /v1/quote",
      amount: "0.01",
      usedBy: "r_1",
      transactionId: "0.0.1@1.1",
    });
    expect(JSON.parse(submit.mock.calls[0]![0])).toEqual({
      payer: "0.0.51234",
      endpoint: "POST /v1/quote",
      amount: "0.01",
      asset: "USDC",
      usedBy: "r_1",
      transactionId: "0.0.1@1.1",
    });
  });
});
