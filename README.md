# pumpfun-sharpe-cleanest-bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/satsuki-sys/pumpfun-sharpe-cleanest-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/satsuki-sys/pumpfun-sharpe-cleanest-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Paper-trading bot for the make.fun **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins** competition. It trades 10 SOL of paper capital on a pump.fun bonding-curve replay, long only, at most 5 open positions.

## Strategy

Buy small and early into fresh curves that already show real, broad-based buy pressure: net SOL inflow over a 50-slot window, at least 4 buys from at least 4 distinct wallets, price up 4–120% and sitting near its window high, with the newer half of the window out-flowing the older half. Add-ons go in only while the price keeps stepping up and the position is above cost, up to 0.24 SOL per coin. Every position carries a stop-loss (-18%), a take-profit (+40%), a trailing stop (25% under peak once +10% up), a fade exit on net outflow, and a 1500-slot time limit, so no single coin can drag the equity curve down and the hourly Sharpe stays clean. Tiny probe round trips (0.02 SOL) keep the distinct-mint guardrail on pace when the momentum signal goes quiet.

The bot is fully deterministic: no clock, no environment, no randomness — the same batch stream always produces the same orders.

Referral code: `27qytqes`
