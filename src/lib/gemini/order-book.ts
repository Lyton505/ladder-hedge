import WebSocket from "ws";
import { isRecord, parseDecimal } from "@/lib/gemini/parse-ladder";

/**
 * Top-of-book sizes from Gemini's public market-data WebSocket.
 *
 * Verified 2026-11-20 from Node 20 with no API key: connecting to `wss://ws.gemini.com`
 * and sending `{"id":1,"method":"subscribe","params":["GEMI-SOL2611202200-HI72@bookTicker"]}`
 * returns, per stream, an immediate message such as
 * `{"u":...,"E":...,"s":"gemi-sol2611202200-hi72","b":"0.4500","B":"25.00","a":"0.4800","A":"576.00"}`
 * where `b`/`a` are best bid/ask prices and `B`/`A` the contracts at those prices. An empty
 * side is sent as `""`. One invalid stream name fails the whole subscription with
 * `{"id":1,"status":400,"error":{...}}`, so only well-formed symbols are subscribed.
 */
export const GEMINI_WS_URL = "wss://ws.gemini.com";

/** Instrument symbols are plain identifiers such as "GEMI-SOL2611202200-HI72". */
const INSTRUMENT_SYMBOL = /^[A-Za-z0-9-]{1,80}$/;

/** Most streams requested in one subscription; larger ladders are truncated. */
const MAX_STREAMS = 100;

/** Best bid and ask for one instrument, with the contracts available at each. */
export interface TopOfBook {
  bidPrice: number | null;
  bidSize: number | null;
  askPrice: number | null;
  askSize: number | null;
}

/**
 * Reads one side of a bookTicker message.
 *
 * @param {unknown} rawPrice - The `b` or `a` field.
 * @param {unknown} rawSize - The `B` or `A` field.
 * @returns {{ price: number | null; size: number | null }} Both null when the side is empty or malformed.
 */
function readSide(rawPrice: unknown, rawSize: unknown): { price: number | null; size: number | null } {
  const price = parseDecimal(rawPrice);
  const size = parseDecimal(rawSize);
  if (price === null || price <= 0 || price >= 1 || size === null || size <= 0) {
    return { price: null, size: null };
  }
  return { price, size };
}

/**
 * Fetches the best bid and ask sizes for prediction-market instruments over Gemini's
 * public WebSocket. Best effort: symbols that do not answer before `timeoutMs` are
 * missing from the result, and a connection or subscription failure is logged and
 * yields whatever was received so far (possibly an empty map). It never rejects.
 *
 * @param {string[]} instrumentSymbols - Symbols such as "GEMI-SOL2611202200-HI72".
 * @param {number} timeoutMs - Maximum time to wait for all symbols, in milliseconds.
 * @returns {Promise<Map<string, TopOfBook>>} Top of book keyed by the symbol as passed in.
 */
export async function fetchTopOfBookSizes(
  instrumentSymbols: string[],
  timeoutMs: number,
): Promise<Map<string, TopOfBook>> {
  const result = new Map<string, TopOfBook>();
  const bySymbolLower = new Map<string, string>();
  for (const symbol of instrumentSymbols) {
    if (INSTRUMENT_SYMBOL.test(symbol) && bySymbolLower.size < MAX_STREAMS) {
      bySymbolLower.set(symbol.toLowerCase(), symbol);
    }
  }
  if (bySymbolLower.size === 0) {
    return result;
  }
  const streams = [...bySymbolLower.values()].map((symbol) => `${symbol}@bookTicker`);

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const socket = new WebSocket(GEMINI_WS_URL, { handshakeTimeout: timeoutMs });

      /**
       * Ends the request once, closing the socket and clearing the timer.
       *
       * @param {string | null} reason - Why the request ended early, or null on success.
       * @returns {void}
       */
      const finish = (reason: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (reason !== null) {
          console.warn(`[order-book] ${reason}; returning ${result.size} of ${bySymbolLower.size} symbols`);
        }
        socket.removeAllListeners();
        // Keep a no-op error listener so a late socket error cannot crash the process.
        socket.on("error", () => undefined);
        socket.terminate();
        resolve();
      };

      const timer = setTimeout(() => finish(`timed out after ${timeoutMs} ms`), timeoutMs);

      socket.on("open", () => {
        socket.send(JSON.stringify({ id: 1, method: "subscribe", params: streams }));
      });

      socket.on("message", (data: WebSocket.RawData) => {
        let message: unknown;
        try {
          message = JSON.parse(data.toString());
        } catch (error) {
          finish(`unparseable message: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (!isRecord(message)) {
          return;
        }
        if (message.id === 1 && message.status !== 200) {
          finish(`subscription rejected: ${JSON.stringify(message.error ?? message.status).slice(0, 200)}`);
          return;
        }
        if (typeof message.s !== "string") {
          return;
        }
        const symbol = bySymbolLower.get(message.s.toLowerCase());
        if (symbol === undefined || result.has(symbol)) {
          return;
        }
        const bid = readSide(message.b, message.B);
        const ask = readSide(message.a, message.A);
        result.set(symbol, { bidPrice: bid.price, bidSize: bid.size, askPrice: ask.price, askSize: ask.size });
        if (result.size === bySymbolLower.size) {
          finish(null);
        }
      });

      socket.on("unexpected-response", (_request, response) => {
        finish(`unexpected HTTP ${response.statusCode ?? "unknown"} on WebSocket upgrade`);
      });
      socket.on("error", (error: Error) => {
        finish(`socket error: ${error.message}`);
      });
      socket.on("close", () => {
        finish("socket closed before all symbols answered");
      });
    });
  } catch (error) {
    // Constructing the socket can throw synchronously (for example on a bad URL).
    console.warn(
      `[order-book] could not open ${GEMINI_WS_URL}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}
