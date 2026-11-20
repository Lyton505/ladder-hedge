import { LadderNotFoundError, describeError, getLadder, getSnapshotInfo } from "@/lib/gemini/ladder-service";

/** Always run at request time: ladder quotes change constantly. */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** Route context for `/api/ladders/[ticker]`; `params` is a Promise in Next 16. */
interface LadderRouteContext {
  params: Promise<{ ticker: string }>;
}

/**
 * Returns one ladder. Live tickers come from Gemini with best-effort order-book sizes;
 * tickers ending in `-SNAPSHOT` come from captured fixtures.
 *
 * 200 `{ ladder: Ladder, snapshot: SnapshotInfo | null }` (`snapshot` carries capture time
 * and whether the reference spot is estimated); 404 `{ error }` when no such ladder exists;
 * 502 `{ error }` when Gemini fails and no snapshot stands in.
 *
 * @param {Request} _request - The incoming request (unused).
 * @param {LadderRouteContext} context - Route context holding the `ticker` param.
 * @returns {Promise<Response>} JSON response.
 */
export async function GET(_request: Request, context: LadderRouteContext): Promise<Response> {
  try {
    const { ticker } = await context.params;
    const ladder = await getLadder(ticker);
    const snapshot = getSnapshotInfo(ladder.eventTicker);
    return Response.json({ ladder, snapshot }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof LadderNotFoundError) {
      return Response.json({ error: error.message }, { status: 404, headers: NO_STORE });
    }
    console.error(`[api/ladders/[ticker]] ${describeError(error)}`);
    return Response.json({ error: describeError(error) }, { status: 502, headers: NO_STORE });
  }
}
