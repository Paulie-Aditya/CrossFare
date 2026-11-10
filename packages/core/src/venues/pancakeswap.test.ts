import { decodeFunctionData, erc20Abi } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAsset, registerAssets, type Asset } from "../assets.ts";
import { PANCAKE_PERMIT2, PERMIT2_ABI, createPancakeSwapVenue, type PancakeRouter } from "./pancakeswap.ts";
import type { ChainReceipt } from "./evm-receipt.ts";
import type { QuoteRequest } from "./types.ts";

const AGENT = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const FEE_WALLET = "0x1111111111111111111111111111111111111111";
const ROUTER = "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB";
const NOW = new Date("2026-11-11T10:00:00.000Z");
const ZERO = "0x0000000000000000000000000000000000000000";
const USDT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

const bsc = (id: string, address: string, symbol: string): Asset => ({
  id, chain: "bsc", symbol, decimals: 18, uniswap: { chainId: 56, address }, evmChainId: 56, swapkitChain: "56",
});
const BNB = bsc("bsc:bnb", ZERO, "BNB");
const USDT = bsc("bsc:usdt", USDT_ADDRESS, "USDT");

beforeAll(() => registerAssets([BNB, USDT]));

const request = (from: string, amount: string, to: string, extra: Partial<QuoteRequest> = {}): QuoteRequest => ({
  from: { asset: from, amount, address: AGENT },
  to: { asset: to, address: AGENT },
  mode: "exact_in",
  slippageBps: 100,
  ...extra,
});

const SWAP_TX = { to: ROUTER, data: "0x3593564c", value: "0x16345785d8a0000" };

function fakeRouter(overrides: Partial<{ amountOut: bigint; minAmountOut: bigint }> = {}) {
  return {
    quote: vi.fn(async (input: Parameters<PancakeRouter["quote"]>[0]) => ({
      amountOut: overrides.amountOut ?? 67_000000000000000000n,
      minAmountOut: overrides.minAmountOut ?? 66_330000000000000000n,
      ...(input.recipient ? { transaction: SWAP_TX } : {}),
    })),
  };
}

const venue = (options: Partial<Parameters<typeof createPancakeSwapVenue>[0]> = {}) =>
  createPancakeSwapVenue({ router: fakeRouter(), now: () => NOW, ...options });

describe("PancakeSwap venue", () => {
  it("replaces SwapKit's route through PancakeSwap when it answers, since only it pays the caller's own wallet", () => {
    expect(venue().replaces).toEqual(["pancakeswap"]);
  });

  it("serves two tokens on BNB Chain only", () => {
    const pancake = venue();
    expect(pancake.serves?.(getAsset("bsc:bnb"), getAsset("bsc:usdt"))).toBe(true);
    expect(pancake.serves?.(getAsset("bsc:bnb"), getAsset("eth:eth"))).toBe(false);
    expect(pancake.serves?.(getAsset("eth:eth"), getAsset("eth:usdc"))).toBe(false);
  });

  it("asks the router for the pair, amount, slippage and recipient", async () => {
    const router = fakeRouter();
    await venue({ router }).quote(request("bsc:bnb", "0.1", "bsc:usdt"));
    expect(router.quote).toHaveBeenCalledWith({
      chainId: 56,
      tokenIn: { address: ZERO, decimals: 18, symbol: "BNB" },
      tokenOut: { address: USDT_ADDRESS, decimals: 18, symbol: "USDT" },
      amountIn: 100000000000000000n,
      slippageBps: 100,
      recipient: AGENT,
    });
  });

  it("returns one route, its minimum the router's", async () => {
    const [route, ...rest] = await venue().quote(request("bsc:bnb", "0.1", "bsc:usdt"));
    expect(rest).toEqual([]);
    expect(route).toMatchObject({
      venue: "pancakeswap",
      from: "bsc:bnb",
      to: "bsc:usdt",
      amountIn: "100000000000000000",
      amountOut: "67000000000000000000",
      minAmountOut: "66330000000000000000",
      validUntil: "2026-11-11T10:01:00.000Z",
    });
  });

  it("pays the caller's fee to their EVM wallet and quotes what's left", async () => {
    const router = fakeRouter();
    const fee = { bps: 50, recipients: { evm: FEE_WALLET } };
    const [route] = await venue({ router }).quote(request("bsc:bnb", "0.1", "bsc:usdt", { fee }));
    expect(router.quote.mock.calls[0]![0].fee).toEqual({ bps: 50, recipient: FEE_WALLET });
    expect(route).toMatchObject({ amountOut: "66665000000000000000", minAmountOut: "65998350000000000000", fees: { integrator: "0.335 USDT" } });
  });

  it("charges no fee when the caller names no EVM wallet", async () => {
    const router = fakeRouter();
    await venue({ router }).quote(request("bsc:bnb", "0.1", "bsc:usdt", { fee: { bps: 50, recipients: { near: "me.near" } } }));
    expect(router.quote.mock.calls[0]![0].fee).toBeUndefined();
  });

  it("prices without a recipient for a price check, and such a route can't be executed", async () => {
    const router = fakeRouter();
    const pancake = venue({ router });
    const price = request("bsc:bnb", "0.1", "bsc:usdt", { indicative: true });
    const [route] = await pancake.quote(price);
    expect(router.quote.mock.calls[0]![0].recipient).toBeUndefined();
    await expect(pancake.prepare(route!, price)).rejects.toMatchObject({ venue: "pancakeswap", status: 422 });
  });

  it("finds nothing for an exact output or a pair with no pools", async () => {
    expect(await venue().quote(request("bsc:bnb", "0.1", "bsc:usdt", { mode: "exact_out" }))).toEqual([]);
    expect(await venue({ router: { quote: async () => null } }).quote(request("bsc:bnb", "0.1", "bsc:usdt"))).toEqual([]);
  });

  it("reports a router failure as a venue error", async () => {
    const broken = venue({ router: { quote: async () => { throw new Error("rpc down"); } } });
    await expect(broken.quote(request("bsc:bnb", "0.1", "bsc:usdt"))).rejects.toMatchObject({ venue: "pancakeswap", status: 502 });
  });

  it("sends a native coin straight to the router", async () => {
    const pancake = venue();
    const req = request("bsc:bnb", "0.1", "bsc:usdt");
    const [route] = await pancake.quote(req);
    expect(await pancake.prepare(route!, req)).toEqual({ transactions: [{ kind: "swap", chainId: 56, ...SWAP_TX }] });
  });

  describe("a token in, through Permit2", () => {
    const req = request("bsc:usdt", "10", "bsc:bnb");
    const tokenIn = 10_000000000000000000n;

    it("approves Permit2, then the router through Permit2, when neither is allowed", async () => {
      const readAllowances = vi.fn(async () => ({ token: 0n, router: { amount: 0n, expiration: 0 } }));
      const pancake = venue({ readAllowances });
      const [route] = await pancake.quote(req);
      const { transactions } = await pancake.prepare(route!, req);
      expect(readAllowances).toHaveBeenCalledWith(56, USDT_ADDRESS, AGENT, ROUTER);
      expect(transactions.map((tx) => [tx.kind, tx.to])).toEqual([
        ["approval", USDT_ADDRESS],
        ["approval", PANCAKE_PERMIT2],
        ["swap", ROUTER],
      ]);
      expect(decodeFunctionData({ abi: erc20Abi, data: transactions[0]!.data as `0x${string}` }).args).toEqual([PANCAKE_PERMIT2, tokenIn]);
      const permit = decodeFunctionData({ abi: PERMIT2_ABI, data: transactions[1]!.data as `0x${string}` });
      expect(permit.args.slice(0, 3)).toEqual([USDT_ADDRESS, ROUTER, tokenIn]);
      // Thirty days from now.
      expect(permit.args[3]).toBe(Math.floor(NOW.getTime() / 1000) + 30 * 86_400);
    });

    it("skips approvals the wallet already gave", async () => {
      const far = Math.floor(NOW.getTime() / 1000) + 86_400;
      const pancake = venue({ readAllowances: async () => ({ token: tokenIn, router: { amount: tokenIn, expiration: far } }) });
      const [route] = await pancake.quote(req);
      expect((await pancake.prepare(route!, req)).transactions.map((tx) => tx.kind)).toEqual(["swap"]);
    });

    it("renews the router's Permit2 allowance once it has expired", async () => {
      const past = Math.floor(NOW.getTime() / 1000) - 1;
      const pancake = venue({ readAllowances: async () => ({ token: tokenIn, router: { amount: tokenIn, expiration: past } }) });
      const [route] = await pancake.quote(req);
      expect((await pancake.prepare(route!, req)).transactions.map((tx) => tx.to)).toEqual([PANCAKE_PERMIT2, ROUTER]);
    });

    it("asks for both approvals when it can't read allowances", async () => {
      const pancake = venue();
      const [route] = await pancake.quote(req);
      expect((await pancake.prepare(route!, req)).transactions.map((tx) => tx.kind)).toEqual(["approval", "approval", "swap"]);
    });
  });

  describe("tracking", () => {
    const req = request("bsc:usdt", "10", "bsc:bnb", { fee: { bps: 50, recipients: { evm: FEE_WALLET } } });
    const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
    const receipt = (overrides: Partial<ChainReceipt> = {}): ChainReceipt => ({
      status: "success",
      from: AGENT,
      to: ROUTER,
      // 0.02 BNB unwrapped; the caller's 0.5% then goes to the fee wallet.
      logs: [{ address: WBNB, topics: [WITHDRAWAL], data: `0x${(2n * 10n ** 16n).toString(16).padStart(64, "0")}` }],
      ...overrides,
    });

    async function tracked(chain: ChainReceipt | null) {
      const pancake = venue({ getReceipt: async () => chain });
      const [route] = await pancake.quote(req);
      const prepared = await pancake.prepare(route!, req);
      return pancake.track({ route: route!, request: req, prepared, txHashes: ["0xswap"], venueSwapId: null });
    }

    it("reads what was delivered, less the caller's fee", async () => {
      expect(await tracked(receipt())).toEqual({ status: "completed", amountReceived: "0.0199" });
    });

    it("waits for the transaction to be mined", async () => {
      expect(await tracked(null)).toEqual({ status: "confirming" });
    });

    it("fails a reverted swap", async () => {
      expect(await tracked(receipt({ status: "reverted" }))).toEqual({ status: "failed" });
    });

    it("ignores a hash that isn't this wallet's call to the router", async () => {
      expect(await tracked(receipt({ from: FEE_WALLET }))).toEqual({ status: "confirming" });
    });
  });
});
