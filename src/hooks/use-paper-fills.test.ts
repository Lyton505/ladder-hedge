// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HedgePlan, PaperFill } from "@/lib/hedge/types";
import { PAPER_FILLS_STORAGE_KEY, usePaperFills } from "./use-paper-fills";

const PLAN: HedgePlan = {
  status: "no-hedge-needed",
  legs: [],
  totalCost: 0,
  outcomes: [],
  worstCaseBefore: -100,
  worstCaseAfter: -100,
  expectedHedgePayout: 0,
  requestedMaxLoss: 500,
  stressPrice: 90,
};

/**
 * Builds a paper fill for tests.
 *
 * @param {string} id - Fill id.
 * @returns {PaperFill} An unsigned fill.
 */
function makeFill(id: string): PaperFill {
  return {
    id,
    createdAt: "2026-11-19T12:00:00.000Z",
    eventTicker: "SOL25NOV2012",
    exposure: { asset: "SOL", quantity: 10, spot: 140 },
    plan: PLAN,
    planHash: "a".repeat(64),
    memo: `LH1|SOL25NOV2012|q=10|floor=500|cost=0.00|legs=0|h=${"a".repeat(32)}`,
    signature: null,
  };
}

describe("usePaperFills", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("starts empty", () => {
    const { result } = renderHook(() => usePaperFills());
    expect(result.current.fills).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("warns, naming the storage key, when stored JSON is corrupt", () => {
    window.localStorage.setItem(PAPER_FILLS_STORAGE_KEY, "{still not json");
    const { result } = renderHook(() => usePaperFills());
    expect(result.current.fills).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PAPER_FILLS_STORAGE_KEY));
  });

  it("drops malformed entries with a warning and keeps the valid ones", () => {
    const planWithoutLegs: Record<string, unknown> = { ...PLAN };
    delete planWithoutLegs.legs;
    const entries = [
      makeFill("fill-ok"),
      { ...makeFill("no-legs"), plan: planWithoutLegs },
      { ...makeFill("bad-leg"), plan: { ...PLAN, legs: [{ quantity: "lots" }] } },
      { ...makeFill("bad-cost"), plan: { ...PLAN, totalCost: "free" } },
      { ...makeFill("bad-exposure"), exposure: { asset: "SOL" } },
    ];
    window.localStorage.setItem(PAPER_FILLS_STORAGE_KEY, JSON.stringify(entries));
    const { result } = renderHook(() => usePaperFills());
    expect(result.current.fills.map((fill) => fill.id)).toEqual(["fill-ok"]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("dropped 4 malformed entries"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PAPER_FILLS_STORAGE_KEY));
  });

  it("persists an added fill across a remount", () => {
    const first = renderHook(() => usePaperFills());
    act(() => {
      first.result.current.addFill(makeFill("fill-1"));
    });
    expect(first.result.current.fills.map((fill) => fill.id)).toEqual(["fill-1"]);
    first.unmount();

    const second = renderHook(() => usePaperFills());
    expect(second.result.current.fills).toEqual([makeFill("fill-1")]);
    const stored: unknown = JSON.parse(window.localStorage.getItem(PAPER_FILLS_STORAGE_KEY) ?? "null");
    expect(stored).toEqual([makeFill("fill-1")]);
  });

  it("yields an empty list for corrupt stored JSON", () => {
    window.localStorage.setItem(PAPER_FILLS_STORAGE_KEY, "{not json");
    const { result } = renderHook(() => usePaperFills());
    expect(result.current.fills).toEqual([]);
  });

  it("yields an empty list when stored JSON is not an array", () => {
    window.localStorage.setItem(PAPER_FILLS_STORAGE_KEY, '{"id":"x"}');
    const { result } = renderHook(() => usePaperFills());
    expect(result.current.fills).toEqual([]);
  });

  it("can add a fill after starting from corrupt storage", () => {
    window.localStorage.setItem(PAPER_FILLS_STORAGE_KEY, "[[[");
    const { result } = renderHook(() => usePaperFills());
    act(() => {
      result.current.addFill(makeFill("fill-1"));
    });
    expect(result.current.fills.map((fill) => fill.id)).toEqual(["fill-1"]);
  });

  it("setSignature updates only the matching fill", () => {
    const { result } = renderHook(() => usePaperFills());
    act(() => {
      result.current.addFill(makeFill("fill-1"));
    });
    act(() => {
      result.current.addFill(makeFill("fill-2"));
    });
    act(() => {
      result.current.setSignature("fill-2", "sig-abc");
    });
    expect(result.current.fills).toEqual([makeFill("fill-1"), { ...makeFill("fill-2"), signature: "sig-abc" }]);
  });

  it("clear removes every fill", () => {
    const { result } = renderHook(() => usePaperFills());
    act(() => {
      result.current.addFill(makeFill("fill-1"));
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.fills).toEqual([]);
    expect(window.localStorage.getItem(PAPER_FILLS_STORAGE_KEY)).toBeNull();
  });
});
