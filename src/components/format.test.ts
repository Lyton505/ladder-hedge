import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatPercent,
  formatPriceInterval,
  formatQuantity,
  formatShortHash,
  formatStrike,
  formatUsd,
} from "./format";

describe("formatUsd", () => {
  it("formats negative amounts with the sign before the dollar sign", () => {
    expect(formatUsd(-51.2)).toBe("-$51.20");
  });

  it("groups thousands and keeps two decimals", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("never shows negative zero", () => {
    expect(formatUsd(-0.001)).toBe("$0.00");
  });

  it("adds a plus sign when signed is requested", () => {
    expect(formatUsd(6.27, { signed: true })).toBe("+$6.27");
    expect(formatUsd(-6.27, { signed: true })).toBe("-$6.27");
  });

  it("returns an en dash for non-finite values", () => {
    expect(formatUsd(Number.NaN)).toBe("–");
  });
});

describe("formatPercent", () => {
  it("formats a fraction with two decimals", () => {
    expect(formatPercent(0.0329)).toBe("3.29%");
  });

  it("respects the decimals argument", () => {
    expect(formatPercent(0.015, 1)).toBe("1.5%");
  });
});

describe("formatQuantity", () => {
  it("drops trailing zeros and groups thousands", () => {
    expect(formatQuantity(20)).toBe("20");
    expect(formatQuantity(3.58)).toBe("3.58");
    expect(formatQuantity(1250.5)).toBe("1,250.5");
  });
});

describe("formatCountdown", () => {
  const nowMs = Date.parse("2026-11-20T03:00:00Z");

  it("returns expired for a past time", () => {
    expect(formatCountdown("2026-11-20T02:59:00Z", nowMs)).toBe("expired");
  });

  it("returns hours and zero-padded minutes", () => {
    const expiry = new Date(nowMs + (2 * 60 + 5) * 60_000).toISOString();
    expect(formatCountdown(expiry, nowMs)).toBe("2h 05m");
  });

  it("returns days and hours beyond a day", () => {
    const expiry = new Date(nowMs + (27 * 60 + 10) * 60_000).toISOString();
    expect(formatCountdown(expiry, nowMs)).toBe("1d 03h");
  });

  it("returns minutes only under an hour", () => {
    const expiry = new Date(nowMs + 45 * 60_000).toISOString();
    expect(formatCountdown(expiry, nowMs)).toBe("45m");
  });

  it("returns unknown for an unparseable time", () => {
    expect(formatCountdown("not a date", nowMs)).toBe("unknown");
  });
});

describe("formatStrike and formatPriceInterval", () => {
  it("drops cents on whole strikes", () => {
    expect(formatStrike(72)).toBe("$72");
    expect(formatStrike(97000)).toBe("$97,000");
    expect(formatStrike(2.75)).toBe("$2.75");
  });

  it("labels open and closed intervals", () => {
    expect(formatPriceInterval(null, 68)).toBe("below $68");
    expect(formatPriceInterval(68, 69)).toBe("$68 to $69");
    expect(formatPriceInterval(75, null)).toBe("$75 and above");
  });
});

describe("formatShortHash", () => {
  it("keeps both ends of a long value", () => {
    expect(formatShortHash("5Kx9abcdefghijklmnopQe2a")).toBe("5Kx9...Qe2a");
  });

  it("returns short values unchanged", () => {
    expect(formatShortHash("abc")).toBe("abc");
  });
});
