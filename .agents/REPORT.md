# Is "Mandate" (a self-custodial replacement for market-maker token-loan deals on 1inch Aqua + Uniswap v4) worth building at ETHGlobal Mumbai?

Yes, build the primary idea, but with a sharper scope than the current pitch. I found no prior hackathon project, 1inch incubator team or live product that puts a launch treasury's market-maker deal on Aqua/SwapVM with per-epoch net-sell caps, vesting-style release and a v4 TWAP anchor. The problem is real and well documented. The mechanics fit Aqua and SwapVM well. The two weak spots you must fix: (1) the MOVE dump happened on Binance, and an onchain strategy cannot stop a CEX dump, so the demo has to be framed honestly; and (2) the pattern of an Extruction quoter with a stateful cap and a v4-anchored price guard has already won (Wamia's spend limit, VexiHakari's v4 anchor). Your edge therefore has to come from the *application*, meaning the treasury/MM mandate and its economics, not from new primitives. The LST exit-queue fallback is weak: RateSpace (Tokyo 2026) and Wamia already cover the space, so skip it.

## TL;DR
- **Primary idea: BUILD (about 7.5/10 overall).** It is unique as an application, the problem is real (MOVE: 66M tokens sold the day after listing, 38M USDT frozen by Binance; Gotbit founder jailed; FBI NexFundAI sting), and it fits Aqua's maker-owned-balance model natively. Pitch it as "onchain-first launches and treasury-run market making," not "this would have stopped MOVE."
- **Prior art:** no exact match on ETHGlobal, Devpost, Dorahacks or the 1inch Aqua Revenue Stream Incubator. The nearest are Steer Finance (incubator, launch "market cultivation" ALM with no sell caps), LiquidLaunch (v4 launchpad), and v4 launch hooks with anti-whale limits or drip auto-sells. The building blocks have won before (Wamia per-block spend cap via Extruction; VexiHakari v4 anchor), so judges will reward the treasury-mandate framing and a real onchain fork replay, not the opcodes themselves.
- **Next ~20 hours:** Safe-as-maker on a mainnet/Base fork, one Extruction quoter (NetSellCap + ReleaseCurve + PriceFloor + v4 TWAP anchor), a ~150-line Safe "MandateModule" that lets the MM only dock/re-ship within bounds, MM pay via a fee instruction, and a two-act demo: a scripted MOVE-sized counterfactual plus a fork replay of a real Uniswap dump. Drop the LST idea.

## Key Findings

### 1. Prior art / duplication check

**Close matches and adjacent projects**

| Project | Event / venue | What it does | Won? | How Mandate differs |
|---|---|---|---|---|
| Wamia (ethglobal.com/showcase/wamia-z11ah) | ETHGlobal Tokyo 2026 | Pendle PT backstop. A single Extruction instruction points at a stateless WamiaQuoter; optional WamiaRateGuard and **WamiaSpendLimit (per-block spend cap)**; fork replay of the Aug 25, 2026 attack | 1inch Aqua 2nd | Same *technique* (Extruction quoter + spend cap); different problem (issuer treasury selling its own token under an MM mandate). You must not present "stateful cap via Extruction" as novel |
| VexiHakari (ethglobal.com/showcase/vexihakari-y7trp) | Tokyo 2026 | Options vault as Aqua maker; ExposureGuard/DeltaSkew instructions; UniswapAnchoredPricer refuses to quote if spot is >3% from the v4 pool; HAKARI TWAP oracle hook; fork-proven manipulation attack | 1inch Continuity 1st + Uniswap Best Stack 1st | Your v4 TWAP anchor is the same pattern. Reuse the idea, credit it, and key it to launch-token manipulation instead |
| Steer Finance | 1inch Aqua Revenue Stream Incubator (approved) | ALM vaults on Aqua; programmes include "chain launches and spot-market growth, asset issuance and market cultivation"; "manages capital it does not supply" | Incubator-funded | Closest commercial overlap, but no sell caps, vesting release or MM mandate described. Mandate is issuer-self-custodial |
| LiquidLaunch (ethglobal.com/showcase/liquidlaunch-bvt5i) | ETHGlobal (v4 era) | v4-hook launchpad with a multi-stage token sale; vesting only listed as future work | Not shown | Primary-sale tooling, not post-listing treasury/MM inventory control |
| LaunchTokenV4 / V4LaunchHook (Uniswap hooklist PRs #6904, #7467) | Mainnet hooks (not hackathon) | Buy/sell taxes; anti-whale wallet/tx limits during a block window; V4LaunchHook **auto-sells a marketing reserve on a drip schedule** | n/a | Limits apply to all traders or force-sell a reserve; none bounds a hired MM's discretion over issuer inventory |
| RateSpace (github.com/AaronTan11/ratespace) | Tokyo 2026 | One ETH balance as exit/entry liquidity for wstETH, rETH, weETH at each token's onchain rate, on Aqua | Not shown | Direct prior art for the **LST fallback** |
| Brick Finance, Iceberg, AegisNet, Jev Market Factory, AquaVol, Aqua Outcome Market, Aqua0, Solvent | Tokyo 2026 / ETHOnline 2026 / Buenos Aires 2025 | Floor-bid v4 hook (Brick), partially active Aqua+v4 AMM (Iceberg), prediction markets, options, cross-chain shared liquidity | Some won (below) | Different problems; shows the Aqua+v4 combo is crowded |
| Mumbai 2026 competitors seen on GitHub: Tremor, TRACE, Autonomous Working Capital | ETHGlobal Mumbai (now) | Tremor: v4 hook fee buys variance cover from an Aqua strategy via a new opcode 0x22; TRACE: infers LP strategies and ships them to Aqua (taker blocked by KycNFT); AWC: lender strategies on Aqua via an Arc fork | In progress | None touches launch/MM deals. Expect Tremor to compete for both 1inch and Uniswap |

A subagent searched the 1inch DAO forum (incubator assessment report, Sept 24, 2026), the ETHGlobal showcase, Devpost and Dorahacks with launch/MM/vesting/sell-cap queries and found **no project that implements an MM mandate or vesting/per-epoch sell caps for a launch treasury on Aqua/SwapVM or v4 hooks**. The incubator assessment approved four teams (Aqua0, Bleu, Steer Finance, 1delta) from a $436K budget approved March 8, 2026 (up to $50K per team). It notes the approvals do not duplicate the core team's working list of curves and fee mechanisms. A launch-treasury strategy fills an open slot there.

**What judges have rewarded (2025–2026)**

| Event | 1inch Aqua track | Uniswap track |
|---|---|---|
| Tokyo 2026 | OddsFlow 1st; Wamia 2nd; watermark 3rd; Continuity: VexiHakari 1st, Takarabako 2nd | VexiHakari Best Uniswap Stack 1st |
| ETHOnline 2026 | Solvent ("the sum 1inch Aqua never computes and never over commits") placed | — |
| Lisbon 2026 | Pool Party Continuity 1st | Pool Party Best Uniswap Stack (Continuity) 1st |
| HackMoney 2026 | — | Uniforum: Uniswap v4 Agentic Finance 3rd |
| Buenos Aires 2025 | Aqua0 4th (+ finalist); Aqua Outcome Market listed as "Build an Aqua App 1st place" (pm-AMM invariant) | — |

The pattern: winners pair (a) a precise real-world failure (a dated attack, a named loss) with (b) a custom SwapVM instruction or Extruction quoter on the *official deployed* router, (c) fork tests against real contracts with numbers, and (d) for the double wins, a genuine v4 hook rather than a token v4 read. Saturated themes: prediction markets, options, shared-liquidity/cross-chain, LST rate-pegged swaps, oracle-guarded AMMs.

### 2. Existing products / competitors
- **Uniswap Continuous Clearing Auction (CCA):** handles *primary* price discovery and liquidity bootstrapping. Aztec raised $59M (19,388 ETH from 16,741 participants, 14.95% of supply, $557M FDV) and seeded $26M of v4 liquidity; Uniswap has since shipped a no-code auction tool. CCA ends where Mandate begins: once the pool exists, who supplies inventory and under what limits. Pitch Mandate as "post-CCA treasury market making."
- **Doppler, Balancer/Fjord LBPs, Flaunch, Zora/Clanker hooks:** launch-time price discovery and fee mechanics for the token's first pool. None constrains a third-party MM's discretion over issuer inventory. Different layer; complementary.
- **Arrakis / Bunni / Gamma / Steer (managed or protocol-owned liquidity):** the closest category. The issuer deposits into a vault and a manager rebalances. Mandate's difference is that tokens never leave the issuer Safe (Aqua virtual balances), the MM's powers are coded in the module plus quoter, and sell limits are time-based and net of buybacks. Steer's presence in the 1inch incubator is both validation and competition. Say so in the pitch.
- **Disclosure efforts (Blockworks Token Transparency, Binance MM rules):** Blockworks' framework requires the MM name, loaned amount as % of supply, term and structure. Ethena's filing lists four "token loan with call option" deals of 6M–20M ENA, each 12 months. Mandate turns disclosure into enforcement: the terms *are* the onchain program.
- **Vesting tooling (Sablier, Hedgey, Streamflow):** controls when tokens *unlock* to a holder, not how unlocked inventory is *sold*. ReleaseCurve is "Sablier for sell-side inventory," which is a clean one-line pitch.
- **LST exit liquidity (Lido withdrawal NFTs, Pendle, Curve stETH/ETH, RateSpace):** already crowded; see the LST verdict.

### 3. Problem reality and size
- **MOVE / Web3Port / Rentech:** Binance's March 25, 2025 announcement said that on Dec 10, 2024, a day after listing, the MOVE market maker sold "approximately 66 million MOVE tokens" with "little buy orders," netted 38 million USDT, was offboarded on March 18, and had the profits frozen; Wu Blockchain named the market maker as Web3Port. Movement committed the funds to a buyback. A CoinDesk-reported deal routed the tokens via Rentech; the co-founder was suspended; MVMT Labs later filed a Subchapter V Chapter 11 petition in Delaware on July 15, 2026, with MOVE down "more than 94% over the past year to roughly $0.01" (Cointelegraph). The dump was on a CEX, so it is a motivating story, not a replayable onchain event.
- **Typical terms:** issuers lend tokens to the MM and grant a call option. Wu Blockchain's "Inside the Black Box of Market Maker Token Loans" says loans are "usually equivalent to 1% to 5% of the circulating supply," while Fabric Ventures cites "1–3% of the circulating supply as a loan" on a "6–12 month term." A Berkeley RDI lecture explains the MM's "structural bias toward selling," since losses are capped by the option while downside profits are not.
- **Enforcement:** the FBI's NexFundAI sting ("Operation Token Mirrors," Oct 9, 2024) charged 18 individuals and entities, including market makers ZM Quant, CLS Global, MyTrade and Gotbit; per the DOJ/IRS-CI release, "more than $25 million in cryptocurrency has been seized" and wash-trading bots covering about 60 tokens were deactivated. Gotbit founder Aleksei Andriunin was sentenced in June 2025 by Judge Angel Kelley (D. Mass.) to "eight months in prison, to be followed by one year of supervised release"; Gotbit was ordered to forfeit about $23 million in seized cryptocurrency and given five years' probation, "during which time Gotbit shall cease to exist or operate" (US Attorney's Office).
- **Momentum:** a June 10, 2026 Newsweek op-ed by Shane Molidor argued for mandatory MM-term disclosure, and coverage explicitly suggests "bringing loan details on-chain." That is your thesis, quoted back to the judges.
- **Onchain-native versions you can replay on a fork:**
  1. **AXIS (Axis Robotics), Oct 2026, Base.** ZachXBT says insiders got "over 76 million tokens, worth over $12 million, from a team wallet," and one suspected insider sold 42M AXIS for more than $5.04M USDC across eight wallets on DEXs. The price fell about 40% on Oct 29, and Axis blames a "trading partner." This is the best narrative fit (a partner allocation dumped onchain). Wallet addresses are in ZachXBT's Telegram post, and the DEX venue (Uniswap vs Aerodrome) is unconfirmed: spend at most 45 minutes retrieving them.
  2. **FUN on Uniswap v2, Oct 30, 2026 (CoinDesk).** Address 0x06ea…685f made 150+ sales into FUN/WETH, selling 134.1M FUN for 111.5 ETH and crashing the price more than 90%. The seller was a hacker, not an MM, but the mechanics are clean and fully on Ethereum: ideal for showing what a NetSellCap plus TWAP anchor would have bounded.
  3. **LAB, July 2026** (18.4M tokens, about $18.3M, −56%) went through Aster on BNB Chain, so it is weak for a Uniswap replay. Cite it as context only.
- **LST data:** in July 2025 the validator exit queue hit a record and stETH slipped about 0.3%–0.6% below par (The Block). In Oct 2026 the MetaMask incident pushed the queue to about 850K ETH, and Lido estimated about 45 days for full exit and re-entry. Discounts stay in the sub-1% range outside 2022-style crises, so there is little edge to demo.

### 4. Technical feasibility on Aqua/SwapVM
- **Safe as maker: yes.** Aqua records virtual balances per maker address and pulls tokens only on fill. Contract makers are proven: VexiHakari's AquaVault "own address is the Aqua maker," Aqua0's AquaAdapter is maker, and a Kernel smart account ships directly "authorised through Aqua, so the passkey never signs typed data." A Safe calls `ship`/`dock` via a normal Safe tx or `execTransactionFromModule`. Strategies are immutable by hash, so "tuning" means dock plus re-ship, which is exactly the surface your module bounds.
- **Opcodes:** the deployed AquaSwapVMRouter carries Controls, XYCSwap, XYCConcentrate, Decay, Fee, PeggedSwap and Extruction. LimitSwap, oracle adjusters and the `InvalidateTokenOut` cumulative-fill cap live on the Limit router, not the Aqua router (Jev Market Factory hit this limit). So **all custom logic goes in one Extruction target**, or a redeployed modified router, which the Mumbai rules allow.
- **Stateful per-epoch caps: yes.** Extruction calls `IStaticExtruction.extruction` (view) when quoting and `IExtruction.extruction` (state-modifying) when swapping, and returns updated registers. Write `soldThisEpoch` only in the swap path. Pitfalls: (a) OpenZeppelin's audit flags quote/swap consistency as a medium-severity risk, so keep both paths reading identical state; (b) the target must be non-upgradeable; (c) **gate the state-writing path to `msg.sender == AquaSwapVMRouter` and key state by orderHash/maker**, or anyone can burn the cap and grief the treasury. Wamia's per-block spend cap shows this works on the deployed router.
- **ReleaseCurve / PriceFloor: trivial.** `released = total × min(1, (t − start)/duration)` from `block.timestamp`, deterministic within a block. The floor reverts if amountOut/amountIn falls below the floor. Aqua's shipped virtual balance is already a hard lifetime ceiling; your instructions add the time and price dimensions.
- **Reading v4: yes, with work.** Spot via v4-core `StateLibrary` on the PoolManager (VexiHakari did this). v4 has no native TWAP, so deploy a pool with an oracle hook (OpenZeppelin uniswap-hooks `BaseOracleHook`) on your fork. That also gives you a real hook for the Uniswap prize.
- **Taker gating:** at launch every dApp strategy carries `_onlyTxOriginTokenBalanceNonZero`, and permitted takers are KYB-verified 1inch Resolvers holding a KycNFT. TRACE (Mumbai) is blocked on this live. **Demo on a fork**, where you can impersonate or mint the credential. In the pitch, turn it into a feature: only verified counterparties can hit the treasury's quotes.
- **Chains:** per 1inch's July 28, 2026 press release, Aqua went live "across 13 EVM chains from day one," including Ethereum, Arbitrum, Base, Robinhood Chain and BNB Chain, after eight independent audits.
- **MM compensation (the piece most pitches miss):** without a call option, why would an MM sign? Use a Fee instruction (or a fee leg inside the quoter) that routes a spread/fee share to the MM address, plus an optional performance kicker paid from the Safe when depth/uptime KPIs are met. Without this, judges with MM backgrounds will call it a toy.
- **24–30 hour estimate:** the core is feasible for 2–3 strong Solidity devs. Quoter about 4–6h, Safe module about 3–4h, v4 oracle-hook pool on fork about 3–4h, fork scripts/replay about 4–6h, minimal UI/dashboard about 3–4h. Submissions close **Nov 7, 2026 at 09:00 IST**, so you really have about 20 hours; cut the UI to a single evidence page.

### 5. Judge appeal and verdict

**Primary idea: Mandate**

| Criterion | Score | Reason |
|---|---|---|
| Uniqueness | 8/10 | No application-level prior art; primitives overlap with Wamia/VexiHakari |
| Real-problem strength | 9/10 | DOJ cases, Binance action, disclosure push, named numbers |
| Technical fit | 8/10 | Maker-owned balances plus bounded re-ship are what Aqua is for; Extruction handles state |
| Demo-ability | 7/10 | Strong if paired with a real onchain fork replay; weaker if only the CEX-based MOVE story |
| Risk | Medium | CEX-dump framing, MM-economics gap, KycNFT gating live, tight clock |

**LST exit-queue idea:** uniqueness 3/10 (RateSpace, Wamia genre), problem 5/10 (discounts usually 0.3%–0.6%), fit 7/10, demo 5/10. **Do not build.**

**Sharpened variants (pick one framing)**
1. **"Mandate: the market-maker deal as an onchain program" (recommended).** The issuer Safe is maker; the MM gets a module role that can only dock/re-ship strategies whose Extruction target and parameters sit inside issuer bounds (max epoch sell, release schedule, floor, max TWAP deviation, fee split). The v4 oracle hook pool doubles as the public "disclosure surface": anyone can read remaining releasable inventory and the epoch counter. This is Blockworks-style disclosure that cannot be violated.
2. **"Unlock Desk": investor/team unlock selling under a ReleaseCurve.** The same engine, aimed at cliff unlocks (the moment most onchain dumps happen) rather than MM loans. Vested holders ship to Aqua through the capped quoter instead of market-selling. This variant is the fallback if MM-economics questions dominate feedback. No prior art found beyond Sablier-style unlocking and drip-sell hooks.

## Recommendations: build scope and demo plan (next ~20 hours)

**Must-have (in order)**
1. Fork Ethereum mainnet (or Base, if AXIS addresses are retrieved) with canonical Aqua and AquaSwapVMRouter. Deploy a mock LAUNCH token and a Safe holding 5% of supply plus USDC.
2. `MandateQuoter` (Extruction target): XYC-style pricing over Aqua balances; NetSellCap per epoch, net of buys that push inventory back; ReleaseCurve; PriceFloor; v4 TWAP deviation check; router-only write path; quote == swap tests.
3. v4 LAUNCH/USDC pool with an oracle hook (BaseOracleHook), seeded on the fork.
4. `MandateModule` for Safe: the MM address may call only `dock` and `ship` with a whitelisted quoter, params within bounds, and Aqua balances ≤ the mandate allotment; issuer can revoke instantly.
5. MM fee leg to the MM address.
6. Foundry fork tests with printed numbers, git commits throughout (the rule requires proper history).

**Demo (3–4 minutes, real onchain token transfers on the fork)**
- **Act 1, the counterfactual (about 60s):** "MOVE-sized deal": an MM tries to sell an allotment equal to 66M-token scale in one day. The quoter fills only the epoch cap, then reverts `EpochCapReached`. Show the cap math versus the 66M / 38M USDT outcome. State clearly that MOVE's dump was on Binance and this is a model, not a replay.
- **Act 2, the onchain replay (about 90s):** replay the FUN Uniswap v2 sell sequence (or AXIS if addresses are found) through a pool where the treasury quotes via Mandate. Show (a) the treasury cannot be the dumper beyond the curve, and (b) when the attacker pumps the v4 pool first, the TWAP anchor refuses to quote, so the treasury is not used as exit liquidity at a manipulated price.
- **Act 3, the MM (about 45s):** the MM re-ships with a tighter spread (allowed), then tries to raise the epoch cap (module reverts), then earns fee share on real fills.
- Close with: "The deal terms are the program; disclosure is the contract."

## Caveats
- The Uniswap Foundation shows **$15,000** on the Mumbai prize page versus the $10,000 you cited; check its exact track wording before submitting.
- Some winner placements (OddsFlow, Solvent's exact place, Aqua Outcome Market's event) come from secondary listings and GitHub READMEs, not the ETHGlobal prize pages themselves.
- AXIS, LAB and FUN details come from crypto-media reports of ZachXBT/Lookonchain/CoinDesk; tx hashes were not retrieved. Verify on Etherscan/Basescan before you put any number on a slide.
- Mandate cannot constrain CEX activity. Its real addressable market is DEX-first launches and treasuries that market-make onchain, so position it that way.
- Steer Finance is incubator-funded in an adjacent space, and 1inch's core team keeps its own working list of mechanisms. Frame Mandate as a strategy that issuers or Steer-like managers could adopt, not a competitor to them.