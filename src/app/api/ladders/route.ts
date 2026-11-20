import { GeminiError } from "@/lib/gemini/gemini-client";
import { describeError, listLadders } from "@/lib/gemini/ladder-service";

/** Always run at request time: ladder quotes change constantly. */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Lists live Gemini crypto ladders followed by captured snapshots.
 *
 * Query: `asset` (optional), for example `?asset=SOL`.
 * 200 `{ ladders: LadderSummary[] }`; 400 `{ error }` for a malformed asset;
 * 502 `{ error }` when Gemini fails and no snapshot exists for the asset.
 *
 * @param {Request} request - The incoming request.
 * @returns {Promise<Response>} JSON response.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const assetParam = new URL(request.url).searchParams.get("asset");
    const asset = assetParam === null || assetParam.trim() === "" ? null : assetParam;
    const ladders = await listLadders(asset);
    return Response.json({ ladders }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof GeminiError && error.kind === "invalid-input") {
      return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error(`[api/ladders] ${describeError(error)}`);
    return Response.json({ error: describeError(error) }, { status: 502, headers: NO_STORE });
  }
}
