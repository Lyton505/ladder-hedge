"use client";

import { useId } from "react";
import type { SpotQuote } from "@/lib/hedge/types";
import { NumberField } from "./floor-controls";
import { formatClockTime, formatQuantity, formatUsd } from "./format";

/** Assets that have Gemini price ladders and can be selected. */
export const SUPPORTED_ASSETS: readonly string[] = ["SOL", "BTC", "ETH", "XRP"];

/** Props for {@link ExposurePanel}. */
export interface ExposurePanelProps {
  /** The selected asset symbol, for example "SOL". */
  asset: string;
  /** Called when the user picks another asset. */
  onAssetChange: (asset: string) => void;
  /** Units of the asset held. */
  quantity: number;
  /** Called with a new valid quantity as the user types. */
  onQuantityChange: (quantity: number) => void;
  /** Current spot quote, or null when not yet known. */
  spot: SpotQuote | null;
  /** True while the spot price is loading. */
  spotLoading?: boolean;
  /** A readable message when the spot price could not be read. */
  spotError?: string | null;
  /** The connected wallet's SOL balance, or null when no wallet balance is available. */
  walletBalance: number | null;
  /** Called when the user asks to use the wallet balance as the quantity. */
  onUseWalletBalance: () => void;
  /** The wallet connect button, rendered by the caller. */
  walletButton: React.ReactNode;
  /** Selectable assets. Defaults to {@link SUPPORTED_ASSETS}. */
  assets?: readonly string[];
}

/**
 * Explains why the wallet balance action is unavailable, or returns null when it is available.
 *
 * @param {string} asset - The selected asset.
 * @param {number | null} walletBalance - The wallet's SOL balance, if known.
 * @returns {string | null} A short reason, or null when the action can be used.
 */
function walletActionBlocker(asset: string, walletBalance: number | null): string | null {
  if (asset !== "SOL") {
    return "The wallet balance is read for SOL only. Enter other holdings by hand.";
  }
  if (walletBalance === null) {
    return "Connect a Solana wallet to read its SOL balance, or enter a quantity by hand.";
  }
  return null;
}

/**
 * The holding to protect: asset, quantity, spot price with its source, and the
 * position value. Quantity can come from a connected Solana wallet when the
 * asset is SOL.
 *
 * @param {ExposurePanelProps} props - Component props.
 * @returns {JSX.Element} The panel.
 */
export function ExposurePanel({
  asset,
  onAssetChange,
  quantity,
  onQuantityChange,
  spot,
  spotLoading = false,
  spotError = null,
  walletBalance,
  onUseWalletBalance,
  walletButton,
  assets = SUPPORTED_ASSETS,
}: ExposurePanelProps) {
  const baseId = useId();
  const quantityId = `${baseId}-quantity`;
  const walletHelpId = `${baseId}-wallet-help`;
  const blocker = walletActionBlocker(asset, walletBalance);
  const spotIsSnapshot = spot !== null && spot.source.toLowerCase().includes("snapshot");
  const positionValue = spot !== null ? spot.price * quantity : null;

  return (
    <section aria-labelledby={`${baseId}-heading`} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${baseId}-heading`} className="stretch-semiwide text-[15px] font-semibold">
          Your holding
        </h2>
        <div className="shrink-0">{walletButton}</div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Asset</legend>
        <div className="grid grid-cols-4 rounded-[5px] border border-rule bg-paper p-0.5">
          {assets.map((option) => {
            const selected = option === asset;
            return (
              <label
                key={option}
                className={`stretch-semiwide flex h-9 cursor-pointer items-center justify-center rounded-[3px] text-sm font-semibold transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-cobalt ${
                  selected ? "bg-ink text-paper" : "text-graphite hover:text-ink"
                }`}
              >
                <input
                  type="radio"
                  name={`${baseId}-asset`}
                  value={option}
                  checked={selected}
                  onChange={() => onAssetChange(option)}
                  className="sr-only"
                />
                {option}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor={quantityId} className="text-sm font-medium">
          Quantity held
        </label>
        <NumberField
          id={quantityId}
          value={quantity}
          onCommit={onQuantityChange}
          min={0}
          suffix={asset}
          describedBy={walletHelpId}
        />
        <div id={walletHelpId} className="flex flex-col items-start gap-1">
          <button
            type="button"
            onClick={onUseWalletBalance}
            disabled={blocker !== null}
            className="text-sm font-medium text-cobalt underline decoration-cobalt/40 underline-offset-4 hover:decoration-cobalt disabled:cursor-not-allowed disabled:text-mist disabled:no-underline"
          >
            {walletBalance !== null && asset === "SOL"
              ? `Use wallet balance (${formatQuantity(walletBalance, 4)} SOL)`
              : "Use wallet balance"}
          </button>
          {blocker !== null ? (
            <p className="text-xs leading-relaxed text-graphite">{blocker}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-rule pt-4">
        <dl className="grid grid-cols-2 gap-x-4">
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-graphite">Spot price</dt>
            <dd className="figures stretch-semiwide text-xl font-semibold">
              {spotLoading && spot === null ? (
                <span className="text-mist">Loading</span>
              ) : spot !== null ? (
                formatUsd(spot.price)
              ) : (
                <span className="text-mist">{"–"}</span>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-graphite">Position value</dt>
            <dd className="figures stretch-semiwide text-xl font-semibold">
              {positionValue !== null ? (
                formatUsd(positionValue)
              ) : (
                <span className="text-mist">{"–"}</span>
              )}
            </dd>
          </div>
        </dl>
        <div className="text-xs leading-relaxed text-graphite">
          {spotError !== null && spotError !== "" ? (
            <span className="text-alarm">{spotError}</span>
          ) : spot !== null ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              {spotIsSnapshot ? (
                <span className="rounded-[3px] border border-dashed border-graphite/60 bg-fog-deep px-1.5 py-px font-medium text-ink">
                  Snapshot price
                </span>
              ) : null}
              <span>
                {spot.source}, as of{" "}
                <time dateTime={spot.asOf} suppressHydrationWarning>
                  {formatClockTime(spot.asOf)}
                </time>
              </span>
            </span>
          ) : spotLoading ? (
            "Reading the spot price"
          ) : (
            "Spot price not available yet."
          )}
        </div>
      </div>
    </section>
  );
}
