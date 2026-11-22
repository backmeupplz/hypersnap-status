# Hypersnap Network Status

Live status page for the [Hypersnap](https://github.com/farcasterorg/hypersnap) network, and for upstream [Snapchain](https://github.com/farcasterxyz/snapchain) which shares its gossip mesh, at **[status.quilcast.com](https://status.quilcast.com)** (Snapchain at `/snapchain`): every node reachable through the mesh, with its IP, location, version and sync state, each shard's latest block, validators and halts, plus uptime history.

## How it works

Every minute `crawl.mjs` walks the mesh starting from a few public nodes. It asks each node's HTTP API for `/v1/info` (version and shard heights) and `/v1/currentPeers` (the peers it's connected to), and follows those peers' addresses to more nodes. A node's own API decides its network: only Hypersnap serves `/v1/nativeRegistration` (Snapchain answers 404). A node without a public API keeps the network it had before. Failing that, it's placed by the current validator sets in each network's `validators.toml` ([Hypersnap](https://github.com/farcasterorg/hypersnap/blob/main/validators.toml), [Snapchain](https://github.com/farcasterxyz/snapchain/blob/main/validators.toml); a validator's peer ID is derived from its key), by the `hyper:v1` capability it gossips, or by Snapchain's known fleet. Nodes without a public API show up as "seen in gossip".

`status.mjs` turns a crawl into the network state:

- **Shards:** a shard's tip is the highest height two Hypersnap nodes agree on. It's halted when no two nodes have seen a block in 2 minutes. A peer that was Hypersnap once stays listed unless its own API says otherwise.
- **Nodes:** a node more than 60 blocks behind a tip is syncing.

`store.mjs` keeps hourly uptime and incidents in SQLite (`DATA_DIR`). `server.mjs` serves the following:

- the SPA (`public/`), with per-page meta tags and the live snapshot inlined
- `/api/status` and `/api/node/<peer id>`
- share images (`/og.png`, `/og/node/<peer id>.png`), drawn by `og.mjs` with resvg
- `/sitemap.xml`

Locations come from ip-api.com.

## Run

```sh
npm install
mkdir -p data && npm start   # http://localhost:3000
npm test                     # status.mjs against a recorded crawl
```

MIT
