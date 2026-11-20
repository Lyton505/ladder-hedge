# Ladder Hedge: Devpost submission draft

Everything here matches the code in this repository. Paste each answer as is, or trim.

## Tagline

The cheapest basket of Gemini price-ladder contracts that keeps your crypto loss above a floor until expiry, priced after fees and available size, with the plan committed on Solana.

## What did you build?

Ladder Hedge is a web app for someone holding SOL, BTC, ETH or XRP who wants a hard cap on their loss by a set time. It reads Gemini's live crypto price ladders ("SOL above $72 at 5pm ET", "above $73", ...), and computes the lowest-cost basket of those contracts that keeps the holder's loss above a floor they choose, at expiry, in every price interval the ladder defines. Prices are the asks you would actually pay, plus Gemini's taker fee, capped at the size the order book shows. The app shows the payoff before and after, the cost, the worst case before and after, the largest position the quotes can protect, and any inconsistent quotes on the ladder. A "paper fill" saves the plan and writes its SHA-256 hash to Solana devnet as a memo signed by the user's wallet.

## What problem does it solve?

Prediction-market ladders are, in effect, a strip of digital options on one settlement price, which makes them a natural hedge for a spot holder. But nobody holding SOL wants to work out by hand which of twenty contracts to buy, in what size, after a fee that depends on price, with one-sided books and thin depth. Picking contracts by eye either overpays or leaves gaps. Ladder Hedge turns "I can stomach losing $10 by 5pm" into a specific, executable basket and tells you plainly what it costs, where the protection ends (below the lowest strike, and only at expiry), and whether the book is deep enough. It never claims profit: it shows the expected payout at market-implied probabilities next to the cost, so the price of protection is visible.

## How does it work?

- Data: Next.js route handlers call Gemini's public Prediction Markets API (`/v1/prediction-markets/events` and `/events/{ticker}`) for ladders and best bid and ask, read the size at the best price from Gemini's market-data WebSocket (`{instrumentSymbol}@bookTicker`), and take spot from Gemini's public ticker. If Gemini is unreachable, captured snapshots are served and labelled "Snapshot".
- Engine (pure TypeScript, runs in the browser): a ladder with n strikes splits the expiry price into n + 1 intervals. Every contract pays a fixed amount inside each interval, and a long holder's loss is worst at an interval's lower edge, so the floor only needs checking at n + 1 points. Stage 1 is a linear program (yalps) that minimises cost subject to the floor in every interval and the size caps. If the floor is out of reach, stage 2 finds the best reachable worst case and returns the cheapest plan that comes within 0.1% of position value of it, labelled "out of reach". Quantities are rounded to Gemini's 0.01-contract steps, fees are rounded up to the cent, and if rounding breaches the floor the engine re-solves with a tighter floor until it holds.
- Solana: a Wallet Standard wallet supplies the SOL balance as the exposure and signs a one-instruction SPL Memo transaction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`, devnet) carrying the plan's hash. Receipts are read back with `getSignaturesForAddress` and matched to local plans by hash.

## What makes it unique?

- It solves for the basket rather than suggesting one contract. Recent research hedges spot Bitcoin with single prediction-market contracts treated as options and names multi-strike portfolios as future work (arXiv 2609.14267); this is a multi-strike version, on Gemini.
- It prices what is executable, not what looks cheap: asks rather than mids, the real fee formula with cent rounding, and the size actually on the book. Following arXiv 2608.00666, its consistency panel separates executable arbitrage from mere quote inversions, and following arXiv 2605.00864 it reports the largest position the book's depth can protect.
- It is candid by construction: snapshot data, assumed depth and the unprotected region below the lowest strike are always labelled, and a floor that cannot be met is reported as "out of reach" with the worst case actually achieved.
- The receipt makes the plan auditable: anyone with the plan can recompute the hash and match it to the wallet-signed memo on chain.

## What would you build next?

- Real execution through Gemini's authenticated trading endpoints, with limit orders at the planned prices and re-planning on partial fills.
- Full order-book depth (Gemini's `@depth5` stream) priced as piecewise-linear costs in the optimiser, so larger positions can be hedged at worse prices instead of being capped.
- Rebalancing as quotes move and expiry approaches.
- Ladders across expiries and venues, and a model of the gap between the settlement index and the price the holder can sell at.
- SPL token balances as exposure, and mainnet once execution is real.

## Technologies

Only what the project uses (see `package.json`):

- Next.js 16 (App Router, route handlers), React 19, TypeScript (strict)
- Tailwind CSS 4
- yalps (linear programming)
- Recharts (charts)
- `@solana/web3.js`, `@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`, `@solana/wallet-adapter-base`
- `ws` (Gemini market-data WebSocket from Node)
- Vitest, Testing Library, jsdom, ESLint
- pnpm, Node 20
- Vercel (hosting)

Sponsor tools:

- Gemini Prediction Markets API (market data: events list, event detail) and Gemini market-data WebSocket (`@bookTicker`); Gemini public ticker for spot
- Solana devnet, SPL Memo program, Solana Explorer

## Form selections

| Field | Selection | Why it qualifies |
|---|---|---|
| Main track | DeFi and Onchain Applications | Hedges a crypto holding with on-chain-recorded plans; the README answers "Explain the economic design and risk assumptions in your README" (sections Economic design and Risk assumptions) and "Include the address of any program or contract your project deploys or uses" (SPL Memo program id; nothing deployed). |
| Chain award | Best use of Solana | "Include the program ID(s) your project deploys or uses and explain in your README how your project uses Solana": the README lists `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (devnet) and explains the wallet balance read, the signed memo receipt and the read-back. |
| Bounty | Gemini Prediction Markets (opt in) | "Use the Gemini Prediction Markets API (market data and/or trading endpoints)": every ladder, quote and size comes from Gemini's prediction-markets endpoints and market-data stream. Market data only; execution is simulated. |

Links to give: repository https://github.com/Lyton505/ladder-hedge, the live demo URL (see the top of the README), and the video.

## Demo video script (about 2 minutes 40 seconds)

Record at 1280 px wide or more, browser zoom 100%, one tab. Speak plainly; the numbers on screen will differ from any quoted here because quotes move.

| Time | Screen and action | Say |
|---|---|---|
| 0:00 to 0:15 | The app, top of the page, nothing clicked. | "Ladder Hedge answers one question for someone holding crypto: what is the cheapest basket of Gemini price-ladder contracts that keeps my loss above a floor until the ladder expires, after fees and available size. It never claims profit; it tells you what protection costs." |
| 0:15 to 0:30 | Click the wallet button, choose the devnet wallet, approve. Click "Use wallet balance". | "I connect a Solana wallet on devnet. The app reads my SOL balance and uses it as the position to protect. The spot price comes from Gemini's ticker." |
| 0:30 to 0:50 | Point at the ladder list (Live badge, countdown), then scroll to the quotes table. | "These are Gemini's live SOL price ladders from the Prediction Markets API. Each rung pays a dollar if SOL settles at or above its strike. The table shows the YES bid and ask, the NO price, and the size at the best price from Gemini's order-book stream." |
| 0:50 to 1:20 | Back to the three headline figures and the payoff chart. Drag the loss floor slider from 1.5% to 3%, then back. | "I set the most I am willing to lose. The dashed grey line is my position unhedged, the blue line hedged. Worst case without the hedge, worst case with it, and the cost. Loosen the floor and the cost falls fast; tighten it and it rises. The hatched area is below the lowest strike: the hedge pays a fixed amount there and I am exposed again. The app says so." |
| 1:20 to 1:40 | Scroll to the legs table. Point at fee and cost columns, then at "Largest position hedgeable". | "This is the basket: mostly NO contracts, each priced at the ask, with Gemini's taker fee of seven percent times price times one minus price, rounded up to the cent. Each leg is capped at the size on the book, and this figure is the largest position the book can protect at this floor." |
| 1:40 to 1:55 | Drag the slider to its tightest setting until the status reads "Floor out of reach", then back to 1.5%. | "If I ask for more than the book can give, the app does not pretend. It says the floor is out of reach and shows the best worst case it can actually reach." |
| 1:55 to 2:10 | Scroll to the distribution chart and the quote consistency panel. | "The ladder also implies a probability for each price range. Those probabilities only feed the expected payout; the hedge itself is chosen on executable prices. This panel flags inconsistent quotes, and separates real arbitrage from inversions you cannot trade." |
| 2:10 to 2:30 | Click "Paper fill and record receipt". Approve in the wallet. Wait for the signature to appear and the receipt to show as verified. | "Execution here is simulated: no order goes to Gemini. The paper fill writes a hash of the exact plan to Solana as a memo, signed by my wallet. The app reads it back from devnet and matches it to the plan." |
| 2:30 to 2:45 | Click the Explorer link on the receipt. On Solana Explorer, show the Memo program instruction and the `LH1|...` text, and the signer. | "Here it is on Solana Explorer: a Memo program transaction on devnet, signed by my wallet, carrying the ladder, size, floor, cost and plan hash. Ladder Hedge: the cheapest floor the book can actually sell you, and a receipt that proves what you chose." |

## Pre-recording checklist

- The deployed app (or `pnpm build` and `pnpm start`) loads, and the dev server is not in a reload loop.
- Wallet installed, set to Solana devnet, connected once already so it reconnects.
- Wallet funded with devnet SOL from https://faucet.solana.com (the devnet RPC airdrop is closed). One receipt costs 0.000005 SOL; a balance of a few SOL also gives a sensible position size.
- Pick the daily SOL ladder ("SOL price on November 20", expiry 22:00 UTC) or the monthly one ("November 30"). Avoid the hourly ladders: they are thinly quoted, often with one two-sided rung.
- Check the status at 1.5% reads "Floor met" and that the tightest slider setting reads "Floor out of reach" on the ladder you picked; if not, find the setting that does before recording. For reference, the engine on the SOL snapshot with 10 SOL, fee 7% and assumed depth 100 gives: 1.5% floor met for $37.23 (net expected cost $3.28), 3% for $9.72, and 1% out of reach.
- The headline cost at tight floors can look large (tens of dollars on a $700 position) because the basket covers intervals above spot too; point at the net expected cost beside it when you say the number.
- If live quotes are thin or Gemini is down, use the snapshot ladder `SOL2611202200-SNAPSHOT` (or restart with `LADDER_FORCE_SNAPSHOT=1`) and say once on camera that it is a labelled snapshot captured from Gemini. Its sizes are unknown, so the depth figure will read as assumed. Note that this snapshot's own expiry is 2026-11-20 22:00 UTC; after that it shows as expired.
- Record a receipt once before the take to confirm the wallet signs and the Explorer link opens on devnet.
- Close other tabs on the app's port; no notifications on screen.
