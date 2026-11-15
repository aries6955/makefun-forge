# aries6955/makefun-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aries6955/makefun-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aries6955/makefun-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One Node 22 process serving four GitHub surfaces from its own in-memory store, with
nothing but the standard library and no git binary: git smart HTTP (protocol v2
`ls-refs`/`fetch`, v0 `receive-pack`, packs read and written by hand), REST v3,
GraphQL v4 for the documents `gh` and `github-mcp-server` send, and an MCP endpoint
speaking JSON-RPC 2.0 over streamable HTTP.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
