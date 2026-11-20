import { GeminiError } from "@/lib/gemini/gemini-client";
import { describeError, getSpotQuote } from "@/lib/gemini/ladder-service";

/** Always run at request time: spot prices change constantly. */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Returns the spot price for an asset from Gemini's `{asset}usd` ticker.
 *
 * Query: `asset` (required), for example `?asset=SOL`.
 * 200 `{ spot: SpotQuote }`; 400 `{ error }` when `asset` is missing or malformed;
 * 502 `{ error }` when Gemini fails or has no ticker for the asset.
 *
 * @param {Request} request - The incoming request.
 * @returns {Promise<Response>} JSON response.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const asset = new URL(request.url).searchParams.get("asset");
    if (asset === null || asset.trim() === "") {
      return Response.json({ error: "Missing asset query parameter" }, { status: 400, headers: NO_STORE });
    }
    const spot = await getSpotQuote(asset);
    return Response.json({ spot }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof GeminiError && error.kind === "invalid-input") {
      return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error(`[api/spot] ${describeError(error)}`);
    return Response.json({ error: describeError(error) }, { status: 502, headers: NO_STORE });
  }
}
