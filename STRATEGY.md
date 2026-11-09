# Pullback-confirmation candidate

This is a deterministic `agent-fun/replay/v2` Pump.fun bonding-curve strategy. It reads only replay
events, marks, fills, and state. It makes no network calls and uses no wall-clock time or randomness.

## Selection and entry

- Ignore curves younger than 500 slots or outside the configured real-reserve range.
- Require recent buy volume, at least five distinct buying wallets, net SOL inflow of at least
  1.5 SOL, positive and accelerating newer-half flow, and a 5%-to-7.5% window price rise.
- Cap an individual wallet at 40% of observed buy volume.
- Require price to have retreated 0.5%-5% from the short-window high, then rebounded at least 0.2%
  from the low of the last eight slots before entering. This is intended to avoid buying directly
  into a local high; it may also miss uninterrupted breakouts.
- Use at most one entry per curve and one open position at a time, with a 0.01 SOL initial order.
  Orders are additionally constrained by the replay SDK's real-reserve cap and position limits.

## Exits and risk

- Keep the inherited 5% cost-based stop, 5%-armed/15% trailing stop, 1,500-slot maximum hold, and
  150-slot per-curve cooldown.
- Exit on net sell flow of at least 0.25 SOL over the 15-slot fade window or a single sell of at
  least 2 SOL. These thresholds are hypotheses, not calibrated guarantees.
- Do not use leverage or short selling. The official replay applies its own latency, curve fees,
  transaction fees, impact, and seeded transaction failures.
- Halt new entries and try to close holdings if marked portfolio equity falls 10% below its peak.
  Marked liquidation values use a conservative 1.25% curve-fee deduction and the replay's base plus
  priority transaction fee; execution remains subject to actual simulator costs and failures.

## Evaluation note

The candidate is for local dev-window evaluation only. The dev window is not the final window, and
passing local protocol or qualification checks does not establish profitable out-of-sample results.
