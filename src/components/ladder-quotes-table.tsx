import { Fragment } from "react";
import type { LadderRung } from "@/lib/hedge/types";
import { formatQuantity, formatStrike, formatUsd } from "./format";

/** Props for {@link LadderQuotesTable}. */
export interface LadderQuotesTableProps {
  /** Ladder rungs, sorted ascending by strike. */
  rungs: LadderRung[];
  /** Current spot price, marked between the rungs it falls between; null when unknown. */
  spot: number | null;
  /** Strikes that the current plan buys, marked in the table. */
  planStrikes?: readonly number[];
}

/**
 * Renders a quote cell: a dollar price, or "none" when the side is not quoted.
 *
 * @param {number | null} price - The price in dollars, or null.
 * @returns {JSX.Element} The cell content.
 */
function QuoteCell({ price }: { price: number | null }) {
  if (price === null) {
    return <span className="text-mist">none</span>;
  }
  return <span>{formatUsd(price)}</span>;
}

/**
 * Renders a size cell: a contract count, or "unknown" when Gemini did not report one.
 *
 * @param {number | null} size - Contracts at the best price, or null.
 * @returns {JSX.Element} The cell content.
 */
function SizeCell({ size }: { size: number | null }) {
  if (size === null) {
    return <span className="text-mist">unknown</span>;
  }
  return <span>{formatQuantity(size)}</span>;
}

/**
 * The ladder's quotes rung by rung: strike, YES bid and ask, the derived NO ask
 * (one minus the YES bid), and the sizes at each side. A rule marks where spot
 * sits on the ladder.
 *
 * @param {LadderQuotesTableProps} props - Component props.
 * @returns {JSX.Element} The table.
 */
export function LadderQuotesTable({ rungs, spot, planStrikes = [] }: LadderQuotesTableProps) {
  if (rungs.length === 0) {
    return (
      <p className="rounded-[5px] border border-dashed border-rule px-3 py-3 text-sm text-graphite">
        This ladder has no rungs to show.
      </p>
    );
  }

  const spotIndex = spot === null ? -1 : rungs.findIndex((rung) => rung.strike > spot);
  const showSpotAtEnd = spot !== null && spotIndex === -1;
  const anySizeKnown = rungs.some((rung) => rung.yesBidSize !== null || rung.yesAskSize !== null);
  const columnCount = anySizeKnown ? 6 : 4;
  const headCell = "px-2 py-2 text-right font-medium first:pl-0 first:text-left";
  const bodyCell = "px-2 py-2 text-right first:pl-0 first:text-left";

  return (
    <div className="flex flex-col gap-2">
      <div className="-mx-1 overflow-x-auto px-1">
        <table
          className={`figures w-full border-collapse whitespace-nowrap text-sm ${anySizeKnown ? "min-w-[520px]" : "sm:min-w-[360px]"}`}
        >
          <caption className="sr-only">Ladder quotes by strike</caption>
          <thead>
            <tr className="border-b border-ink/80 text-xs text-graphite">
              <th scope="col" className={headCell}>Contract</th>
              <th scope="col" className={headCell}>YES bid</th>
              <th scope="col" className={headCell}>YES ask</th>
              <th scope="col" className={headCell}>NO ask</th>
              {anySizeKnown ? (
                <>
                  <th scope="col" className={headCell}>Bid size</th>
                  <th scope="col" className={headCell}>Ask size</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rungs.map((rung, index) => {
              const noAsk = rung.yesBid === null ? null : 1 - rung.yesBid;
              const inPlan = planStrikes.includes(rung.strike);
              const label = rung.label !== "" ? rung.label : `${formatStrike(rung.strike)} or above`;
              return (
                <Fragment key={rung.instrumentSymbol}>
                  {index === spotIndex && spot !== null ? (
                    <SpotRow spot={spot} columnCount={columnCount} />
                  ) : null}
                  <tr className="border-b border-rule">
                    <th scope="row" className={`${bodyCell} font-medium`}>
                      <span className="flex items-center gap-2">
                        {label}
                        {inPlan ? (
                          <>
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-cobalt sm:hidden"
                              aria-hidden="true"
                            />
                            <span className="sr-only sm:not-sr-only sm:rounded-[3px] sm:bg-cobalt-tint sm:px-1.5 sm:py-px sm:text-[11px] sm:font-medium sm:text-cobalt-deep">
                              in plan
                            </span>
                          </>
                        ) : null}
                      </span>
                    </th>
                    <td className={bodyCell}><QuoteCell price={rung.yesBid} /></td>
                    <td className={bodyCell}><QuoteCell price={rung.yesAsk} /></td>
                    <td className={bodyCell}><QuoteCell price={noAsk} /></td>
                    {anySizeKnown ? (
                      <>
                        <td className={bodyCell}><SizeCell size={rung.yesBidSize} /></td>
                        <td className={bodyCell}><SizeCell size={rung.yesAskSize} /></td>
                      </>
                    ) : null}
                  </tr>
                </Fragment>
              );
            })}
            {showSpotAtEnd && spot !== null ? <SpotRow spot={spot} columnCount={columnCount} /> : null}
          </tbody>
        </table>
      </div>
      <p className="text-xs leading-relaxed text-graphite">
        NO ask is one minus the YES bid.{" "}
        {planStrikes.length > 0 ? "Rungs marked in cobalt are in the plan. " : ""}
        {anySizeKnown
          ? "Sizes are contracts at the best price; unknown where Gemini did not report one."
          : "Order sizes: unknown. Gemini reports no size for these quotes, so the depth limit is an assumption."}
      </p>
    </div>
  );
}

/**
 * A thin marker row that shows where spot sits between two strikes.
 *
 * @param {{ spot: number; columnCount: number }} props - Component props.
 * @param {number} props.spot - The spot price.
 * @param {number} props.columnCount - Number of table columns to span.
 * @returns {JSX.Element} The marker row.
 */
function SpotRow({ spot, columnCount }: { spot: number; columnCount: number }) {
  return (
    <tr aria-label={`Spot price ${formatUsd(spot)}`}>
      <td colSpan={columnCount} className="py-1">
        <span className="flex items-center gap-2 text-xs font-semibold text-ink">
          <span className="h-px flex-1 bg-ink/70" aria-hidden="true" />
          Spot {formatUsd(spot)}
          <span className="h-px flex-1 bg-ink/70" aria-hidden="true" />
        </span>
      </td>
    </tr>
  );
}
