import { describe, expect, it } from "vitest";
import { chainFor } from "./chains.ts";

describe("chainFor", () => {
  const rpcUrls = { ethereum: "https://eth.example", base: "https://base.example" };

  it("signs on Ethereum and Base, each through its own RPC", () => {
    expect(chainFor(1, rpcUrls)).toMatchObject({ chain: { id: 1 }, rpcUrl: "https://eth.example" });
    expect(chainFor(8453, rpcUrls)).toMatchObject({ chain: { id: 8453 }, rpcUrl: "https://base.example" });
  });

  it("refuses any other chain rather than signing blind", () => {
    expect(() => chainFor(137, rpcUrls)).toThrow(/137/);
  });
});
