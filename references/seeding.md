# Driving Suite into an account state without a device

Suite web can be put into any wallet state from the page itself. This is not a hack around a
missing emulator — it is strictly better for profiling, because the state is byte-identical on both
branches, arbitrary in size, and takes a second rather than a discovery cycle.

`examples/history-load/page.js` and `examples/account-switch/page.js` implement everything here
for the rig (the older `assets/adapters/suite-web.js` for the MCP-only harness). Read this file when
you need to extend a seed — more networks, transactions, a different device model — or when seeding
fails and you need to know which gate you tripped.

Rig specifics, measured 2026-10:

- `window.__H.store()` finds the store on both targets: `window.store` (web with `window.Playwright`,
  desktop with the `--expose-store` switch the rig passes), else the react-redux Provider in the
  React tree. Desktop has no `window.TrezorConnect`: `__H.connect()` returns the bundle's
  `@trezor/connect-electron` object, whose methods can be replaced like web's.
- Stored transactions go into the same payload: `txs: [{ tx: { ...connectTx, descriptor, symbol,
  deviceState }, order }]` (`storageLoadTransactions` in `packages/suite/src/support/extraDependencies.ts`
  groups them by account key, `order` is the index).
- Missing payload keys make the seed no-op silently — see "Seeding and the app" in pitfalls.md.
- Seed from `__A.seed()`, which the runner calls as soon as the store exists, before Suite finishes
  init; `__A.isReady()` (default `__H.suiteReady()`) then waits for lifecycle ready.

## The seam

`suite/web-app/src/support/usePlaywright.ts`:

```ts
export const usePlaywright = () => {
    const store = useStore();
    useEffect(() => {
        if (typeof window !== 'undefined' && window.Playwright) {
            window.store = store;
            window.TrezorConnect = TrezorConnect;
            ...
```

Set `window.Playwright = true` from an **init script** so it is true before that effect runs. Do it
from `evaluate_script` after load and the effect has already been skipped — `window.store` will
never appear and there is no second chance short of reloading.

`window.store` is the real Redux store, so `dispatch` and `getState` are both available.

## The two dispatches

### 1. `@storage/load` — devices, accounts, settings

At boot, `preloadStore()` (`packages/suite/src/support/suite/preloadStore.ts`) reads IndexedDB and
returns a `@storage/load` action; `initStore` runs it through the root reducer to build the
preloaded state. Every slice therefore already has a handler for it — see the `storageLoad*`
reducers in `packages/suite/src/support/extraDependencies.ts`. Dispatching the same action at
runtime re-runs all of them, which is why one dispatch can install a whole wallet.

The payload must carry every key `preloadStore` reads, or a slice reducer will throw:

- Read with `getItemsExtended` / `getItemsWithKeys` → must be an **array** (`devices`, `accounts`,
  `txs`, `graph`, `tradingTrades`, `coinjoinAccounts`, `explorer`, `historicRates`, `phishing`,
  `backendSettings`, `sendFormDrafts`, `receive`, `formDrafts`, `tokenManagement`,
  `suiteSyncOwners`).
- Read with `getItemByPK` → may be `undefined` (`suiteSettings`, `walletSettings`, `analytics`,
  `metadata`, `messageSystem`, `thp`, `bluetooth`, `phishingMetadata`, `coinjoinDebugSettings`,
  `persistentDeviceData`, `connect`, `bioAuth`, `firmware`, `suiteSync*`, `featureFeedback`,
  `discreetMode`, `debug`).

If Suite adds a store, `preloadStore.ts` is the list to re-derive this from.

### 2. `@suite/device/updateSelectedDevice` — the selected device

`selectedDevice` is deliberately **not** restored from storage; it is set when a device connects.
`@storage/load` fills `state.device.devices` but leaves `selectedDevice` undefined, and the sidebar
renders nothing without it.

`updateSelectedDevice` is the right action rather than `selectDevice`, because `selectDevice` also
runs `updateTimestamp`, which looks the device up in `state.devices` by instance.

## Gates you have to clear

Miss one of these and the app renders something other than the wallet, usually with no error:

| Gate | What clears it | Symptom if missed |
| --- | --- | --- |
| Onboarding | `suiteSettings.flags.initialRun = false` | App redirects to `/start` |
| Analytics consent | `analytics.confirmed = true` | Consent screen instead of the app |
| Device selected | `updateSelectedDevice` | Wallet layout renders empty |

## The selector chain accounts must survive

`selectAllAccountsToList` (`suite-common/wallet-core/src/selectors.ts`) is the gate for the sidebar.
An account is listed only if **all** of these hold:

1. `visible: true` and `deviceState` equal to the selected device's `state.staticSessionId`
   (`selectVisibleDeviceAccounts`).
2. Its `symbol` is in `walletSettings.enabledNetworks`.
3. Its `symbol` is supported by the device — derived from `device.features`, so give the device a
   full `capabilities` array and an empty `unavailableCapabilities`.

If accounts land in `state.wallet.accounts` but the sidebar stays empty, it is almost always (2) or
(3).

## Account shape

The type is `Account` in `suite-common/wallet-types/src/account.ts`. The constraint that bites:

```ts
key = `${descriptor}-${symbol}-${deviceState}`
```

`createAccountKey` throws if **any** of the three parts contains a dash, since the dash is the
separator. Keep descriptors alphanumeric. `deviceState` follows the real format
`<address>@<device_id>:<instance>`, e.g. `1stTestnetAddress@device_id:0` — no dash there either.

Network-specific fields matter: `networkType: 'ethereum'` needs `misc: { nonce }`, `'bitcoin'` takes
`misc: undefined`, and `'stellar'` uses `stellarCursor` with `page: undefined`.

## Narrower actions

Useful when you want to change accounts without touching other slices:

- `@common/wallet-core/accounts/createAccount` — payload is one full `Account` (dispatching the
  plain object bypasses the action creator's `prepare`, which expects `accountInfo`).
- `@common/wallet-core/accounts/removeAccount` — payload is an `Account[]`, so one dispatch clears
  the list.

Be careful with these in a measured window: Suite reads the store through `useSyncExternalStore`, so
a store change from outside React renders **synchronously, once per dispatch**. Sixty
`createAccount` dispatches produce roughly 39 commits and an incrementally-built list. For anything
you are timing, use a single `@storage/load`.

## Verifying the seed

```js
() => {
  const st = window.store.getState();
  return {
    accounts: st.wallet.accounts.length,
    selectedDevice: !!st.device.selectedDevice,
    enabledNetworks: st.wallet.settings.enabledNetworks,
    rows: document.querySelectorAll('[data-testid^="@account-menu/"]').length,
    domNodes: document.querySelectorAll('*').length,
    router: st.router.pathname,
  };
}
```

`rows` well below `accounts` means the list is virtualized; equal or higher means every account is
in the DOM. That single number is often the clearest structural difference between two branches.

## Extending

- **Transactions** — the `txs` store is keyed by `[descriptor, symbol, deviceState]` with an
  `order` index; add `DBWalletAccountTransaction` records to the `txs` array. Needed to profile the
  transactions table or anything using `Table`.
- **Tokens** — `account.tokens` takes `TokenInfo[]`. Note token definitions are not loaded in this
  setup, so `getTokens` classifies them as it would for an unclassified coin. Say so in the report.
- **Other device models** — change `features.internal_model` and `capabilities`; the supported
  network set follows from them.

## Why not seed IndexedDB

You can — the DB is `trezor-suite`, the `accounts` store has keyPath
`['descriptor', 'symbol', 'deviceState']` and an index on `deviceState` (see
`packages/suite/src/storage/migrations/index.ts`) — and it survives reloads, which store dispatches
do not.

It is rarely worth it. The version number is derived from the migrations list and must match or the
app migrates or wipes what you wrote, and `selectedDevice` still is not restored, so you need the
store dispatch anyway. The one case that justifies it is measuring a genuine cold app boot with
accounts already present in the preloaded state.
