import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent, type AgentDeps, type Goal } from "./run.ts";

const EVM = "0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421";
const WRITER = "0xWriter";

const goal: Goal = {
  from: { asset: "base:usdc", amount: "2", address: EVM },
  to: { asset: "base:eth", address: EVM },
  slippageBps: 50,
};

const route = (quoteId: string, minAmountOut: string, extra = {}) => ({
  quoteId,
  venue: "uniswap",
  amountOut: minAmountOut,
  minAmountOut,
  validUntil: "2026-11-06T10:01:00.000Z",
  arkiv: { entityKey: `0x${quoteId}`, pending: false },
  ...extra,
});

const discovery = {
  network: "hedera:testnet",
  asset: "USDC",
  payTo: "0.0.999",
  arkiv: { writer: WRITER },
  endpoints: [
    { method: "POST", path: "/v1/quote", price: "0.01" },
    { method: "POST", path: "/v1/swap", price: "0" },
  ],
};

const tx = { kind: "swap", chainId: 8453, to: "0xrouter", data: "0xswap", value: "0x0" };

type Fakes = { [K in keyof AgentDeps]: AgentDeps[K] extends (...a: never[]) => unknown ? ReturnType<typeof vi.fn> : AgentDeps[K] };
let deps: Fakes;
let logs: string[];

beforeEach(() => {
  logs = [];
  const routes = [route("q_low", "100"), route("q_high", "200")];
  deps = {
    discover: vi.fn(async () => discovery),
    requestQuote: vi.fn(async () => ({ status: 200, body: { requestId: "r_1", swapToken: "tok", routes, payment: { transactionId: "0.0.1@1.1" } } })),
    readQuote: vi.fn(async (key: string) => ({
      owner: WRITER,
      payload: routes.find((r) => r.arkiv.entityKey === key),
    })),
    listQuotes: vi.fn(async () => []),
    requestSwap: vi.fn(async () => ({
      status: 200,
      body: { swapId: "s_1", venue: "uniswap", transactions: [tx], payment: { transactionId: "0.0.1@2.2" } },
    })),
    sendTransaction: vi.fn(async () => "0xhash"),
    submitHash: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ status: "completed", amountReceived: "0.0002", txHashes: ["0xhash"] })),
    sleep: vi.fn(async () => {}),
    log: vi.fn((line: string) => logs.push(line)),
    allowLiveSwaps: true,
    allowedPayTo: ["0.0.999"],
    pollIntervalMs: 1,
    maxPolls: 3,
  } as unknown as Fakes;
});

const run = () => runAgent(deps as unknown as AgentDeps, goal);

describe("reference agent", () => {
  it("completes the whole loop with no human input", async () => {
    const result = await run();
    expect(result).toMatchObject({ outcome: "completed", swapId: "s_1", amountReceived: "0.0002" });
    expect(deps.discover).toHaveBeenCalled();
    expect(deps.requestQuote).toHaveBeenCalled();
    expect(deps.readQuote).toHaveBeenCalled();
    expect(deps.requestSwap).toHaveBeenCalled();
    expect(deps.sendTransaction).toHaveBeenCalledWith(tx);
    expect(deps.submitHash).toHaveBeenCalledWith("s_1", "0xhash");
  });

  it("picks the route with the higher guaranteed output and says why", async () => {
    await run();
    expect(deps.requestSwap).toHaveBeenCalledWith("q_high", "tok");
    expect(logs.join("\n")).toMatch(/q_high/);
  });

  it("reads every route back from Arkiv before choosing", async () => {
    await run();
    expect(deps.readQuote).toHaveBeenCalledWith("0xq_low");
    expect(deps.readQuote).toHaveBeenCalledWith("0xq_high");
  });

  it("logs each payment's HashScan link", async () => {
    await run();
    expect(logs.join("\n")).toContain("https://hashscan.io/testnet/transaction/0.0.1@1.1");
  });

  it("drops a route whose Arkiv record differs from the API response", async () => {
    deps.readQuote.mockImplementation(async (key: string) =>
      key === "0xq_high"
        ? { owner: WRITER, payload: route("q_high", "999") }
        : { owner: WRITER, payload: route("q_low", "100") },
    );
    await run();
    expect(deps.requestSwap).toHaveBeenCalledWith("q_low", "tok");
  });

  it("drops a route whose Arkiv record has another owner", async () => {
    deps.readQuote.mockImplementation(async (key: string) => ({
      owner: key === "0xq_high" ? "0xImpostor" : WRITER,
      payload: key === "0xq_high" ? route("q_high", "200") : route("q_low", "100"),
    }));
    await run();
    expect(deps.requestSwap).toHaveBeenCalledWith("q_low", "tok");
  });

  it("stops without paying for a swap when no quote can be verified", async () => {
    deps.readQuote.mockResolvedValue({ owner: "0xImpostor", payload: {} });
    const result = await run();
    expect(result.outcome).toBe("stopped");
    expect(deps.requestSwap).not.toHaveBeenCalled();
  });

  it("finds the key of a pending Arkiv write by polling", async () => {
    deps.requestQuote.mockResolvedValue({
      status: 200,
      body: {
        requestId: "r_1",
        swapToken: "tok",
        routes: [route("q_1", "100", { arkiv: { entityKey: null, pending: true } })],
        payment: { transactionId: "t" },
      },
    });
    deps.listQuotes
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ quoteId: "q_1", entityKey: "0xlate" }]);
    deps.readQuote.mockResolvedValue({ owner: WRITER, payload: route("q_1", "100") });
    await run();
    expect(deps.readQuote).toHaveBeenCalledWith("0xlate");
    expect(deps.requestSwap).toHaveBeenCalledWith("q_1", "tok");
  });

  it("re-quotes automatically on a 409, using the fresh quote", async () => {
    deps.requestSwap
      .mockResolvedValueOnce({ status: 409, body: { error: "quote_expired", freshQuote: route("q_new", "150") } })
      .mockResolvedValue({ status: 200, body: { swapId: "s_2", transactions: [tx], payment: { transactionId: "t" } } });
    deps.readQuote.mockImplementation(async (key: string) => ({
      owner: WRITER,
      payload: [route("q_low", "100"), route("q_high", "200"), route("q_new", "150")].find((r) => r.arkiv.entityKey === key),
    }));
    const result = await run();
    expect(deps.requestSwap).toHaveBeenLastCalledWith("q_new", "tok");
    expect(result.outcome).toBe("completed");
  });

  it("gives up after repeated 409s", async () => {
    deps.requestSwap.mockResolvedValue({ status: 409, body: { error: "price_moved", freshQuote: route("q_high", "200") } });
    const result = await run();
    expect(result.outcome).toBe("stopped");
    expect(deps.requestSwap).toHaveBeenCalledTimes(3);
    expect(deps.sendTransaction).not.toHaveBeenCalled();
  });

  it("never signs when live swaps aren't allowed", async () => {
    (deps as { allowLiveSwaps: boolean }).allowLiveSwaps = false;
    const result = await run();
    expect(result.outcome).toBe("dry_run");
    expect(deps.requestSwap).not.toHaveBeenCalled();
    expect(deps.sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses to start when the service's account isn't allowed", async () => {
    deps.discover.mockResolvedValue({ ...discovery, payTo: "0.0.666" });
    const result = await run();
    expect(result.outcome).toBe("stopped");
    expect(deps.requestQuote).not.toHaveBeenCalled();
  });

  it("stops gracefully when a payment is refused by policy", async () => {
    deps.requestQuote.mockRejectedValue(new Error("Payment aborted: over budget"));
    const result = await run();
    expect(result).toMatchObject({ outcome: "stopped" });
    expect(result.reason).toMatch(/over budget/);
  });

  it("stops when the quote request fails", async () => {
    deps.requestQuote.mockResolvedValue({ status: 422, body: { error: "no_route" } });
    expect((await run()).outcome).toBe("stopped");
  });

  it("sends approval before the swap and submits the swap's hash", async () => {
    const approval = { ...tx, kind: "approval", data: "0xapprove" };
    deps.requestSwap.mockResolvedValue({
      status: 200,
      body: { swapId: "s_1", transactions: [approval, tx], payment: { transactionId: "t" } },
    });
    deps.sendTransaction.mockResolvedValueOnce("0xapprovalhash").mockResolvedValue("0xswaphash");
    await run();
    expect(deps.sendTransaction.mock.calls.map(([t]) => t.kind)).toEqual(["approval", "swap"]);
    expect(deps.submitHash).toHaveBeenCalledTimes(1);
    expect(deps.submitHash).toHaveBeenCalledWith("s_1", "0xswaphash");
  });

  it("executes when the swap call is free, with no payment in the response", async () => {
    deps.requestSwap.mockResolvedValue({ status: 200, body: { swapId: "s_1", venue: "uniswap", transactions: [tx] } });
    const result = await runAgent(deps as unknown as AgentDeps, goal);
    expect(result.outcome).toBe("completed");
    expect(logs.join("\n")).not.toContain("Paid for execution");
  });

  it("won't send funds to a deposit address on its own", async () => {
    deps.requestSwap.mockResolvedValue({
      status: 200,
      body: { swapId: "s_1", transactions: [], deposit: { address: "bc1q", amount: "1" }, payment: { transactionId: "t" } },
    });
    const result = await run();
    expect(result.outcome).toBe("stopped");
    expect(deps.sendTransaction).not.toHaveBeenCalled();
  });

  it("polls until the swap finishes", async () => {
    deps.getStatus
      .mockResolvedValueOnce({ status: "confirming" })
      .mockResolvedValueOnce({ status: "exchanging" })
      .mockResolvedValue({ status: "completed", amountReceived: "1" });
    expect((await run()).outcome).toBe("completed");
    expect(deps.getStatus).toHaveBeenCalledTimes(3);
  });

  it("reports a refund as its own outcome", async () => {
    deps.getStatus.mockResolvedValue({ status: "refunded" });
    expect((await run()).outcome).toBe("refunded");
  });

  it("reports when polling runs out before the swap finishes", async () => {
    deps.getStatus.mockResolvedValue({ status: "exchanging" });
    expect(await run()).toMatchObject({ outcome: "pending", swapId: "s_1" });
    expect(deps.getStatus).toHaveBeenCalledTimes(3);
  });
});
