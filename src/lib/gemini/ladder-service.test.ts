import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiError, fetchActiveCryptoEvents, fetchEvent, fetchSpot } from "@/lib/gemini/gemini-client";
import { getLadder, getSnapshotInfo, getSpotQuote, listLadders, LadderNotFoundError } from "@/lib/gemini/ladder-service";
import { fetchTopOfBookSizes } from "@/lib/gemini/order-book";
import solDailyEvent from "../../../fixtures/gemini/sol-2611202200.json";

vi.mock("@/lib/gemini/gemini-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini/gemini-client")>();
  return {
    ...actual,
    fetchActiveCryptoEvents: vi.fn(),
    fetchEvent: vi.fn(),
    fetchSpot: vi.fn(),
  };
});

vi.mock("@/lib/gemini/order-book", () => ({
  fetchTopOfBookSizes: vi.fn(),
}));

const mockedFetchEvents = vi.mocked(fetchActiveCryptoEvents);
const mockedFetchEvent = vi.mocked(fetchEvent);
const mockedFetchSpot = vi.mocked(fetchSpot);
const mockedSizes = vi.mocked(fetchTopOfBookSizes);

/**
 * Returns a copy of the SOL daily fixture with a new ticker and expiry, as if it were live.
 *
 * @param {string} ticker - Event ticker to use.
 * @param {string} expiryDate - ISO expiry to use.
 * @returns {Record<string, unknown>} A raw event object.
 */
function liveEvent(ticker: string, expiryDate: string): Record<string, unknown> {
  return { ...solDailyEvent, ticker, expiryDate };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mockedSizes.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockedFetchEvents.mockReset();
  mockedFetchEvent.mockReset();
  mockedFetchSpot.mockReset();
  mockedSizes.mockReset();
});

describe("listLadders", () => {
  it("returns only snapshot summaries when the live call rejects", async () => {
    mockedFetchEvents.mockRejectedValue(new GeminiError("timeout", "timed out"));
    const ladders = await listLadders(null);
    expect(ladders.length).toBeGreaterThanOrEqual(6);
    expect(ladders.every((summary) => summary.source === "snapshot")).toBe(true);
    expect(ladders.every((summary) => summary.eventTicker.endsWith("-SNAPSHOT"))).toBe(true);
    expect(ladders[0].eventTicker).toBe("SOL2611202200-SNAPSHOT");
  });

  it("filters snapshots by asset when the live call rejects", async () => {
    mockedFetchEvents.mockRejectedValue(new Error("network down"));
    const ladders = await listLadders("btc");
    expect(ladders.map((summary) => summary.eventTicker)).toEqual([
      "BTC2611202200-SNAPSHOT",
      "BTC2611200500-SNAPSHOT",
    ]);
  });

  it("puts unexpired live ladders first and drops expired and non-ladder events", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    mockedFetchEvents.mockResolvedValue([
      liveEvent("SOL2699999999", future),
      liveEvent("SOL2600000000", past),
      { type: "binary", category: "Crypto", ticker: "SOLUP", contracts: [] },
      "garbage",
    ]);
    const ladders = await listLadders("SOL");
    expect(ladders[0]).toMatchObject({ eventTicker: "SOL2699999999", source: "live", rungCount: 20 });
    expect(ladders.slice(1).every((summary) => summary.source === "snapshot")).toBe(true);
    expect(ladders.some((summary) => summary.eventTicker === "SOL2600000000")).toBe(false);
  });

  it("serves snapshots without calling Gemini when LADDER_FORCE_SNAPSHOT=1", async () => {
    vi.stubEnv("LADDER_FORCE_SNAPSHOT", "1");
    const ladders = await listLadders(null);
    expect(mockedFetchEvents).not.toHaveBeenCalled();
    expect(ladders.every((summary) => summary.source === "snapshot")).toBe(true);
  });

  it("throws when the live call fails and the asset has no snapshot", async () => {
    mockedFetchEvents.mockRejectedValue(new Error("network down"));
    await expect(listLadders("HYPE")).rejects.toThrow(/unavailable/);
  });
});

describe("getLadder", () => {
  it("serves the SOL 12am snapshot with its reference spot", async () => {
    const ladder = await getLadder("SOL2611200500-SNAPSHOT");
    expect(ladder.source).toBe("snapshot");
    expect(ladder.referenceSpot).toBe(72.12);
    expect(ladder.eventTicker).toBe("SOL2611200500-SNAPSHOT");
    expect(ladder.fetchedAt).toBe("2026-11-20T04:44:00.000Z");
    expect(mockedFetchEvent).not.toHaveBeenCalled();
  });

  it("labels estimated snapshot spots", () => {
    expect(getSnapshotInfo("BTC2611200500-SNAPSHOT")).toMatchObject({ spotIsEstimated: true });
    expect(getSnapshotInfo("SOL2611202200-SNAPSHOT")).toMatchObject({
      spotIsEstimated: false,
      referenceSpot: 71.8915,
    });
    expect(getSnapshotInfo("SOL2611202200")).toBeNull();
  });

  it("throws LadderNotFoundError for an unknown snapshot", async () => {
    await expect(getLadder("SOL2000000000-SNAPSHOT")).rejects.toBeInstanceOf(LadderNotFoundError);
  });

  it("throws LadderNotFoundError for a malformed ticker without calling Gemini", async () => {
    await expect(getLadder("../../etc")).rejects.toBeInstanceOf(LadderNotFoundError);
    expect(mockedFetchEvent).not.toHaveBeenCalled();
  });

  it("fills order-book sizes only where the book price matches the quote", async () => {
    mockedFetchEvent.mockResolvedValue(liveEvent("SOL2699999999", "2099-01-01T00:00:00.000Z"));
    mockedSizes.mockImplementation(async (symbols: string[]) => {
      const books = new Map<string, { bidPrice: number | null; bidSize: number | null; askPrice: number | null; askSize: number | null }>();
      for (const symbol of symbols) {
        books.set(symbol, { bidPrice: 0.46, bidSize: 25, askPrice: 0.48, askSize: 576 });
      }
      return books;
    });
    const ladder = await getLadder("sol2699999999");
    expect(ladder.source).toBe("live");
    const rung72 = ladder.rungs.find((rung) => rung.strike === 72);
    expect(rung72).toMatchObject({ yesBid: 0.46, yesAsk: 0.48, yesBidSize: 25, yesAskSize: 576 });
    const rung70 = ladder.rungs.find((rung) => rung.strike === 70);
    expect(rung70).toMatchObject({ yesBidSize: null, yesAskSize: null });
  });

  it("falls back to a snapshot of the same ticker when the live event is settled", async () => {
    mockedFetchEvent.mockResolvedValue({ ...solDailyEvent, ticker: "SOL2611200500", contracts: [] });
    const ladder = await getLadder("SOL2611200500");
    expect(ladder.source).toBe("snapshot");
    expect(ladder.eventTicker).toBe("SOL2611200500-SNAPSHOT");
  });

  it("falls back to a snapshot of the same ticker when Gemini times out", async () => {
    mockedFetchEvent.mockRejectedValue(new GeminiError("timeout", "timed out"));
    const ladder = await getLadder("SOL2611202200");
    expect(ladder.source).toBe("snapshot");
  });

  it("throws LadderNotFoundError when Gemini has no such event and no snapshot exists", async () => {
    mockedFetchEvent.mockRejectedValue(new GeminiError("not-found", "404", 404));
    await expect(getLadder("SOL2000000000")).rejects.toBeInstanceOf(LadderNotFoundError);
  });

  it("throws a non-404 error when Gemini fails and no snapshot exists", async () => {
    mockedFetchEvent.mockRejectedValue(new GeminiError("http", "500", 500));
    const result = getLadder("SOL2000000000");
    await expect(result).rejects.toThrow(/unavailable/);
    await expect(getLadder("SOL2000000000")).rejects.not.toBeInstanceOf(LadderNotFoundError);
  });
});

describe("getSpotQuote", () => {
  it("returns the live quote normally", async () => {
    mockedFetchSpot.mockResolvedValue({ asset: "SOL", price: 71.9, source: "Gemini SOLUSD ticker (bid/ask mid)", asOf: "t" });
    await expect(getSpotQuote("sol")).resolves.toMatchObject({ price: 71.9 });
  });

  it("returns a labelled snapshot spot when LADDER_FORCE_SNAPSHOT=1", async () => {
    vi.stubEnv("LADDER_FORCE_SNAPSHOT", "1");
    const spot = await getSpotQuote("SOL");
    expect(mockedFetchSpot).not.toHaveBeenCalled();
    expect(spot.price).toBe(71.8915);
    expect(spot.source.startsWith("snapshot")).toBe(true);
  });
});
