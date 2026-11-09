// Pullback-confirmation strategy for the pump.fun bonding-curve replay.
//
// It retains the existing flow, age, liquidity, and price-extension filters, then requires a modest
// pullback and a rebound before entry. A buyer-share ceiling rejects signals dominated by one wallet.
//
// A position uses the inherited stop, trailing-stop and time exits, plus active sell-flow triggers.
// The strategy reads only replay batches and is deterministic: it uses no wall clock, randomness,
// network calls, or external data.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far inside one window. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's (acceleration). */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Minimum retreat from the entry-window high before a pullback entry is allowed. */
  pullbackMin: number;
  /** Maximum retreat from the entry-window high before the setup is considered weak. */
  pullbackMax: number;
  /** Lookback in slots for the pullback low used by the rebound confirmation. */
  reclaimWindow: number;
  /** Minimum rebound above the pullback low before an entry is allowed. */
  reclaimMin: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Keep adding to a position while the entry signal still holds, up to stakeSol. */
  pyramid: boolean;
  /** Hold on (no fade or trail exit) once the curve's real SOL passes this: completion is near. */
  rideRqSol: number;
  /** Longer lookback (slots) whose high the price must be near: a breakout, not a bounce. 0 = off. */
  breakoutWindow: number;
  /** Price now at least this share of the breakout window's high. */
  breakoutNear: number;
  /** Most SOL per buy order (the 1% reserve cap applies too). */
  maxChunkSol: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /**
   * Guardrail pacing: the run must end with at least 200 fills over at least 20 coins. When the
   * bot's own fills or coins lag targetFills / targetCoins scaled by the share of paceSecs elapsed
   * (block time since the first batch), it opens tiny probe round trips (buy probeSol, sell it all
   * as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Stop new entries and close held positions after this peak-to-trough equity drawdown. */
  maxDrawdown: number;
}

// Conservative candidate settings; these are a hypothesis to evaluate, not a claim of profitability.
export const DEFAULT_PARAMS: Params = {
  window: 30,
  minNetSol: 1.25,
  minBuys: 3,
  minBuyers: 5,
  minPriceUp: 0.05,
  maxPriceUp: 0.075,
  accel: 1,
  nearHigh: 0.95,
  pullbackMin: 0.005,
  pullbackMax: 0.05,
  reclaimWindow: 8,
  reclaimMin: 0.002,
  maxBuyerShare: 0.4,
  minRqSol: 2,
  maxRqSol: 60,
  minAge: 500,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.05,
  trail: 0.15,
  trailArm: 0.05,
  fadeWindow: 15,
  fadeNetSol: 0.25,
  bigSellSol: 2,
  maxHold: 1500,
  cooldown: 150,
  maxEntries: 1,
  pyramid: false,
  rideRqSol: 1000,
  breakoutWindow: 0,
  breakoutNear: 1,
  maxChunkSol: 1000,
  holdIfUp: 1000,
  initialSol: 0.01,
  addSol: 0.01,
  addStep: 0,
  addIfUp: -1,
  addNetSol: 0,
  maxMain: 1,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 0,
  maxExposureSol: 2,
  maxDrawdown: 0.1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

interface Signal {
  ok: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const entryAttempted = new Set<Pubkey>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  let peakEquitySol: number | null = null;
  let drawdownHalted = false;
  const keep = Math.max(p.window, p.fadeWindow, p.breakoutWindow, p.reclaimWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): Signal => {
    const no = { ok: false };
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return no;
    if (t.created === null || now - t.created < p.minAge) return no;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let reclaimLow = Number.POSITIVE_INFINITY;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else sellSol += tr.sol;
      if (tr.price > high) high = tr.price;
      if (tr.slot > now - p.reclaimWindow && tr.price < reclaimLow) reclaimLow = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return no;
    const net = buySol - sellSol;
    if (net < p.minNetSol) return no;
    if (startPrice <= 0) return no;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return no;
    if (last < high * p.nearHigh) return no;
    const pullback = 1 - last / high;
    if (pullback < p.pullbackMin || pullback > p.pullbackMax) return no;
    if (!Number.isFinite(reclaimLow) || last < reclaimLow * (1 + p.reclaimMin)) return no;
    if (netNew <= 0 || netNew < p.accel * netOld) return no;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return no;
    if (p.breakoutWindow > 0) {
      let longHigh = 0;
      for (const tr of t.trades) if (tr.slot > now - p.breakoutWindow && tr.price > longHigh) longHigh = tr.price;
      if (last < longHigh * p.breakoutNear) return no;
    }
    return { ok: true };
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      let equitySol = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.virtual_token_reserves <= 0n) continue;
        const mark = marks.get(mint);
        const vq = mark ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mark ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
        const grossValue = pos.token_amount * vq / (vt + pos.token_amount);
        const netValue = grossValue * 9_875n / 10_000n - BigInt(state.txFeeLamports());
        equitySol += Math.max(0, Number(netValue) / LAMPORTS);
      }
      if (peakEquitySol === null) {
        peakEquitySol = Math.max(Number(state.hello.capital.lamports) / LAMPORTS, equitySol);
      } else {
        peakEquitySol = Math.max(peakEquitySol, equitySol);
      }
      if (equitySol <= peakEquitySol * (1 - p.maxDrawdown)) drawdownHalted = true;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting || drawdownHalted;
        const t = tapeOf(mint);
        const riding = rqSol >= p.rideRqSol;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && !riding && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && !riding && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && !riding && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        if (pendingByMint.has(mint)) {
          const hasPendingOrder = [...state.pending.values()]
            .some(po => po.order.mint === mint);
          if (hasPendingOrder) continue;
        }
        if (orders.length >= cap) break;
        h.exiting = true;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (drawdownHalted) break;
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || entryAttempted.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol).ok) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Pyramid into strength only: the position is up, the price stepped up from the last
          // add, and net SOL still flows in.
          if (!p.pyramid || h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxChunkSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          entryAttempted.add(mint);
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (!drawdownHalted && probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
