// Synthetic coinjoin account for getAccountInfo: real regtest segwit addresses (derived once with the
// bundle's own CoinjoinAddressController, cached in fnbench's cache dir) and wide `joint` transactions
// where most inputs/outputs are foreign and a few are owned. Deterministic: one shape, one input.
import fs from 'node:fs';
import path from 'node:path';

const rng = seed => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;

    return seed / 2 ** 32;
};

const prederive = (mod, cacheDir, receiveCount, changeCount) => {
    const file = path.join(cacheDir, `coinjoin-addresses-${receiveCount}-${changeCount}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const ctl = new mod.CoinjoinAddressController(mod.SEGWIT_XPUB, mod.networks.regtest, {
        blockHash: 'x',
        blockHeight: 1,
        receiveCount,
        changeCount,
    });
    const strip = list => list.map(({ address, path: p }) => ({ address, path: p }));
    const out = { receive: strip(ctl.receive), change: strip(ctl.change) };
    fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(out));
    fs.renameSync(`${file}.${process.pid}`, file);

    return out;
};

// shape: T confirmed txs, V inputs+outputs per tx, receive/change address counts
export const makeInput = ({ T, V, receive: receiveCount, change: changeCount }, { mod, cacheDir }) => {
    const cache = prederive(mod, cacheDir, receiveCount, changeCount);
    const rand = rng(T * 7919 + V);
    let foreign = 0;
    const foreignAddress = () => `bcrt1qforeign${(foreign++).toString(36).padStart(28, '0')}`;
    const vv = (n, address, value, owned, extra = {}) => ({
        n,
        addresses: [address],
        isAddress: true,
        isAccountOwned: owned || undefined,
        value: String(value),
        ...extra,
    });

    const unspent = []; // owned outputs not yet spent: { txid, vout, value, address }
    const txs = [];
    for (let t = 0; t < T; t++) {
        const txid = t.toString(16).padStart(64, '0');
        const nIn = V / 2;
        const nOut = V - nIn;
        const vin = [];
        const vout = [];
        // 1–2 owned inputs spending earlier owned outputs (the first round comes from a receive address)
        const ownedIn = Math.min(unspent.length, 1 + Math.floor(rand() * 2));
        let sent = 0;
        for (let i = 0; i < ownedIn; i++) {
            const u = unspent.splice(Math.floor(rand() * unspent.length), 1)[0];
            sent += u.value;
            vin.push(vv(vin.length, u.address, u.value, true, { txid: u.txid, vout: u.vout }));
        }
        if (!ownedIn) {
            const a = cache.receive[t % cache.receive.length].address;
            vin.push(vv(0, foreignAddress(), 500000, false, { txid: 'f'.repeat(64), vout: t }));
            vout.push(vv(0, a, 400000, true));
            unspent.push({ txid, vout: 0, value: 400000, address: a });
        }
        while (vin.length < nIn) {
            const value = 100000 + Math.floor(rand() * 900000);
            vin.push(vv(vin.length, foreignAddress(), value, false, { txid: 'e'.repeat(64), vout: vin.length }));
        }
        // 2–4 owned outputs to change addresses (cycled), the rest foreign
        const ownedOut = 2 + Math.floor(rand() * 3);
        let received = 0;
        for (let i = 0; i < ownedOut; i++) {
            const a = cache.change[(t * 4 + i) % cache.change.length].address;
            const value = 50000 + Math.floor(rand() * 200000);
            received += value;
            unspent.push({ txid, vout: vout.length, value, address: a });
            vout.push(vv(vout.length, a, value, true));
        }
        while (vout.length < nOut) {
            vout.push(vv(vout.length, foreignAddress(), 50000 + Math.floor(rand() * 200000), false));
        }
        txs.push({
            type: 'joint',
            txid,
            blockHeight: t + 1,
            blockTime: 1700000000 + t * 600,
            amount: String(received - sent),
            fee: '0',
            targets: [],
            tokens: [],
            internalTransfers: [],
            details: { vin, vout, size: V * 60, totalInput: '0', totalOutput: '0' },
        });
    }

    return {
        descriptor: mod.SEGWIT_XPUB,
        transactions: txs,
        network: mod.networks.regtest,
        checkpoint: { blockHash: 'x', blockHeight: T, receiveCount, changeCount },
        cache: { receivePrederived: cache.receive, changePrederived: cache.change },
    };
};

// what the table prints next to the shape (from the reference variant's output)
export const describe = (input, output) => ({
    addresses: input.cache.receivePrederived.length + input.cache.changePrederived.length,
    used: output.addresses.used.length,
    utxo: output.utxo.length,
});
