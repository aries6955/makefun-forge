// REST v3 API: /api/v3 routes over the Store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, type Issue, type PullRequest, type Repo, RepoExistsError, LabelNotFoundError, RefNotFoundError, listPath, readPath, collectFiles, commitPath, refCommit, listCommits, globalId, blobSha, shortSha, nowIso } from './store.ts';
import { diffTrees, diffStats, isAncestor, peel } from './git-http.ts';
import { buildTreeFromFiles, isTreeMode } from './git.ts';

export interface RestContext {
  store: Store;
  owner: string; // the token's login
  token: string;
  baseUrl: string; // the entry's own origin, for absolute Link headers
}

export type RouteHandler = (ctx: RestContext, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean;

/** Parse the JSON body. Returns undefined for an empty body; throws on malformed JSON. */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new MalformedJsonError());
      }
    });
    req.on('error', reject);
  });
}

export class MalformedJsonError extends Error {}

// ---------------------------------------------------------------- helpers

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ridOf(),
    ...headers,
  });
  res.end(text);
}

let ridCounter = 0;
function ridOf(): string {
  ridCounter += 1;
  return `forge-${ridCounter.toString(16).padStart(8, '0')}`;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  send(res, status, { message });
}

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? 'forge-user';
  return {
    id: repo.id,
    node_id: globalId('R', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, node_id: globalId('U', owner) },
    private: repo.private,
    html_url: `/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    default_branch: repo.defaultBranch,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    watchers: 0,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

const userJsonCache = new Map<string, Record<string, unknown>>();

/** Memoised: the read workload asks for the same owner 2,000 times. */
function userJson(login: string): Record<string, unknown> {
  const hit = userJsonCache.get(login);
  if (hit !== undefined) return hit;
  const made = { login, id: loginId(login), node_id: globalId('U', login), type: 'User', site_admin: false };
  userJsonCache.set(login, made);
  return made;
}

function loginId(login: string): number {
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h || 1;
}

const labelJsonCache = new Map<string, Record<string, unknown>>();

/** Memoised per name+colour: issue reads rebuild the same labels thousands of times. */
function labelJson(name: string, color: string): Record<string, unknown> {
  const key = `${color}\u0000${name}`;
  const hit = labelJsonCache.get(key);
  if (hit !== undefined) return hit;
  const made = { id: loginId(name), node_id: globalId('L', name), name, color, default: false, description: null };
  labelJsonCache.set(key, made);
  return made;
}

/**
 * The parts of an issue's JSON that never change once it exists: node_id and id are hashes of
 * its address, the owner and the labels' colours are fixed. The read workload fetches one issue
 * 2,000 times, so these hashes and the two cached lookups were recomputed 2,000 times for
 * nothing. Mutable fields (title, body, state, comments, timestamps) stay live below.
 */
const issueFixedCache = new Map<string, { id: number; node_id: string; user: Record<string, unknown>; url: string }>();

function issueFixed(repo: Repo, issue: Issue): { id: number; node_id: string; user: Record<string, unknown>; url: string } {
  const owner = repo.owner ?? '';
  const key = `${owner}/${repo.name}#${issue.number}`;
  const hit = issueFixedCache.get(key);
  if (hit !== undefined) return hit;
  const made = {
    id: loginId(key),
    node_id: globalId('I', `${owner}/${repo.name}/${issue.number}`),
    user: userJson(owner),
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
  issueFixedCache.set(key, made);
  return made;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const fixed = issueFixed(repo, issue);
  return {
    id: fixed.id,
    node_id: fixed.node_id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((l) => labelJson(l, 'ededed')),
    user: fixed.user,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    author_association: 'OWNER',
    repository_url: fixed.url,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IC', comment.id),
    body: comment.body,
    user: userJson(repo.owner),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headCommit = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
  const baseCommit = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  return {
    id: loginId(`${repo.owner}/${repo.name}#pr${pr.number}`),
    node_id: globalId('PR', `${repo.owner}/${repo.name}/${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    merged_by: pr.merged ? userJson(repo.owner) : null,
    user: userJson(repo.owner),
    head: {
      label: `${repo.owner}:${pr.head.ref}`,
      ref: pr.head.ref,
      sha: headCommit,
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pr.base.ref}`,
      ref: pr.base.ref,
      sha: baseCommit,
      repo: repoJson(repo),
    },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.merged ? pr.mergedAt : pr.state === 'closed' ? pr.updatedAt : null,
    draft: false,
    merged_by_login: pr.merged ? repo.owner : null,
    comments: 0,
    commits: 1,
    additions: 1,
    deletions: 0,
    changed_files: 1,
  };
}

function encodePath(p: string): string {
  return p;
}

function decodePath(p: string): string {
  return p;
}

// ---------------------------------------------------------------- the dispatcher

/** Parse the path and dispatch. Returns true when handled. */
export async function handleRest(ctx: RestContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const query = url.searchParams;

  // Everything under /api/v3
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    send(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
      organization_url: '/api/v3/orgs/{org}',
      emojis_url: '/api/v3/emojis',
      meta_url: '/api/v3/meta',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (path === '/api/v3/meta' && method === 'GET') {
    send(res, 200, { installed_version: 'forge-1.0.0' });
    return true;
  }

  // /user
  if (path === '/api/v3/user' && method === 'GET') {
    const login = ctx.store.login();
    send(res, 200, { ...userJson(login), name: login, email: `${login}@example.invalid` });
    return true;
  }

  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
      const all = ctx.store.listRepos(ctx.store.login());
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        headers.link = `<${ctx.baseUrl}${path}?per_page=${perPage}&page=${page + 1}>; rel="next", <${ctx.baseUrl}${path}?per_page=${perPage}&page=1>; rel="first"`;
      }
      send(res, 200, slice.map(repoJson), headers);
      return true;
    }
    if (method === 'POST') {
      let body: { name?: string; description?: string; private?: boolean; auto_init?: boolean };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof body?.name !== 'string' || body.name === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      try {
        const repo = ctx.store.createRepo(null, body.name, { description: body.description ?? null, private: body.private ?? false });
        send(res, 201, repoJson(repo));
      } catch (err) {
        if (err instanceof RepoExistsError) {
          sendError(res, 422, 'name already exists on this account');
        } else {
          sendError(res, 422, 'Validation Failed');
        }
      }
      return true;
    }
  }

  // /repos/{owner}/{repo}/...
  const reposMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (reposMatch !== null) {
    const owner = decodeURIComponent(reposMatch[1]!);
    const name = decodeURIComponent(reposMatch[2]!);
    const rest = reposMatch[3] ?? '';
    const repo = ctx.store.getRepo(owner, name);
    // Ownership: the repo's bound owner must match the path owner (getRepo enforces
    // it), and any bound owner is the token's own login (the first to touch it).
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    return handleRepoRoutes(ctx, repo, method, rest, req, res, url);
  }

  // anything else under /api/v3
  if (path.startsWith('/api/v3/')) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  return false;
}

async function handleRepoRoutes(ctx: RestContext, repo: Repo, method: string, rest: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const query = url.searchParams;
  const store = ctx.store;
  const apiRoot = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // the repo itself
  if (rest === '' || rest === '/') {
    if (method === 'GET') {
      send(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      let body: { description?: string; name?: string; default_branch?: string; private?: boolean };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (body.description !== undefined) repo.description = body.description;
      if (body.default_branch !== undefined && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (body.private !== undefined) repo.private = body.private;
      repo.updatedAt = nowIso();
      send(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': ridOf() });
      res.end();
      return true;
    }
  }

  // branches
  if (rest === '/branches' && method === 'GET') {
    const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort();
    send(res, 200, list.map((b) => ({
      name: b,
      commit: { sha: repo.refs.get(`refs/heads/${b}`)!, url: `${apiRoot}/commits/${repo.refs.get(`refs/heads/${b}`)}` },
      protected: false,
    })));
    return true;
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(rest);
  if (branchMatch !== null && method === 'GET') {
    const b = decodeURIComponent(branchMatch[1]!);
    const sha = repo.refs.get(`refs/heads/${b}`);
    if (sha === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    send(res, 200, { name: b, commit: { sha, url: `${apiRoot}/commits/${sha}` }, protected: false });
    return true;
  }

  // git refs
  if (rest === '/git/refs' && method === 'GET') {
    const list = [...repo.refs.keys()].sort().map((r) => ({ ref: r, object: { sha: repo.refs.get(r)!, type: repo.store.get(repo.refs.get(r)!)?.type === 'tag' ? 'tag' : 'commit', url: `${apiRoot}/git/${r}` } }));
    send(res, 200, list);
    return true;
  }
  if (rest === '/git/refs' && method === 'POST') {
    let body: { ref?: string; sha?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    if (typeof body?.ref !== 'string' || typeof body?.sha !== 'string') {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    if (!body.ref.startsWith('refs/')) {
      sendError(res, 422, 'Invalid ref name');
      return true;
    }
    const existing = repo.refs.get(body.ref);
    if (existing !== undefined && existing !== body.sha) {
      sendError(res, 422, 'Reference already exists');
      return true;
    }
    repo.refs.set(body.ref, body.sha);
    send(res, 201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
    return true;
  }
  const refMatch = /^\/git\/refs\/(.+)$/.exec(rest);
  if (refMatch !== null && method === 'GET') {
    const refName = decodeURIComponent(refMatch[1]!);
    let full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
    const sha = repo.refs.get(full) ?? repo.refs.get(`refs/heads/${refName}`) ?? repo.refs.get(`refs/tags/${refName}`);
    if (sha === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    void full;
    send(res, 200, { ref: full, object: { sha, type: repo.store.get(sha)?.type === 'tag' ? 'tag' : 'commit', url: `${apiRoot}/git/${sha}` } });
    return true;
  }

  // commits
  if (rest === '/commits' && method === 'GET') {
    const shaParam = query.get('sha');
    const ref = `refs/heads/${shaParam ?? repo.defaultBranch}`;
    const tip =
      refCommit(repo, ref) ??
      (shaParam !== null && repo.store.has(shaParam) ? shaParam : null) ??
      refCommit(repo, `refs/tags/${shaParam ?? ''}`);
    if (tip === null) {
      send(res, 200, []);
      return true;
    }
    const commits = listCommits(repo, tip, 30);
    send(res, 200, commits.map((c) => {
      const raw = repo.store.get(c.sha)!.data.toString('utf8');
      const authorLine = /^author (.*) <(.*)> (\d+) ([+-]\d{4})$/m.exec(raw);
      const when = authorLine === null ? repo.createdAt : new Date(Number(authorLine[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const who = { name: authorLine?.[1] ?? 'forge', email: authorLine?.[2] ?? 'forge@example.invalid', date: when };
      return {
        sha: c.sha,
        commit: {
          message: c.message.replace(/\n$/, ''),
          author: who,
          committer: who,
          tree: { sha: c.tree, url: `${apiRoot}/git/trees/${c.tree}` },
        },
        parents: c.parents.map((p) => ({ sha: p, url: `${apiRoot}/commits/${p}` })),
        html_url: `/${repo.owner}/${repo.name}/commit/${c.sha}`,
        url: `${apiRoot}/commits/${c.sha}`,
        author: who,
        committer: who,
      };
    }));
    return true;
  }

  // contents
  const contentsMatch = /^\/contents\/(.*)$/.exec(rest);
  if (contentsMatch !== null) {
    const filePath = decodePath(decodeURIComponent(contentsMatch[1]!));
    const refParam = query.get('ref') ?? bodyRefHint(req);
    const branch = refParam ?? repo.defaultBranch;
    const tip = refCommit(repo, `refs/heads/${branch}`);
    if (method === 'GET') {
      if (tip === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      // directory?
      if (filePath === '' || filePath === '/') {
        const entries = listPath(repo, tip, '') ?? [];
        send(res, 200, entries.map((e) => contentEntryJson(repo, e, branch)));
        return true;
      }
      let dirEntries: ReturnType<typeof listPath> = null;
      try {
        dirEntries = listPath(repo, tip, filePath);
      } catch {
        dirEntries = null;
      }
      if (dirEntries !== null) {
        send(res, 200, dirEntries.map((e) => contentEntryJson(repo, e, branch, filePath)));
        return true;
      }
      const file = readPath(repo, tip, filePath);
      if (file === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      send(res, 200, {
        name: filePath.split('/').pop()!,
        path: filePath,
        sha: blobSha(file.data.toString('utf8')),
        size: file.data.length,
        type: 'file',
        encoding: 'base64',
        content: file.data.toString('base64'),
        url: `${apiRoot}/contents/${filePath}`,
        git_url: `${apiRoot}/git/blobs/${file.entry.oid}`,
        html_url: `/${repo.owner}/${repo.name}/blob/${tip}/${filePath}`,
        download_url: `/${repo.owner}/${repo.name}/raw/${tip}/${filePath}`,
        _links: {},
      });
      return true;
    }
    if (method === 'PUT') {
      let body: { message?: string; content?: string; sha?: string; branch?: string };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof body?.content !== 'string') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const message = body.message ?? 'update';
      const branch2 = body.branch ?? refParam ?? repo.defaultBranch;
      const parentSha = refCommit(repo, `refs/heads/${branch2}`);
      // stale sha check
      if (body.sha !== undefined) {
        if (parentSha === null) {
          sendError(res, 409, 'does not match');
          return true;
        }
        const existing = readPath(repo, parentSha, filePath);
        if (existing === null || blobSha(existing.data.toString('utf8')) !== body.sha) {
          sendError(res, 409, 'the blob SHA provided does not match the current file');
          return true;
        }
      }
      let content: string | null;
      try {
        content = Buffer.from(body.content, 'base64').toString('utf8');
      } catch {
        sendError(res, 422, 'invalid base64');
        return true;
      }
      const parentCommit = parentSha;
      const oldContent = parentCommit !== null ? readPath(repo, parentCommit, filePath) : null;
      const created = oldContent === null;
      const commitSha = commitPath(repo, parentCommit, filePath, content, message, { name: ctx.owner, email: `${ctx.owner}@example.invalid` }, branch2);
      const entry = readPath(repo, commitSha, filePath);
      const newBlobSha = entry !== null ? blobSha(entry.data.toString('utf8')) : '';
      send(res, created ? 201 : 200, {
        content: {
          name: filePath.split('/').pop()!,
          path: filePath,
          sha: newBlobSha,
          size: Buffer.byteLength(content),
          type: 'file',
          encoding: 'base64',
          url: `${apiRoot}/contents/${filePath}`,
          git_url: `${apiRoot}/git/blobs/${newBlobSha}`,
          html_url: `/${repo.owner}/${repo.name}/blob/${commitSha}/${filePath}`,
          download_url: `/${repo.owner}/${repo.name}/raw/${commitSha}/${filePath}`,
          _links: {},
        },
        commit: { sha: commitSha, message, html_url: `/${repo.owner}/${repo.name}/commit/${commitSha}` },
      });
      return true;
    }
    if (method === 'DELETE') {
      let body: { message?: string; sha?: string; branch?: string };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      const branch2 = body?.branch ?? refParam ?? repo.defaultBranch;
      const parentSha = refCommit(repo, `refs/heads/${branch2}`);
      if (parentSha === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const commitSha = commitPath(repo, parentSha, filePath, null, body?.message ?? 'delete', { name: ctx.owner, email: `${ctx.owner}@example.invalid` }, branch2);
      send(res, 200, { commit: { sha: commitSha, message: body?.message ?? 'delete' } });
      return true;
    }
  }

  // labels
  if (rest === '/labels' && method === 'GET') {
    send(res, 200, repo.labels.map((l) => labelJson(l.name, l.color)));
    return true;
  }
  if (rest === '/labels' && method === 'POST') {
    let body: { name?: string; color?: string; description?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    if (typeof body?.name !== 'string' || body.name === '') {
      sendError(res, 422, 'Validation Failed');
      return true;
    }
    const existing = repo.labels.find((l) => l.name === body.name);
    if (existing !== undefined) {
      send(res, 200, labelJson(existing.name, existing.color));
      return true;
    }
    repo.labels.push({ name: body.name, color: body.color ?? 'ededed' });
    send(res, 201, labelJson(body.name, body.color ?? 'ededed'));
    return true;
  }

  // issues
  if (rest === '/issues') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => {
        const byDate = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        const byNumber = a.number - b.number;
        if (sort === 'created') {
          if (byDate !== 0) return direction === 'asc' ? byDate : -byDate;
          return direction === 'asc' ? byNumber : -byNumber;
        }
        return direction === 'asc' ? byNumber : -byNumber;
      });
      send(res, 200, list.map((i) => issueJson(repo, i)));
      return true;
    }
    if (method === 'POST') {
      let body: { title?: string; body?: string; labels?: string[] };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof body?.title !== 'string' || body.title === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      try {
        const issue = store.createIssue(repo, { title: body.title, body: body.body, labels: body.labels });
        send(res, 201, issueJson(repo, issue));
      } catch (err) {
        if (err instanceof LabelNotFoundError) {
          sendError(res, 422, `Label "${err.label}" does not exist`);
        } else {
          sendError(res, 422, 'Validation Failed');
        }
      }
      return true;
    }
  }

  const issueMatch = /^\/issues\/(\d+)(\/.*)?$/.exec(rest);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]!);
    const sub = issueMatch[2] ?? '';
    const issue = repo.issues.find((i) => i.number === number);
    const pr = repo.pulls.find((p) => p.number === number);
    if (sub === '') {
      if (method === 'GET') {
        if (issue !== undefined) {
          send(res, 200, issueJson(repo, issue));
          return true;
        }
        if (pr !== undefined) {
          const j = pullJson(repo, pr) as Record<string, unknown> & { body: string; title: string };
          send(res, 200, { ...j, labels: [] });
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PATCH') {
        let body: { title?: string; body?: string; state?: string; labels?: string[] };
        try {
          body = (await readJsonBody(req)) as typeof body;
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        if (issue !== undefined) {
          if (body.title !== undefined) issue.title = body.title;
          if (body.body !== undefined) issue.body = body.body;
          if (body.state !== undefined && (body.state === 'open' || body.state === 'closed')) {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? nowIso() : null;
          }
          issue.updatedAt = nowIso();
          send(res, 200, issueJson(repo, issue));
          return true;
        }
        if (pr !== undefined) {
          if (body.title !== undefined) pr.title = body.title;
          if (body.body !== undefined) pr.body = body.body;
          if (body.state !== undefined && (body.state === 'open' || body.state === 'closed')) {
            pr.state = body.state;
          }
          pr.updatedAt = nowIso();
          send(res, 200, { ...(pullJson(repo, pr) as Record<string, unknown> & { title: string; body: string }), labels: [] });
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
    }
    if (sub === '/comments') {
      if (method === 'GET') {
        if (issue !== undefined) {
          send(res, 200, issue.comments.map((c) => commentJson(repo, issue.number, c)));
          return true;
        }
        if (pr !== undefined) {
          send(res, 200, []);
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'POST') {
        let body: { body?: string };
        try {
          body = (await readJsonBody(req)) as typeof body;
        } catch {
          sendError(res, 400, 'Problems parsing JSON');
          return true;
        }
        if (typeof body?.body !== 'string' || body.body === '') {
          sendError(res, 422, 'Validation Failed');
          return true;
        }
        if (issue !== undefined) {
          const id = (issue.number * 1000 + issue.comments.length + 1);
          issue.comments.push({ id, body: body.body, createdAt: nowIso() });
          issue.updatedAt = nowIso();
          send(res, 201, commentJson(repo, issue.number, issue.comments[issue.comments.length - 1]!));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // pulls
  if (rest === '/pulls') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => (state === 'open' ? !p.merged && p.state === 'open' : p.merged || p.state === 'closed'));
      send(res, 200, list.map((p) => pullJson(repo, p)));
      return true;
    }
    if (method === 'POST') {
      let body: { title?: string; body?: string; head?: string; base?: string };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (typeof body?.title !== 'string' || typeof body?.head !== 'string' || typeof body?.base !== 'string') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      try {
        const pr = store.createPull(repo, { title: body.title, body: body.body, head: body.head, base: body.base });
        send(res, 201, pullJson(repo, pr));
      } catch (err) {
        if (err instanceof RefNotFoundError) {
          sendError(res, 422, `Validation Failed: ${err.message}`);
        } else {
          sendError(res, 422, 'Validation Failed');
        }
      }
      return true;
    }
  }

  const pullMatch = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest);
  if (pullMatch !== null) {
    const number = Number(pullMatch[1]!);
    const sub = pullMatch[2] ?? '';
    const pr = repo.pulls.find((p) => p.number === number);
    if (pr === undefined) {
      sendError(res, 404, 'Pull request not found');
      return true;
    }
    if (sub === '' && method === 'GET') {
      send(res, 200, pullJson(repo, pr));
      return true;
    }
    if (sub === '' && method === 'PATCH') {
      let body: { title?: string; body?: string; state?: string };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (body.title !== undefined) pr.title = body.title;
      if (body.body !== undefined) pr.body = body.body;
      if (body.state !== undefined && (body.state === 'open' || body.state === 'closed')) pr.state = body.state;
      pr.updatedAt = nowIso();
      send(res, 200, pullJson(repo, pr));
      return true;
    }
    if (sub === '/files' && method === 'GET') {
      const headSha = pr.merged ? pr.head.sha : repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
      const baseSha = pr.base.sha;
      const changes = diffTrees(repo, baseSha, headSha);
      const files = changes.map((c) => {
        const stats = diffStats(c.before, c.after);
        return {
          filename: c.path,
          status: c.status === 'added' ? 'added' : c.status === 'removed' ? 'removed' : 'modified',
          additions: stats.additions,
          deletions: stats.deletions,
          changes: stats.additions + stats.deletions,
          raw_url: `/${repo.owner}/${repo.name}/raw/${headSha}/${c.path}`,
          blob_url: `/${repo.owner}/${repo.name}/blob/${headSha}/${c.path}`,
          patch: '',
        };
      });
      send(res, 200, files);
      return true;
    }
    if (sub === '/merge' && method === 'PUT') {
      let body: { merge_method?: string; commit_title?: string; sha?: string } = {};
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return true;
      }
      if (pr.merged) {
        sendError(res, 405, 'Pull request is not mergeable: already merged');
        return true;
      }
      const headSha = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
      const baseSha = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
      // Squash merge: build the squash commit on the base branch.
      // Mergeable iff the head commit's changes apply on the base — we take the simple
      // GitHub-like path: if base is not an ancestor of head and trees conflict, 405.
      const baseIsAncestor = isAncestor(repo, baseSha, headSha);
      const diff = diffTrees(repo, baseSha, headSha);
      // Detect conflicts: a file changed (not added) on head that was also changed on
      // base since the merge base — with no merge base info we approximate: base NOT
      // ancestor of head AND any file modified in both → conflict.
      if (!baseIsAncestor) {
        // Compute the merge base (common ancestor).
        const mergeBase = findMergeBase(repo, baseSha, headSha);
        if (mergeBase === null) {
          sendError(res, 405, 'Pull Request is not mergeable');
          return true;
        }
        const baseChanges = diffTrees(repo, mergeBase, baseSha);
        const headChanges = diffTrees(repo, mergeBase, headSha);
        const basePaths = new Set(baseChanges.map((c) => c.path));
        const headPaths = new Set(headChanges.map((c) => c.path));
        let conflict = false;
        for (const p of headPaths) {
          if (basePaths.has(p)) {
            const hc = headChanges.find((c) => c.path === p)!;
            const bc = baseChanges.find((c) => c.path === p)!;
            if (hc.after !== bc.after) conflict = true;
          }
        }
        if (conflict) {
          sendError(res, 405, 'Pull Request is not mergeable: conflicts');
          return true;
        }
      }
      void diff;
      void body;
      // Squash: take the head tree content onto the base branch.
      const files = new Map<string, string>();
      collectFiles(repo, headSha, '', files);
      const parentSha = baseSha;
      const now = Math.floor(Date.parse(nowIso()) / 1000);
      const rootTree = buildRootTree(repo, files);
      const message = body.commit_title ?? `Squash merge PR #${pr.number}: ${pr.title}`;
      const commitData = Buffer.from(
        `tree ${rootTree}\nparent ${parentSha}\nauthor ${ctx.owner} <${ctx.owner}@example.invalid> ${now} +0000\ncommitter ${ctx.owner} <${ctx.owner}@example.invalid> ${now} +0000\n\n${message}\n`,
        'utf8',
      );
      const mergeSha = repo.store.store('commit', commitData);
      repo.refs.set(`refs/heads/${pr.base.ref}`, mergeSha);
      pr.merged = true;
      pr.mergedAt = nowIso();
      pr.mergeCommitSha = mergeSha;
      pr.state = 'closed';
      repo.pushedAt = nowIso();
      send(res, 200, { merged: true, message: 'Pull Request successfully merged', sha: mergeSha });
      return true;
    }
  }

  // git blobs (for contents git_url)
  const blobMatch = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
  if (blobMatch !== null && method === 'GET') {
    const oid = blobMatch[1]!;
    const obj = repo.store.get(oid);
    if (obj === undefined || obj.type !== 'blob') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    send(res, 200, { sha: oid, size: obj.data.length, content: obj.data.toString('base64'), encoding: 'base64', node_id: globalId('B', oid) });
    return true;
  }

  // unknown repo route
  sendError(res, 404, 'Not Found');
  return true;
}

function contentEntryJson(repo: Repo, e: { name: string; oid: string; mode: string }, branch: string, parentPath = ''): Record<string, unknown> {
  const owner = repo.owner ?? 'forge-user';
  const isDir = isTreeMode(e.mode);
  const full = parentPath === '' ? e.name : `${parentPath}/${e.name}`;
  const obj = repo.store.get(e.oid);
  const size = obj !== undefined && obj.type === 'blob' ? obj.data.length : 0;
  return {
    name: e.name,
    path: full,
    sha: isDir ? e.oid : blobSha(obj?.type === 'blob' ? obj.data.toString('utf8') : ''),
    size: isDir ? 0 : size,
    type: isDir ? 'dir' : 'file',
    url: `/api/v3/repos/${owner}/${repo.name}/contents/${full}`,
    git_url: isDir ? `/api/v3/repos/${owner}/${repo.name}/git/trees/${e.oid}` : `/api/v3/repos/${owner}/${repo.name}/git/blobs/${e.oid}`,
    html_url: `/${owner}/${repo.name}/blob/${branch}/${full}`,
    download_url: isDir ? null : `/${owner}/${repo.name}/raw/${branch}/${full}`,
    _links: {},
  };
}

/** A hint of ?ref= passed as a query param on PUT; the body wins. */
function bodyRefHint(req: IncomingMessage): string | null {
  void req;
  return null;
}

function findMergeBase(repo: Repo, a: string, b: string): string | null {
  // ancestors of a
  const ancestorsOfA = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (ancestorsOfA.has(sha)) continue;
    ancestorsOfA.add(sha);
    const obj = repo.store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const m of obj.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm)) queue.push(m[1]!);
  }
  // BFS from b for the first common
  const seen = new Set<string>();
  const queue2 = [b];
  while (queue2.length > 0) {
    const sha = queue2.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    const obj = repo.store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const m of obj.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm)) queue2.push(m[1]!);
  }
  return null;
}

function buildRootTree(repo: Repo, files: Map<string, string>): string {
  return buildTreeFromFiles(repo.store, files);
}

export { shortSha };
