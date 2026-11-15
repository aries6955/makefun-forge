# A GitHub-compatible git forge

One Node 22 process serving four surfaces from its own in-memory store, with no
dependencies beyond the standard library and no git binary:

- **git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 `ls-refs`/`fetch`, v0
  `receive-pack`, pack files read and written by hand (`node:zlib`), ofs/ref deltas
  resolved, shallow and incremental fetches.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, labels,
  issues and comments, pull requests, files and squash merges.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server` send,
  including introspection, cursor pagination and the issue/pull mutations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP, revision 2026-07-28
  (`server/discover`) and the `initialize` handshake, with six tools.

## Run

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

`main.ts` is the entry↔env lifecycle (bind an ephemeral port, register it, poll until
done); `app.ts` is the server. Every request is served from memory, so a restart is a
clean store.

## Local grading

```sh
sh run-suite.sh            # starts the forge, runs the 120-check conformance suite, stops it
sh run-suite.sh --perf     # also runs the four timed workloads
```

`run-suite.sh` expects the competition kit at `/root/makefun/github-core-clone-01-kit`;
point it at the kit's own `sdk/run.ts` if you keep the kit elsewhere.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | lifecycle: register the port, poll `done`, exit 0 |
| `app.ts` | HTTP routing, auth, the git/GraphQL/MCP endpoints |
| `store.ts` | repositories, refs, issues, pulls, labels; tree/commit helpers |
| `git.ts` | object model (blob/tree/commit/tag), SHA-1 ids, pack read/write, deltas |
| `git-http.ts` | pkt-line, advertisements, upload-pack v0/v2, receive-pack report |
| `rest.ts` | the REST v3 routes |
| `graphql.ts` | the GraphQL parser, resolver and introspection |
| `mcp.ts` | the MCP tools and their JSON-RPC plumbing |
| `rest-merge.ts` | squash merge shared by REST and GraphQL |
