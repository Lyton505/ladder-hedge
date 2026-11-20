# Ladder Hedge

Live demo: <!-- DEPLOY_URL -->

Repository: https://github.com/Lyton505/ladder-hedge (default branch `build`)

Ladder Hedge is a web app for someone who holds a crypto asset and wants a hard limit on how much they can lose by a given time. It reads Gemini's prediction-market price ladders ("SOL at or above $72 at 5pm ET", "at or above $73", ...) and computes the cheapest basket of those contracts that keeps the holder's loss above a chosen floor at the ladder's expiry, priced at the asks you would actually pay, after Gemini's taker fee, and within the size the order book shows. The plan can then be "paper filled" and its hash recorded as a memo transaction on Solana devnet, so anyone can later check which plan was committed, by which wallet, and when.

## The claim, and its limits

The single claim: **for the chosen ladder, quotes and floor, this is the lowest-cost basket of contracts that keeps the hedged position at or above the floor in every price interval the ladder defines, at expiry, after fees and available size.**

What it does not claim:

- It never claims profit. A hedge costs money. Because it buys at the ask and pays a fee, its expected payout at mid-market implied probabilities is normally below its cost (see the worked example), and the app shows that net expected cost.
- It does not protect below the ladder's lowest strike. Below that strike the basket pays a fixed amount and every further dollar of decline is the holder's loss again.
- It does not protect before expiry. The contracts settle once; their value in between moves with the market.
- It places no orders. Execution is simulated ("paper"); the on-chain receipt records a plan, not a trade.

## For judges: where each requirement is answered

| Requirement | Where |
|---|---|
| DeFi track: "Explain the economic design and risk assumptions in your README" | [Economic design](#economic-design), [Risk assumptions](#risk-assumptions) |
| DeFi track: "Include the address of any program or contract your project deploys or uses" | [How it uses Solana](#how-it-uses-solana): the SPL Memo program; nothing is deployed |
| Best use of Solana: "Include the program ID(s) your project deploys or uses and explain in your README how your project uses Solana" | [How it uses Solana](#how-it-uses-solana) |
| Gemini bounty: "Use the Gemini Prediction Markets API (market data and/or trading endpoints)" | [How it uses the Gemini Prediction Markets API](#how-it-uses-the-gemini-prediction-markets-api): market data only |
| Setup and architecture | [Architecture](#architecture), [Setup](#setup) |

## Worked example

These numbers come from running the engine (`optimizeHedge` in `src/lib/hedge/optimize-hedge.ts`) on the canonical test fixture `SOL_FIXTURE_LADDER` in `src/lib/hedge/test-fixtures.ts`. The fixture is an eight-rung SOL ladder shaped like a real Gemini ladder; its order sizes are unknown.

**Inputs**

- Holding: 10 SOL at a spot of $72.12 (position value $721.20).
- Floor: lose at most $10.00 at expiry (about 1.39% of the position).
- Taker fee rate: 0.07 (Gemini's published rate).
- Depth: unlimited. An assumed depth of 100 contracts per leg gives the same plan, because no leg needs more than 20.

| Strike | YES bid | YES ask | NO price (1 - YES bid) |
|---|---|---|---|
| $68 | 0.95 | 0.99 | 0.05 |
| $69 | 0.98 | 0.99 | 0.02 |
| $70 | 0.96 | none | 0.04 |
| $71 | 0.95 | none | 0.05 |
| $72 | 0.70 | 0.77 | 0.30 |
| $73 | none | 0.04 | none |
| $74 | none | 0.05 | none |
| $75 | none | 0.05 | none |

**Plan (status `optimal`)**

| Buy | Pays $1 per contract if SOL settles | Contracts | Price | Fee | Cost |
|---|---|---|---|---|---|
| NO $69 | below $69 | 20 | $0.02 | $0.03 | $0.43 |
| NO $70 | below $70 | 10 | $0.04 | $0.03 | $0.43 |
| NO $71 | below $71 | 10 | $0.05 | $0.04 | $0.54 |
| NO $72 | below $72 | 3.80 | $0.30 | $0.06 | $1.20 |
| **Total** | | | | **$0.16** | **$2.60** |

Each fee is `0.07 x contracts x price x (1 - price)` rounded up to the next cent; for NO $72 that is 0.07 x 3.8 x 0.30 x 0.70 = $0.0559, charged as $0.06.

| | Without hedge | With hedge |
|---|---|---|
| Worst case at expiry (down to the $67 stress price) | -$51.20 | -$10.00 |
| Cost | | $2.60 (0.36% of the position) |
| Expected payout at mid-implied probabilities | | $1.91 |
| Net expected cost (cost minus expected payout) | | $0.69 |

**Outcome in each price interval** (hedged = unhedged + payout - $2.60)

| SOL at expiry | Evaluated at | Implied probability | Unhedged | Hedge pays | Hedged |
|---|---|---|---|---|---|
| below $68 | $67 (stress price) | 2.17% | -$51.20 | $43.80 | -$10.00 |
| $68 to $69 | $68 | 0.00% | -$41.20 | $43.80 | $0.00 |
| $69 to $70 | $69 | 0.00% | -$31.20 | $23.80 | -$10.00 |
| $70 to $71 | $70 | 0.33% | -$21.20 | $13.80 | -$10.00 |
| $71 to $72 | $71 | 24.00% | -$11.20 | $3.80 | -$10.00 |
| $72 to $73 | $72 | 71.17% | -$1.20 | $0.00 | -$3.80 |
| $73 to $74 | $73 | 0.00% | $8.80 | $0.00 | $6.20 |
| $74 to $75 | $74 | 0.00% | $18.80 | $0.00 | $16.20 |
| $75 and above | $75 | 2.33% | $28.80 | $0.00 | $26.20 |

What this example shows:

- **Only NO contracts are bought.** A long holder loses when the price falls, and NO pays when the price is below its strike. YES contracts pay in the intervals where the holder is already fine.
- **NO $68 is not bought.** NO $69 costs $0.02, pays in every interval NO $68 pays in, and also pays between $68 and $69. NO $68 at $0.05 is dominated.
- **Rounding is repaired, not tolerated.** The linear program's optimum is 3.7758 contracts of NO $72 at a linear cost of $2.5758. Rounded to Gemini's 0.01-contract step (3.78) and priced with cent-rounded fees, the cost becomes $2.594 and the worst case -$10.014, which breaches the floor. The engine re-solves with a slightly raised floor and lands on 3.80 contracts, $2.60, and exactly -$10.00.
- **Fees matter.** With the fee rate set to 0 the plan is the same except NO $72 x 3.58, and it costs $2.374 (worst case -$9.994). The fee adds $0.226, about 10%.
- **Protection ends at the stress price.** Below $68 the basket pays a fixed $43.80. At an expiry price of $66 the hedged result is -$20.00, and each further dollar of decline costs the holder $10 again.

Same fixture, other settings (fee 0.07):

| Change | Status | Result |
|---|---|---|
| Floor $0 (no loss at all) | `best-effort` | The floor is out of reach; the worst case is lifted from -$51.20 to -$6.45 for $4.23 |
| Floor $10, assumed depth 5 contracts per leg | `best-effort` | Worst case -$29.34 for $2.12; depth, not price, is the limit |
| Floor $100 | `no-hedge-needed` | The unhedged worst case of -$51.20 already meets it; nothing to buy |
| Assumed depth 50, floor 2% of position value | | Largest hedgeable position: 61.37 SOL |
| Quote consistency check | | One bid inversion ($69 bid above $68 bid, gap $0.03), one ask inversion ($74 ask above $73 ask, gap $0.01), no executable arbitrage |

To reproduce, put this in a `*.test.ts` file under `src/` and run `pnpm exec vitest run <file> --disableConsoleIntercept`:

```ts
import { test } from "vitest";
import { optimizeHedge } from "@/lib/hedge";
import { SOL_FIXTURE_EXPOSURE, SOL_FIXTURE_LADDER } from "@/lib/hedge/test-fixtures";

test("worked example", () => {
  const plan = optimizeHedge({
    ladder: SOL_FIXTURE_LADDER,
    exposure: SOL_FIXTURE_EXPOSURE,
    maxLoss: 10,
    stressPrice: null,
    takerFeeRate: 0.07,
    assumedDepth: null,
  });
  console.log(plan.status, plan.totalCost, plan.worstCaseBefore, plan.worstCaseAfter, plan.legs);
});
```

### A real captured ladder

The bundled snapshot `SOL2611202200-SNAPSHOT` is Gemini's "SOL price on November 20" ladder (20 rungs, $65 to $84), captured 2026-11-20 05:09:28 UTC with SOL at $71.8915. It is much tighter around spot than the fixture, so protection costs more. For 10 SOL (position value $718.92), fee 0.07 and an assumed depth of 100 contracts per leg (snapshots carry no sizes):

| Floor (share of position) | Status | Cost | Expected payout | Worst case before / after |
|---|---|---|---|---|
| 1% | `best-effort` | $62.08 | $58.16 | -$78.92 / -$10.11 |
| 1.5% | `optimal` | $37.23 | $33.96 | -$78.92 / -$10.78 |
| 3% | `optimal` | $9.72 | $7.83 | -$78.92 / -$21.56 |
| 5% | `optimal` | $3.67 | $2.48 | -$78.92 / -$35.94 |

The cost of a floor falls steeply as the floor is loosened. Tight floors force the basket to cover intervals above spot as well, because the cost of the hedge itself counts against the floor in every interval; the gross outlay is then large, but most of it comes back in expectation (net expected cost $3.28 at 1.5%). Below about 1.3% no basket on this ladder meets the floor.

## How the hedge is computed

All of this is in `src/lib/hedge`, which is pure TypeScript with no network or storage access.

### Price intervals

A ladder with strikes K1 < K2 < ... < Kn splits the expiry price into n + 1 intervals (`buildPriceStates` in `price-states.ts`):

- State 0: below K1.
- State i (1 to n): from Ki (inclusive) to K(i+1) (exclusive); the last state has no upper bound.

A YES contract at Ki pays $1 when the expiry price is at or above Ki. A NO contract pays $1 when it is below Ki. So every contract's payout is constant inside each interval, and the problem reduces to n + 1 scenarios with exact payoffs. No correlation or volatility model is needed, because every rung settles on the same number.

### Why each interval is evaluated at its lower edge

The holder is long: unhedged profit and loss is `quantity x (price - spot)`, which rises with the price. The hedge's payout is constant within an interval. So within any interval the hedged result is lowest at the interval's lower edge, and checking the floor there guarantees it for the whole interval.

State 0 has no lower edge. It is evaluated at a **stress price**: by default the lower of (a) the lowest strike minus the median gap between strikes and (b) spot minus that gap ($67 for the fixture). The second term matters when spot is already below the ladder; without it every evaluation price would sit above spot and the holder would wrongly appear safe. The floor is guaranteed only down to the stress price.

### Legs, prices and costs

For each rung the candidate legs are (`candidateLegs` in `optimize-hedge.ts`):

- YES at the YES ask, if there is an ask.
- NO at 1 - YES bid, if there is a bid. Buying NO is taking the YES bid.

Inside the linear programs a contract costs `price + rate x price x (1 - price)`, the taker fee before cent rounding. Legs whose unit cost is $1 or more are dropped, since they can never help. Each leg is capped at the size shown at the best price on the side it lifts (`yesAskSize` for YES, `yesBidSize` for NO); where that size is unknown, at the user's assumed depth; and where that is set to unlimited, not at all.

### The two linear programs

Solved with [yalps](https://www.npmjs.com/package/yalps), a simplex solver written in TypeScript.

1. **Stage 1, minimum cost.** Minimise total cost subject to, in every state j, `unhedged_j + payout_j - totalCost >= -maxLoss`, and the leg caps. Cost appears inside every state's constraint, not only in the objective, so the hedge has to pay for itself within the floor.
2. **Stage 2, best reachable worst case.** Used only when stage 1 is infeasible. It first finds the best worst case t* the legs and caps allow, then returns the cheapest plan whose worst case is within 0.1% of position value of t*. Without that second step the pure maximin plan can spend dollars on near-certain contracts to gain fractions of a cent.

If the unhedged worst case already meets the floor, neither program runs.

### Rounding to tradable quantities

After solving, legs under half a quantity increment are dropped and the rest are rounded **up** to a whole number of increments (caps are rounded down to whole increments beforehand, so rounding up cannot pass a cap). Each leg's fee is then computed and rounded up to the next cent, and every reported number (cost, outcomes, worst case, expected payout) is recomputed from the rounded legs.

Rounding and cent fees can push the worst case below the floor. When that happens the engine re-solves stage 1 with the floor raised by the shortfall (growing geometrically from $0.005), up to 12 attempts; the last attempt uses a provable bound, the sum over candidate legs of one increment plus one cent. If the raised floor becomes infeasible it falls back to stage 2. A plan labelled `optimal` therefore meets the floor after rounding, to within floating-point noise of at most $0.000001.

### The four statuses

| Status | Meaning |
|---|---|
| `optimal` | The floor is met at minimum cost. |
| `best-effort` | The floor cannot be met with the quoted legs and depth. The plan lifts the worst case nearly as far as possible and reports the worst case it actually achieves. |
| `no-hedge-needed` | The unhedged worst case already meets the floor. No legs. |
| `unhedgeable` | No available leg improves the worst case. No legs. |

### Largest hedgeable position

`maxHedgeableQuantity` answers "how big a position can these quotes protect to this floor?", with the floor held at a fixed share of position value. It returns:

- "any size" (infinity) when no position needs a hedge at that floor;
- "not known" (null) when a usable leg has no cap, because the answer would be unbounded;
- otherwise the largest size found on a doubling grid from 2^-14 up to 10^9 at which the plan is `optimal`, refined by 20 bisection steps toward the next grid size.

Because whole-increment rounding and cent fees make success slightly non-monotone in size, the answer is a size that can be hedged near the top of the feasible range, not a sharp threshold.

### Implied distribution

The distribution chart and the expected payout use the ladder's implied probabilities (`implied-distribution.ts`):

- Each rung's probability of finishing at or above its strike is the mid of bid and ask; with a bid only, `(bid + 1) / 2`; with an ask only, `ask / 2`; with neither, linear interpolation between quoted neighbours.
- The sequence is forced to be non-increasing with pool-adjacent-violators, clamped to [0, 1], and differenced into one probability per interval. The probabilities always sum to 1.

The optimiser does **not** use these probabilities. The hedge is chosen on executable prices and the worst case alone; probabilities affect only the displayed expected payout and the chart.

### Quote consistency

`checkCoherence` (`coherence.ts`) separates executable inconsistencies from ones you cannot trade, following arXiv 2608.00666:

- **Arbitrage** (executable): for strikes Ki <= Kk, the YES ask at Ki is below the YES bid at Kk, so buying YES at Ki and NO at Kk pays at least $1 at any expiry price for less than $1. When i = k this is a crossed book on one rung. It is reported only if the edge is still positive after the taker fee on both legs; the finding gives the gross and the net edge.
- **Bid inversion** and **ask inversion** (not executable on their own): on adjacent rungs, the higher strike's YES bid, or ask, is above the lower strike's, which a coherent ladder never shows.

The engine also rejects malformed ladders before solving: strikes must be strictly increasing, prices must lie in [0, 1], and sizes must be non-negative.

## Economic design

- **Instrument.** Each NO contract at strike K is a digital put: $1 if the asset settles below K. A strip of NO contracts at several strikes builds a step-shaped put that pays more the further the price falls, down to the lowest strike.
- **Objective.** Robust (scenario) cost minimisation: the cheapest basket that keeps the worst case at or above the floor in every interval. It does not depend on anyone's forecast. Probabilities are shown, not optimised.
- **Prices paid.** Executable top-of-book prices (YES ask, or 1 - YES bid for NO) plus Gemini's taker fee of `0.07 x contracts x price x (1 - price)` rounded up to the cent, with no settlement fee (source: https://www.gemini.com/fees/predictions). The engine never assumes fills at mid. The net expected cost the app shows (cost minus mid-implied expected payout) is roughly what crossing the spread and paying the fee costs.
- **Size.** Each leg is capped at the size shown at the best price, so the plan never assumes more liquidity than the top of the book offers. When the size is unknown, an assumed depth is used and labelled as assumed.
- **Counterparties.** Gemini's order-book makers. The project runs no pool, vault or token, uses no leverage and has no liquidation. The most a basket can lose is its cost.
- **The receipt.** A commitment, not a settlement: a hash of the exact plan, written by the user's wallet at a block time, for the price of one devnet transaction fee.

## Risk assumptions

1. **Protection holds only at expiry.** The engine evaluates profit and loss at the expiry price. Before expiry the basket's market value moves, and the app does not model selling it early.
2. **No protection below the lowest strike.** Below it every NO leg has already paid, so the basket pays a fixed amount and the holder is exposed again. The floor is guaranteed only down to the stress price. The UI shades this region and states where protection stops.
3. **Settlement price versus realised price.** The contracts settle on Gemini's settlement reference for the ladder. The holder's spot comes from Gemini's spot ticker (bid/ask mid), and the holder may sell elsewhere at another price. The engine treats these as one number; any gap between them is unhedged.
4. **Quotes are top of book and can move or vanish.** Plans use the best bid and ask only, read at one moment. By the time an order could be placed, prices and sizes may differ.
5. **Assumed depth where size is unknown.** Live ladders get sizes from Gemini's order-book WebSocket, and only where its best price matches the REST quote. Snapshots carry no sizes. Wherever size is unknown, the user's assumed depth (or unlimited) caps each leg, and the UI marks the figure as assumed.
6. **One-sided quotes restrict the legs.** A rung with no ask has no YES leg; a rung with no bid has no NO leg. Prices of exactly 0 or 1 from Gemini are treated as unquoted.
7. **Fees follow Gemini's published formula, which can change.** The rate is an input (default 0.07). Fees are computed per leg as one order; if an order filled in several pieces, cent rounding could differ slightly.
8. **Execution is simulated.** "Paper fill" saves the plan in the browser's local storage and records a receipt. No order is sent to Gemini.
9. **Devnet only, as deployed.** The default and only exercised cluster is Solana devnet, where SOL has no value; the wallet balance stands in for a real holding. The cluster is an environment setting.
10. **Implied probabilities are market prices, not forecasts.** They are mids with simple rules for one-sided and unquoted rungs, smoothed to be consistent. They inform the expected-payout figure only.
11. **Long holdings only.** The engine rejects a negative quantity; short exposure is not modelled.
12. **Venue risk is not modelled.** The plan assumes Gemini settles its contracts as specified.

## How it uses Solana

**Programs.** This project deploys no program of its own. It uses one on-chain program:

| Program | Program ID | Cluster | Used for |
|---|---|---|---|
| SPL Memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | devnet | Writing hedge receipts |

The id is set in `src/lib/solana/constants.ts` and was checked against the SPL documentation (https://www.solana-program.com/docs/memo) and the program's interface source. Explorer: https://explorer.solana.com/address/MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr?cluster=devnet

**What the app does on Solana** (`src/lib/solana`, `src/hooks`, `src/components/solana-provider.tsx`):

1. **Wallet.** Connects any Wallet Standard wallet (for example Phantom or Solflare) through `@solana/wallet-adapter-react`, with no hard-coded adapters.
2. **Exposure.** Reads the connected wallet's SOL balance (`getBalance` at `confirmed`) and offers it as the quantity to hedge.
3. **Receipt write.** "Paper fill and record receipt" builds a one-instruction transaction calling the Memo program, with the wallet as the instruction's only key, marked as signer, so the Memo program checks the signature and logs the signer. The wallet signs and sends it; the app waits for `confirmed` and links the signature to Solana Explorer.
4. **Receipt read.** Reads the wallet's recent transactions with `getSignaturesForAddress`, keeps those whose memo starts with `LH1|`, and matches them to locally saved paper fills by plan hash.

**Receipt format.** The plan is serialised to canonical JSON (fixed key order, legs sorted, numbers rounded to 6 decimals, no whitespace) and hashed with SHA-256. The memo is pipe-delimited and under 300 bytes:

```
LH1|{eventTicker}|q={quantity}|floor={maxLoss}|cost={totalCost, 2 decimals}|legs={count}|h={first 32 hex of the plan hash}
```

For the worked example: `LH1|SOL-FIXTURE|q=10|floor=10|cost=2.60|legs=4|h=92f33be1954735bedb66cbd2026fab64`. Anyone holding the plan can recompute the hash and compare it with the memo; the memo alone shows the size, floor and cost that were committed.

**Status.** <!-- UPDATE AFTER WALLET TEST --> The receipt transaction has been simulated successfully on devnet (the Memo program executed and logged the `LH1|` memo), but a signed, confirmed write from a browser wallet has not yet been verified end to end. The read path was checked against existing devnet Memo transactions.

## How it uses the Gemini Prediction Markets API

Market data only. **No orders are placed and no authenticated endpoint is called;** execution is simulated. All calls are made server-side by Next.js route handlers, without credentials, uncached, with an 8-second timeout.

| Call | Code | Used for |
|---|---|---|
| `GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=crypto&limit=500&offset={n}` (paged, at most 10 pages) | `fetchActiveCryptoEvents` in `src/lib/gemini/gemini-client.ts` | Listing live crypto price ladders. Only `categorical` crypto events whose contracts are labelled "$K or above" count as ladders; binary up/down events are ignored. |
| `GET https://api.gemini.com/v1/prediction-markets/events/{ticker}` | `fetchEvent` | One ladder's contracts: strikes (parsed from labels such as "$61,200 or above"), quantity increments, and best bid and ask (`prices.bestBid`, `prices.bestAsk`). |
| WebSocket `wss://ws.gemini.com`, subscribe to `{instrumentSymbol}@bookTicker` for each rung | `fetchTopOfBookSizes` in `src/lib/gemini/order-book.ts` | Contracts available at the best bid and ask, used as leg caps. Best effort with a 2.5-second timeout; a size is used only when its price matches the REST quote. |
| `GET https://api.gemini.com/v1/pubticker/{asset}usd` (Gemini's exchange ticker, not part of the prediction-markets API) | `fetchSpot` | The asset's spot price: bid/ask mid, or last trade if a side is missing. |

Notes from building against the live API (see the comments in `parse-ladder.ts`):

- Only `bestBid` and `bestAsk` are read as quotes. When one side of a book is empty, Gemini fills `prices.buy.yes` or `prices.sell.yes` with the last trade price, which would invent a quote and can cross the book, so those fields are ignored.
- Contracts whose status is not `active` are dropped, so a settled event stops being a ladder.

**Snapshots.** `fixtures/gemini/` holds six captured ladder events (SOL, BTC and ETH, two expiries each) with the spot at capture in `snapshot-meta.json`. They are served under tickers ending in `-SNAPSHOT` when Gemini is unreachable, when a live ticker has settled, or when `LADDER_FORCE_SNAPSHOT=1`. Snapshot data is labelled `source: "snapshot"` in every API response and "Snapshot" in the UI; two older snapshots carry an estimated spot, flagged `spotIsEstimated: true`.

## Architecture

```
Browser (Next.js client components)                  Server (Next.js route handlers, Node)
+-----------------------------------------------+    +-------------------------------------------------+
| src/app/page.tsx                              |    | GET /api/ladders?asset=SOL                      |
|   hooks: ladders, ladder, spot, hedge plan,   |    | GET /api/ladders/{ticker}                       |
|          SOL balance, paper fills             |<-->| GET /api/spot?asset=SOL                         |
|   src/lib/hedge   engine (yalps LP), pure TS  |JSON|   src/lib/gemini/ladder-service.ts              |
|   src/components  inputs, charts, tables      |    |     gemini-client.ts --HTTPS--> api.gemini.com  |
|   src/lib/solana  memo, receipts, balance     |    |     order-book.ts    --WSS----> ws.gemini.com   |
+-----------------------+-----------------------+    |     fixtures/gemini/*.json (labelled snapshots) |
                        |                            +-------------------------------------------------+
                        | wallet adapter (Wallet Standard): sign and send
                        v
        Solana devnet RPC: getBalance, Memo transaction, getSignaturesForAddress
                        |
                        v
        Solana Explorer link for each receipt signature
```

<!-- CHECK AFTER TASK 6: the paragraph below and "Page behaviour" describe the integration task's specification. -->

Data flow for one plan: the page lists ladders for the chosen asset, loads one ladder (live with sizes, or a snapshot) and the spot price, and runs the engine in the browser whenever an input changes: price states, the linear programs, the payoff curve, the largest hedgeable position and the consistency check. Paper fill builds the memo, saves the fill locally without a signature, then asks the wallet to sign the receipt and stores the signature on success. If the wallet is missing, the user rejects, or the RPC fails, the fill stays saved without a signature and the error is shown.

### Page behaviour

- Starts on SOL and picks the live, unexpired ladder with the most two-sided rungs (hourly ladders are often thin), falling back to a snapshot. Assets offered: SOL, BTC, ETH, XRP (snapshots exist for SOL, BTC and ETH).
- Quantity defaults to the wallet's SOL balance when one is connected, otherwise 10. The floor is set as a share of position value (default 1.5%, slider from 0.25% to 10%), the fee rate defaults to 7%, and the assumed depth to 100 contracts.
- Live ladders refresh every 15 seconds while the tab is visible, and the fetch time is shown.
- `/preview` renders every component with fixed sample data.

### Directory layout

```
src/
  app/
    page.tsx, layout.tsx            page and root layout
    preview/page.tsx                components with sample data
    api/ladders/route.ts            GET /api/ladders
    api/ladders/[ticker]/route.ts   GET /api/ladders/{ticker}
    api/spot/route.ts               GET /api/spot
  lib/
    hedge/                          engine: types, validation, price states, implied
                                    distribution, optimiser, coherence, payoff curve,
                                    test fixture
    gemini/                         REST client, order-book WebSocket, ladder parser,
                                    ladder service with snapshot fallback
    solana/                         cluster and Memo id, receipt memo and hash,
                                    receipt send and read, balance
  hooks/                            React hooks: data, plan, SOL balance, paper fills
  components/                       presentational components and formatting
fixtures/gemini/                    captured ladder events and snapshot-meta.json
docs/                               submission draft; design spec and plan under superpowers/
```

## Setup

Built with Node 20.20.2 and pnpm 12.18.0 (pinned as `packageManager` in `package.json`). Main libraries: Next.js 16.4.6, React 19.3.0, TypeScript 5 in strict mode, Tailwind CSS 4, yalps 0.6.4, Recharts 3, `@solana/web3.js` 1.99 with the Solana wallet adapter, `ws` 8, and Vitest 4.

```bash
pnpm install
cp .env.example .env.local   # optional: the defaults use devnet and live Gemini data
pnpm dev                     # http://localhost:3000
```

| Command | What it does |
|---|---|
| `pnpm dev` | Development server |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build`, then `pnpm start` | Production build and server |
| `LADDER_FORCE_SNAPSHOT=1 pnpm dev` | Serve captured snapshots only; never call Gemini |

### Environment variables

From `.env.example`:

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `devnet` | Cluster for the wallet balance and receipts: `devnet`, `testnet` or `mainnet-beta`. Unknown values fall back to `devnet`. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | empty | RPC URL override; empty uses the public endpoint for the cluster. |
| `LADDER_FORCE_SNAPSHOT` | empty | `1` serves snapshots only, for ladders and spot. |

No API keys are needed: every Gemini endpoint used is public.

### Recording a receipt

1. Install a Wallet Standard wallet (for example Phantom or Solflare) and switch it to Solana devnet.
2. Fund it from https://faucet.solana.com; the devnet RPC airdrop is closed. One receipt costs one transaction fee, 0.000005 SOL.
3. Connect, compute a plan, click "Paper fill and record receipt", approve in the wallet, then open the Explorer link.

### Devnet end-to-end test

`src/lib/solana/receipts.devnet.test.ts` sends a real receipt from a throwaway keypair and reads it back. It is skipped unless enabled:

```bash
LADDER_HEDGE_DEVNET_E2E=1 LADDER_HEDGE_DEVNET_FUNDING_WAIT_S=300 \
  pnpm exec vitest run src/lib/solana/receipts.devnet.test.ts --silent=false
```

It prints the throwaway address; fund it at https://faucet.solana.com within the wait time.

## Research

| Paper | What it contributes here |
|---|---|
| Bhaskara and Jerfy, "Public Opinion as an Option: Leveraging Prediction Markets to Hedge Exposure to Spot Crypto Volatility", arXiv 2609.14267, September 2026 | Treats Kalshi Bitcoin event contracts as option-like instruments to hedge spot exposure, studies three contracts across bullish, bearish and flat regimes, and reports a dynamic hedge outperforming simpler portfolios. It names multi-strike portfolios and rebalancing frequency as future work. Ladder Hedge is a multi-strike, cost-and-depth-aware version on Gemini; it does not rebalance. |
| Gebele, Mutzel and Matthes, "Executable Arbitrage and Market Efficiency in Prediction Markets", arXiv 2608.00666, August 2026 | Separates payoff-space no-arbitrage from what is actually executable, using depth-aware executable portfolio values. Basis for the consistency panel distinguishing executable arbitrage from mere quote inversions, and for pricing at executable asks with size caps. |
| Cheng, Yang and Zou, "Arbitrage Analysis in Polymarket NBA Markets", arXiv 2605.00864, 2026 | Finds that order-book depth is what limits risk-free extraction. Basis for reporting the largest hedgeable position. |
| Saguillo, Ghafouri, Kiffer and Suarez-Tangil, "Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets", arXiv 2508.03474, AFT 2025 | Classifies within-market and cross-market arbitrage on Polymarket. The consistency check here is a within-market check on one ladder. |

## Known limitations

- **Top of book only.** Each leg is priced at the best quote and capped at the size there. Deeper levels, which would allow larger hedges at worse prices, are not used.
- **Snapshots have no sizes,** so on a snapshot every cap is the assumed depth.
- **Rounding costs a little.** The repair that keeps rounded plans above the floor raises the floor uniformly and in growing steps, so an `optimal` plan can cost slightly more than the true rounded minimum; in an independent review against a separate solver the median excess was under one cent. Very rarely a floor reachable before rounding (by under 1.5 cents) is reported as `best-effort`.
- **`best-effort` trades a little protection for cost.** It returns the cheapest plan within 0.1% of position value of the best reachable worst case, so its worst case can sit up to that much below the true maximum. Its gross outlay can still be large near the feasibility limit (see the 1% row above).
- **Static hedge.** No rebalancing, no early exit, and no mark-to-market view before expiry.
- **The stress price is the default** described above. The engine accepts another value, but the page does not expose it.
- **One expiry at a time.** Ladders with different expiries are not combined.
- **Spot basis and settlement reference are not modelled** (risk assumption 3).
- **The receipt holds a 128-bit hash prefix, not the plan.** The full plan lives in the browser's local storage; clearing it loses the plan, though the on-chain commitment remains.
- **Snapshots keep their original expiry.** The default SOL snapshot expires 2026-11-20 22:00 UTC; after that it shows as expired, though the engine still runs on it. XRP has no snapshot, so XRP needs Gemini to be reachable.
- **Each live ladder request opens a WebSocket** to read sizes, which adds up to 2.5 seconds.
- **The largest-hedgeable figure runs dozens of optimisations** per input change.

## What is next

- Real execution through Gemini's authenticated trading endpoints: limit orders at the planned prices, partial-fill handling, and re-planning on the unfilled remainder.
- Use the full order book (Gemini's `@depth5` stream) and model price impact as piecewise-linear costs in the linear program.
- Rebalancing over the life of the hedge, the open question named in arXiv 2609.14267.
- Combine ladders across expiries and venues, and model the gap between settlement index and spot.
- Hedge SPL token balances, not only SOL, and move from devnet to mainnet once execution is real.
- Publish the full canonical plan alongside the hash, so a receipt can be verified without the browser that made it.
