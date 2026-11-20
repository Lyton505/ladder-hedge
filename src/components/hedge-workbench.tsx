"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { GEMINI_TAKER_FEE_RATE } from "@/lib/hedge";
import type { Exposure, Ladder, PaperFill, SpotQuote } from "@/lib/hedge/types";
import { describeClientError, type SnapshotMeta } from "@/lib/client/api";
import {
  countTwoSidedRungs,
  hedgeInputBlocker,
  horizonLabel,
  ladderDepthBasis,
  ladderHorizon,
  matchVerifiedSignatures,
  MIN_TWO_SIDED_RUNGS,
  planDepthBasis,
  QUANTITY_PROMPT,
  spotPosition,
  spotPositionNotice,
  type DepthBasis,
} from "@/lib/client/workbench-model";
import { explorerTxUrl } from "@/lib/solana/constants";
import { buildReceiptMemo } from "@/lib/solana/receipt-memo";
import { sendHedgeReceipt } from "@/lib/solana/receipts";
import { useHedgePlan, type HedgePlanInputs } from "@/hooks/use-hedge-plan";
import { useHedgeReceipts } from "@/hooks/use-hedge-receipts";
import { useLadder } from "@/hooks/use-ladder";
import { useLadders } from "@/hooks/use-ladders";
import { useNow } from "@/hooks/use-now";
import { usePaperFills } from "@/hooks/use-paper-fills";
import { useSolBalance } from "@/hooks/use-sol-balance";
import { useSpot } from "@/hooks/use-spot";
import { CoherencePanel } from "./coherence-panel";
import { DataSourceBadge } from "./data-source-badge";
import { DistributionChart } from "./distribution-chart";
import { ExposurePanel } from "./exposure-panel";
import { FloorControls } from "./floor-controls";
import { HedgeLegsTable } from "./hedge-legs-table";
import { LadderPicker, type LadderNote } from "./ladder-picker";
import { LadderQuotesTable } from "./ladder-quotes-table";
import { PayoffChart } from "./payoff-chart";
import { PlanStats } from "./plan-stats";
import { ReceiptPanel } from "./receipt-panel";
import {
  formatClockTime,
  formatLocalDateTime,
  formatQuantity,
  formatShortHash,
  formatStrike,
  formatUsd,
} from "./format";

/** Asset selected when the page opens. */
const DEFAULT_ASSET = "SOL";

/** Quantity used when the user has not typed one and no positive wallet balance is available. */
const DEFAULT_QUANTITY = 10;

/** Default loss floor as a fraction of position value. */
const DEFAULT_MAX_LOSS_FRACTION = 0.015;

/** Default contracts assumed per leg where Gemini publishes no size. */
const DEFAULT_ASSUMED_DEPTH = 100;

/**
 * Inline style for the wallet adapter's button. The adapter's stylesheet is not in a
 * cascade layer, so it beats Tailwind's utilities; inline styles are the reliable override.
 */
const WALLET_BUTTON_STYLE: React.CSSProperties = {
  height: 32,
  padding: "0 12px",
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: "30px",
  color: "#142033",
  backgroundColor: "transparent",
  border: "1px solid rgba(20, 32, 51, 0.8)",
  borderRadius: 5,
};

/**
 * Placeholder shown while the wallet button's code loads in the browser.
 *
 * @returns {JSX.Element} A disabled button of the same size.
 */
function WalletButtonPlaceholder() {
  return (
    <button type="button" disabled style={WALLET_BUTTON_STYLE} className="opacity-60">
      Wallet
    </button>
  );
}

/**
 * The wallet adapter's connect button, loaded only in the browser: its label depends on
 * wallets found in the browser, which would not match a server render.
 */
const WalletMultiButton = dynamic(
  async () => {
    try {
      const walletUi = await import("@solana/wallet-adapter-react-ui");
      return walletUi.WalletMultiButton;
    } catch (error) {
      throw new Error(`Could not load the wallet button: ${describeClientError(error)}`, { cause: error });
    }
  },
  { ssr: false, loading: WalletButtonPlaceholder },
);

/** Tone of a notice above the results. */
type NoticeTone = "info" | "warning" | "error";

/** One message shown above the results. */
interface NoticeItem {
  id: string;
  tone: NoticeTone;
  title: string;
  body: string;
}

/**
 * A boxed message above the results.
 *
 * @param {{ notice: NoticeItem; action?: React.ReactNode }} props - Component props.
 * @param {NoticeItem} props.notice - What to say.
 * @param {React.ReactNode} [props.action] - Optional button after the text.
 * @returns {JSX.Element} The notice.
 */
function Notice({ notice, action }: { notice: NoticeItem; action?: React.ReactNode }) {
  const toneClass =
    notice.tone === "error"
      ? "border-alarm/30 bg-alarm-tint"
      : notice.tone === "warning"
        ? "border-dashed border-graphite/60 bg-fog-deep/70"
        : "border-rule bg-fog";
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`flex flex-col gap-1 rounded-[6px] border px-4 py-3 text-sm leading-relaxed ${toneClass}`}
    >
      <p className={`font-semibold ${notice.tone === "error" ? "text-alarm" : "text-ink"}`}>{notice.title}</p>
      <p className="text-ink">{notice.body}</p>
      {action !== undefined ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

/**
 * Builds the spot quote for a snapshot ladder from its captured reference spot, labelled
 * as a snapshot and, when it was not observed, as an estimate.
 *
 * @param {Ladder} ladder - The snapshot ladder.
 * @param {SnapshotMeta | null} snapshot - Provenance from the route.
 * @returns {SpotQuote | null} The quote, or null when the snapshot carries no spot.
 */
function snapshotSpotQuote(ladder: Ladder, snapshot: SnapshotMeta | null): SpotQuote | null {
  const price = snapshot?.referenceSpot ?? ladder.referenceSpot;
  if (price === null || !Number.isFinite(price)) {
    return null;
  }
  const estimated = snapshot?.spotIsEstimated === true;
  const detail = snapshot?.spotSource ?? "spot recorded with the snapshot";
  return {
    asset: ladder.asset,
    price,
    source: estimated ? `Snapshot spot, ESTIMATED (not observed): ${detail}` : `Snapshot spot: ${detail}`,
    asOf: snapshot?.capturedAt ?? ladder.fetchedAt,
  };
}

/**
 * Says where the size limits in a plan came from, in one sentence.
 *
 * @param {DepthBasis} basis - Where the plan's caps came from.
 * @param {number | null} assumedDepth - Contracts assumed per leg, or null for unlimited.
 * @returns {string} The sentence.
 */
function describeDepthBasis(basis: DepthBasis, assumedDepth: number | null): string {
  const assumed =
    assumedDepth === null
      ? "treated as unlimited (your setting)"
      : `capped at an assumed ${formatQuantity(assumedDepth)} contracts per leg`;
  switch (basis) {
    case "measured":
      return "Size limits: measured. Every contract in this plan is capped at the size Gemini's order book shows at the quoted price.";
    case "assumed":
      return `Size limits: assumed. Gemini published no size for these quotes, so each contract is ${assumed}.`;
    case "mixed":
      return `Size limits: mixed. Contracts with a published size are capped at it; the others are ${assumed}.`;
    case "none":
      return "This plan buys no contracts, so no size limit applies.";
  }
}

/**
 * Ends a message with a full stop unless it already ends with punctuation, so
 * messages from the server can be followed by another sentence.
 *
 * @param {string} text - The message.
 * @returns {string} The message as a sentence.
 */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Creates a unique id for a paper fill.
 *
 * @returns {string} A random UUID, or a time-based id where `crypto.randomUUID` is unavailable.
 */
function newFillId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The whole Ladder Hedge tool on one page: the holding, the ladder, the loss floor,
 * the cheapest basket that meets it with its payoff, the ladder's quotes and implied
 * distribution, and the paper fill with its Solana devnet receipt.
 *
 * Works without a wallet; only writing the on-chain receipt needs one.
 *
 * @returns {JSX.Element} The workbench.
 */
export function HedgeWorkbench() {
  const nowMs = useNow();
  const [asset, setAsset] = useState<string>(DEFAULT_ASSET);
  const [typedQuantity, setTypedQuantity] = useState<number | null>(null);
  // False while the quantity field is blank, unparseable or negative (it then keeps its last valid value).
  const [quantityDraftValid, setQuantityDraftValid] = useState<boolean>(true);
  const [maxLossFraction, setMaxLossFraction] = useState<number>(DEFAULT_MAX_LOSS_FRACTION);
  const [takerFeeRate, setTakerFeeRate] = useState<number>(GEMINI_TAKER_FEE_RATE);
  const [assumedDepth, setAssumedDepth] = useState<number | null>(DEFAULT_ASSUMED_DEPTH);
  const [selectedByAsset, setSelectedByAsset] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordNotice, setRecordNotice] = useState<string | null>(null);

  const wallet = useWallet();
  const { connection } = useConnection();
  const { balance: walletBalance, error: balanceError, refresh: refreshBalance } = useSolBalance();
  const { fills, addFill, setSignature } = usePaperFills();
  const receiptsState = useHedgeReceipts();
  const { refresh: refreshReceipts } = receiptsState;

  // Ladder list, default choice and the selected ladder.
  const laddersState = useLadders(asset);
  const userTicker = selectedByAsset[asset] ?? null;
  const selectedTicker = userTicker ?? laddersState.defaultTicker;
  const preloaded = selectedTicker === null ? null : (laddersState.preloaded[selectedTicker] ?? null);
  const ladderState = useLadder(selectedTicker, preloaded);
  const ladder = ladderState.ladder !== null && ladderState.ladder.asset === asset ? ladderState.ladder : null;
  const isSnapshot = ladder !== null && ladder.source === "snapshot";

  // Spot: live from Gemini, except for a snapshot ladder, which uses the spot captured with it.
  const spotState = useSpot(asset, !isSnapshot);
  const snapshotMeta = ladderState.snapshot;
  const snapshotSpot = useMemo(
    () => (ladder !== null && ladder.source === "snapshot" ? snapshotSpotQuote(ladder, snapshotMeta) : null),
    [ladder, snapshotMeta],
  );
  const spotQuote = isSnapshot ? snapshotSpot : spotState.spot;
  const spotError = isSnapshot
    ? snapshotSpot === null
      ? "This snapshot has no recorded spot price."
      : null
    : spotState.error;

  // Quantity: what the user typed, else the wallet's SOL balance, else the default.
  const walletDefault = asset === "SOL" && walletBalance !== null && walletBalance > 0 ? walletBalance : null;
  const quantity = typedQuantity ?? walletDefault ?? DEFAULT_QUANTITY;
  const positionValue = spotQuote === null || !quantityDraftValid ? Number.NaN : spotQuote.price * quantity;

  // The engine throws on a zero, negative or non-finite quantity or spot, so it is not called with one.
  const inputBlocker = hedgeInputBlocker(quantityDraftValid ? quantity : null, spotQuote?.price ?? null);
  const inputs = useMemo<HedgePlanInputs | null>(() => {
    if (ladder === null || spotQuote === null || inputBlocker !== null) {
      return null;
    }
    const exposure: Exposure = { asset, quantity, spot: spotQuote.price };
    return { ladder, exposure, maxLossFraction, takerFeeRate, assumedDepth };
  }, [ladder, spotQuote, inputBlocker, asset, quantity, maxLossFraction, takerFeeRate, assumedDepth]);

  const hedge = useHedgePlan(inputs);
  const plan = hedge.plan;
  const planRequest = hedge.planRequest;
  const planLadder = planRequest?.ladder ?? null;

  const ladderBasis = ladder === null ? "none" : ladderDepthBasis(ladder);
  const sizesUnknown = ladderBasis === "assumed" || ladderBasis === "mixed";
  const legBasis = plan !== null && planLadder !== null ? planDepthBasis(planLadder, plan.legs) : "none";
  const strikes = useMemo(() => (ladder === null ? [] : ladder.rungs.map((rung) => rung.strike)), [ladder]);
  const lowestStrike = strikes.length > 0 ? strikes[0] : null;
  const highestStrike = strikes.length > 0 ? strikes[strikes.length - 1] : null;
  const expiryMs = ladder === null ? Number.NaN : Date.parse(ladder.expiry);
  const expired = ladder !== null && nowMs !== null && !Number.isNaN(expiryMs) && expiryMs <= nowMs;
  const position = ladder !== null && spotQuote !== null ? spotPosition(ladder, spotQuote.price) : null;

  const fillsNewestFirst = useMemo(() => [...fills].reverse(), [fills]);
  const verifiedSignatures = useMemo(
    () => matchVerifiedSignatures(fills, receiptsState.receipts),
    [fills, receiptsState.receipts],
  );

  const ladderNotes = useMemo<Record<string, LadderNote>>(() => {
    const notes: Record<string, LadderNote> = {};
    for (const summary of laddersState.ladders) {
      const twoSided = laddersState.twoSidedByTicker[summary.eventTicker];
      notes[summary.eventTicker] = {
        horizon: horizonLabel(ladderHorizon(summary)),
        detail: twoSided === undefined ? null : `${twoSided} two-sided`,
      };
    }
    return notes;
  }, [laddersState.ladders, laddersState.twoSidedByTicker]);

  // Messages above the results: data provenance and the states the ladder can be in.
  const notices: NoticeItem[] = [];
  if (ladder !== null && isSnapshot) {
    const captured = ladderState.snapshot?.capturedAt ?? ladder.fetchedAt;
    const estimated = ladderState.snapshot?.spotIsEstimated === true;
    notices.push({
      id: "snapshot",
      tone: "warning",
      title: "Snapshot data, not live prices",
      body: `These quotes were captured from Gemini at ${formatLocalDateTime(captured)}. ${
        estimated
          ? "The spot price was not observed at capture: it is estimated from the ladder's own quotes."
          : "The spot price is the one observed at capture."
      } Order sizes were not captured, so depth is assumed.`,
    });
    const liveExists = laddersState.ladders.some((summary) => summary.source === "live");
    if (userTicker === null && liveExists && !laddersState.choosingDefault) {
      notices.push({
        id: "no-live-default",
        tone: "info",
        title: "No live ladder chosen by default",
        body: `No live ${asset} ladder had at least ${MIN_TWO_SIDED_RUNGS} rungs quoted on both sides when this page loaded, so the snapshot is shown. You can still pick a live ladder from the list.`,
      });
    }
  }
  if (ladder !== null && expired) {
    notices.push({
      id: "expired",
      tone: "error",
      title: "This ladder has expired",
      body: `It settled at ${formatLocalDateTime(ladder.expiry)}. Its contracts no longer trade, so the plan below is an illustration built from its last quotes, not something you could buy. Pick a ladder that has not expired.`,
    });
  }
  const spotNotice =
    ladder !== null && spotQuote !== null && lowestStrike !== null && highestStrike !== null
      ? spotPositionNotice({
          position,
          asset,
          spot: spotQuote.price,
          quantity,
          lowestStrike,
          highestStrike,
          // The stress price the displayed plan used, only when that plan is for this ladder.
          stressPrice: plan !== null && planLadder?.eventTicker === ladder.eventTicker ? plan.stressPrice : null,
        })
      : null;
  if (spotNotice !== null) {
    notices.push({ id: spotNotice.id, tone: "warning", title: spotNotice.title, body: spotNotice.body });
  }
  if (ladder !== null && ladderState.error !== null) {
    notices.push({
      id: "refresh-failed",
      tone: "warning",
      title: "The ladder could not be refreshed",
      body: `${asSentence(ladderState.error)} Showing the quotes read at ${formatClockTime(ladder.fetchedAt)}.`,
    });
  }
  if (!isSnapshot && spotQuote !== null && spotState.error !== null) {
    notices.push({
      id: "spot-refresh-failed",
      tone: "warning",
      title: "The spot price could not be refreshed",
      body: `${asSentence(spotState.error)} Using ${formatUsd(spotQuote.price)} read at ${formatClockTime(spotQuote.asOf)}.`,
    });
  }

  // Why there is no plan yet, when there is none.
  const noLadderAvailable =
    !laddersState.loading && !laddersState.choosingDefault && selectedTicker === null;
  let planError: string | null = null;
  if (noLadderAvailable && laddersState.error !== null) {
    planError = `The ${asset} ladder list could not be loaded, so there is nothing to hedge with yet. ${asSentence(laddersState.error)}`;
  } else if (ladder === null && ladderState.error !== null) {
    planError = `Ladder ${selectedTicker ?? ""} could not be loaded: ${asSentence(ladderState.error)}`;
  } else if (ladder !== null && spotQuote === null && spotError !== null) {
    planError = `The ${asset} spot price is unavailable, and the hedge needs it to value your holding. ${asSentence(spotError)} It is retried every 15 seconds.`;
  } else if (ladder !== null && spotQuote !== null && inputBlocker === "spot") {
    planError = `The ${asset} spot price received, ${formatUsd(spotQuote.price)}, is not a usable price, so the holding cannot be valued. It is retried every 15 seconds.`;
  } else if (inputBlocker === null && hedge.error !== null) {
    // With no usable quantity the engine is not called; a prompt is shown instead of an error.
    planError = hedge.error;
  }
  if (noLadderAvailable && planError === null) {
    notices.push({
      id: "no-ladder",
      tone: "info",
      title: `No ${asset} ladder to hedge with`,
      body: `Gemini lists no ${asset} price ladder right now and no snapshot is stored for it, so no hedge can be computed. Pick another asset.`,
    });
  }
  const quantityPrompt = planError === null && inputBlocker === "quantity" ? QUANTITY_PROMPT : null;
  const planLoading =
    planError === null &&
    quantityPrompt === null &&
    plan === null &&
    (laddersState.loading || laddersState.choosingDefault || ladderState.loading || spotState.loading);

  let maxHedgeableNote: string | null = null;
  if (hedge.maxHedgeableStatus === "computing") {
    maxHedgeableNote = "Calculating";
  } else if (hedge.maxHedgeableStatus === "error") {
    maxHedgeableNote = "could not be computed for this ladder";
  } else if (assumedDepth === null && sizesUnknown) {
    maxHedgeableNote = "not limited: depth is set to unlimited where Gemini publishes no size";
  }
  const depthNote =
    ladderBasis === "measured"
      ? "at this floor, on measured order-book sizes"
      : ladderBasis === "mixed"
        ? "at this floor, on measured sizes plus assumed depth where none is published"
        : "at this floor, on assumed depth";

  let disabledReason: string | null = null;
  if (plan === null || planRequest === null) {
    disabledReason = "Nothing to fill until a plan is computed.";
  } else if (hedge.stale) {
    disabledReason = "Updating the plan.";
  } else if (expired) {
    disabledReason = "This ladder has expired, so there is nothing to fill.";
  } else if (plan.legs.length === 0) {
    disabledReason = "Nothing to fill: this plan buys no contracts.";
  }
  const canRecord = disabledReason === null;

  /**
   * Switches asset. The ladder choice for each asset is remembered.
   *
   * @param {string} next - The asset to show.
   * @returns {void}
   */
  function handleAssetChange(next: string): void {
    setAsset(next);
  }

  /**
   * Remembers the user's ladder choice for the current asset.
   *
   * @param {string} ticker - The ladder picked.
   * @returns {void}
   */
  function handleSelectLadder(ticker: string): void {
    setSelectedByAsset((previous) => ({ ...previous, [asset]: ticker }));
  }

  /**
   * Saves a paper fill of the current plan in this browser, then, if a wallet is
   * connected, writes its receipt on Solana devnet and stores the signature. A failure
   * keeps the fill and shows the error.
   *
   * @returns {Promise<void>} Resolves when done; every failure is shown in the receipt panel.
   */
  async function handleRecord(): Promise<void> {
    if (plan === null || planRequest === null) {
      return;
    }
    setRecording(true);
    setRecordError(null);
    setRecordNotice(null);
    try {
      const eventTicker = planRequest.ladder.eventTicker;
      const exposure = planRequest.exposure;
      const { memo, planHash } = await buildReceiptMemo(eventTicker, exposure, plan);
      const fill: PaperFill = {
        id: newFillId(),
        createdAt: new Date().toISOString(),
        eventTicker,
        exposure,
        plan,
        planHash,
        memo,
        signature: null,
      };
      try {
        addFill(fill);
      } catch (error) {
        setRecordError(
          `The paper fill could not be saved in this browser, so no receipt was sent. ${asSentence(describeClientError(error))}`,
        );
        return;
      }

      if (wallet.publicKey === null) {
        setRecordNotice(
          "Paper fill saved in this browser (simulated, no order sent). No wallet is connected, so no on-chain receipt was written.",
        );
        return;
      }

      let signature: string;
      try {
        signature = await sendHedgeReceipt(connection, wallet, memo);
      } catch (error) {
        setRecordError(
          `${asSentence(describeClientError(error))} The paper fill is still saved in this browser, without a receipt.`,
        );
        return;
      }
      try {
        setSignature(fill.id, signature);
        setRecordNotice(`Receipt recorded on Solana devnet: ${formatShortHash(signature, 6)}.`);
      } catch (error) {
        setRecordError(
          `Receipt ${formatShortHash(signature, 6)} was written on devnet, but the saved fill could not be updated with it. ${asSentence(describeClientError(error))}`,
        );
      }
      refreshReceipts();
      refreshBalance();
    } catch (error) {
      setRecordError(`The paper fill could not be prepared. ${asSentence(describeClientError(error))}`);
    } finally {
      setRecording(false);
    }
  }

  const headerDetail =
    ladder === null
      ? null
      : isSnapshot
        ? `captured ${formatLocalDateTime(ladderState.snapshot?.capturedAt ?? ladder.fetchedAt)}`
        : `read ${formatClockTime(ladder.fetchedAt)}, refreshed every 15 s`;

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-end justify-between gap-x-8 gap-y-3 px-5 pb-5 pt-7 sm:px-8">
          <div className="flex flex-col gap-1.5">
            <h1 className="stretch-wide text-2xl font-bold tracking-tight sm:text-[1.75rem]">Ladder Hedge</h1>
            <p className="max-w-[64ch] text-sm leading-relaxed text-graphite">
              The cheapest basket of Gemini price-ladder contracts that keeps your loss at expiry above a
              floor you choose. Fills are simulated; no order is sent to Gemini.
            </p>
          </div>
          {ladder !== null && headerDetail !== null ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-graphite">
              <span className="max-w-[28ch] truncate font-medium text-ink" title={ladder.title}>
                {ladder.title}
              </span>
              <DataSourceBadge source={ladder.source} detail={headerDetail} />
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1320px] grid-cols-1 gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-8">
        <aside className="flex min-w-0 flex-col gap-7 lg:self-start">
          <div className="flex flex-col gap-2">
            <ExposurePanel
              asset={asset}
              onAssetChange={handleAssetChange}
              quantity={quantity}
              onQuantityChange={(next) => {
                setTypedQuantity(next);
                setQuantityDraftValid(true);
              }}
              onQuantityInvalid={() => setQuantityDraftValid(false)}
              quantityValid={quantityDraftValid}
              spot={spotQuote}
              spotLoading={!isSnapshot && spotState.loading}
              spotError={spotQuote === null ? spotError : null}
              walletBalance={walletBalance}
              onUseWalletBalance={() => {
                if (walletBalance !== null) {
                  setTypedQuantity(walletBalance);
                  setQuantityDraftValid(true);
                }
              }}
              walletButton={<WalletMultiButton style={WALLET_BUTTON_STYLE} />}
            />
            {wallet.publicKey !== null ? (
              <p className="text-xs leading-relaxed text-graphite">
                {balanceError !== null
                  ? `The wallet balance could not be read: ${balanceError}`
                  : "The wallet balance is read from Solana devnet, so it is test SOL, not a real holding."}
              </p>
            ) : null}
          </div>
          <div className="h-px bg-rule" />
          <FloorControls
            positionValue={positionValue}
            maxLossFraction={maxLossFraction}
            onMaxLossFractionChange={setMaxLossFraction}
            takerFeeRate={takerFeeRate}
            onTakerFeeRateChange={setTakerFeeRate}
            assumedDepth={assumedDepth}
            onAssumedDepthChange={setAssumedDepth}
            sizesUnknown={sizesUnknown}
          />
          <div className="h-px bg-rule" />
          <div className="flex flex-col gap-2">
            <LadderPicker
              ladders={laddersState.ladders}
              selectedTicker={selectedTicker}
              onSelect={handleSelectLadder}
              nowMs={nowMs}
              asset={asset}
              loading={laddersState.loading}
              error={laddersState.error}
              notes={ladderNotes}
            />
            {laddersState.error !== null ? (
              <button
                type="button"
                onClick={laddersState.retry}
                className="self-start text-sm font-medium text-cobalt underline decoration-cobalt/40 underline-offset-4 hover:decoration-cobalt"
              >
                Try again
              </button>
            ) : null}
            {!laddersState.loading && laddersState.choosingDefault && laddersState.ladders.length > 0 ? (
              <p className="text-xs text-graphite" aria-live="polite">
                Checking which live ladder is quoted on both sides
              </p>
            ) : null}
          </div>
        </aside>

        <div
          aria-busy={hedge.stale}
          className="flex min-w-0 flex-col gap-10 rounded-[8px] border border-rule bg-paper px-5 py-6 sm:px-8 sm:py-8"
        >
          {notices.length > 0 ? (
            <div className="flex flex-col gap-3">
              {notices.map((notice) => (
                <Notice key={notice.id} notice={notice} />
              ))}
            </div>
          ) : null}

          <PlanStats
            plan={planError === null && quantityPrompt === null ? plan : null}
            positionValue={planRequest === null ? positionValue : planRequest.exposure.quantity * planRequest.exposure.spot}
            asset={asset}
            expiry={ladder?.expiry ?? null}
            nowMs={nowMs}
            lowestStrike={lowestStrike}
            maxHedgeableQuantity={hedge.maxHedgeable}
            depthAssumed={ladderBasis !== "measured"}
            loading={planLoading}
            error={planError}
            maxHedgeableNote={maxHedgeableNote}
            depthNote={depthNote}
            emptyMessage={quantityPrompt}
            chartSlot={
              planError === null && !noLadderAvailable ? (
                <PayoffChart
                  points={hedge.payoff}
                  maxLoss={plan?.requestedMaxLoss ?? maxLossFraction * (Number.isFinite(positionValue) ? positionValue : 0)}
                  spot={planRequest?.exposure.spot ?? spotQuote?.price ?? null}
                  strikes={strikes}
                  asset={asset}
                  quantity={planRequest?.exposure.quantity ?? quantity}
                  loading={plan === null && quantityPrompt === null}
                />
              ) : null
            }
          />
          {planError !== null && ladder === null && ladderState.error !== null ? (
            <button
              type="button"
              onClick={ladderState.refresh}
              className="-mt-6 self-start text-sm font-medium text-cobalt underline decoration-cobalt/40 underline-offset-4 hover:decoration-cobalt"
            >
              Try loading the ladder again
            </button>
          ) : null}

          <section aria-label="Limits of this hedge" className="flex flex-col gap-1.5 border-l-[3px] border-l-ink/70 pl-4">
            <h2 className="stretch-semiwide text-[15px] font-semibold">What this hedge does not do</h2>
            <ul className="flex max-w-[76ch] list-disc flex-col gap-1 pl-4 text-sm leading-relaxed text-graphite">
              <li>
                It pays only at expiry
                {ladder !== null ? (
                  <>
                    {" "}(
                    <time dateTime={ladder.expiry} suppressHydrationWarning>
                      {formatLocalDateTime(ladder.expiry)}
                    </time>
                    )
                  </>
                ) : null}
                . Before then the basket&apos;s value moves with the market, and nothing protects you after it.
              </li>
              <li>
                {lowestStrike !== null
                  ? `Below the lowest strike, ${formatStrike(lowestStrike)}, the basket pays a fixed amount and every further dollar of decline is your loss.`
                  : "Below the lowest strike the basket pays a fixed amount and every further dollar of decline is your loss."}
              </li>
              <li>
                Gemini settles each ladder on its own reference price, which can differ from the spot shown here.
              </li>
              <li>
                Fills are simulated at the quoted asks, with the taker fee. No order is sent, and quoted sizes can
                change before anyone could trade them. Nothing here is a forecast or a promise of profit.
              </li>
            </ul>
          </section>

          <section aria-label="Contracts to buy" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="stretch-semiwide text-[15px] font-semibold">Contracts to buy</h2>
              <p className="text-sm leading-relaxed text-graphite">
                YES pays $1 if {asset} settles at or above its strike; NO pays $1 if it settles below. Prices are the
                quoted asks; fees use Gemini&apos;s taker formula.
              </p>
            </div>
            {plan !== null && planError === null ? (
              <>
                <HedgeLegsTable legs={plan.legs} totalCost={plan.totalCost} asset={asset} />
                <p className="text-xs leading-relaxed text-graphite">{describeDepthBasis(legBasis, assumedDepth)}</p>
              </>
            ) : (
              <p className="text-sm text-graphite">The contracts appear once a plan is computed.</p>
            )}
          </section>

          {ladder !== null ? (
            <div className="grid grid-cols-1 gap-10 2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <section aria-label="Ladder quotes" className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="stretch-semiwide text-[15px] font-semibold">Ladder quotes</h2>
                  <DataSourceBadge
                    source={ladder.source}
                    detail={
                      isSnapshot
                        ? `captured ${formatClockTime(ladderState.snapshot?.capturedAt ?? ladder.fetchedAt)}`
                        : `read ${formatClockTime(ladder.fetchedAt)}`
                    }
                  />
                </div>
                <LadderQuotesTable
                  rungs={ladder.rungs}
                  spot={spotQuote?.price ?? null}
                  planStrikes={plan?.legs.map((leg) => leg.strike) ?? []}
                />
                <p className="text-xs leading-relaxed text-graphite">
                  {countTwoSidedRungs(ladder)} of {ladder.rungs.length} rungs are quoted on both sides. A side with no
                  quote cannot be bought.
                </p>
              </section>
              <div className="flex min-w-0 flex-col gap-10">
                <DistributionChart states={hedge.states} spot={spotQuote?.price ?? null} asset={asset} />
                <CoherencePanel findings={hedge.coherence} error={hedge.coherenceError} />
              </div>
            </div>
          ) : null}

          <div className="h-px bg-rule" />
          <ReceiptPanel
            onRecord={() => {
              void handleRecord();
            }}
            canRecord={canRecord}
            disabledReason={disabledReason}
            recording={recording}
            error={recordError}
            notice={recordNotice}
            walletConnected={wallet.publicKey !== null}
            fills={fillsNewestFirst}
            receipts={receiptsState.receipts}
            verifiedSignatures={verifiedSignatures}
            explorerTxUrl={explorerTxUrl}
            receiptsLoading={receiptsState.loading}
            receiptsError={
              receiptsState.error === null
                ? null
                : `Receipts could not be read from Solana devnet. ${receiptsState.error}`
            }
          />
        </div>
      </main>
    </div>
  );
}
