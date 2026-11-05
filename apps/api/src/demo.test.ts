import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mountDemo } from "./demo.ts";

function setup(limits = { perIpPerHour: 2, perDay: 3 }, startAt = new Date("2026-11-06T10:00:00Z")) {
  let current = startAt;
  const paidPost = vi.fn(async (_path: string, _body: unknown): Promise<{ status: number; body: unknown }> => ({ status: 200, body: { ok: true } }));
  const app = new Hono();
  mountDemo(app, { paidPost, limits, now: () => current });
  const post = (path: string, ip = "1.1.1.1", body: unknown = { a: 1 }) =>
    app.request(path, { method: "POST", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` }, body: JSON.stringify(body) });
  return { post, paidPost, advance: (to: Date) => (current = to), app };
}

describe("demo payer", () => {
  it("forwards a quote through the paying client and returns its answer", async () => {
    const { post, paidPost } = setup();
    const response = await post("/demo/quote");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(paidPost).toHaveBeenCalledWith("/v1/quote", { a: 1 });
  });

  it("forwards a swap", async () => {
    const { post, paidPost } = setup();
    await post("/demo/swap");
    expect(paidPost).toHaveBeenCalledWith("/v1/swap", { a: 1 });
  });

  it("passes on the API's error status", async () => {
    const { post, paidPost } = setup();
    paidPost.mockResolvedValue({ status: 409, body: { error: "quote_expired" } });
    const response = await post("/demo/swap");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "quote_expired" });
  });

  it("limits calls per visitor per hour", async () => {
    const { post, paidPost } = setup();
    await post("/demo/quote");
    await post("/demo/quote");
    const third = await post("/demo/quote");
    expect(third.status).toBe(429);
    expect(paidPost).toHaveBeenCalledTimes(2);
    expect((await post("/demo/quote", "2.2.2.2")).status).toBe(200);
  });

  it("resets a visitor's limit after an hour", async () => {
    const { post, advance } = setup();
    await post("/demo/quote");
    await post("/demo/quote");
    advance(new Date("2026-11-06T11:00:01Z"));
    expect((await post("/demo/quote")).status).toBe(200);
  });

  it("stops all visitors at the daily limit, then resets the next day", async () => {
    const { post, advance } = setup();
    await post("/demo/quote", "1.1.1.1");
    await post("/demo/quote", "2.2.2.2");
    await post("/demo/quote", "3.3.3.3");
    expect((await post("/demo/quote", "4.4.4.4")).status).toBe(429);
    advance(new Date("2026-11-07T10:00:01Z"));
    expect((await post("/demo/quote", "4.4.4.4")).status).toBe(200);
  });

  it("answers 502 when the paying client fails", async () => {
    const { post, paidPost } = setup();
    paidPost.mockRejectedValue(new Error("no funds at key xyz"));
    const response = await post("/demo/quote");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("xyz");
  });

  it("rejects a malformed body", async () => {
    const { app } = setup();
    const response = await app.request("/demo/quote", { method: "POST", body: "not json" });
    expect(response.status).toBe(400);
  });
});
