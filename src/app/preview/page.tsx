"use client";

import { useState } from "react";
import type {
  CoherenceFinding,
  HedgeLeg,
  HedgePlan,
  HedgeReceipt,
  HedgeStatus,
  Ladder,
  LadderRung,
  LadderSummary,
  PaperFill,
  PayoffPoint,
  PriceState,
  SpotQuote,
  StateOutcome,
} from "@/lib/hedge/types";
import { CoherencePanel } from "@/components/coherence-panel";
import { DataSourceBadge } from "@/components/data-source-badge";
import { DistributionChart } from "@/components/distribution-chart";
import { ExposurePanel } from "@/components/exposure-panel";
import { FloorControls } from "@/components/floor-controls";
import { HedgeLegsTable } from "@/components/hedge-legs-table";
import { LadderPicker } from "@/components/ladder-picker";
import { LadderQuotesTable } from "@/components/ladder-quotes-table";
import { PayoffChart } from "@/components/payoff-chart";
import { PlanStats } from "@/components/plan-stats";
import { ReceiptPanel } from "@/components/receipt-panel";

/*
 * Sample data for the component preview. Everything below is hard-coded and
 * self-consistent: leg fees follow Gemini's taker formula, and outcomes,
 * worst cases and the payoff curve are derived from the legs here, so the
 * numbers on screen agree with each other.
 */

/** Fixed clock for the preview, so countdowns are stable: 9:55 PM EST on Nov 20, 2026. */
const PREVIEW_NOW_MS = Date.parse("2026-11-21T02:55:00Z");
const SAMPLE_EXPIRY = "2026-11-21T05:00:00Z";
const SAMPLE_TICKER = "PM-SOL-20261121-0000";
const SAMPLE_SPOT = 72.12;
const SAMPLE_QUANTITY = 10;
const SAMPLE_TAKER_FEE_RATE = 0.07;
const SAMPLE_MAX_LOSS_FRACTION = 0.015;
const SAMPLE_STRESS_PRICE = 67;
const PREVIEW_ASSETS_WITH_WALLET = "SOL";

/** YES bid and ask per strike, as captured: [strike, yesBid, yesAsk]. */
const SAMPLE_QUOTES: ReadonlyArray<readonly [number, number | null, number | null]> = [
  [68, 0.95, 0.99],
  [69, 0.98, 0.99],
  [70, 0.96, null],
  [71, 0.95, null],
  [72, 0.7, 0.77],
  [73, null, 0.04],
  [74, null, 0.05],
  [75, null, 0.05],
];

/** Market-implied interval probabilities from pooled mid quotes, aligned with state index. */
const SAMPLE_PROBABILITIES: readonly number[] = [
  0.0225, 0, 0.0175, 0.01, 0.215, 0.711667, 0, 0, 0.023333,
];

const SAMPLE_RUNGS: LadderRung[] = SAMPLE_QUOTES.map(([strike, yesBid, yesAsk]) => ({
  instrumentSymbol: `SOL-20261121-${strike}`,
  label: `$${strike} or above`,
  strike,
  yesBid,
  yesAsk,
  yesBidSize: null,
  yesAskSize: null,
  quantityIncrement: 0.01,
}));

/** The lower rungs with order sizes filled in, to show the size columns. */
const SIZED_RUNGS: LadderRung[] = SAMPLE_RUNGS.slice(0, 4).map((rung, index) => ({
  ...rung,
  yesBidSize: rung.yesBid === null ? null : 40 + index * 15,
  yesAskSize: rung.yesAsk === null ? null : index === 1 ? null : 120,
}));

const SAMPLE_LADDER: Ladder = {
  eventTicker: SAMPLE_TICKER,
  title: "SOL price today at 12am EST",
  asset: "SOL",
  expiry: SAMPLE_EXPIRY,
  rungs: SAMPLE_RUNGS,
  fetchedAt: "2026-11-21T02:54:48Z",
  source: "live",
  referenceSpot: null,
};

const SAMPLE_STRIKES: number[] = SAMPLE_RUNGS.map((rung) => rung.strike);

const SAMPLE_STATES: PriceState[] = buildStates(SAMPLE_STRIKES, SAMPLE_STRESS_PRICE, SAMPLE_PROBABILITIES);

/**
 * Builds the price states for a ladder: one below the lowest strike, then one per strike.
 *
 * @param {number[]} strikes - Ascending strikes.
 * @param {number} stressPrice - Evaluation price for the bottom state.
 * @param {readonly number[]} probabilities - Probability per state, aligned by index.
 * @returns {PriceState[]} The states.
 */
function buildStates(strikes: number[], stressPrice: number, probabilities: readonly number[]): PriceState[] {
  const states: PriceState[] = [
    { index: 0, lower: null, upper: strikes[0], evalPrice: stressPrice, probability: probabilities[0] },
  ];
  strikes.forEach((strike, position) => {
    const upper = position + 1 < strikes.length ? strikes[position + 1] : null;
    states.push({
      index: position + 1,
      lower: strike,
      upper,
      evalPrice: strike,
      probability: probabilities[position + 1],
    });
  });
  return states;
}

/**
 * Builds a NO leg at a strike from the YES bid, with Gemini's taker fee rounded up to the cent.
 *
 * @param {number} strike - The rung strike.
 * @param {number} quantity - Contracts bought.
 * @returns {HedgeLeg} The leg.
 * @throws {Error} If the strike has no YES bid, so NO cannot be bought.
 */
function buildNoLeg(strike: number, quantity: number): HedgeLeg {
  const rung = SAMPLE_RUNGS.find((candidate) => candidate.strike === strike);
  if (rung === undefined || rung.yesBid === null) {
    throw new Error(`No YES bid at ${strike}; NO is not available.`);
  }
  const price = Number((1 - rung.yesBid).toFixed(4));
  const fee = Math.ceil(SAMPLE_TAKER_FEE_RATE * quantity * price * (1 - price) * 100 - 1e-9) / 100;
  return {
    instrumentSymbol: rung.instrumentSymbol,
    strike,
    side: "no",
    quantity,
    price,
    fee,
    cost: quantity * price + fee,
  };
}

/**
 * Total payout of a set of legs if the expiry price is `price`.
 *
 * @param {HedgeLeg[]} legs - The legs.
 * @param {number} price - Expiry price.
 * @returns {number} Dollars paid.
 */
function legsPayout(legs: HedgeLeg[], price: number): number {
  return legs.reduce((sum, leg) => {
    const pays = leg.side === "no" ? price < leg.strike : price >= leg.strike;
    return pays ? sum + leg.quantity : sum;
  }, 0);
}

/**
 * Assembles a full plan from legs, deriving outcomes and summary figures.
 *
 * @param {HedgeLeg[]} legs - The legs.
 * @param {number} maxLoss - Requested largest loss in dollars.
 * @param {HedgeStatus} status - Status to report.
 * @returns {HedgePlan} The plan.
 */
function buildPlan(legs: HedgeLeg[], maxLoss: number, status: HedgeStatus): HedgePlan {
  const totalCost = legs.reduce((sum, leg) => sum + leg.cost, 0);
  const outcomes: StateOutcome[] = SAMPLE_STATES.map((state) => {
    const unhedgedPnl = (state.evalPrice - SAMPLE_SPOT) * SAMPLE_QUANTITY;
    const hedgePayout = legsPayout(legs, state.evalPrice);
    return { ...state, unhedgedPnl, hedgePayout, hedgedPnl: unhedgedPnl + hedgePayout - totalCost };
  });
  return {
    status,
    legs,
    totalCost,
    outcomes,
    worstCaseBefore: Math.min(...outcomes.map((outcome) => outcome.unhedgedPnl)),
    worstCaseAfter: Math.min(...outcomes.map((outcome) => outcome.hedgedPnl)),
    expectedHedgePayout: outcomes.reduce((sum, outcome) => sum + outcome.probability * outcome.hedgePayout, 0),
    requestedMaxLoss: maxLoss,
    stressPrice: SAMPLE_STRESS_PRICE,
  };
}

/**
 * Samples profit and loss across expiry prices, with a point at each strike and
 * one just below it so the hedged line draws as steps.
 *
 * @param {HedgePlan} plan - The plan.
 * @returns {PayoffPoint[]} Points sorted by price.
 */
function buildPayoff(plan: HedgePlan): PayoffPoint[] {
  const prices = new Set<number>();
  for (let price = 66; price <= 76.0001; price += 0.25) {
    prices.add(Number(price.toFixed(4)));
  }
  SAMPLE_STRIKES.forEach((strike) => {
    prices.add(strike);
    prices.add(strike - 1e-6);
  });
  return Array.from(prices)
    .sort((a, b) => a - b)
    .map((price) => {
      const unhedged = (price - SAMPLE_SPOT) * SAMPLE_QUANTITY;
      return { price, unhedged, hedged: unhedged + legsPayout(plan.legs, price) - plan.totalCost };
    });
}

const SAMPLE_MAX_LOSS = SAMPLE_MAX_LOSS_FRACTION * SAMPLE_SPOT * SAMPLE_QUANTITY;

const SAMPLE_PLAN: HedgePlan = buildPlan(
  [buildNoLeg(69, 20), buildNoLeg(70, 10), buildNoLeg(71, 10), buildNoLeg(72, 3.58)],
  SAMPLE_MAX_LOSS,
  "optimal",
);

const SAMPLE_PAYOFF: PayoffPoint[] = buildPayoff(SAMPLE_PLAN);

const BEST_EFFORT_PLAN: HedgePlan = buildPlan(
  [buildNoLeg(68, 5), buildNoLeg(69, 5), buildNoLeg(70, 5), buildNoLeg(71, 5), buildNoLeg(72, 5)],
  0.005 * SAMPLE_SPOT * SAMPLE_QUANTITY,
  "best-effort",
);

const SAMPLE_LADDERS: LadderSummary[] = [
  {
    eventTicker: SAMPLE_TICKER,
    title: "SOL price today at 12am EST",
    asset: "SOL",
    expiry: SAMPLE_EXPIRY,
    rungCount: 8,
    quotedRungCount: 8,
    source: "live",
  },
  {
    eventTicker: "PM-SOL-20261122-0000",
    title: "SOL price tomorrow at 12am EST",
    asset: "SOL",
    expiry: "2026-11-22T05:00:00Z",
    rungCount: 10,
    quotedRungCount: 4,
    source: "live",
  },
];

const SNAPSHOT_LADDERS: LadderSummary[] = [
  {
    eventTicker: "PM-SOL-20261120-0000",
    title: "SOL price today at 12am EST",
    asset: "SOL",
    expiry: "2026-11-20T05:00:00Z",
    rungCount: 8,
    quotedRungCount: 5,
    source: "snapshot",
  },
];

const SAMPLE_SPOT_QUOTE: SpotQuote = {
  asset: "SOL",
  price: SAMPLE_SPOT,
  source: "Gemini SOLUSD ticker",
  asOf: "2026-11-21T02:54:51Z",
};

const SNAPSHOT_SPOT_QUOTE: SpotQuote = {
  asset: "SOL",
  price: 71.4,
  source: "snapshot",
  asOf: "2026-11-20T04:12:00Z",
};

const SAMPLE_FINDINGS: CoherenceFinding[] = [
  {
    kind: "arbitrage",
    lowerStrike: 70,
    higherStrike: 71,
    edge: 0.02,
    detail: "YES $70 ask $0.93 plus NO $71 ask $0.05 costs $0.98 for a pair that pays at least $1.00.",
  },
  {
    kind: "bid-inversion",
    lowerStrike: 68,
    higherStrike: 69,
    edge: 0.03,
    detail: "YES $69 bid $0.98 is above YES $68 bid $0.95.",
  },
];

const SAMPLE_SIGNATURE_A =
  "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi6ZtRHSu9hFCYsVwmRwHEw7RUtadyFdFZKdBEkeNDh6xJr";
const SAMPLE_SIGNATURE_B =
  "2nF8rDqLhUu7Fw4c9pyZQ3XbYV1sKe6mJtGaRdWo5HxNiCv8TzkMB3qAeLs7PjUoYd4fGh2RcWn9Xk6Ty5EbZmQa";
const SAMPLE_PLAN_HASH = "9c4e1b7a2f0d58e3a61c7b2d94f0e8a3c5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0";

const SAMPLE_FILLS: PaperFill[] = [
  {
    id: "fill-2",
    createdAt: "2026-11-21T02:51:10Z",
    eventTicker: SAMPLE_TICKER,
    exposure: { asset: "SOL", quantity: SAMPLE_QUANTITY, spot: SAMPLE_SPOT },
    plan: SAMPLE_PLAN,
    planHash: SAMPLE_PLAN_HASH,
    memo: `LH1|${SAMPLE_TICKER}|10|10.82|2.53|4|9c4e1b7a2f0d`,
    signature: SAMPLE_SIGNATURE_A,
  },
  {
    id: "fill-1",
    createdAt: "2026-11-21T02:40:02Z",
    eventTicker: SAMPLE_TICKER,
    exposure: { asset: "SOL", quantity: SAMPLE_QUANTITY, spot: SAMPLE_SPOT },
    plan: BEST_EFFORT_PLAN,
    planHash: "17ab03fe9d2c4b5a6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5",
    memo: `LH1|${SAMPLE_TICKER}|10|3.61|2.45|5|17ab03fe9d2c`,
    signature: null,
  },
];

const SAMPLE_RECEIPTS: HedgeReceipt[] = [
  {
    signature: SAMPLE_SIGNATURE_A,
    memo: `LH1|${SAMPLE_TICKER}|10|10.82|2.53|4|9c4e1b7a2f0d`,
    blockTime: Date.parse("2026-11-21T02:51:14Z") / 1000,
    slot: 377_214_908,
  },
  {
    signature: SAMPLE_SIGNATURE_B,
    memo: "LH1|PM-SOL-20261120-0000|4|2.90|0.88|2|5d0e6c2b8a14",
    blockTime: null,
    slot: 376_998_412,
  },
];

/**
 * Builds a Solana explorer link for a devnet transaction.
 *
 * @param {string} signature - Transaction signature.
 * @returns {string} The explorer URL.
 */
function previewExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/**
 * Does nothing; stands in for callbacks in static alternate states.
 *
 * @returns {void}
 */
function noop(): void {
  return;
}

/**
 * A placeholder for the wallet connect button, which the integration renders
 * from the Solana wallet adapter.
 *
 * @param {{ connected: boolean }} props - Component props.
 * @param {boolean} props.connected - Whether to show a connected address.
 * @returns {JSX.Element} The placeholder button.
 */
function PreviewWalletButton({ connected }: { connected: boolean }) {
  return (
    <button
      type="button"
      className="stretch-semiwide h-8 rounded-[5px] border border-ink/80 px-3 text-xs font-semibold text-ink hover:bg-paper"
    >
      {connected ? "7xKX...gAsU" : "Connect wallet"}
    </button>
  );
}

/**
 * Labels one alternate state in the gallery.
 *
 * @param {{ title: string; children: React.ReactNode }} props - Component props.
 * @param {string} props.title - What state is shown.
 * @param {React.ReactNode} props.children - The component in that state.
 * @returns {JSX.Element} The labelled frame.
 */
function StateFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium text-graphite">{title}</p>
      <div className="rounded-[6px] border border-rule bg-paper p-5">{children}</div>
    </div>
  );
}

/**
 * Preview of every presentational component with hard-coded sample data, plus
 * one alternate state of each. Not linked from the app; for design review only.
 *
 * @returns {JSX.Element} The preview page.
 */
export default function PreviewPage() {
  const [asset, setAsset] = useState<string>("SOL");
  const [quantity, setQuantity] = useState<number>(SAMPLE_QUANTITY);
  const [maxLossFraction, setMaxLossFraction] = useState<number>(SAMPLE_MAX_LOSS_FRACTION);
  const [takerFeeRate, setTakerFeeRate] = useState<number>(SAMPLE_TAKER_FEE_RATE);
  const [assumedDepth, setAssumedDepth] = useState<number | null>(100);
  const [maxOutlayFraction, setMaxOutlayFraction] = useState<number | null>(0.1);
  const [selectedTicker, setSelectedTicker] = useState<string>(SAMPLE_TICKER);
  const walletBalance = 12.4817;
  const positionValue = quantity * SAMPLE_SPOT;
  const planStrikes = SAMPLE_PLAN.legs.map((leg) => leg.strike);

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-end justify-between gap-x-8 gap-y-3 px-5 pb-5 pt-7 sm:px-8">
          <div className="flex flex-col gap-1.5">
            <p className="stretch-wide text-2xl font-bold tracking-tight sm:text-[1.75rem]">Ladder Hedge</p>
            <p className="max-w-[60ch] text-sm leading-relaxed text-graphite">
              The cheapest basket of Gemini price-ladder contracts that keeps your loss at expiry above
              a floor you choose.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-graphite">
            <span>Component preview with sample data</span>
            <DataSourceBadge source="live" detail="sample" />
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1320px] grid-cols-1 gap-6 px-5 py-6 sm:px-8 lg:grid-cols-[340px_minmax(0,1fr)] lg:gap-8">
        <aside className="flex flex-col gap-7 lg:sticky lg:top-6 lg:self-start">
          <ExposurePanel
            asset={asset}
            onAssetChange={setAsset}
            quantity={quantity}
            onQuantityChange={setQuantity}
            spot={SAMPLE_SPOT_QUOTE}
            walletBalance={asset === PREVIEW_ASSETS_WITH_WALLET ? walletBalance : null}
            onUseWalletBalance={() => setQuantity(walletBalance)}
            walletButton={<PreviewWalletButton connected />}
          />
          <div className="h-px bg-rule" />
          <LadderPicker
            ladders={SAMPLE_LADDERS}
            selectedTicker={selectedTicker}
            onSelect={setSelectedTicker}
            nowMs={PREVIEW_NOW_MS}
            asset={asset}
          />
          <div className="h-px bg-rule" />
          <FloorControls
            positionValue={positionValue}
            maxLossFraction={maxLossFraction}
            onMaxLossFractionChange={setMaxLossFraction}
            maxOutlayFraction={maxOutlayFraction}
            onMaxOutlayFractionChange={setMaxOutlayFraction}
            takerFeeRate={takerFeeRate}
            onTakerFeeRateChange={setTakerFeeRate}
            assumedDepth={assumedDepth}
            onAssumedDepthChange={setAssumedDepth}
            sizesUnknown
          />
        </aside>

        <div className="flex min-w-0 flex-col gap-10 rounded-[8px] border border-rule bg-paper px-5 py-6 sm:px-8 sm:py-8">
          <PlanStats
            plan={SAMPLE_PLAN}
            positionValue={SAMPLE_SPOT * SAMPLE_QUANTITY}
            asset="SOL"
            expiry={SAMPLE_EXPIRY}
            nowMs={PREVIEW_NOW_MS}
            lowestStrike={SAMPLE_STRIKES[0]}
            maxHedgeableQuantity={41.3}
            depthAssumed
            chartSlot={
              <PayoffChart
                points={SAMPLE_PAYOFF}
                maxLoss={maxLossFraction * positionValue}
                spot={SAMPLE_SPOT}
                strikes={SAMPLE_STRIKES}
                asset="SOL"
                quantity={SAMPLE_QUANTITY}
              />
            }
          />
          <section aria-label="Contracts to buy" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="stretch-semiwide text-[15px] font-semibold">Contracts to buy</h2>
              <p className="text-sm leading-relaxed text-graphite">
                NO pays $1 if SOL settles below its strike. Prices are the quoted asks; fees use
                Gemini&apos;s taker formula.
              </p>
            </div>
            <HedgeLegsTable legs={SAMPLE_PLAN.legs} totalCost={SAMPLE_PLAN.totalCost} asset="SOL" />
          </section>
          <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <section aria-label="Ladder quotes" className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="stretch-semiwide text-[15px] font-semibold">Ladder quotes</h2>
                <DataSourceBadge source={SAMPLE_LADDER.source} detail="read 9:54 PM" />
              </div>
              <LadderQuotesTable rungs={SAMPLE_LADDER.rungs} spot={SAMPLE_SPOT} planStrikes={planStrikes} />
            </section>
            <div className="flex min-w-0 flex-col gap-10">
              <DistributionChart states={SAMPLE_STATES} spot={SAMPLE_SPOT} asset="SOL" />
              <CoherencePanel findings={[]} />
            </div>
          </div>
          <div className="h-px bg-rule" />
          <ReceiptPanel
            onRecord={noop}
            canRecord
            recording={false}
            error={null}
            walletConnected
            fills={SAMPLE_FILLS}
            receipts={SAMPLE_RECEIPTS}
            verifiedSignatures={[SAMPLE_SIGNATURE_A]}
            explorerTxUrl={previewExplorerUrl}
          />
        </div>
      </main>

      <section aria-labelledby="alternate-states" className="border-t border-rule bg-fog-deep/50">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-6 px-5 py-8 sm:px-8">
          <div className="flex flex-col gap-1">
            <h2 id="alternate-states" className="stretch-wide text-xl font-bold tracking-tight">
              Other states
            </h2>
            <p className="text-sm text-graphite">Each component in an empty, loading, error or warning state.</p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            <StateFrame title="Holding: BTC, spot loading, no wallet balance">
              <ExposurePanel
                asset="BTC"
                onAssetChange={noop}
                quantity={0.25}
                onQuantityChange={noop}
                spot={null}
                spotLoading
                walletBalance={null}
                onUseWalletBalance={noop}
                walletButton={<PreviewWalletButton connected={false} />}
              />
            </StateFrame>
            <StateFrame title="Holding: snapshot spot price">
              <ExposurePanel
                asset="SOL"
                onAssetChange={noop}
                quantity={10}
                onQuantityChange={noop}
                spot={SNAPSHOT_SPOT_QUOTE}
                walletBalance={null}
                onUseWalletBalance={noop}
                walletButton={<PreviewWalletButton connected={false} />}
              />
            </StateFrame>
            <StateFrame title="Floor: unlimited depth, sizes published">
              <FloorControls
                positionValue={721.2}
                maxLossFraction={0.04}
                onMaxLossFractionChange={noop}
                maxOutlayFraction={null}
                onMaxOutlayFractionChange={noop}
                takerFeeRate={0.07}
                onTakerFeeRateChange={noop}
                assumedDepth={null}
                onAssumedDepthChange={noop}
                sizesUnknown={false}
              />
            </StateFrame>
            <StateFrame title="Ladders: snapshot, expired">
              <LadderPicker
                ladders={SNAPSHOT_LADDERS}
                selectedTicker="PM-SOL-20261120-0000"
                onSelect={noop}
                nowMs={PREVIEW_NOW_MS}
                asset="SOL"
              />
            </StateFrame>
            <StateFrame title="Ladders: loading">
              <LadderPicker ladders={[]} selectedTicker={null} onSelect={noop} nowMs={PREVIEW_NOW_MS} asset="ETH" loading />
            </StateFrame>
            <StateFrame title="Ladders: error and empty">
              <div className="flex flex-col gap-6">
                <LadderPicker
                  ladders={[]}
                  selectedTicker={null}
                  onSelect={noop}
                  nowMs={PREVIEW_NOW_MS}
                  asset="XRP"
                  error="Gemini did not answer within 8 seconds, and no snapshot is stored for XRP. Try again shortly."
                />
                <LadderPicker ladders={[]} selectedTicker={null} onSelect={noop} nowMs={PREVIEW_NOW_MS} asset="XRP" />
              </div>
            </StateFrame>
          </div>

          <StateFrame title="Plan: floor out of reach (best effort, 5 contracts per leg, floor 0.5%, size limit unknown)">
            <PlanStats
              plan={BEST_EFFORT_PLAN}
              positionValue={SAMPLE_SPOT * SAMPLE_QUANTITY}
              asset="SOL"
              expiry={SAMPLE_EXPIRY}
              nowMs={PREVIEW_NOW_MS}
              lowestStrike={SAMPLE_STRIKES[0]}
              maxHedgeableQuantity={null}
              depthAssumed
            />
          </StateFrame>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <StateFrame title="Plan: computing">
              <PlanStats
                plan={null}
                positionValue={721.2}
                asset="SOL"
                expiry={SAMPLE_EXPIRY}
                nowMs={PREVIEW_NOW_MS}
                lowestStrike={null}
                maxHedgeableQuantity={null}
                depthAssumed
                loading
              />
            </StateFrame>
            <StateFrame title="Plan: engine error">
              <PlanStats
                plan={null}
                positionValue={721.2}
                asset="SOL"
                expiry={SAMPLE_EXPIRY}
                nowMs={PREVIEW_NOW_MS}
                lowestStrike={null}
                maxHedgeableQuantity={null}
                depthAssumed
                error="The ladder has no quoted contracts on either side, so there is nothing to price. Pick another ladder or wait for quotes."
              />
            </StateFrame>
            <StateFrame title="Payoff: computing">
              <PayoffChart points={[]} maxLoss={10.82} spot={72.12} strikes={[]} asset="SOL" quantity={10} loading height={220} />
            </StateFrame>
            <StateFrame title="Distribution and legs: empty">
              <div className="flex flex-col gap-6">
                <DistributionChart states={[]} spot={null} asset="SOL" height={140} />
                <HedgeLegsTable legs={[]} totalCost={0} asset="SOL" />
              </div>
            </StateFrame>
            <StateFrame title="Quote consistency: findings">
              <CoherencePanel findings={SAMPLE_FINDINGS} />
            </StateFrame>
            <StateFrame title="Quotes: spot above every strike, some sizes published">
              <LadderQuotesTable rungs={SIZED_RUNGS} spot={72.12} />
            </StateFrame>
          </div>

          <StateFrame title="Receipt: recording, previous attempt failed, wallet not connected">
            <ReceiptPanel
              onRecord={noop}
              canRecord
              recording
              error="The wallet rejected the signature request. The paper fill is saved in this browser without a receipt."
              walletConnected={false}
              fills={[]}
              receipts={[]}
              verifiedSignatures={[]}
              explorerTxUrl={previewExplorerUrl}
              receiptsError="Solana devnet did not respond. Receipts will load when it does."
            />
          </StateFrame>
          <StateFrame title="Receipt: nothing to fill">
            <ReceiptPanel
              onRecord={noop}
              canRecord={false}
              disabledReason="Nothing to fill: this plan buys no contracts."
              recording={false}
              error={null}
              walletConnected
              fills={[]}
              receipts={[]}
              verifiedSignatures={[]}
              explorerTxUrl={previewExplorerUrl}
              receiptsLoading
            />
          </StateFrame>
        </div>
      </section>
    </div>
  );
}
