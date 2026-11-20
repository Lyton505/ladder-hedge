import { GeminiError } from "@/lib/gemini/gemini-client";
import { describeError, listLadders } from "@/lib/gemini/ladder-service";

/** Always run at request time: ladder quotes change constantly. */
export const dynamic = "force-dynamic";

/**
 * Upper bound on this function's run time, in seconds. The live events list gets 15 s per
 * attempt and one retry, so about 30 s in the worst case; 60 s leaves room for paging and
 * is within every Vercel plan's limit.
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Lists live Gemini crypto ladders followed by captured snapshots.
 *
 * Query: `asset` (optional), for example `?asset=SOL`.
 * 200 `{ ladders: LadderSummary[], liveError: string | null }`: `liveError` is a short reason
 * when the live Gemini list could not be read and only snapshots are listed; it is null when
 * the live call worked (even if it found no live ladder) or live data is disabled.
 * 400 `{ error }` for a malformed asset; 502 `{ error }` when Gemini fails and no snapshot
 * exists for the asset.
 *
 * @param {Request} request - The incoming request.
 * @returns {Promise<Response>} JSON response.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const assetParam = new URL(request.url).searchParams.get("asset");
    const asset = assetParam === null || assetParam.trim() === "" ? null : assetParam;
    const { ladders, liveError } = await listLadders(asset);
    return Response.json({ ladders, liveError }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof GeminiError && error.kind === "invalid-input") {
      return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error(`[api/ladders] ${describeError(error)}`);
    return Response.json({ error: describeError(error) }, { status: 502, headers: NO_STORE });
  }
}
