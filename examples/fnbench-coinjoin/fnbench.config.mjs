// fnbench example: the coinjoin getAccountInfo one-pass rewrite (9ae5eeea9b on top of 04caace736).
// The old address stats walked every transaction once per address (~ addresses · T · V² work),
// the new code walks the transactions once. It runs in the coinjoin backend's Electron utility
// process, which the page rig never sees, so it is measured here, function against function.
//
//   node <skill>/rig/fnbench.mjs --config=<skill>/examples/fnbench-coinjoin/fnbench.config.mjs --run=fnbench-coinjoin
//
// Measured 2026-10-17 (Apple M4, AC power, settled inputs): S 381 ms → 1.65 ms (235×), M 6.19 s →
// 3.64 ms (1693×), both called 6 v 6 at p 0.0022; A/A 0.996–1.000, 2x 1.93–2.00, the hybrid AU/A
// 0.997–0.998 (inside the A/A spread: the getAccountUtxo hunk alone changes nothing). L and XL run
// the new side only (8.1 ms, 53 ms); the model, fitted on S and 7.7 % low on M, puts the old side
// at ≥ 62 s and ≥ 63 min. ~13 min in all. Numbers and how to read them: references/fnbench.md.
import { makeInput, describe } from './data.mjs';

export default {
    name: 'coinjoin-getAccountInfo',
    revs: { A: '04caace736', B: '9ae5eeea9b' },
    variants: {
        A: { base: 'A' },
        B: { base: 'B' },
        // old getAccountInfo with the new getAccountUtxo: which hunk carries the win
        AU: { base: 'A', files: { 'packages/coinjoin/src/backend/getAccountUtxo.ts': 'B' } },
    },
    // what the bundle exports: the function under test and what the data module needs
    entry: {
        getAccountInfo: 'packages/coinjoin/src/backend/getAccountInfo.ts',
        CoinjoinAddressController: 'packages/coinjoin/src/backend/CoinjoinAddressController.ts',
        SEGWIT_XPUB: 'packages/coinjoin/src/__fixtures__/methods.fixture.ts',
        networks: '@trezor/utxo-lib',
    },
    // bcrypto (a native addon) is found on its own; golomb and loady locate it by path
    external: ['golomb', 'bcrypto', 'loady'],
    makeInput,
    describe,
    call: (mod, input) => mod.getAccountInfo(input),
    // T confirmed txs × V inputs+outputs each; receive + change prederived addresses
    sizes: {
        S: { shape: { T: 30, V: 100, receive: 40, change: 120 }, sessions: 6, rounds: 8 },
        M: { shape: { T: 60, V: 200, receive: 60, change: 240 }, sessions: 6, rounds: 4 },
        L: { shape: { T: 150, V: 300, receive: 80, change: 500 }, sessions: 4, rounds: 8 },
        XL: { shape: { T: 1000, V: 400, receive: 200, change: 2800 }, sessions: 4, rounds: 8 },
    },
    // minutes per size: M keeps 4 rounds; the old side at L (~1 min a call) and XL (~1 h) does not fit
    budgetMin: 10,
    // the old cost, fitted on S: checked against M, extrapolated to L and XL
    model: { variant: 'A', fit: ['S'], cost: ({ T, V, receive, change }) => (receive + change) * T * V ** 2 },
};
