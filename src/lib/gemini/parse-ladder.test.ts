import { describe, expect, it } from "vitest";
import { parseLadder, parseStrikeLabel, summarizeLadder } from "@/lib/gemini/parse-ladder";
import btcEvent from "../../../fixtures/gemini/btc-2611200500.json";
import solDailyEvent from "../../../fixtures/gemini/sol-2611202200.json";
import solEvent from "../../../fixtures/gemini/sol-2611200500.json";

const FETCHED_AT = "2026-11-20T04:44:00.000Z";

/**
 * Builds a minimal crypto ladder event for edge-case tests.
 *
 * @param {unknown[]} contracts - Raw contracts to include.
 * @returns {Record<string, unknown>} A raw event object.
 */
function makeEvent(contracts: unknown[]): Record<string, unknown> {
  return {
    type: "categorical",
    category: "Crypto",
    ticker: "SOL2611209900",
    title: "SOL test ladder",
    expiryDate: "2026-11-20T22:00:00.000Z",
    contracts,
  };
}

/**
 * Builds a minimal active "or above" contract.
 *
 * @param {string} label - Contract label such as "$70 or above".
 * @param {unknown} [prices] - Raw prices object; omitted when undefined.
 * @returns {Record<string, unknown>} A raw contract object.
 */
function makeContract(label: string, prices?: unknown): Record<string, unknown> {
  const contract: Record<string, unknown> = {
    label,
    instrumentSymbol: `GEMI-SOL2611209900-HI${label.replace(/\D/g, "")}`,
    status: "active",
    quantityIncrement: "0.01",
  };
  if (prices !== undefined) {
    contract.prices = prices;
  }
  return contract;
}

describe("parseLadder", () => {
  it("parses the SOL 12am snapshot", () => {
    const ladder = parseLadder(solEvent, "snapshot", FETCHED_AT, 72.12);
    expect(ladder).not.toBeNull();
    if (ladder === null) return;
    expect(ladder.asset).toBe("SOL");
    expect(ladder.eventTicker).toBe("SOL2611200500");
    expect(ladder.expiry).toBe("2026-11-20T05:00:00.000Z");
    expect(ladder.source).toBe("snapshot");
    expect(ladder.referenceSpot).toBe(72.12);
    expect(ladder.rungs).toHaveLength(8);
    expect(ladder.rungs.map((rung) => rung.strike)).toEqual([68, 69, 70, 71, 72, 73, 74, 75]);
    const rung72 = ladder.rungs.find((rung) => rung.strike === 72);
    expect(rung72?.yesBid).toBe(0.7);
    expect(rung72?.yesAsk).toBe(0.77);
    expect(rung72?.instrumentSymbol).toBe("GEMI-SOL2611200500-HI72");
    expect(rung72?.quantityIncrement).toBe(0.01);
    expect(rung72?.yesBidSize).toBeNull();
    const rung73 = ladder.rungs.find((rung) => rung.strike === 73);
    expect(rung73?.yesBid).toBeNull();
    expect(rung73?.yesAsk).toBe(0.04);
  });

  it("parses the BTC snapshot with comma-separated strikes", () => {
    const ladder = parseLadder(btcEvent, "snapshot", FETCHED_AT, null);
    expect(ladder).not.toBeNull();
    if (ladder === null) return;
    expect(ladder.asset).toBe("BTC");
    expect(ladder.rungs).toHaveLength(10);
    expect(ladder.rungs[0].strike).toBe(61200);
    expect(ladder.rungs[ladder.rungs.length - 1].strike).toBe(62100);
  });

  it("parses the fresh SOL daily snapshot in ascending strike order", () => {
    const ladder = parseLadder(solDailyEvent, "snapshot", FETCHED_AT, 71.8915);
    expect(ladder).not.toBeNull();
    if (ladder === null) return;
    expect(ladder.rungs).toHaveLength(20);
    const strikes = ladder.rungs.map((rung) => rung.strike);
    expect(strikes).toEqual([...strikes].sort((a, b) => a - b));
    expect(strikes[0]).toBe(65);
    expect(strikes[strikes.length - 1]).toBe(84);
  });

  it("returns null for a binary up/down event", () => {
    const binary = {
      type: "binary",
      category: "Crypto",
      ticker: "SOLUP2611200515",
      title: "SOL up or down in 15 minutes",
      expiryDate: "2026-11-20T05:15:00.000Z",
      contracts: [makeContract("$70 or above"), makeContract("$71 or above")],
    };
    expect(parseLadder(binary, "live", FETCHED_AT, null)).toBeNull();
  });

  it("returns null for a sports event", () => {
    const sports = {
      type: "categorical",
      category: "Sports",
      ticker: "NCAAM-2611200400-KU-HOU-M",
      title: "Kansas vs Houston",
      expiryDate: "2026-11-20T04:00:00.000Z",
      contracts: [{ label: "Houston", instrumentSymbol: "GEMI-X-HOU", status: "active" }],
    };
    expect(parseLadder(sports, "live", FETCHED_AT, null)).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseLadder(null, "live", FETCHED_AT, null)).toBeNull();
    expect(parseLadder("not an event", "live", FETCHED_AT, null)).toBeNull();
    expect(parseLadder({ ...makeEvent([]), contracts: "nope" }, "live", FETCHED_AT, null)).toBeNull();
    expect(parseLadder({ ...makeEvent([]), expiryDate: "never" }, "live", FETCHED_AT, null)).toBeNull();
  });

  it("keeps a contract whose prices are missing entirely, with null quotes", () => {
    const event = makeEvent([makeContract("$70 or above"), makeContract("$71 or above", { bestBid: "0.4" })]);
    const ladder = parseLadder(event, "live", FETCHED_AT, null);
    expect(ladder).not.toBeNull();
    if (ladder === null) return;
    expect(ladder.rungs).toHaveLength(2);
    expect(ladder.rungs[0]).toMatchObject({ strike: 70, yesBid: null, yesAsk: null });
    expect(ladder.rungs[1]).toMatchObject({ strike: 71, yesBid: 0.4, yesAsk: null });
  });

  it("ignores last-trade echoes in buy/sell and nulls 0, 1 and non-numeric prices", () => {
    const event = makeEvent([
      makeContract("$70 or above", {
        buy: { yes: "0.9", no: "0.05" },
        sell: { yes: "0.95", no: "0.1" },
        bestBid: "0.95",
        lastTradePrice: "0.9",
      }),
      makeContract("$71 or above", { bestBid: "0", bestAsk: "1" }),
      makeContract("$72 or above", { bestBid: "abc", bestAsk: 0.3 }),
    ]);
    const ladder = parseLadder(event, "live", FETCHED_AT, null);
    expect(ladder?.rungs.map((rung) => [rung.yesBid, rung.yesAsk])).toEqual([
      [0.95, null],
      [null, null],
      [null, 0.3],
    ]);
  });

  it("never produces a crossed rung from the fresh SOL daily fixture", () => {
    const ladder = parseLadder(solDailyEvent, "snapshot", FETCHED_AT, 71.8915);
    for (const rung of ladder?.rungs ?? []) {
      if (rung.yesBid !== null && rung.yesAsk !== null) {
        expect(rung.yesBid).toBeLessThanOrEqual(rung.yesAsk);
      }
    }
    const rung78 = ladder?.rungs.find((rung) => rung.strike === 78);
    expect(rung78).toMatchObject({ yesBid: null, yesAsk: 0.05 });
  });

  it("drops inactive contracts and duplicate strikes, keeping the first", () => {
    const duplicate = makeContract("$70 or above", { bestBid: "0.9" });
    duplicate.instrumentSymbol = "GEMI-SOL2611209900-DUP70";
    const inactive = makeContract("$72 or above");
    inactive.status = "settled";
    const event = makeEvent([
      makeContract("$71 or above"),
      makeContract("$70 or above", { bestBid: "0.8" }),
      duplicate,
      inactive,
    ]);
    const ladder = parseLadder(event, "live", FETCHED_AT, null);
    expect(ladder?.rungs.map((rung) => rung.strike)).toEqual([70, 71]);
    expect(ladder?.rungs[0].yesBid).toBe(0.8);
  });

  it("returns null when fewer than two usable rungs remain", () => {
    const event = makeEvent([makeContract("$70 or above"), { label: "Something else", status: "active" }]);
    expect(parseLadder(event, "live", FETCHED_AT, null)).toBeNull();
  });
});

describe("parseStrikeLabel", () => {
  it("parses dollar, comma and decimal strikes and rejects other labels", () => {
    expect(parseStrikeLabel("$61,200 or above")).toBe(61200);
    expect(parseStrikeLabel("$0.96 or above")).toBe(0.96);
    expect(parseStrikeLabel("$64.5 or above")).toBe(64.5);
    expect(parseStrikeLabel("$72 or below")).toBeNull();
    expect(parseStrikeLabel("Houston")).toBeNull();
  });
});

describe("summarizeLadder", () => {
  it("counts rungs with any quote", () => {
    const event = makeEvent([makeContract("$70 or above"), makeContract("$71 or above", { bestAsk: "0.2" })]);
    const ladder = parseLadder(event, "live", FETCHED_AT, null);
    expect(ladder).not.toBeNull();
    if (ladder === null) return;
    expect(summarizeLadder(ladder)).toEqual({
      eventTicker: "SOL2611209900",
      title: "SOL test ladder",
      asset: "SOL",
      expiry: "2026-11-20T22:00:00.000Z",
      rungCount: 2,
      quotedRungCount: 1,
      source: "live",
    });
  });
});
