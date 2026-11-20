export type LegSide = "yes" | "no";
export type DataSource = "live" | "snapshot";

/** One contract on a ladder: pays $1 on YES if the expiry price is at or above `strike`. */
export interface LadderRung {
  instrumentSymbol: string;
  label: string;
  strike: number;
  /** Best bid for YES in dollars (0..1), or null when no bid is quoted. */
  yesBid: number | null;
  /** Best ask for YES in dollars (0..1), or null when no ask is quoted. */
  yesAsk: number | null;
  /** Contracts available at the best bid, or null when unknown. */
  yesBidSize: number | null;
  /** Contracts available at the best ask, or null when unknown. */
  yesAskSize: number | null;
  /** Smallest tradable quantity step, in contracts. */
  quantityIncrement: number;
}

export interface Ladder {
  eventTicker: string;
  title: string;
  asset: string;
  /** ISO 8601 expiry time. */
  expiry: string;
  /** Sorted ascending by strike, strikes unique. */
  rungs: LadderRung[];
  fetchedAt: string;
  source: DataSource;
  /** Spot price at capture time for snapshots; null for live ladders. */
  referenceSpot: number | null;
}

export interface LadderSummary {
  eventTicker: string;
  title: string;
  asset: string;
  expiry: string;
  rungCount: number;
  quotedRungCount: number;
  source: DataSource;
}

export interface SpotQuote {
  asset: string;
  price: number;
  /** Human-readable origin, for example "Gemini SOLUSD ticker" or "snapshot". */
  source: string;
  asOf: string;
}

/** A long holding of `quantity` units of `asset`, valued at `spot` dollars per unit. */
export interface Exposure {
  asset: string;
  quantity: number;
  spot: number;
}

export interface HedgeLeg {
  instrumentSymbol: string;
  strike: number;
  side: LegSide;
  quantity: number;
  /** Ask price per contract in dollars, before fees. */
  price: number;
  /** Taker fee in dollars: takerFeeRate * quantity * price * (1 - price), rounded up to the next cent. */
  fee: number;
  /** quantity * price + fee. */
  cost: number;
}

/** One interval of the expiry price. State 0 is below the lowest strike; state i (i >= 1) starts at rung i-1's strike. */
export interface PriceState {
  index: number;
  /** Inclusive lower bound, or null for state 0. */
  lower: number | null;
  /** Exclusive upper bound, or null for the top state. */
  upper: number | null;
  /** Price at which the holder's loss is evaluated: the lower bound, or the stress price for state 0. */
  evalPrice: number;
  /** Market-implied probability of this interval; all states sum to 1. */
  probability: number;
}

export interface StateOutcome extends PriceState {
  unhedgedPnl: number;
  hedgePayout: number;
  /** unhedgedPnl + hedgePayout - totalCost. */
  hedgedPnl: number;
}

export interface HedgeRequest {
  ladder: Ladder;
  exposure: Exposure;
  /** Largest acceptable loss in dollars, as a non-negative number. */
  maxLoss: number;
  /** Evaluation price for state 0; null means lowest strike minus the median strike spacing. */
  stressPrice: number | null;
  /** Gemini taker rate; fee = rate * contracts * price * (1 - price). Gemini's published rate is 0.07. */
  takerFeeRate: number;
  /** Contracts assumed available per leg when the rung's size is unknown; null means unlimited. */
  assumedDepth: number | null;
}

/**
 * optimal: the floor is met at minimum cost.
 * best-effort: the floor cannot be met; the plan maximises the worst case instead.
 * no-hedge-needed: the unhedged worst case already meets the floor.
 * unhedgeable: no leg can improve the worst case.
 */
export type HedgeStatus = "optimal" | "best-effort" | "no-hedge-needed" | "unhedgeable";

export interface HedgePlan {
  status: HedgeStatus;
  legs: HedgeLeg[];
  totalCost: number;
  outcomes: StateOutcome[];
  worstCaseBefore: number;
  worstCaseAfter: number;
  /** Sum over states of probability * hedgePayout. */
  expectedHedgePayout: number;
  requestedMaxLoss: number;
  /** The stress price actually used for state 0. */
  stressPrice: number;
}

export interface ImpliedDistribution {
  strikes: number[];
  /** survival[i] = implied probability that the expiry price is at or above strikes[i]; non-increasing. */
  survival: number[];
  /** Length strikes.length + 1, aligned with PriceState.index; sums to 1. */
  bucketProbabilities: number[];
}

export type CoherenceKind = "arbitrage" | "bid-inversion" | "ask-inversion";

export interface CoherenceFinding {
  kind: CoherenceKind;
  lowerStrike: number;
  higherStrike: number;
  /** Dollars per contract pair. */
  edge: number;
  detail: string;
}

export interface PayoffPoint {
  price: number;
  unhedged: number;
  hedged: number;
}

export interface HedgeReceipt {
  signature: string;
  memo: string;
  blockTime: number | null;
  slot: number;
}

export interface PaperFill {
  id: string;
  createdAt: string;
  eventTicker: string;
  exposure: Exposure;
  plan: HedgePlan;
  planHash: string;
  memo: string;
  signature: string | null;
}
