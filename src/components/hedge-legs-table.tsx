import type { HedgeLeg } from "@/lib/hedge/types";
import { formatQuantity, formatStrike, formatUsd } from "./format";

/** Props for {@link HedgeLegsTable}. */
export interface HedgeLegsTableProps {
  /** Contracts the plan buys. */
  legs: HedgeLeg[];
  /** Total cost of the plan in dollars, fees included. */
  totalCost: number;
  /** Asset symbol for copy, for example "SOL". */
  asset: string;
}

/**
 * Describes when a leg pays $1 at expiry.
 *
 * @param {HedgeLeg} leg - The leg.
 * @returns {string} For NO, "below $69"; for YES, "$69 or above".
 */
function payoutCondition(leg: HedgeLeg): string {
  const strike = formatStrike(leg.strike);
  return leg.side === "no" ? `below ${strike}` : `${strike} or above`;
}

/**
 * The basket the plan buys: side, strike, when each contract pays, quantity,
 * price, fee and cost, with totals.
 *
 * @param {HedgeLegsTableProps} props - Component props.
 * @returns {JSX.Element} The table, or an empty-state line when there are no legs.
 */
export function HedgeLegsTable({ legs, totalCost, asset }: HedgeLegsTableProps) {
  if (legs.length === 0) {
    return (
      <p className="rounded-[5px] border border-dashed border-rule px-3 py-3 text-sm text-graphite">
        No contracts to buy for this floor.
      </p>
    );
  }

  const totalContracts = legs.reduce((sum, leg) => sum + leg.quantity, 0);
  const totalFees = legs.reduce((sum, leg) => sum + leg.fee, 0);
  const headCell = "px-2 py-2 text-right font-medium first:pl-0 first:text-left";
  const bodyCell = "px-2 py-2.5 text-right first:pl-0 first:text-left";
  const conditionHeadCell = "hidden px-2 py-2 text-left font-medium sm:table-cell";
  const conditionCell = "hidden px-2 py-2.5 text-left sm:table-cell";

  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="figures w-full border-collapse text-sm sm:min-w-[540px]">
        <caption className="sr-only">Contracts in the hedge</caption>
        <thead>
          <tr className="border-b border-ink/80 text-xs text-graphite">
            <th scope="col" className={headCell}>Buy</th>
            <th scope="col" className={conditionHeadCell}>Pays $1 if {asset} settles</th>
            <th scope="col" className={headCell}>Contracts</th>
            <th scope="col" className={headCell}>Price</th>
            <th scope="col" className={headCell}>Fee</th>
            <th scope="col" className={headCell}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((leg) => (
            <tr key={`${leg.instrumentSymbol}-${leg.side}`} className="border-b border-rule">
              <th scope="row" className={`${bodyCell} font-semibold`}>
                <span className="stretch-semiwide">{leg.side === "no" ? "NO" : "YES"}</span>{" "}
                <span className="font-normal text-graphite">{formatStrike(leg.strike)}</span>
              </th>
              <td className={conditionCell}>{payoutCondition(leg)}</td>
              <td className={bodyCell}>{formatQuantity(leg.quantity)}</td>
              <td className={bodyCell}>{formatUsd(leg.price)}</td>
              <td className={`${bodyCell} text-graphite`}>{formatUsd(leg.fee)}</td>
              <td className={`${bodyCell} font-medium`}>{formatUsd(leg.cost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-ink/80">
            <th scope="row" className={`${bodyCell} font-semibold`}>
              Total
            </th>
            <td className={conditionCell} />
            <td className={`${bodyCell} font-medium`}>{formatQuantity(totalContracts)}</td>
            <td className={bodyCell} />
            <td className={`${bodyCell} text-graphite`}>{formatUsd(totalFees)}</td>
            <td className={`${bodyCell} stretch-semiwide font-semibold`}>{formatUsd(totalCost)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
