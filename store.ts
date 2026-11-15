// The in-memory store: repositories, refs, issues, pulls, labels, comments.
// One forge instance owns one Store; REST, GraphQL, MCP and git all act on it.

import { createHash } from 'node:crypto';
import { ObjectStore, buildTreeFromFiles, isTreeMode, parseCommit, parseTree, parseTag, type TreeEntry } from './git.ts';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null; // bound on first owner-scoped access
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  store: ObjectStore;
  refs: Map<string, string>; // refs/heads/..., refs/tags/...
  peeled: Map<string, string>; // tag oid -> peeled commit oid (annotated tags)
  issues: Issue[];
  pulls: PullRequest[];
  labels: Label[];
  nextIssueNumber: number;
  deleted: boolean;
}

let nextRepoId = 1;

/** Deterministic-ish time: GitHub-format ISO strings. We use the trial's now when
 *  available, else real time. Everything stays consistent within one process run. */
export function nowIso(): string {
  const env = process.env['MAKEFUN_TRIAL_NOW'];
  const ms = env !== undefined && env !== '' ? Date.parse(env) : Date.now();
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Store {
  readonly repos = new Map<string, Repo>(); // key: owner/name lowercase
  readonly reposByOwner = new Map<string, string[]>(); // owner lowercase -> repo names (display)

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(owner: string | null, name: string, opts: { description?: string | null; private?: boolean; autoInit?: boolean } = {}): Repo {
    const k = name.toLowerCase();
    const existing = this.repos.get(k);
    if (existing !== undefined) {
      if (!existing.deleted) throw new RepoExistsError(k);
    }
    const repo: Repo = {
      id: nextRepoId++,
      name,
      owner,
      description: opts.description ?? null,
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pushedAt: nowIso(),
      store: new ObjectStore(),
      refs: new Map(),
      peeled: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      deleted: false,
    };
    this.repos.set(k, repo);
    if (owner !== null) {
      const list = this.reposByOwner.get(owner.toLowerCase()) ?? [];
      list.push(name);
      this.reposByOwner.set(owner.toLowerCase(), list);
    }
    return repo;
  }

  /** The first owner-scoped access binds an unbound repo to that owner. */
  getRepo(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(name.toLowerCase());
    if (repo === undefined || repo.deleted) return undefined;
    if (repo.owner === null) {
      repo.owner = owner;
      const list = this.reposByOwner.get(owner.toLowerCase()) ?? [];
      list.push(repo.name);
      this.reposByOwner.set(owner.toLowerCase(), list);
    }
    return repo.owner.toLowerCase() === owner.toLowerCase() ? repo : undefined;
  }

  /** A repo's display owner before binding. */
  storeLoginFallback(this: void): string {
    return 'forge-user';
  }

  /** The token's login: the owner any repo was bound to, else a default. */
  login(): string {
    for (const repo of this.repos.values()) {
      if (!repo.deleted && repo.owner !== null) return repo.owner;
    }
    return 'forge-user';
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(name.toLowerCase());
    if (repo === undefined || repo.deleted) return false;
    repo.deleted = true;
    const list = this.reposByOwner.get(repo.owner.toLowerCase()) ?? [];
    const idx = list.indexOf(repo.name);
    if (idx >= 0) list.splice(idx, 1);
    return true;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (!repo.deleted && (repo.owner === null || repo.owner.toLowerCase() === owner.toLowerCase())) out.push(repo);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.name < b.name ? -1 : 1));
    return out;
  }

  createIssue(repo: Repo, body: { title: string; body?: string; labels?: string[] }): Issue {
    const labels = body.labels ?? [];
    for (const l of labels) {
      if (!repo.labels.some((x) => x.name === l)) throw new LabelNotFoundError(l);
    }
    const issue: Issue = {
      number: repo.nextIssueNumber++,
      title: body.title,
      body: body.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, body: { title: string; body?: string; head: string; base: string }): PullRequest {
    const headRef = body.head;
    const baseRef = body.base;
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) throw new RefNotFoundError(`refs/heads/${headRef}`);
    if (baseSha === undefined) throw new RefNotFoundError(`refs/heads/${baseRef}`);
    const pr: PullRequest = {
      number: repo.nextIssueNumber++,
      title: body.title,
      body: body.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.pulls.push(pr);
    return pr;
  }
}

export class RepoExistsError extends Error {}
export class LabelNotFoundError extends Error {
  readonly label: string;
  constructor(label: string) {
    super(`label ${label} not found`);
    this.label = label;
  }
}
export class RefNotFoundError extends Error {}

// ---------------------------------------------------------------- repo tree walk

/** List one path's entries in a repo at a commit: returns tree entries (like GitHub's contents dir listing). */
export function listPath(repo: Repo, commitSha: string, path: string): TreeEntry[] | null {
  const commit = repo.store.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  const parsed = parseCommit(commit.data);
  let treeOid = parsed.tree;
  if (path !== '' && path !== '/') {
    const segs = path.split('/').filter((s) => s !== '');
    for (const seg of segs) {
      const tree = repo.store.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entries = parseTree(tree.data);
      const hit = entries.find((e) => e.name === seg);
      if (hit === undefined) return null;
      if (!isTreeMode(hit.mode)) return null;
      treeOid = hit.oid;
    }
  }
  const tree = repo.store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  return parseTree(tree.data);
}

/** Read one blob at a path; returns the entry and blob data, or null. */
export function readPath(repo: Repo, commitSha: string, path: string): { entry: TreeEntry; data: Buffer; treeSha: string } | null {
  const segs = path.split('/').filter((s) => s !== '');
  if (segs.length === 0) return null;
  const commit = repo.store.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  const parsed = parseCommit(commit.data);
  let treeOid = parsed.tree;
  for (let i = 0; i < segs.length - 1; i++) {
    const tree = repo.store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entries = parseTree(tree.data);
    const hit = entries.find((e) => e.name === segs[i]);
    if (hit === undefined || !isTreeMode(hit.mode)) return null;
    treeOid = hit.oid;
  }
  const tree = repo.store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  const entries = parseTree(tree.data);
  const hit = entries.find((e) => e.name === segs[segs.length - 1]);
  if (hit === undefined || isTreeMode(hit.mode)) return null;
  const blob = repo.store.get(hit.oid);
  if (blob === undefined) return null;
  return { entry: hit, data: blob.data, treeSha: treeOid };
}

/** Build a new commit that changes one path in the tree of `parentSha` (or an empty tree if null). */
export function commitPath(
  repo: Repo,
  parentSha: string | null,
  path: string,
  content: string | null,
  message: string,
  author: { name: string; email: string },
  branch: string,
): string {
  // Read the full path->content map of the parent commit (small repos: fine).
  const files = new Map<string, string>();
  if (parentSha !== null) collectFiles(repo, parentSha, '', files);
  if (content === null) files.delete(path);
  else files.set(path, content);
  const rootTree = buildTree(repo, files);
  const now = Math.floor(Date.now() / 1000);
  const commitData = Buffer.from(
    `tree ${rootTree}\n` +
      (parentSha !== null ? `parent ${parentSha}\n` : '') +
      `author ${author.name} <${author.email}> ${now} +0000\n` +
      `committer ${author.name} <${author.email}> ${now} +0000\n\n${message}\n`,
    'utf8',
  );
  const oid = repo.store.store('commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.pushedAt = nowIso();
  return oid;
}

export function collectFiles(repo: Repo, commitSha: string, prefix: string, out: Map<string, string>): void {
  const commit = repo.store.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return;
  const parsed = parseCommit(commit.data);
  const walk = (treeOid: string, dir: string): void => {
    const tree = repo.store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      if (isTreeMode(e.mode)) {
        walk(e.oid, dir === '' ? e.name : `${dir}/${e.name}`);
      } else if (e.mode === '100644' || e.mode === '100755' || e.mode === '120000') {
        const blob = repo.store.get(e.oid);
        if (blob !== undefined) out.set(dir === '' ? e.name : `${dir}/${e.name}`, blob.data.toString('utf8'));
      }
    }
  };
  walk(parsed.tree, '');
}

function buildTree(repo: Repo, files: Map<string, string>): string {
  return buildTreeFromFiles(repo.store, files);
}

/** Peel an annotated tag to its commit (cached). */
export function peel(repo: Repo, tagOid: string): string {
  const cached = repo.peeled.get(tagOid);
  if (cached !== undefined) return cached;
  const obj = repo.store.get(tagOid);
  if (obj === undefined || obj.type !== 'tag') return tagOid;
  const tag = parseTag(obj.data);
  if (tag === null) return tagOid;
  let target = tag.object;
  // Only one level of nesting in practice.
  const targetObj = repo.store.get(target);
  if (targetObj !== undefined && targetObj.type === 'tag') {
    const inner = parseTag(targetObj.data);
    if (inner !== null) target = inner.object;
  }
  repo.peeled.set(tagOid, target);
  return target;
}

/** The commit a ref points at, peeling annotated tags. */
export function refCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peel(repo, oid);
}

/** List commits reachable from a commit (by date order git uses: reverse chronological by commit graph walk). */
export function listCommits(repo: Repo, startSha: string, limit = Infinity): { sha: string; parents: string[]; message: string; tree: string }[] {
  const out: { sha: string; parents: string[]; message: string; tree: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [startSha];
  while (queue.length > 0 && out.length < limit) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = repo.store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const p = parseCommit(obj.data);
    out.push({ sha, parents: p.parents, message: p.message, tree: p.tree });
    for (const parent of p.parents) queue.push(parent);
  }
  return out;
}

/** Global node id for GraphQL: base64 of a stable id string. */
export function globalId(kind: string, n: number | string): string {
  return Buffer.from(`${kind}:${n}`).toString('base64');
}

export function parseGlobalId(id: string): { kind: string; n: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const idx = text.indexOf(':');
    if (idx <= 0) return null;
    return { kind: text.slice(0, idx), n: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** Short sha helper. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Stable content sha for contents listings. */
export function blobSha(content: string): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content, 'utf8').digest('hex');
}
