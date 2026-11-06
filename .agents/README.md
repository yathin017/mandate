# Mandate

**The market-maker deal as an onchain program.**
A project's tokens never leave its own Safe. The market maker gets a *mandate* (permission to quote within hard limits), not custody of the tokens. The deal terms are the code, and the code refuses any trade that breaks them.

Built for **ETHGlobal Mumbai 2026** (Nov 5–7) on **1inch Aqua + SwapVM** and **Uniswap v4**.

> **For AI agents working in this repo:** this file is the source of truth for *what* we are building and *why*. Read it fully before writing code. Where this file says "verify", you must check the real source (contracts, docs, chain data) instead of guessing. Never invent function signatures, addresses, or numbers. If something here conflicts with the actual Aqua/SwapVM/Uniswap source code, the source code wins. Note the conflict in `NOTES.md` and continue.

---

## Table of contents

1. [The problem](#1-the-problem)
2. [Evidence the problem is real](#2-evidence-the-problem-is-real)
3. [What existing solutions miss](#3-what-existing-solutions-miss)
4. [Our solution](#4-our-solution)
5. [Actors and permissions](#5-actors-and-permissions)
6. [The rules (mandate terms)](#6-the-rules-mandate-terms)
7. [System architecture](#7-system-architecture)
8. [Smart contract specification](#8-smart-contract-specification)
9. [How the market maker gets paid](#9-how-the-market-maker-gets-paid)
10. [UI and UX specification](#10-ui-and-ux-specification)
11. [Demo plan (what judges see)](#11-demo-plan-what-judges-see)
12. [Tech stack and repo layout](#12-tech-stack-and-repo-layout)
13. [Build order and time budget](#13-build-order-and-time-budget)
14. [Rules for agents](#14-rules-for-agents)
15. [Honest limitations](#15-honest-limitations)
16. [Prize requirements checklist](#16-prize-requirements-checklist)
17. [Glossary](#17-glossary)

---

## 1. The problem

### 1.1 Every new token needs a market maker

When a token launches, traders need to be able to buy and sell it without moving the price wildly. Someone has to quote it continuously, offering to buy slightly below the price and sell slightly above it. That someone is a **market maker (MM)**. Projects rarely do this themselves; they hire a professional firm.

### 1.2 The market maker needs inventory, but won't buy it

To sell tokens to buyers, the MM needs tokens. A new token is risky, so the MM does not want to buy a large position. The industry-standard fix is the **token loan + call option** deal:

| Term | What it means | Typical size |
|---|---|---|
| **Token loan** | The project transfers tokens to the MM's wallet. At the end of the term, the MM returns them (or pays for them). | ~1–5% of circulating supply |
| **Term** | How long the MM keeps the tokens. | 6–12 months |
| **Call option** | The MM may *buy* the loaned tokens at a fixed strike price instead of returning them. This is how the MM gets paid. | Strike set at signing |

### 1.3 The incentives push the market maker to sell

Example: the MM borrows 10M tokens with an option to buy them at $1.

- **If the MM sells early and the price crashes to $0.20:** it buys 10M tokens back for $2M, returns them, and keeps the difference from what it sold for. That profit grows the further the price falls.
- **If the price instead rises to $3:** the MM exercises its option and buys at $1. Its loss is capped.

**Selling has open-ended upside and limited downside.** A firm that dumps inventory into a thin, freshly listed market can earn more than one that patiently provides liquidity. Some deals add clauses that make it worse. In the MOVE deal, the MM was allowed to sell once the token hit a $5B valuation, which rewards pumping first and dumping after.

### 1.4 The project gives up custody and visibility

Once the tokens are transferred:

- **The project cannot see** what the MM does with them in real time.
- **The project cannot stop** a sale; the tokens are no longer in its wallet.
- **The contract is private**, often with an offshore entity, sometimes through a middleman.
- **The only remedy is after the fact:** a lawsuit, a public complaint, or hoping an exchange intervenes.

### 1.5 Who gets hurt

- **The project:** its price collapses, exchanges may delist it, it loses community trust, and sometimes the company itself fails.
- **Retail holders:** they bought because of the apparent liquidity, then absorbed the dump.
- **Honest market makers:** every scandal makes projects suspicious of the whole industry.

### 1.6 The core insight

The problem is not that market makers exist. The problem is that **the deal's terms are unenforceable promises, and the tokens are handed over in full on day one.** Disclosure alone (publishing the terms) lets you *see* a violation; it does not *prevent* one.

**If the tokens never leave the project's wallet, and the MM can only act through code that enforces the terms, violations become impossible rather than merely visible.**

---

## 2. Evidence the problem is real

Use these in the pitch and UI. Before putting any number on a slide, verify it against the original source. Items marked *(media-reported)* come from crypto media citing onchain investigators; check the onchain transactions before quoting exact figures.

| Case | When | What happened | Venue |
|---|---|---|---|
| **Movement (MOVE)** | Dec 2024 | The day after listing, the MM sold ~66M MOVE (~$38M), and the price fell ~47%. Binance offboarded the MM and froze the proceeds. The co-founder was suspended, Coinbase suspended trading, and the company later filed for bankruptcy. The deal was routed via a middleman (Rentech) and let the MM sell at a $5B valuation. | Centralized exchange |
| **FBI "Operation Token Mirrors" / NexFundAI** | Oct 2024 | The FBI created a fake token and hired market makers to see what they would offer. 18 individuals and entities were charged, including market makers offering wash trading and dumps, and over $25M was seized. Gotbit's founder was later sentenced to prison, and the firm was ordered to shut down. | Mixed |
| **Axis Robotics (AXIS)** *(media-reported)* | Oct 2026 | Insiders got 76M+ tokens (>$12M) from a team wallet. One wallet sold ~42M AXIS for >$5M on decentralized exchanges, and the price dropped ~40%. The project blamed a "trading partner." **This is the closest match to our use case: a partner allocation dumped onchain.** | DEX (Base) |
| **FUN on Uniswap v2** *(media-reported)* | Oct 30, 2026 | One address made 150+ sales of 134.1M FUN for 111.5 ETH, and the price crashed >90%. The seller was a hacker, not an MM, but the *mechanics* (repeated dumping into one pool) are exactly what a sell cap bounds. | Uniswap v2 (Ethereum) |
| **Ethena disclosure** | 2024–25 | Public Blockworks Token Transparency filing listing four "token loan with call option" MM deals of 6M–20M ENA, each 12 months. This shows the structure is **standard practice**, not a rogue edge case. | n/a |

**Pitch line:** "Federal agents caught market makers just by posing as a client. MOVE lost $38M the day after listing. These deals are standard, private, and unenforceable. We made them enforceable."

---

## 3. What existing solutions miss

| Existing approach | What it does | Why it is not enough |
|---|---|---|
| **Disclosure** (Blockworks Token Transparency, exchange MM rules) | Publishes deal terms | You can see a violation, but you cannot stop it |
| **Vesting tools** (Sablier, Hedgey, Streamflow) | Controls *when tokens unlock* to a holder | Says nothing about *how unlocked tokens are sold* |
| **Launch auctions** (Uniswap CCA, Doppler, LBPs) | Primary price discovery at launch | Ends when the pool exists; does not govern ongoing market making |
| **Managed liquidity vaults** (Arrakis, Steer, Bunni, Gamma) | A manager runs liquidity for the project | The project deposits into the vault; there are no time-based net-sell limits or MM mandate bounds |
| **Launch hooks with anti-whale limits** | Limits all traders' size | Restricts the public, not the hired MM's discretion over treasury inventory |

**Our position:** Mandate sits *after* launch (post-CCA/LBP). It governs how a treasury's tokens are sold over time by a third party, without custody transfer. It complements launch tools; it does not compete with them.

---

## 4. Our solution

### 4.1 One-sentence version

The project's Safe stays the owner of its tokens and acts as the liquidity provider on 1inch Aqua; the market maker can only tune strategies inside limits enforced by code; every trade passes through a quoter that checks the deal's rules; and a Uniswap v4 price anchor refuses to sell into a manipulated price.

### 4.2 Why 1inch Aqua makes this possible

On a normal AMM or with a normal MM deal, tokens must be *moved* somewhere (into a pool or the MM's wallet) before they can be traded. **Aqua is different:**

- **Tokens stay in the owner's wallet.** The owner (the "maker") *ships* a strategy, which registers a **virtual balance** that strategy may use.
- **Tokens move only when a trade fills.** At that moment, Aqua *pulls* exactly the tokens needed from the maker's wallet and *pushes* the proceeds back, in one atomic transaction.
- **Strategies are SwapVM programs.** A program can call our own contract (via the **Extruction** instruction) to decide the price and to accept or reject each trade.
- **A smart contract can be the maker.** Past projects used vaults and smart accounts as makers, so a Safe works too.

So "the MM never takes custody" is not a promise. **It is how Aqua works.**

### 4.3 The four parts

1. **Issuer Safe as maker.** The project's treasury Safe ships the Mandate strategy to Aqua. The tokens stay in the Safe.
2. **MandateQuoter (SwapVM Extruction target).** Prices every trade and enforces the rules: per-epoch net sell cap, release schedule, price floor, and the Uniswap v4 anchor. It reverts any trade that breaks a rule.
3. **MandateModule (Safe module).** Gives the MM a narrow role: it can *re-ship* the strategy with different parameters (spread, epoch size) **only inside bounds the issuer set**. It cannot move tokens, raise limits, or swap in a different quoter. The issuer can revoke instantly.
4. **Uniswap v4 anchor pool with an oracle hook.** A LAUNCH/USDC v4 pool carries an oracle hook that records a TWAP (time-weighted average price). The quoter refuses to quote when the Aqua price is too far from that TWAP, so the treasury is never used as exit liquidity at a pumped or crashed price.

### 4.4 What this changes

| | Traditional MM deal | Mandate |
|---|---|---|
| Who holds the tokens | MM's wallet | Project's Safe, always |
| Can the MM dump everything on day one | Yes | No: blocked by the epoch cap and release curve |
| Can the MM sell below an agreed price | Yes | No: blocked by the floor |
| Can the MM sell into a manipulated price | Yes | No: blocked by the v4 anchor |
| Can the project see the terms | Only if disclosed | Always: they are onchain |
| Can the project stop it mid-term | Lawsuit | One transaction (revoke) |
| How the MM is paid | Call option (rewards selling) | Fee share on real fills (rewards providing liquidity) |

---

## 5. Actors and permissions

| Actor | Who | Can do | Cannot do |
|---|---|---|---|
| **Issuer** | Project treasury Safe (its owners sign) | Create a mandate; set bounds; fund the Safe; revoke or pause; pay MM fees | n/a (owner) |
| **Market maker** | MM operator address, given a role in MandateModule | Re-ship the strategy with parameters *inside bounds*; pause (reduce risk) anytime; view fees earned | Move tokens out of the Safe; raise caps or lower the floor beyond bounds; change the quoter; un-revoke |
| **Taker** | Traders, resolvers, aggregator routes | Swap against the strategy via AquaSwapVMRouter | Bypass rules; trades breaking rules revert |
| **Observer** | Anyone (community, exchanges, investors) | Read all terms, the epoch counter, released vs sold, and anchor status | n/a |

**Taker gating note (verify):** on the live Aqua launch, takers must be verified counterparties (1inch Resolvers holding a KYC NFT, checked onchain at swap time). **All demos run on a local mainnet fork**, where we impersonate or mint the credential. In the pitch, frame this as a feature: only verified counterparties can hit treasury quotes.

---

## 6. The rules (mandate terms)

All of these live onchain, are readable by anyone, and are enforced on every swap.

### 6.1 Issuer-set bounds (only the issuer can change these)

| Bound | Type | Meaning | Example |
|---|---|---|---|
| `allotment` | uint | Max LAUNCH the strategy may ever sell (the "loan size" equivalent) | 10,000,000 LAUNCH |
| `releaseStart`, `releaseDuration` | timestamps | Sellable inventory unlocks linearly over this period | 0 → 180 days |
| `maxEpochCap` | uint | Ceiling on net LAUNCH sold per epoch | 200,000 / day |
| `epochLength` | seconds | Length of an epoch | 86,400 |
| `floorPrice` | uint (USDC per LAUNCH, scaled) | Never sell below this price | $0.40 |
| `maxAnchorDeviationBps` | uint | Max allowed distance between the Aqua price and the v4 TWAP | 300 (3%) |
| `twapWindow` | seconds | TWAP lookback window | 1,800 (30 min) |
| `spreadBpsMin`, `spreadBpsMax` | uint | Range of spreads the MM may choose | 10 – 200 |
| `mmFeeShareBps` | uint | MM's share of fees earned on fills | 5,000 (50%) |
| `quoter` | address | The only allowed Extruction target | MandateQuoter |

### 6.2 MM-tunable parameters (only within bounds)

| Parameter | Constraint |
|---|---|
| `spreadBps` | `spreadBpsMin ≤ x ≤ spreadBpsMax` |
| `epochCap` | `x ≤ maxEpochCap` |
| `shippedLaunch` | `x ≤ allotment − totalNetSold` |
| `shippedUsdc` | `x ≤ USDC the issuer approved for buybacks` |

### 6.3 Enforcement checks on every swap

Run in this order. Each failure reverts with a named error so the UI can explain it in plain language.

1. `NotRouter`: the state-writing call must come from AquaSwapVMRouter.
2. `MandateRevoked` / `MandatePaused`
3. `AnchorDeviation`: `|aquaPrice − v4Twap| / v4Twap > maxAnchorDeviationBps`
4. `BelowFloor`: when selling LAUNCH, execution price < `floorPrice`
5. `EpochCapReached`: `netSoldThisEpoch + amountOut > epochCap`
6. `ReleaseExceeded`: `totalNetSold + amountOut > released(now)`, where `released(t) = allotment × clamp((t − releaseStart) / releaseDuration, 0, 1)`

**Net accounting:** when the strategy *buys* LAUNCH back (a taker sells LAUNCH to the treasury), subtract that amount from `netSoldThisEpoch` and `totalNetSold`, but never below zero. Buybacks restore capacity, so a two-sided MM is not punished for genuine market making.

---

## 7. System architecture

```
                         ┌────────────────────────────┐
   Issuer Safe owners ──▶│        Issuer Safe         │ holds LAUNCH + USDC (always)
                         │  (Aqua maker)              │
                         │   └─ MandateModule ◀───────┼── MM operator (bounded role)
                         └─────────────┬──────────────┘
                     ship/dock         │ pull on fill / push proceeds
                                       ▼
                         ┌────────────────────────────┐
   Taker ── swap ──────▶ │  AquaSwapVMRouter + Aqua   │
                         │  program: [Extruction]     │
                         └─────────────┬──────────────┘
                                       │ quote (view) / swap (stateful)
                                       ▼
                         ┌────────────────────────────┐
                         │      MandateQuoter         │ rules + pricing + epoch state
                         └─────────────┬──────────────┘
                                       │ read TWAP + spot
                                       ▼
                         ┌────────────────────────────┐
                         │ Uniswap v4 PoolManager     │
                         │ LAUNCH/USDC pool +         │
                         │ MandateOracleHook (TWAP)   │
                         └────────────────────────────┘
```

**Flow of a fill:**
1. A taker requests a quote → the router calls MandateQuoter's **view** path → the quoter returns a price or an error.
2. The taker swaps → the router calls the **state-modifying** path → the quoter re-checks all rules and updates the epoch counters → Aqua pulls LAUNCH from the Safe and pushes USDC into the Safe, atomically.
3. The fee portion is recorded as owed to the MM.

---

## 8. Smart contract specification

> **Verify first:** read `github.com/1inch/aqua` and `github.com/1inch/swap-vm` (and `@1inch/aqua-sdk`, `@1inch/swap-vm-sdk`) before writing contracts. Find the real `IExtruction` and `IStaticExtruction` interfaces, how instruction args are encoded, the `ship`/`dock` signatures, and the deployed addresses on Ethereum mainnet. Reference addresses from the developer release (verify they are still canonical): Aqua `0x499943e74fb0ce105688beee8ef2abec5d936d31`, SwapVM `0x8fdd04dbf6111437b44bbca99c28882434e0958f`. Use the Solidity version the Aqua repo pins.

### 8.1 `MandateQuoter.sol`

- Implements **both** `IStaticExtruction` (view, used for quoting) and `IExtruction` (state-modifying, used for swapping) exactly as defined in swap-vm.
- **Single source of truth:** both paths must call the same internal `_check(...)` and `_price(...)` functions so quotes always match swaps (the OpenZeppelin audit flagged quote/swap consistency as a risk).
- **Pricing:** constant-product (x·y=k) over the strategy's Aqua virtual balances, plus `spreadBps`. Keep it simple and deterministic.
- **State:** `mapping(bytes32 mandateId => EpochState)` with `epochIndex`, `netSoldThisEpoch`, `totalNetSold`. Identify the mandate from the instruction args (or from the order hash, if the router exposes it in context; verify).
- **Access control:** the state-writing function must `require(msg.sender == AQUA_SWAPVM_ROUTER)`. Without this, anyone could burn the epoch cap and grief the treasury.
- **Non-upgradeable.** No owner functions that change rules; rules come from MandateModule's stored terms.
- **Events:** `Filled(mandateId, side, amountIn, amountOut, price, netSoldThisEpoch, totalNetSold)`, `FeeAccrued(mandateId, amount)`.
- **Errors:** `NotRouter`, `MandateRevoked`, `MandatePaused`, `AnchorDeviation(uint256 aquaPrice, uint256 twap)`, `BelowFloor(uint256 price, uint256 floor)`, `EpochCapReached(uint256 used, uint256 cap)`, `ReleaseExceeded(uint256 used, uint256 released)`.
- **Views for the UI:** `released(mandateId)`, `remainingThisEpoch(mandateId)`, `epochResetsAt(mandateId)`, `anchorStatus(mandateId)` (returns aquaPrice, twap, deviationBps, ok).

### 8.2 `MandateModule.sol` (Safe module)

- Enabled on the issuer Safe. Stores `Bounds` and the current `Params` per `mandateId`.
- **Issuer-only** (must be called by the Safe itself): `createMandate(bounds, mmAddress)`, `updateBounds(...)`, `revoke(mandateId)` (docks all strategies, disables the MM), `payMmFees(mandateId)`.
- **MM-only:** `reship(mandateId, newParams)` validates `newParams` against `Bounds`, then via `execTransactionFromModule` calls Aqua `dock(oldStrategy)` and `ship(newStrategy)`. Strategies are immutable by hash, so "tuning" always means dock + re-ship. `pause(mandateId)` is allowed anytime and only ever reduces risk.
- **MM can never:** call arbitrary Safe transactions, transfer tokens, change `quoter`, exceed any bound, or re-enable after revoke.
- Keep it small (~150 lines). Write tests for every forbidden action.

### 8.3 `MandateOracleHook.sol` (Uniswap v4)

- Based on OpenZeppelin `uniswap-hooks` `BaseOracleHook` (verify the package and contract name). Deploy at a CREATE2 address with the required hook flags.
- Attached to the LAUNCH/USDC v4 pool on the fork.
- Exposes `twap(window)` and spot via v4-core `StateLibrary`.
- On the fork, generate observation history by warping time and swapping, and **label it as synthetic** in the UI.

### 8.4 Tests (Foundry, mainnet fork)

Required:
- Fill within limits succeeds; tokens move Safe → taker and USDC taker → Safe (assert balances).
- `EpochCapReached` after the cap; succeeds again after `vm.warp` past the epoch.
- `ReleaseExceeded` early in the release schedule.
- `BelowFloor` when the curve price drops under the floor.
- `AnchorDeviation` after a taker pumps or crashes the v4 pool, then the same trade succeeds once the price returns.
- A buyback reduces `netSoldThisEpoch`.
- Quote == swap for 100 random sizes (fuzz).
- `NotRouter` when a random address calls the stateful path.
- MM `reship` inside bounds works; outside bounds reverts; any MM attempt to transfer tokens reverts; after `revoke` the MM can do nothing.
- Demo scenarios (section 11) as scripts with printed numbers.

---

## 9. How the market maker gets paid

This is the question MM-savvy judges will ask: *"Why would a market maker sign this without a call option?"*

**Answer:** in Mandate, the MM earns a share of the fees on every real fill. It is paid for *providing liquidity*, not for *selling inventory*. This reverses the bad incentive.

Implementation (simple and robust):
- The quoter applies `spreadBps`. The fee portion of each fill stays in the Safe as part of the proceeds.
- The quoter emits `FeeAccrued` and records `feeOwed[mandateId]` in USDC.
- The issuer calls `payMmFees` via the module to send `feeOwed × mmFeeShareBps` to the MM. (Optional stretch: allow the MM to claim directly through the module, capped at the accrued amount.)
- **Optional stretch, mention in the pitch only:** a performance kicker paid when uptime and depth KPIs are met (measured onchain from fills and shipped balances).

Pitch line: **"Old deal: the MM profits when your token falls. Mandate: the MM profits when your token trades."**

---

## 10. UI and UX specification

### 10.1 Design direction

**Concept: "A term sheet that enforces itself."** The UI should feel like a serious financial instrument, a live legal document, not a meme-coin dashboard. Judges should immediately understand: *these are the deal terms, and here is the code refusing to break them.*

- **Aesthetic:** paper and ink. Off-white background (`#F6F4EF`), near-black text (`#141414`), hairline rules, generous whitespace. Dark mode inverts to deep ink (`#111214`) with warm off-white text.
- **Typography:** a serif for the terms and headings (e.g. *Fraunces* or *Source Serif 4*, so it reads like a contract); a clean sans for UI controls (*Inter*); **monospace with tabular numbers** for all figures and addresses (*JetBrains Mono*).
- **Color with meaning (use sparingly):**
  - **Filled / within limits:** deep green `#1F7A4D`
  - **Blocked by Mandate:** vermilion `#D2462E` (the signature color; a "stamp" feel)
  - **Warning / near limit:** amber `#C98A1B`
  - **Neutral data:** ink and grey
- **Signature element: the "BLOCKED BY MANDATE" stamp.** When a trade is rejected, a red, slightly rotated stamp animates onto the trade row, naming the clause it broke. This is the visual moment of the demo.
- **Motion:** minimal and purposeful. Counters tick, gauges fill, stamps land. No decorative animation.
- **Responsive:** must work at 375px width. No horizontal scroll. Charts collapse to a single column.

### 10.2 UX principles (non-negotiable)

1. **Every number has a source.** Hovering any figure shows where it came from (contract + function + block number). Synthetic or modeled data carries a visible `MODELED` or `SYNTHETIC` tag.
2. **Every "no" explains itself in plain language.** Never show a raw revert. Map each error to a sentence:
   - `EpochCapReached` → "Blocked by Mandate · Daily sell limit reached (200,000 / 200,000 LAUNCH). Resets in 4h 12m."
   - `ReleaseExceeded` → "Blocked by Mandate · Only 1,111,111 LAUNCH has unlocked so far (day 20 of 180)."
   - `BelowFloor` → "Blocked by Mandate · Price $0.37 is below the $0.40 floor."
   - `AnchorDeviation` → "Blocked by Mandate · The price here is 9.4% away from the Uniswap 30-min average (limit 3%). Possible manipulation."
   - `NotRouter` → "This call must come through the 1inch Aqua router."
3. **Bounds are visible as rails.** MM sliders show the issuer's bounds as hard stops; the slider physically cannot go past them, and a lock icon explains why.
4. **Plain words first, jargon second.** Write "Daily sell limit", with "epoch cap" in small text beneath. Every term has an info tooltip that uses the glossary.
5. **Transaction states are always clear:** idle → waiting for signature → pending (with hash) → confirmed (with block) → or failed (with plain-language reason).
6. **No dead ends.** Empty states explain what to do next ("No mandate yet. Create one in 3 steps.").

### 10.3 Screens

#### Screen A: Landing / "The Deal, Enforced"
- Hero: "Market makers get a mandate, not your tokens."
- A three-panel story: **The old deal** (tokens leave, MM profits from dumping, you find out from the chart) → **What happened** (MOVE: 66M tokens, ~$38M, −47%, with a source link) → **Mandate** (tokens stay, rules enforced, MM paid for liquidity).
- Two buttons: **"Watch the replay"** (Screen E) and **"Open a mandate"** (Screen B).

#### Screen B: Issuer Console (create and manage)
- **Create Mandate wizard, 3 steps:**
  1. *Parties:* token, quote token, MM address.
  2. *Terms:* allotment, release schedule, daily sell limit, floor, anchor tolerance, spread range, MM fee share. Each field shows a one-line plain explanation and a live example ("With these terms, at most 200,000 LAUNCH can be sold per day; 50% unlocks by day 90.").
  3. *Review:* the terms render as a **term sheet document** (serif, numbered clauses) with "Sign with Safe" at the bottom.
- **Manage view:** status pill (Active / Paused / Revoked), live clauses, buttons for **Pause**, **Revoke** (red, with confirmation explaining exactly what happens), and **Pay MM fees**.

#### Screen C: MM Desk
- Shows the mandate the MM operates under, as a compact term sheet.
- **Controls:** spread slider, epoch cap slider, shipped-amount input, all clamped to bounds with visible rails.
- **"Re-ship strategy"** button: previews the old vs new parameters, then executes `reship`.
- **Earnings panel:** fees accrued, fees paid, fill count, volume.
- **"What I can't do"** box, listed explicitly: move tokens, raise limits, change the quoter. This builds trust and makes the point for judges.

#### Screen D: Public Mandate Page (the transparency page; shareable URL)
Anyone can open this page; no wallet required.
- **Header:** project, MM, status, term start/end.
- **Four live gauges:**
  1. **Today's sell limit:** a ring gauge, `used / cap`, plus a countdown to reset.
  2. **Unlocked vs sold:** an area chart of the release curve (dashed line) vs cumulative net sold (solid line). Sold must always stay under the curve.
  3. **Price vs floor:** a line chart of the execution price with the floor as a red line.
  4. **Anchor health:** the Aqua price vs the v4 TWAP with a tolerance band; a green "In range" or red "Paused: price out of range" status.
- **Activity feed:** every fill and every blocked attempt, newest first. Blocked rows carry the red stamp and the plain-language reason.
- **Terms section:** the full term sheet, with each clause linked to the contract code line or function that enforces it.

#### Screen E: Replay Theater (the demo centerpiece)
A guided, step-by-step comparison. One **"Run"** button per act, with pause, step and reset. Each act shows a **split view**:

| Left: "Traditional loan" | Right: "Mandate" |
|---|---|
| The MM's wallet holds the tokens | The issuer's Safe holds the tokens |
| Every sell order executes | Sells beyond the rules get stamped BLOCKED |
| Price chart collapses | Price chart stays within a bounded path |
| "Treasury tokens remaining: 0" | "Treasury tokens remaining: 9.8M" |

- Top: a scenario selector (Act 1, Act 2, Act 3; see section 11).
- Bottom: a running "damage" counter: tokens dumped, price impact, value lost by holders, on each side.
- Every executed step links to its fork transaction hash and block. The 1inch prize requires showing real onchain token transfers, so show them.
- Modeled scenarios carry a clear `MODELED ON REAL EVENT` banner with the source link.

### 10.4 Components to build once and reuse
`TermClause`, `BlockedStamp`, `SourceTooltip`, `BoundedSlider`, `RingGauge`, `ReleaseCurveChart`, `AnchorBandChart`, `ActivityFeed`, `TxStatus`, `StatusPill`, `SplitReplay`.

### 10.5 Copy tone
Calm, precise, confident. Short sentences. No hype words ("revolutionary", "game-changing"). Let the stamp do the drama.

---

## 11. Demo plan (what judges see)

Target: **3–4 minutes.** Everything runs on a local Ethereum mainnet fork with real token transfers.

### Act 1: "The MOVE-sized deal" (counterfactual, ~60s)
- Setup: a mock LAUNCH token; the issuer Safe holds 10M LAUNCH under mandate.
- Left side: the MM holds 10M LAUNCH in its own wallet and sells all of it into the pool in one day. The price collapses.
- Right side: the same sell intent goes through Mandate. Fills up to the daily cap; every order after that is stamped `EpochCapReached`.
- Say clearly: **"MOVE's dump happened on Binance. This is a model of the incentive, not a replay of that event."**

### Act 2: Onchain replay (~90s)
- Replay the FUN sell sequence (150+ sells, 134.1M FUN for 111.5 ETH) against a pool where the treasury quotes via Mandate. **Verify**: pull the real transactions from Etherscan or an RPC. If unavailable in time, synthesize a sequence matching the reported totals and label it `MODELED ON REAL EVENT`.
- Then show manipulation: the attacker pumps the v4 pool first and tries to sell to the treasury → stamped `AnchorDeviation`. When the price returns to normal → the trade fills.
- Stretch alternative: AXIS on Base (a partner allocation dumped onchain) if the wallet addresses can be found in under 45 minutes.

### Act 3: The MM at work (~45s)
- The MM tightens the spread from 80 → 30 bps via `reship` → succeeds (inside bounds).
- The MM tries to raise the daily cap above the issuer's maximum → the module reverts; the UI shows the lock.
- The MM tries to transfer tokens out of the Safe → impossible; show the revert.
- Fees earned tick up on real fills. The issuer pays the MM.

### Close (~15s)
> "The old deal pays market makers when your token falls. Mandate pays them when it trades. The terms are the program. Disclosure becomes the contract."

---

## 12. Tech stack and repo layout

**Contracts:** Foundry; Solidity version pinned to match the Aqua/SwapVM repos (verify); 1inch Aqua + SwapVM as dependencies at pinned release tags; Uniswap v4-core / v4-periphery; OpenZeppelin uniswap-hooks; Safe contracts (use canonical Safe singleton and proxy factory on the fork).

**Frontend:** React + TypeScript + Vite, viem + wagmi, `@1inch/aqua-sdk`, `@1inch/swap-vm-sdk`, Recharts (or visx) for charts, Tailwind CSS with the design tokens above.

**Fork:** `anvil --fork-url $MAINNET_RPC` at a pinned block. All scripts are deterministic.

```
mandate/
├── README.md                ← this file
├── NOTES.md                 ← decisions, verified facts, conflicts found
├── contracts/
│   ├── src/
│   │   ├── MandateQuoter.sol
│   │   ├── MandateModule.sol
│   │   ├── MandateOracleHook.sol
│   │   └── mocks/LaunchToken.sol
│   ├── test/
│   │   ├── Quoter.t.sol
│   │   ├── Module.t.sol
│   │   ├── Anchor.t.sol
│   │   └── Scenarios.t.sol   ← Acts 1–3 with printed numbers
│   └── script/
│       ├── DeployFork.s.sol
│       ├── SeedV4Pool.s.sol
│       └── RunActs.s.sol
├── app/
│   ├── src/
│   │   ├── screens/ (Landing, IssuerConsole, MMDesk, PublicMandate, ReplayTheater)
│   │   ├── components/ (see section 10.4)
│   │   ├── lib/ (contracts.ts, errors.ts ← revert → plain-language map)
│   │   └── data/ (replay JSON exported from scripts)
│   └── ...
└── replay/
    └── export.ts            ← runs scenarios on the fork, writes JSON for the UI
```

---

## 13. Build order and time budget

Submissions close **Nov 7, 2026, 09:00 IST** (verify on the event page). That leaves about 20 hours. Build in this order and cut from the bottom.

| # | Task | Est. | Done when |
|---|---|---|---|
| 1 | Fork setup; read Aqua/SwapVM source; record verified interfaces and addresses in NOTES.md | 1.5h | A trivial Aqua strategy fills on the fork |
| 2 | MandateQuoter: pricing + all 6 checks + router gate + views | 4–5h | Quoter tests pass, incl. quote==swap fuzz |
| 3 | v4 pool + oracle hook on the fork; anchor check wired in | 3h | Anchor tests pass |
| 4 | Safe as maker + MandateModule (reship, pause, revoke, fees) | 3h | Module tests pass, incl. every forbidden action |
| 5 | Scenario scripts (Acts 1–3) + JSON export | 3h | `RunActs` prints numbers; JSON exists |
| 6 | Replay Theater + Public Mandate Page | 4h | Demo runs end to end from the UI |
| 7 | Issuer Console + MM Desk | 2h | Create, reship and revoke work from the UI |
| 8 | Landing page, polish, demo video, submission text | 1.5h | Submitted |

**If time runs short, cut in this order:** the Issuer Console wizard (pre-create the mandate in a script) → MM Desk (show Act 3 from the Replay Theater only) → the Landing page. **Never cut:** the quoter checks, the fork token transfers, the BLOCKED stamp, or the Replay Theater.

---

## 14. Rules for agents

1. **Commit early and often** with meaningful messages. The 1inch prize requires a proper Git history, with no single-commit entries on the final day.
2. **Verify, don't guess.** Interfaces, addresses, opcode availability on the Aqua router, hook flags, and incident numbers all come from the source. Record each verified fact in `NOTES.md` with its source.
3. **Never fabricate data.** Real data is labeled with its source; modeled or synthetic data is labeled `MODELED` or `SYNTHETIC` in code and UI.
4. **Use the official Aqua/SwapVM contracts** (a redeployed *modified* SwapVM is allowed). Do not fork and rewrite Aqua itself.
5. **Quote and swap paths must share logic.** No duplicated rule code.
6. **Security basics:** router-gated state writes; no upgradeability; no owner backdoors in the quoter; the module grants the MM nothing beyond section 5.
7. **No real private keys** anywhere. Use anvil test accounts.
8. **Keep it shippable.** Prefer the simplest correct implementation. A working, well-explained demo beats an ambitious broken one.
9. **Plain-language errors:** every revert added to a contract must get an entry in `app/src/lib/errors.ts`.
10. **Credit prior work** in the README (section 3 and the submission): Wamia used an Extruction quoter with a spend limit; VexiHakari used a v4-anchored price guard. Our novelty is the *application*: treasury-custodied, MM-mandated, time-released selling.

---

## 15. Honest limitations

Say these out loud in the pitch; judges respect it.

- **We cannot stop CEX dumps.** If a market maker gets tokens elsewhere and sells on Binance, Mandate cannot touch that. Our market is **DEX-first launches and treasuries that make markets onchain**, which is a growing share of launches.
- **MM adoption is unproven.** We replace the call option with fee share. Whether large MMs accept this is an open question. The pitch: projects with leverage (good launches) can demand it, and honest MMs can use it to prove they are honest.
- **Live taker gating:** on the live Aqua launch, only verified counterparties can take. Our demo runs on a fork.
- **Single pair, single chain** in the hackathon build. Multi-venue and multi-chain are future work.

---

## 16. Prize requirements checklist

**1inch: Build an Aqua App** (verify the current text on ethglobal.com/events/mumbai/prizes)
- [ ] Uses official Aqua/SwapVM contracts (modified SwapVM redeploy allowed)
- [ ] Uses SwapVM (scored higher), via our Extruction quoter
- [ ] Onchain token transfers shown in the final demo (local fork OK)
- [ ] Proper Git commit history

**Uniswap Foundation: Build with Uniswap** (verify the amount and wording; we have seen both $10,000 and $15,000)
- [ ] Meaningful use of the Uniswap stack: v4 pool + custom oracle hook + `StateLibrary` reads as a core safety mechanism
- [ ] README explains the architecture and how to run it

**Finalist judging** (if chosen): problem clarity, live demo, technical depth, honesty about limits.

---

## 17. Glossary

- **Market maker (MM):** a firm that continuously quotes buy and sell prices so others can trade.
- **Token loan + call option:** the standard MM deal. The project lends tokens; the MM may buy them at a fixed price instead of returning them.
- **Aqua:** 1inch's shared liquidity protocol. Tokens stay in the owner's wallet; strategies get virtual balances; tokens move only when a trade fills.
- **Maker:** the address whose tokens back an Aqua strategy (here, the issuer Safe).
- **Ship / dock:** register a strategy with a virtual balance on Aqua / remove it.
- **Pull / push:** Aqua moving tokens from / to the maker at fill time.
- **SwapVM:** the instruction set that defines an Aqua strategy's pricing program.
- **Extruction:** a SwapVM instruction that calls an external contract (our quoter) to price or approve a trade.
- **Epoch:** a fixed time window (e.g. one day) for the sell limit.
- **Net sold:** LAUNCH sold minus LAUNCH bought back.
- **Release curve:** the schedule by which sellable inventory unlocks over time.
- **TWAP:** time-weighted average price; harder to manipulate than the spot price.
- **Uniswap v4 hook:** a contract attached to a v4 pool that runs custom logic on swaps, used here to record TWAP observations.
- **Safe module:** a contract granted specific permissions to act on behalf of a Safe smart wallet.
- **Taker:** whoever trades against the strategy.