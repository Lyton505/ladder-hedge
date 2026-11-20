import { describe, expect, it } from "vitest";
import type { LadderRung } from "@/lib/hedge/types";

describe("shared hedge types", () => {
  it("accepts a rung with one-sided quotes", () => {
    const rung: LadderRung = {
      instrumentSymbol: "TEST-RUNG",
      label: "Test rung",
      strike: 100,
      yesBid: null,
      yesAsk: 0.42,
      yesBidSize: null,
      yesAskSize: 10,
      quantityIncrement: 1,
    };

    expect(rung.yesBid).toBeNull();
    expect(rung.yesAsk).toBe(0.42);
  });
});
