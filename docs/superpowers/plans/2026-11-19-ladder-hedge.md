# Ladder Hedge Implementation Plan

> **For agentic workers:** this plan is executed task-by-task by subagents under a controller. Read the header (through "Shared Types") and your own task. Do not read other tasks unless your task's Interfaces block points at one.

**Goal:** A web app that reads a crypto exposure, pulls a Gemini price ladder, and computes the cheapest basket of ladder contracts that keeps the holder's loss above a floor, then records a hedge receipt on Solana devnet.

**Architecture:** Next.js App Router app. A pure TypeScript hedge engine (`src/lib/hedge`) runs in the browser. Server route handlers (`src/app/api`) proxy Gemini's public prediction-markets API and fall back to captured snapshots. A Solana module (`src/lib/solana`) reads the wallet balance and writes and reads memo receipts. One page composes presentational components.

**Tech Stack:** Next.js (latest stable that supports Node 20.20), React, TypeScript strict, Tailwind CSS, pnpm, Vitest, `yalps` (linear programming), `recharts`, `@solana/web3.js` v1, `@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`, `@solana/wallet-adapter-base`.

**Spec:** `docs/superpowers/specs/2026-11-19-ladder-hedge-design.md`

## Global Constraints

- Repo root: `the repository root`. Use absolute paths. Package manager: `pnpm`. Node 20.20.2.
- NEVER run `git commit`, `git push`, `git stash`, or create remotes. The owner approves every commit personally. `git status` and `git diff` are fine.
- No emojis anywhere: code, comments, UI copy, docs.
- Every function, component and hook has a JSDoc block with `@param`, `@returns`, and `@throws` where relevant.
- TypeScript strict. Never use `any` without a comment explaining why. Prefer explicit, readable code over clever one-liners.
- Every `async` function handles errors with `try/catch` and never swallows them: rethrow with context or return a typed error result.
- File names are kebab-case (`payoff-chart.tsx`). Components are PascalCase exports. Hooks are camelCase prefixed `use`. Constants are SCREAMING_SNAKE_CASE. Types and interfaces are PascalCase with no `I` prefix.
- Do not add or upgrade dependencies after Task 1. If you believe one is needed, say so in your report instead of installing it.
- Only touch files your task lists under Files. Another agent may be editing the rest of the tree at the same time.
- Honesty rules from the spec: snapshot data, assumed depth and estimated spot are always labelled as such in data and UI. No copy promises profit. The UI states that protection stops at the lowest strike.
- Done means: `pnpm lint`, `pnpm typecheck` and `pnpm test` all pass for the files you own, and your report says exactly what you ran and what it printed.

## Review Focus

1. A ladder whose rungs are quoted on one side only, or not at all (common: tonight 3 of 8 SOL rungs had no bid). Expected: unquoted sides are simply unavailable as legs; nothing throws; the implied distribution still sums to 1.
2. A floor that cannot be met (too tight, or depth too small). Expected: a `best-effort` plan with the true achieved worst case, never a plan labelled `optimal` that breaches the floor by more than rounding.
3. Spot outside the ladder's strike range, or a ladder that has already expired. Expected: states still build; the UI shows the ladder as expired or out of range rather than a blank chart.
4. Gemini returning an error, a timeout, or an event that is no longer active. Expected: the route returns a typed error or falls back to a snapshot labelled `snapshot`; the page shows a readable message.
5. Wallet not installed, user rejects the signature, or devnet RPC fails. Expected: the receipt panel shows the error and the paper fill is still saved locally with `signature: null`.

---

## Shared Types

Task 1 creates `src/lib/hedge/types.ts` with exactly these exports. Every other task imports from it and none may change it; report a needed change instead.

```ts
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
```

Derived prices used everywhere: buying YES at a rung costs `yesAsk`; buying NO costs `1 - yesBid`. A side with a null source quote is not available.

---

### Task 1: Scaffold

**Files:** everything needed for an empty, passing Next.js project at the repo root, plus `src/lib/hedge/types.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`. Do not delete `docs/`.

**Produces:** scripts `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck` (`tsc --noEmit`), `pnpm test` (`vitest run`); path alias `@/*` to `src/*`; all dependencies in Tech Stack installed.

- [ ] Step 1: The repo root contains only `docs/`. Scaffold with create-next-app into a temporary sibling directory and move the result in, or scaffold in place if the tool allows it. Flags: TypeScript, ESLint, Tailwind, `src/` directory, App Router, import alias `@/*`, pnpm, and `--disable-git` (create-next-app otherwise makes a commit, which is forbidden).
- [ ] Step 2: Run `git init` at the repo root (no commit). Ensure `.gitignore` covers `node_modules`, `.next`, `.env*.local`, `.superpowers/`, `.vercel`.
- [ ] Step 3: Confirm `"strict": true` in `tsconfig.json`. Add the `typecheck` and `test` scripts.
- [ ] Step 4: Install `yalps recharts @solana/web3.js @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-adapter-react-ui` and dev dependencies `vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom`. If `yalps` does not install or has no TypeScript types, install `javascript-lp-solver` instead and say so in the report.
- [ ] Step 5: Write `vitest.config.ts` (node environment by default, `@` alias, include `src/**/*.test.ts` and `src/**/*.test.tsx`).
- [ ] Step 6: Create `src/lib/hedge/types.ts` with the Shared Types block verbatim, and `src/lib/hedge/types.test.ts` with one trivial test so `pnpm test` has something to run.
- [ ] Step 7: Write `.env.example` with `NEXT_PUBLIC_SOLANA_CLUSTER=devnet`, `NEXT_PUBLIC_SOLANA_RPC_URL=` (optional override) and `LADDER_FORCE_SNAPSHOT=` (set to `1` to serve snapshots only).
- [ ] Step 8: Replace the starter page with a minimal placeholder that says "Ladder Hedge". Set the metadata title to "Ladder Hedge".
- [ ] Step 9: Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. All four must pass. Report installed versions of next, react, yalps (or the fallback), recharts and the Solana packages.

---

### Task 2: Hedge engine

**Files:**
- Create: `src/lib/hedge/implied-distribution.ts`, `src/lib/hedge/price-states.ts`, `src/lib/hedge/optimize-hedge.ts`, `src/lib/hedge/coherence.ts`, `src/lib/hedge/payoff.ts`, `src/lib/hedge/index.ts` (re-exports), `src/lib/hedge/test-fixtures.ts`
- Test: one `*.test.ts` beside each module.

**Interfaces produced (exact signatures):**

```ts
export function impliedDistribution(ladder: Ladder): ImpliedDistribution;
export function defaultStressPrice(ladder: Ladder): number;
export function buildPriceStates(ladder: Ladder, stressPrice: number | null): PriceState[];
export function legPaysAtPrice(side: LegSide, strike: number, price: number): boolean;
export function optimizeHedge(request: HedgeRequest): HedgePlan;
export function maxHedgeableQuantity(request: HedgeRequest, maxLossFraction: number): number | null;
export function checkCoherence(ladder: Ladder): CoherenceFinding[];
export function evaluatePayoffAt(price: number, exposure: Exposure, legs: HedgeLeg[], totalCost: number): PayoffPoint;
export function payoffCurve(plan: HedgePlan, exposure: Exposure, ladder: Ladder, pointCount: number): PayoffPoint[];
```

**Definitions (these are the decisions; implement them exactly):**

- Rungs with strikes K1 < ... < Kn. States 0..n as in `PriceState`. `evalPrice` is the lower bound, or the stress price for state 0. `defaultStressPrice` is K1 minus the median gap between adjacent strikes; for a one-rung ladder it is 0.99 * K1. A supplied stress price at or above K1 throws a `RangeError`.
- `legPaysAtPrice`: YES pays when `price >= strike`; NO pays when `price < strike`.
- Unhedged profit and loss in a state: `exposure.quantity * (evalPrice - exposure.spot)`.
- Raw survival for a rung: both quotes present, the mid; bid only, `(yesBid + 1) / 2`; ask only, `yesAsk / 2`; neither, linear interpolation in strike between the nearest quoted rungs on each side, treating the region below K1 as survival 1 and above Kn as survival 0 at one median gap beyond the end. Then enforce non-increasing survival with pool-adjacent-violators (unweighted), and clamp to [0, 1]. Bucket probabilities: `1 - survival[0]`, then `survival[i-1] - survival[i]`, then `survival[n-1]`.
- Legs available to the optimiser: for each rung, YES at `yesAsk` if non-null, NO at `1 - yesBid` if `yesBid` is non-null. Unit cost inside the linear programs is `price + takerFeeRate * price * (1 - price)` (Gemini's taker fee formula, source https://www.gemini.com/fees/predictions; export `GEMINI_TAKER_FEE_RATE = 0.07` from `optimize-hedge.ts`). Legs with unit cost >= 1 are excluded (they can never help). After rounding quantities, each leg's `fee` is `takerFeeRate * quantity * price * (1 - price)` rounded UP to the next cent (0 when the rate is 0), and `cost = quantity * price + fee`. Cap per leg: the rung's size on the side being lifted (`yesAskSize` for YES, `yesBidSize` for NO) if non-null, else `assumedDepth` if non-null, else none.
- Stage 1 (LP): minimise total cost subject to, for every state j, `unhedged_j + sum(quantity_l * pays_lj) - totalCost >= -maxLoss`, and caps. If `worstCaseBefore >= -maxLoss` return `no-hedge-needed` with no legs without solving.
- Stage 2 (LP, when stage 1 is infeasible): maximise t subject to `hedged_j >= t` for every state, and caps. If the resulting worst case does not beat `worstCaseBefore` by more than 1e-9, return `unhedgeable` with no legs; otherwise `best-effort`. t may be negative: model it as the difference of two non-negative variables if the solver requires non-negative variables.
- After solving, drop legs below half an increment, round each remaining quantity UP to its rung's `quantityIncrement`, respecting the cap (round down if rounding up would exceed it), then recompute every cost, outcome, `worstCaseAfter` and `expectedHedgePayout` from the rounded legs. Reported numbers always describe the rounded plan.
- `maxHedgeableQuantity`: returns null when at least one available leg has no cap. Otherwise the largest quantity q (bisection, 40 iterations, upper bound found by doubling from 1 up to 1e9) such that `optimizeHedge` with `exposure.quantity = q` and `maxLoss = maxLossFraction * q * spot` returns `optimal` or `no-hedge-needed`. Returns 0 if even tiny quantities fail.
- `checkCoherence`: `arbitrage` for every pair of rungs i < k with `yesAsk_i < yesBid_k` (buying YES at the lower strike and NO at the higher strike costs under $1 and always pays at least $1), edge `yesBid_k - yesAsk_i`. `bid-inversion` for adjacent rungs where the higher strike's `yesBid` exceeds the lower strike's `yesBid`; `ask-inversion` likewise for `yesAsk`; edge is the difference. Sort arbitrage first, then by edge descending. `detail` is one plain sentence with the strikes and prices.
- `payoffCurve`: `pointCount` evenly spaced prices from `plan.stressPrice - gap` to `Kn + gap` (gap = median strike spacing), plus one point at each strike and one just below each strike (strike minus 1e-6 of the gap) so the steps render as steps; sorted by price.

**Canonical fixture** (`test-fixtures.ts`, exported as `SOL_FIXTURE_LADDER`): asset `SOL`, eventTicker `SOL-FIXTURE`, `quantityIncrement` 0.01, all sizes null, `referenceSpot` 72.12, source `snapshot`, rungs:

| strike | yesBid | yesAsk |
|---|---|---|
| 68 | 0.95 | 0.99 |
| 69 | 0.98 | 0.99 |
| 70 | 0.96 | null |
| 71 | 0.95 | null |
| 72 | 0.70 | 0.77 |
| 73 | null | 0.04 |
| 74 | null | 0.05 |
| 75 | null | 0.05 |

`SOL_FIXTURE_EXPOSURE`: `{ asset: "SOL", quantity: 10, spot: 72.12 }`.

**Tests (TDD: write each failing test first, watch it fail, then implement):**

- [ ] `impliedDistribution(SOL_FIXTURE_LADDER)`: survival is `[0.978333, 0.978333, 0.978333, 0.975, 0.735, 0.023333, 0.023333, 0.023333]` and bucketProbabilities is `[0.021667, 0, 0, 0.003333, 0.24, 0.711667, 0, 0, 0.023333]`, each to 5 decimal places; buckets sum to 1 within 1e-9.
- [ ] `impliedDistribution` on a ladder with a fully unquoted middle rung interpolates it between its neighbours and still sums to 1; on a ladder with no quotes at all it does not throw and sums to 1.
- [ ] `defaultStressPrice(SOL_FIXTURE_LADDER)` is 67. `buildPriceStates` returns 9 states; state 0 has `lower: null, upper: 68, evalPrice: 67`; state 5 has `lower: 72, upper: 73, evalPrice: 72`; state 8 has `upper: null, evalPrice: 75`. A stress price of 68 throws `RangeError`.
- [ ] `optimizeHedge` with the fixture, `maxLoss: 10`, `stressPrice: null`, `takerFeeRate: 0`, `assumedDepth: null`: status `optimal`; `worstCaseBefore` is -51.2 (2 decimals); `totalCost` is between 2.37 and 2.40 (the unrounded optimum is 2.371429); `worstCaseAfter >= -10.02`; every leg has side `no`; every outcome's `hedgedPnl` equals `unhedgedPnl + hedgePayout - totalCost` within 1e-9; no leg at strike 68 (strike 69 is cheaper and dominates it).
- [ ] Same request with `maxLoss: 0`: status `best-effort`, `worstCaseAfter > worstCaseBefore`, and `worstCaseAfter` equals the minimum `hedgedPnl` across outcomes.
- [ ] Same request with `maxLoss: 10, assumedDepth: 5`: status `best-effort` and every leg quantity is at most 5.
- [ ] Same request with `maxLoss: 100`: status `no-hedge-needed`, no legs, `totalCost` 0.
- [ ] The fixture with every `yesBid` set to null, `maxLoss: 10`: status `unhedgeable`, no legs, `totalCost` 0, `worstCaseAfter` equals `worstCaseBefore`.
- [ ] `takerFeeRate: 0.07` raises `totalCost` above the zero-fee cost for the same request; every leg's `fee` equals `Math.ceil(0.07 * quantity * price * (1 - price) * 100 - 1e-9) / 100`; `totalCost` equals the sum of leg costs; with `takerFeeRate: 0` every leg's `fee` is 0.
- [ ] `maxHedgeableQuantity` returns null with `assumedDepth: null`; with `assumedDepth: 50` and `maxLossFraction: 0.02` it returns a positive finite number q, `optimizeHedge` at 0.99 q is `optimal`, and at 1.05 q it is not.
- [ ] `checkCoherence(SOL_FIXTURE_LADDER)` returns exactly a `bid-inversion` for 68/69 (edge 0.03) and an `ask-inversion` for 73/74 (edge 0.01), and no `arbitrage`. A two-rung ladder with lower `yesAsk` 0.40 and higher `yesBid` 0.45 yields one `arbitrage` with edge 0.05, sorted first.
- [ ] `evaluatePayoffAt(70.5, exposure, legs, cost)` with one NO leg at strike 71 quantity 10 cost 0.5: unhedged is -16.2, hedged is -6.7 (within 1e-9). `legPaysAtPrice("yes", 72, 72)` is true; `legPaysAtPrice("no", 72, 72)` is false.
- [ ] `payoffCurve` output is sorted by price, includes a point at every strike, and `unhedged` is strictly increasing.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test`. All pass.

---

### Task 3: Gemini data layer

**Files:**
- Create: `src/lib/gemini/parse-ladder.ts`, `src/lib/gemini/gemini-client.ts`, `src/lib/gemini/ladder-service.ts`, `src/lib/gemini/order-book.ts`, `src/app/api/ladders/route.ts`, `src/app/api/ladders/[ticker]/route.ts`, `src/app/api/spot/route.ts`, `fixtures/gemini/*.json`
- Test: `src/lib/gemini/parse-ladder.test.ts`, `src/lib/gemini/ladder-service.test.ts`

**Interfaces produced:**

```ts
export function parseLadder(rawEvent: unknown, source: DataSource, fetchedAt: string, referenceSpot: number | null): Ladder | null;
export function summarizeLadder(ladder: Ladder): LadderSummary;
export async function fetchActiveCryptoEvents(): Promise<unknown[]>;
export async function fetchEvent(ticker: string): Promise<unknown>;
export async function fetchSpot(asset: string): Promise<SpotQuote>;
export async function listLadders(asset: string | null): Promise<LadderSummary[]>;
export async function getLadder(ticker: string): Promise<Ladder>;
```

HTTP contract (all JSON, `cache: "no-store"`):
- `GET /api/ladders?asset=SOL` returns `{ ladders: LadderSummary[] }`; `asset` optional.
- `GET /api/ladders/{ticker}` returns `{ ladder: Ladder }`, or 404 `{ error: string }`.
- `GET /api/spot?asset=SOL` returns `{ spot: SpotQuote }`, or 502 `{ error: string }`.

**Known facts about the API (verified 2026-11-19; re-verify anything you rely on beyond these):**
- `GET https://api.gemini.com/v1/prediction-markets/events?status=active&limit=500&offset=0` needs no API key and returns `{ data: Event[], pagination: { limit, offset, total } }`. Docs say a `category` filter and a `search` parameter exist; confirm the exact value that returns only crypto events and use it, otherwise page through and filter on `event.category === "Crypto"`.
- `GET https://api.gemini.com/v1/prediction-markets/events/{ticker}` returns one event.
- Ladder events have `type: "categorical"`, `category: "Crypto"`, tickers like `SOL2611200500`, `expiryDate`, and contracts with `label: "$72 or above"`, `instrumentSymbol: "GEMI-SOL2611200500-HI72"`, `quantityIncrement`, `priceIncrement`, `status`, `marketState`, and `prices: { bestBid?, bestAsk?, buy: { yes?, no? }, sell: { yes?, no? }, lastTradePrice? }` as decimal strings. One-sided books are common. `buy.no` equals one minus `bestBid`. Events with `type: "binary"` (5 and 15 minute up/down) are not ladders and must be ignored.
- `GET https://api.gemini.com/v1/pubticker/solusd` returns `{ bid, ask, last, volume }` as strings. Use the bid/ask mid for spot. Symbols follow `{asset}usd` lowercased; if an asset has no ticker, return a typed error.
- Saved raw responses from tonight are at `(local capture folder, not in the repo) ev.json` and `ev2.json` (two pages of the events endpoint). Extract the `SOL2611200500`, `BTC2611200500` and `ETH2611200500` events into `fixtures/gemini/` as individual files. SOL spot at capture was 72.12; for BTC and ETH store an estimate (the strike where the implied survival crosses 0.5) and mark it `spotIsEstimated: true` in `fixtures/gemini/snapshot-meta.json` along with `capturedAt: "2026-11-20T04:44:00Z"`.

**Decisions:**
- `parseLadder` returns null unless the event is a crypto categorical event with at least two contracts whose label matches "or above" with a parsable dollar strike (strip `$` and commas). `yesBid` from `bestBid` (fallback `sell.yes`), `yesAsk` from `bestAsk` (fallback `buy.yes`). Prices of 0 or 1 or non-numeric become null. Rungs whose contract `status` is not active are dropped. Asset is the leading letters of the event ticker. Rungs sorted ascending, duplicates by strike dropped (keep the first).
- `listLadders` returns live ladders whose expiry is in the future, followed by snapshot ladders (source `snapshot`). If the live call fails or `LADDER_FORCE_SNAPSHOT=1`, return snapshots only. Never throw to the route for a live failure when snapshots exist.
- `getLadder(ticker)`: snapshot tickers are served from fixtures with ticker suffix `-SNAPSHOT` (for example `SOL2611200500-SNAPSHOT`) so they never collide with live tickers. Live tickers call `fetchEvent`.
- Order-book sizes (`order-book.ts`): time-box 30 minutes. Docs describe `wss://ws.gemini.com` streams `{instrumentSymbol}@depth5` and `{instrumentSymbol}@bookTicker`. If an unauthenticated connection from Node returns sizes, export `async function fetchTopOfBookSizes(instrumentSymbols: string[], timeoutMs: number): Promise<Map<string, { bidSize: number | null; askSize: number | null }>>` and have `getLadder` fill `yesBidSize` and `yesAskSize` for live ladders (best effort; on timeout leave null). If it does not work in the time box, export the same function returning an empty map, document why in a comment and in your report, and leave sizes null. Node 20 has no global WebSocket client; do not add a dependency without reporting it first (check whether `ws` is already in `node_modules` as a transitive dependency before asking).
- All fetches time out after 8 seconds (`AbortSignal.timeout`).

**Tests:**
- [ ] `parseLadder` on the SOL fixture: 8 rungs, strikes 68..75 ascending, rung 72 has `yesBid` 0.7 and `yesAsk` 0.77, rung 73 has `yesBid` null, asset `SOL`, expiry `2026-11-20T05:00:00.000Z`.
- [ ] `parseLadder` on the BTC fixture: 10 rungs, first strike 61200, last 62100 (comma parsing).
- [ ] `parseLadder` returns null for a binary up/down event and for a sports event (construct minimal objects).
- [ ] `parseLadder` tolerates a contract with `prices` missing entirely (rung kept with null quotes).
- [ ] `listLadders` with `fetchActiveCryptoEvents` mocked to reject returns only snapshot summaries, each with `source: "snapshot"`.
- [ ] `getLadder("SOL2611200500-SNAPSHOT")` returns `source: "snapshot"` and `referenceSpot: 72.12`.
- [ ] Manually hit all three routes with `pnpm dev` running and paste the trimmed responses into your report, including what live crypto ladders exist right now and their expiries.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test`. All pass.

---

### Task 4: Solana wallet and receipts

**Files:**
- Create: `src/lib/solana/constants.ts`, `src/lib/solana/receipt-memo.ts`, `src/lib/solana/receipts.ts`, `src/lib/solana/balance.ts`, `src/components/solana-provider.tsx`, `src/hooks/use-sol-balance.ts`, `src/hooks/use-paper-fills.ts`
- Test: `src/lib/solana/receipt-memo.test.ts`, `src/hooks/use-paper-fills.test.ts`

**Interfaces produced:**

```ts
export const MEMO_PROGRAM_ID: PublicKey;
export const RECEIPT_PREFIX = "LH1";
export const SOLANA_CLUSTER: "devnet" | "testnet" | "mainnet-beta";
export function getRpcEndpoint(): string;
export function explorerTxUrl(signature: string): string;

export function canonicalPlanJson(eventTicker: string, exposure: Exposure, plan: HedgePlan): string;
export async function hashPlan(eventTicker: string, exposure: Exposure, plan: HedgePlan): Promise<string>;
export async function buildReceiptMemo(eventTicker: string, exposure: Exposure, plan: HedgePlan): Promise<{ memo: string; planHash: string }>;
export function parseReceiptMemo(memo: string): { eventTicker: string; quantity: number; maxLoss: number; totalCost: number; legCount: number; planHash: string } | null;

export async function getSolBalance(connection: Connection, owner: PublicKey): Promise<number>;
export async function sendHedgeReceipt(connection: Connection, wallet: Pick<WalletContextState, "publicKey" | "sendTransaction">, memo: string): Promise<string>;
export async function listHedgeReceipts(connection: Connection, owner: PublicKey, limit: number): Promise<HedgeReceipt[]>;

export function SolanaProvider(props: { children: React.ReactNode }): React.JSX.Element;
export function useSolBalance(): { balance: number | null; loading: boolean; error: string | null; refresh: () => void };
export function usePaperFills(): { fills: PaperFill[]; addFill: (fill: PaperFill) => void; setSignature: (id: string, signature: string) => void; clear: () => void };
```

**Decisions:**
- Verify the SPL Memo program id (v2) against official Solana documentation before hard-coding it, and put the documentation URL in a comment beside it.
- Cluster from `NEXT_PUBLIC_SOLANA_CLUSTER`, default `devnet`. RPC from `NEXT_PUBLIC_SOLANA_RPC_URL`, default `clusterApiUrl(cluster)`.
- Canonical plan JSON: `{ v: 1, eventTicker, asset, quantity, spot, maxLoss, totalCost, legs: [{ s: instrumentSymbol, d: side, q: quantity, p: price }] }` with legs sorted by `instrumentSymbol` then side, numbers rounded to 6 decimals, keys in exactly that order, no whitespace.
- `planHash` is the lowercase hex SHA-256 of that JSON (Web Crypto `crypto.subtle`).
- Memo format, pipe-delimited: `LH1|{eventTicker}|q={quantity}|floor={maxLoss}|cost={totalCost to 2 decimals}|legs={leg count}|h={first 32 hex characters of planHash}`. It must be under 300 bytes.
- `sendHedgeReceipt` builds one transaction with one Memo instruction whose only key is the wallet public key as signer, sends it with the wallet adapter, confirms at `confirmed`, and returns the signature. Throws a clear `Error` if the wallet is not connected.
- `listHedgeReceipts` uses `getSignaturesForAddress`, keeps entries whose `memo` contains `LH1|` (the RPC prefixes memos with a length tag such as `[57] `; strip it), newest first.
- `getSolBalance` returns SOL, not lamports.
- `SolanaProvider` is a client component wrapping `ConnectionProvider`, `WalletProvider` (wallet-standard autodetection, `wallets={[]}`, `autoConnect`) and `WalletModalProvider`, and imports the wallet adapter UI stylesheet.
- `usePaperFills` persists to `localStorage` under `ladder-hedge:paper-fills`, tolerates corrupt stored JSON by starting empty, and is safe during server rendering.

**Tests:**
- [ ] `canonicalPlanJson` is identical for two plans whose legs differ only in order.
- [ ] `hashPlan` is a 64-character lowercase hex string and changes when any leg quantity changes.
- [ ] `buildReceiptMemo` output starts with `LH1|`, is under 300 bytes for a 20-leg plan, and `parseReceiptMemo` round-trips event ticker, quantity, max loss, cost (2 decimals), leg count and the 32-character hash prefix.
- [ ] `parseReceiptMemo` returns null for an unrelated memo and correctly parses one with a leading `[57] ` length tag.
- [ ] `usePaperFills` (jsdom): adding a fill persists across a remount; corrupt stored JSON yields an empty list; `setSignature` updates only the matching fill.
- [ ] Manual: describe in your report exactly how to exercise the receipt flow (wallet, devnet airdrop), since no wallet is available in your environment. Do not claim the on-chain write is verified unless you actually sent a transaction.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test`. All pass.

---

### Task 5: Presentational components

**Files:**
- Create under `src/components/`: `exposure-panel.tsx`, `ladder-picker.tsx`, `floor-controls.tsx`, `payoff-chart.tsx`, `distribution-chart.tsx`, `ladder-quotes-table.tsx`, `hedge-legs-table.tsx`, `plan-stats.tsx`, `coherence-panel.tsx`, `receipt-panel.tsx`, `data-source-badge.tsx`, `format.ts`
- Create: `src/app/preview/page.tsx` (renders every component with hard-coded sample data that satisfies Shared Types, so they can be seen before the engine and data layer exist)
- Modify: `src/app/globals.css`, `src/app/layout.tsx` (fonts, theme tokens only)
- Test: `src/components/format.test.ts`

**Rules:** components take data and callbacks through props only. They import types from `@/lib/hedge/types` and nothing else from `src/lib` or `src/hooks`. No data fetching.

**What each shows:**
- `ExposurePanel`: asset selector (SOL, BTC, ETH, XRP), quantity input, spot price with its source label, position value, and a "use wallet balance" action that is enabled only when the asset is SOL and a wallet balance is supplied. A slot for the wallet connect button passed in as a prop (`walletButton: React.ReactNode`).
- `LadderPicker`: list of `LadderSummary` with expiry as a countdown and local time, quoted rung count, and a `DataSourceBadge`.
- `FloorControls`: maximum loss as a percentage slider of position value with the dollar amount shown, taker fee rate input (shown as a percentage, default 7%, with the caption "Gemini taker fee: rate x contracts x price x (1 - price)"), assumed depth input with an "unlimited" toggle, labelled "assumed" whenever sizes are unknown.
- `PayoffChart`: unhedged and hedged profit and loss against expiry price (from `PayoffPoint[]`), a horizontal floor line, a vertical spot line, and shading or a label for the unprotected region below the lowest strike.
- `DistributionChart`: bar per `PriceState` with its probability, interval labels.
- `LadderQuotesTable`: strike, YES bid, YES ask, derived NO ask, sizes or "unknown".
- `HedgeLegsTable`: side, strike, quantity, price, cost, and totals.
- `PlanStats`: status in plain words for each `HedgeStatus`, total cost, cost as a percentage of position value, worst case before and after, expected hedge payout and net expected cost, largest hedgeable quantity (or "not known: depth is unlimited or unknown"), expiry, and the sentence that protection stops below the lowest strike.
- `CoherencePanel`: findings list; an empty state that says the ladder's quotes are consistent.
- `ReceiptPanel`: a "paper fill and record receipt" action with disabled and in-progress states, an error line, and a list of fills and on-chain receipts with explorer links and a verified or unverified hash indicator.
- `format.ts`: `formatUsd`, `formatPercent`, `formatQuantity`, `formatCountdown(expiryIso, nowMs)`.

**Design direction:** a calm, precise instrument for one decision, not a trading-terminal pastiche. Deliberate typography, strong hierarchy around three numbers (cost, worst case before, worst case after), restrained colour with one accent, fully usable at 1280 px wide and readable at 390 px. Must look intentional in a screen recording. If the `frontend-design:frontend-design` skill is available to you, use it.

**Tests:**
- [ ] `formatUsd(-51.2)` is `-$51.20`; `formatUsd(1234.5)` is `$1,234.50`; `formatPercent(0.0329)` is `3.29%`; `formatCountdown` returns `expired` for a past time and `2h 05m` for 2 hours 5 minutes ahead.
- [ ] `pnpm dev`, open `/preview`, confirm every component renders with the sample data without console errors, and describe what you saw in your report.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test`. All pass.

---

### Task 6: Integration

**Files:**
- Create: `src/hooks/use-ladders.ts`, `src/hooks/use-ladder.ts`, `src/hooks/use-spot.ts`, `src/hooks/use-hedge-plan.ts`, `src/components/hedge-workbench.tsx`
- Modify: `src/app/page.tsx`, `src/app/layout.tsx` (wrap in `SolanaProvider`)

**Consumes:** everything produced by Tasks 2 to 5, by the exact signatures above.

**Behaviour:**
- On load: asset SOL; fetch ladders for the asset; select the soonest-expiring live ladder with at least 3 quoted rungs, otherwise the snapshot. Fetch spot; for a snapshot ladder use `referenceSpot` and label the spot as snapshot.
- Quantity defaults to the wallet's SOL balance when connected and positive, else 10. Default maximum loss 1.5% of position value, taker fee rate `GEMINI_TAKER_FEE_RATE` (0.07), assumed depth 100 contracts.
- `useHedgePlan` memoises `optimizeHedge`, `maxHedgeableQuantity`, `checkCoherence`, `buildPriceStates` and `payoffCurve` from the current inputs, and catches engine errors into an error string.
- Live ladders refresh every 15 seconds while the tab is visible; show the fetched-at time.
- "Paper fill and record receipt": build the memo, save a `PaperFill` with `signature: null`, then if a wallet is connected send the receipt and store the signature. On failure keep the fill and show the error.
- Receipts read from chain are matched to local fills by the hash prefix; a match is shown as verified.
- Every state in Review Focus items 3 to 5 has a visible, readable message.
- Remove `/preview` only if it breaks the build; otherwise keep it.

**Verification:**
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass.
- [ ] With `pnpm dev`: the page loads a ladder, moving the floor slider changes the legs and chart, switching asset to BTC works, `LADDER_FORCE_SNAPSHOT=1` shows snapshot badges. Report what you observed, including a screenshot path if you can take one.

---

### Task 7: README and submission documents

**Files:** `README.md`, `docs/submission.md`

- README: what it is in three sentences; the honest claim and its limits; architecture overview with a diagram in text; how the hedge is computed (states, the two linear programs, rounding) with the worked SOL example; economic design and risk assumptions (settlement index versus spot basis, expiry-only protection, no protection below the lowest strike, top-of-book and assumed depth, fees, one-sided quotes, paper execution only); how the project uses Solana with every program id it uses; how it uses the Gemini Prediction Markets API with endpoints; research references with arXiv ids (2609.14267, 2608.00666, 2605.00864, 2508.03474) and what each contributes; setup and run instructions; environment variables; test instructions.
- `docs/submission.md`: draft answers to the five Devpost questions (what did you build, what problem does it solve, how does it work, what makes it unique, what would you build next), the technologies list, and a shot-by-shot script for a 2 to 3 minute demo video.
- Read the code before describing it. Every claim in the README must match what the code does; where depth is assumed or data is a snapshot, say so.
