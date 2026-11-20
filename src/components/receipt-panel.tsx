"use client";

import type { HedgeReceipt, PaperFill } from "@/lib/hedge/types";
import { formatLocalDateTime, formatQuantity, formatShortHash, formatUsd } from "./format";

/** Props for {@link ReceiptPanel}. */
export interface ReceiptPanelProps {
  /** Called when the user asks to paper fill the plan and record a receipt. */
  onRecord: () => void;
  /** True when there is a plan with contracts to fill. */
  canRecord: boolean;
  /** Why the action is unavailable, shown when canRecord is false. */
  disabledReason?: string | null;
  /** True while a fill is being saved and its receipt sent. */
  recording: boolean;
  /** A readable message when the last attempt failed. */
  error: string | null;
  /** A neutral message about the last attempt, for example that a fill was saved without a receipt. */
  notice?: string | null;
  /** True when a Solana wallet is connected, so the receipt can be sent. */
  walletConnected: boolean;
  /** Paper fills saved in this browser, newest first. */
  fills: PaperFill[];
  /** Receipts read back from Solana devnet, newest first. */
  receipts: HedgeReceipt[];
  /**
   * Signatures of on-chain receipts this browser recorded: a saved fill stores the same
   * signature, and the memo's ladder and plan-hash prefix match that fill.
   */
  verifiedSignatures: readonly string[];
  /**
   * Signatures of on-chain receipts whose memo matches a saved plan but that no saved fill
   * recorded. They are shown as unverified.
   */
  unrecordedSignatures?: readonly string[];
  /** Builds the explorer link for a transaction signature. */
  explorerTxUrl: (signature: string) => string;
  /** True while receipts are being read from chain. */
  receiptsLoading?: boolean;
  /** A readable message when receipts could not be read from chain. */
  receiptsError?: string | null;
}

/** How a receipt compares with the fills saved here. */
type HashCheckState = "verified" | "unrecorded" | "unmatched";

/**
 * Marks whether an on-chain receipt was recorded by this browser for a saved fill.
 *
 * @param {{ state: HashCheckState }} props - Component props.
 * @param {HashCheckState} props.state - verified when a saved fill recorded this transaction and its
 *   memo matches; unrecorded when the memo matches a saved plan but no saved fill recorded this
 *   transaction; unmatched otherwise.
 * @returns {JSX.Element} The indicator.
 */
function HashCheck({ state }: { state: HashCheckState }) {
  if (state === "unrecorded") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-graphite">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.6" />
        </svg>
        Not verified: memo matches a saved plan but was not recorded by this browser
      </span>
    );
  }
  if (state === "verified") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-cobalt-deep">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5.5" fill="currentColor" />
          <path d="M3.4 6.2l1.7 1.7 3.5-3.7" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Hash verified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-graphite">
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.6" />
      </svg>
      Hash not matched
    </span>
  );
}

/**
 * Converts a block time in Unix seconds to ISO 8601.
 *
 * @param {number} seconds - Unix time in seconds.
 * @returns {string} The ISO time.
 */
function blockTimeToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Paper execution and its on-chain record. The fill is simulated at the quoted
 * prices and saved in this browser; a short receipt with the plan hash is
 * written as a memo on Solana devnet and read back to verify it.
 *
 * @param {ReceiptPanelProps} props - Component props.
 * @returns {JSX.Element} The panel.
 */
export function ReceiptPanel({
  onRecord,
  canRecord,
  disabledReason = null,
  recording,
  error,
  notice = null,
  walletConnected,
  fills,
  receipts,
  verifiedSignatures,
  unrecordedSignatures = [],
  explorerTxUrl,
  receiptsLoading = false,
  receiptsError = null,
}: ReceiptPanelProps) {
  const buttonDisabled = !canRecord || recording;

  return (
    <section aria-label="Paper fill and receipt" className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="stretch-semiwide text-[15px] font-semibold">Paper fill and receipt</h2>
        <p className="max-w-[68ch] text-sm leading-relaxed text-graphite">
          A paper fill is simulated at the quoted prices. No order is sent to Gemini. The receipt is a
          memo transaction on Solana devnet that carries a hash of the plan, so the plan can be checked
          later.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={onRecord}
            disabled={buttonDisabled}
            aria-busy={recording}
            className="stretch-semiwide inline-flex h-11 items-center gap-2 rounded-[5px] bg-cobalt px-5 text-sm font-semibold text-paper transition-colors hover:bg-cobalt-deep disabled:cursor-not-allowed disabled:bg-fog-deep disabled:text-mist"
          >
            {recording ? (
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="animate-spin">
                <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
                <path d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : null}
            {recording ? "Recording receipt" : "Paper fill and record receipt"}
          </button>
          <span className="text-xs leading-relaxed text-graphite">
            {!canRecord && disabledReason !== null && disabledReason !== ""
              ? disabledReason
              : walletConnected
                ? "Your wallet will ask you to sign one devnet transaction."
                : "No wallet connected: the fill is saved here without an on-chain receipt."}
          </span>
        </div>
        {error !== null && error !== "" ? (
          <p role="alert" className="rounded-[5px] border border-alarm/30 bg-alarm-tint px-3 py-2 text-sm text-alarm">
            {error}
          </p>
        ) : null}
        {notice !== null && notice !== "" ? (
          <p role="status" className="rounded-[5px] border border-rule bg-fog px-3 py-2 text-sm text-ink">
            {notice}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Saved fills</h3>
          {fills.length === 0 ? (
            <p className="text-sm text-graphite">No paper fills yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-rule border-y border-rule">
              {fills.map((fill) => {
                const contracts = fill.plan.legs.reduce((sum, leg) => sum + leg.quantity, 0);
                const verified = fill.signature !== null && verifiedSignatures.includes(fill.signature);
                return (
                  <li key={fill.id} className="figures flex flex-col gap-1 py-2.5 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="font-medium">
                        {formatQuantity(contracts)} contracts for {formatUsd(fill.plan.totalCost)}
                      </span>
                      <time dateTime={fill.createdAt} suppressHydrationWarning className="text-xs text-graphite">
                        {formatLocalDateTime(fill.createdAt)}
                      </time>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-graphite">
                      <span>
                        {formatQuantity(fill.exposure.quantity, 4)} {fill.exposure.asset}, worst case{" "}
                        {formatUsd(fill.plan.worstCaseAfter)}
                      </span>
                      <span>plan {formatShortHash(fill.planHash, 6)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {fill.signature !== null ? (
                        <>
                          <a
                            href={explorerTxUrl(fill.signature)}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs font-medium text-cobalt underline decoration-cobalt/40 underline-offset-4 hover:decoration-cobalt"
                          >
                            Devnet receipt {formatShortHash(fill.signature)}
                          </a>
                          <HashCheck state={verified ? "verified" : "unmatched"} />
                        </>
                      ) : (
                        <span className="text-xs text-graphite">Saved in this browser only, no receipt</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Receipts on Solana devnet</h3>
          {receiptsError !== null && receiptsError !== "" ? (
            <p role="alert" className="text-sm text-alarm">{receiptsError}</p>
          ) : null}
          {receiptsLoading && receipts.length === 0 ? (
            <p className="animate-pulse text-sm text-graphite">Reading receipts from devnet</p>
          ) : null}
          {!receiptsLoading && receipts.length === 0 && (receiptsError === null || receiptsError === "") ? (
            <p className="text-sm text-graphite">
              {walletConnected
                ? "No receipts from this wallet yet."
                : "Connect a wallet to read its receipts."}
            </p>
          ) : null}
          {receipts.length > 0 ? (
            <ul className="flex flex-col divide-y divide-rule border-y border-rule">
              {receipts.map((receipt) => (
                <li key={receipt.signature} className="figures flex flex-col gap-1 py-2.5 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <a
                      href={explorerTxUrl(receipt.signature)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-cobalt underline decoration-cobalt/40 underline-offset-4 hover:decoration-cobalt"
                    >
                      {formatShortHash(receipt.signature, 6)}
                    </a>
                    <span className="text-xs text-graphite">
                      {receipt.blockTime !== null ? (
                        <time dateTime={blockTimeToIso(receipt.blockTime)} suppressHydrationWarning>
                          {formatLocalDateTime(blockTimeToIso(receipt.blockTime))}
                        </time>
                      ) : (
                        `slot ${formatQuantity(receipt.slot, 0)}`
                      )}
                    </span>
                  </div>
                  <code className="break-all text-xs text-graphite">{receipt.memo}</code>
                  <HashCheck
                    state={
                      verifiedSignatures.includes(receipt.signature)
                        ? "verified"
                        : unrecordedSignatures.includes(receipt.signature)
                          ? "unrecorded"
                          : "unmatched"
                    }
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
