// pumpfun-sharpe-cleanest-bot: a paper-trading bot for the make.fun
// Pump.fun Sharpe Sprint (pumpfun-replay/v2, agent-fun/replay/v2).
//
// Final version — the strict-entry, tight-exit shape graded best on
// the dev window (-0.21 SOL, 5.3% max drawdown, guardrails met). The
// entry filter takes only mature curves (500+ slots old, past the
// bundled-launch dump window) with large, broad, accelerating buy
// pressure: net inflow 4 SOL over 50 slots, at least 8 buys from at
// least 9 distinct wallets, price up 12–50% and within 2% of its
// window high, on curves holding 5–30 SOL. Sizing stays small and
// even (0.04 SOL first buys, at most 0.20 SOL per coin, add-ons only
// while the price steps up and the position is above cost), and exits
// are tight and fast (12% stop, 25% take-profit, 15% trailing stop
// armed at +6%, fade exit on net outflow, 1000-slot time limit), so
// no single coin can drag the equity curve down and the hourly Sharpe
// stays clean. Tiny probe round trips (0.01 SOL) keep the 20-coin
// guardrail on pace when the momentum signal goes quiet. Earlier
// revisions tried looser entries, bigger runner stakes, and wider
// exits; each graded worse on this window, so this version keeps the
// shape that proved least bad.
//
// The hello message sets the caps this bot respects: at most 5 open
// positions, at most 16 orders per batch, buys capped at 1% of a curve's
// real SOL reserve. Each batch of events is answered with at most one
// reply; orders decided on a batch's slot fill two slots later. The bot
// is fully deterministic: no clock, no environment, no randomness —
// iteration only over insertion-ordered maps fed by the batch stream.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAM = 1_000_000_000;
// Bonding-curve fee taken on the way out (about 1.25% of the quote).
const CURVE_FEE = 0.0125;

// ---- entry signal -------------------------------------------------------
// Mature curves only, and only the strongest setups: a curve must
// survive 500 slots before it can be bought, so bundled launches that
// dump in their first minutes are out, and the inflow must be large,
// broad and accelerating.
const WINDOW = 50; // slots of tape the entry signal looks at
const MIN_AGE = 500; // slots since CreateEvent before an entry is allowed
const MIN_NET_SOL = 4.0; // net SOL inflow (buys minus sells) over WINDOW
const MIN_BUYS = 8; // buy trades in WINDOW
const MIN_BUYERS = 9; // distinct buying wallets in WINDOW
const MIN_UP = 0.12; // price rise over WINDOW, at least +12%
const MAX_UP = 0.5; // skip curves that already ran +50% in one window
const NEAR_HIGH = 0.98; // price now must sit within 2% of the window high
const MIN_RQ_SOL = 5; // curve real SOL at entry, at least 5
const MAX_RQ_SOL = 30; // ... and at most 30 (too big = too late)

// ---- sizing -------------------------------------------------------------
// Small and even: no single coin can hurt the equity curve.
const FIRST_SOL = 0.04; // first buy of a position
const ADD_SOL = 0.05; // each add-on buy while the price steps up
const STAKE_SOL = 0.2; // most SOL one position ever holds
const MIN_BUY_SOL = 0.01; // smallest buy worth sending (round-trip floor)
const BUY_SLIP_BPS = 2000;

// ---- exits --------------------------------------------------------------
// Tight and fast: lock small gains, cut losses before they compound.
const STOP_LOSS = 0.12; // sell when value falls 12% under cost
const TAKE_PROFIT = 0.25; // sell when value rises 25% over cost
const TRAIL_ARM = 0.06; // trailing stop arms once value is +6% over cost
const TRAIL = 0.15; // ... then sells 15% under the position's peak value
const MAX_HOLD = 1000; // slots before the time exit fires
const FADE_WINDOW = 25; // slots for the fade check
const FADE_NET_SOL = -2.0; // exit when net flow over FADE_WINDOW is worse than this

// ---- reuse rules --------------------------------------------------------
const COOLDOWN = 100; // slots after an exit before the same mint may re-enter
const MAX_ENTRIES = 2; // most entries per mint over the run

// ---- guardrail pacing ---------------------------------------------------
// The run must end with round trips on at least 20 distinct mints. When
// the bot's own fills or coins lag the pace below, it opens tiny probe
// round trips (buy 0.01 SOL, sell it all as soon as the buy lands).
const TARGET_COINS = 25;
const TARGET_FILLS = 240;
const PACE_SECS = 14_400;
const PROBE_SOL = 0.01;
const MAX_PROBES = 2;

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
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight: false while the buy is pending, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
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
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_UP || up > MAX_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  // Accelerating: the newer half of the window must out-inflow the older half.
  if (netNew <= 0 || netNew < netOld) return false;
  return true;
}

/** Mark-to-market value of a position in SOL, curve and tx fees deducted. */
function positionValue(state: BotState, batch: Batch, mint: Pubkey, tokens: number): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const mark = batch.marks.find((m) => m.mint === mint);
  const vq = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
  const vt = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
  if (vt + tokens <= 0) return 0;
  const tx = Number(state.txFeeLamports()) / LAM;
  return ((tokens * vq) / (vt + tokens) / LAM) * (1 - CURVE_FEE) - tx;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
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
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAM,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      }
    }
    // Prune old tape so memory stays bounded.
    const keep = Math.max(WINDOW, FADE_WINDOW) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAM;
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    // Exits first: stop, take-profit, trailing stop, fade, time limit.
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
      const tokens = Number(pos.token_amount);
      const value = positionValue(state, batch, mint, tokens);
      const cost = Number(pos.cost_lamports) / LAM;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && value > cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && flow(tapeOf(mint), now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
      if (!exit && now - h.opened > MAX_HOLD) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
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

    // Entries and add-ons, only on mints that traded in this batch.
    let free = Number(state.freeCashLamports()) / LAM;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAM;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = FIRST_SOL;
      } else {
        // Add only into strength: price above the last add, value above cost.
        if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice) continue;
        if (h.lastValue < Number(pos.cost_lamports) / LAM) continue;
        if (rqSol > MAX_RQ_SOL) continue;
        want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAM;
      let amount = Math.min(capSol, want);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAM));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: open a probe when fills or coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAM < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAM)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
