import { describe, expect, it } from "vitest";
import type { Exposure, HedgeLeg, HedgePlan } from "@/lib/hedge/types";
import {
  buildReceiptMemo,
  canonicalPlanJson,
  extractReceiptMemo,
  hashPlan,
  MAX_MEMO_BYTES,
  parseReceiptMemo,
} from "./receipt-memo";

const EVENT_TICKER = "SOL25NOV2012";

const EXPOSURE: Exposure = { asset: "SOL", quantity: 250, spot: 142.37 };

/**
 * Builds a hedge leg for tests.
 *
 * @param {string} instrumentSymbol - Contract symbol.
 * @param {HedgeLeg["side"]} side - YES or NO.
 * @param {number} quantity - Contracts.
 * @param {number} price - Ask price in dollars.
 * @returns {HedgeLeg} The leg, with fee and cost derived from quantity and price.
 */
function makeLeg(instrumentSymbol: string, side: HedgeLeg["side"], quantity: number, price: number): HedgeLeg {
  const fee = Math.ceil(0.07 * quantity * price * (1 - price) * 100) / 100;
  return { instrumentSymbol, strike: 100, side, quantity, price, fee, cost: quantity * price + fee };
}

/**
 * Builds a hedge plan for tests.
 *
 * @param {HedgeLeg[]} legs - Plan legs.
 * @returns {HedgePlan} An optimal plan with those legs.
 */
function makePlan(legs: HedgeLeg[]): HedgePlan {
  const totalCost = legs.reduce((sum, leg) => sum + leg.cost, 0);
  return {
    status: "optimal",
    legs,
    totalCost,
    outcomes: [],
    worstCaseBefore: -9000,
    worstCaseAfter: -2000,
    expectedHedgePayout: 123.4,
    requestedMaxLoss: 2000,
    stressPrice: 110,
  };
}

const LEGS: HedgeLeg[] = [
  makeLeg("GEMI-SOL-140", "no", 300, 0.41),
  makeLeg("GEMI-SOL-130", "yes", 120, 0.18),
  makeLeg("GEMI-SOL-130", "no", 50, 0.77),
];

describe("canonicalPlanJson", () => {
  it("is identical for plans whose legs differ only in order", () => {
    const forward = canonicalPlanJson(EVENT_TICKER, EXPOSURE, makePlan(LEGS));
    const reversed = canonicalPlanJson(EVENT_TICKER, EXPOSURE, makePlan([...LEGS].reverse()));
    expect(reversed).toBe(forward);
  });

  it("uses the documented key order, sorted legs, 6-decimal rounding and no whitespace", () => {
    const plan = makePlan([makeLeg("B", "yes", 1.23456789, 0.1234564), makeLeg("A", "no", 2, 0.5)]);
    const json = canonicalPlanJson(EVENT_TICKER, EXPOSURE, { ...plan, totalCost: 10.0000004 });
    expect(json).toBe(
      '{"v":1,"eventTicker":"SOL25NOV2012","asset":"SOL","quantity":250,"spot":142.37,"maxLoss":2000,' +
        '"totalCost":10,"legs":[{"s":"A","d":"no","q":2,"p":0.5},{"s":"B","d":"yes","q":1.234568,"p":0.123456}]}',
    );
  });

  it("throws on a non-finite number", () => {
    expect(() => canonicalPlanJson(EVENT_TICKER, EXPOSURE, { ...makePlan(LEGS), totalCost: Number.NaN })).toThrow(
      /total cost/,
    );
  });
});

describe("hashPlan", () => {
  it("returns a 64-character lowercase hex string", async () => {
    const hash = await hashPlan(EVENT_TICKER, EXPOSURE, makePlan(LEGS));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any leg quantity changes", async () => {
    const base = await hashPlan(EVENT_TICKER, EXPOSURE, makePlan(LEGS));
    for (let index = 0; index < LEGS.length; index += 1) {
      const changedLegs = LEGS.map((leg, legIndex) =>
        legIndex === index ? { ...leg, quantity: leg.quantity + 1 } : leg,
      );
      const changed = await hashPlan(EVENT_TICKER, EXPOSURE, makePlan(changedLegs));
      expect(changed).not.toBe(base);
    }
  });

  it("is stable for the same plan", async () => {
    const first = await hashPlan(EVENT_TICKER, EXPOSURE, makePlan(LEGS));
    const second = await hashPlan(EVENT_TICKER, EXPOSURE, makePlan([...LEGS].reverse()));
    expect(second).toBe(first);
  });
});

describe("buildReceiptMemo and parseReceiptMemo", () => {
  it("builds a memo under 300 bytes for a 20-leg plan that round-trips through the parser", async () => {
    const legs: HedgeLeg[] = [];
    for (let index = 0; index < 20; index += 1) {
      legs.push(makeLeg(`GEMI-SOL-${100 + index * 5}`, index % 2 === 0 ? "yes" : "no", 1000 + index, 0.37));
    }
    const plan = makePlan(legs);
    const exposure: Exposure = { asset: "SOL", quantity: 12345.678901, spot: 142.37 };
    const { memo, planHash } = await buildReceiptMemo(EVENT_TICKER, exposure, plan);

    expect(memo.startsWith("LH1|")).toBe(true);
    expect(new TextEncoder().encode(memo).length).toBeLessThan(MAX_MEMO_BYTES);
    expect(planHash).toMatch(/^[0-9a-f]{64}$/);

    const parsed = parseReceiptMemo(memo);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({
      eventTicker: EVENT_TICKER,
      quantity: 12345.678901,
      maxLoss: 2000,
      totalCost: Number(plan.totalCost.toFixed(2)),
      legCount: 20,
      planHash: planHash.slice(0, 32),
    });
  });

  it("writes cost with exactly 2 decimals", async () => {
    const plan = { ...makePlan(LEGS), totalCost: 87.5 };
    const { memo } = await buildReceiptMemo(EVENT_TICKER, EXPOSURE, plan);
    expect(memo).toContain("|cost=87.50|");
    expect(memo).toContain("|q=250|floor=2000|");
    expect(memo).toContain("|legs=3|");
  });

  it("rejects an event ticker containing the separator", async () => {
    await expect(buildReceiptMemo("BAD|TICKER", EXPOSURE, makePlan(LEGS))).rejects.toThrow(/separator/);
  });

  it("returns null for an unrelated memo", () => {
    expect(parseReceiptMemo("gm")).toBeNull();
    expect(parseReceiptMemo("[2] gm")).toBeNull();
    expect(parseReceiptMemo("LH1|only|three")).toBeNull();
    expect(parseReceiptMemo("LH2|T|q=1|floor=1|cost=1.00|legs=1|h=0123456789abcdef0123456789abcdef")).toBeNull();
    expect(parseReceiptMemo("LH1|T|q=x|floor=1|cost=1.00|legs=1|h=0123456789abcdef0123456789abcdef")).toBeNull();
    expect(parseReceiptMemo("LH1|T|q=1|floor=1|cost=1.00|legs=1|h=XYZ")).toBeNull();
  });

  it("parses a memo with a leading RPC length tag", () => {
    const memo = "LH1|SOL25NOV2012|q=250|floor=2000|cost=87.50|legs=3|h=0123456789abcdef0123456789abcdef";
    expect(parseReceiptMemo(`[57] ${memo}`)).toEqual({
      eventTicker: "SOL25NOV2012",
      quantity: 250,
      maxLoss: 2000,
      totalCost: 87.5,
      legCount: 3,
      planHash: "0123456789abcdef0123456789abcdef",
    });
  });
});

describe("extractReceiptMemo", () => {
  const memo = "LH1|SOL25NOV2012|q=250|floor=2000|cost=87.50|legs=3|h=0123456789abcdef0123456789abcdef";

  it("strips the RPC length tag", () => {
    expect(extractReceiptMemo(`[${memo.length}] ${memo}`)).toBe(memo);
  });

  it("finds the receipt among several RPC memos", () => {
    expect(extractReceiptMemo(`[5] hello; [${memo.length}] ${memo}`)).toBe(memo);
  });

  it("returns null when there is no receipt", () => {
    expect(extractReceiptMemo(null)).toBeNull();
    expect(extractReceiptMemo("[5] hello")).toBeNull();
  });
});
