# Ladder Hedge: Design

Date: 2026-11-19. Approved by the project owner in conversation on 2026-11-19.

## Intent

A UBC 2026 Hackathon entry (DeFi and Onchain Applications track, Best use of
Solana, Gemini Prediction Markets bounty). It answers one question for someone
holding a crypto asset: "what is the cheapest basket of Gemini price-ladder
contracts that keeps my loss above a floor until the ladder expires?"

The claim the product makes is "cheapest hedge after costs, measured". It never
claims profit.

## Why this shape

Gemini lists daily price ladders per asset ("SOL price today at 12am EST":
"$68 or above", "$69 or above", ...). Every contract in a ladder settles on the
same number, so the relationships between contracts are exact. That makes
scenario hedging a small linear program over price intervals with no
correlation modelling.

Research line: arXiv 2609.14267 hedges spot BTC with Kalshi binary contracts
treated as options and lists multi-strike portfolios as future work. arXiv
2608.00666 separates payoff-space arbitrage from executable arbitrage. arXiv
2605.00864 finds order-book depth caps what can be extracted. This build is the
multi-strike, depth-aware version on Gemini.

## Goals

1. Read a Solana wallet's SOL balance as the exposure (manual entry always allowed, and required for other assets).
2. Pull a live Gemini crypto ladder and the spot price; show the ladder's implied price distribution.
3. Given a loss floor, compute the cheapest basket of ladder contracts at executable asks, respecting available size.
4. Show payoff before and after, total cost, expected payout, worst case, and the largest position the quotes can hedge.
5. Flag incoherent quotes on the ladder (executable arbitrage and non-executable inversions).
6. "Paper fill" the basket and record a hedge receipt as a memo transaction on Solana devnet; list past receipts read back from chain.
7. Work from a captured snapshot when no live ladder is quoted, clearly labelled as a snapshot.

## Non-goals

Live order placement on Gemini, rebalancing, Kelly sizing, sports and weather
markets, cross-venue comparison, user accounts, a database.

## Anti-goals

- Presenting assumed depth, snapshot data, or estimated spot as live measured data.
- Implying protection below the lowest strike. Below it, the ladder pays a fixed amount and the holder is exposed again; the UI must say so.
- Any wording that promises profit.

## Constraints

- Submission deadline 2026-11-20 12:00 CST. Feature freeze 09:00 CST.
- Must use the Gemini Prediction Markets API (market data qualifies).
- DeFi track: interact with smart contracts, list every program address used, explain economic design and risk assumptions in the README.
- Public GitHub repo, README with architecture, deployed demo, 2-3 minute video.
- Owner's code rules: no emojis anywhere; JSDoc on every function; TypeScript strict, no `any` without a comment; async functions use try/catch and never swallow errors; kebab-case file names; PascalCase components; hooks prefixed `use`; SCREAMING_SNAKE_CASE constants.
- No `git commit` without the owner's explicit approval.

## Approaches considered

1. Ladder Hedge on crypto ladders (chosen): strongest research line, exact payoff model, uses Gemini's spot-plus-events position.
2. Sports cash-out calculator on spread ladders: most of Gemini's volume, same solver, weaker research line and no natural on-chain link.
3. Cross-venue price gap board: fastest, least novel, mostly outside Gemini's API.

## How it works

- Price states: a ladder with strikes K1 < ... < Kn splits the expiry price into n+1 intervals. A YES contract at Ki pays $1 when the price is at or above Ki; a NO contract pays $1 below Ki. Buying NO costs one minus the YES bid.
- A long holder's loss within an interval is worst at its lower edge, so each interval is evaluated there. The bottom interval is evaluated at a stress price (default: lowest strike minus one strike spacing).
- Stage 1 linear program: minimise total cost subject to hedged profit and loss at or above the floor in every state, with per-contract size caps. Stage 2, when stage 1 is infeasible: maximise the worst-case hedged profit and loss.
- Implied distribution: mid quotes as survival probabilities, made monotone by pooling adjacent violators, differenced into interval probabilities.
- Receipt: a short pipe-delimited memo containing a SHA-256 hash of the canonical plan, written with the SPL Memo program and read back with `getSignaturesForAddress`.

## Left to the builder

Visual design within the constraints above, chart library usage, hook
structure, error copy, and whether order-book sizes can be read from the public
WebSocket (if not, sizes stay unknown and the user-set assumed depth applies).
