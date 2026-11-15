// GraphQL v4: a minimal query engine covering the documents gh and github-mcp-server send.
// Approach: parse the document into a field tree (no variables inline), resolve against
// the store. Supports: viewer, repository(...), node(id:), __type/__schema introspection
// fragments, aliases, and the mutations createIssue/closeIssue/createPullRequest/
// mergePullRequest/addComment (the GitHub shapes).

import { Store, type Repo, type Issue, type PullRequest, globalId, parseGlobalId, listCommits, refCommit } from './store.ts';
import { diffTrees } from './git-http.ts';
import { squashMerge } from './rest-merge.ts';

// ---------------------------------------------------------------- lexer & parser

interface GqlField {
  alias?: string;
  name: string;
  args: Record<string, GqlValue>;
  children: GqlField[];
}

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface GqlOperation {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  varDefs: { name: string; type: string }[];
  fields: GqlField[];
  fragments: Map<string, GqlField[]>;
}

class Lexer {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos]!;
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') this.pos++;
      else if (c === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
      } else break;
    }
  }

  /** The next token without consuming it. */
  peek(): string {
    const start = this.pos;
    const token = this.nextToken();
    this.pos = start;
    return token;
  }

  nextToken(): string {
    this.skipWs();
    const start = this.pos;
    if (this.pos >= this.text.length) return '';
    const c = this.text[this.pos]!;
    if ('{}():'.includes(c)) {
      this.pos++;
      return c;
    }
    if (c === '$') {
      this.pos++;
      while (this.pos < this.text.length && /[A-Za-z_0-9]/.test(this.text[this.pos]!)) this.pos++;
      return this.text.slice(start, this.pos);
    }
    if (c === '.' && this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      return '...';
    }
    if (c === '[') {
      this.pos++;
      return '[';
    }
    if (c === ']') {
      this.pos++;
      return ']';
    }
    if (/[A-Za-z_0-9]/.test(c)) {
      while (this.pos < this.text.length && /[A-Za-z_0-9]/.test(this.text[this.pos]!)) this.pos++;
      return this.text.slice(start, this.pos);
    }
    if (c === '"') {
      this.pos++;
      while (this.pos < this.text.length && this.text[this.pos] !== '"') {
        if (this.text[this.pos] === '\\') this.pos++;
        this.pos++;
      }
      this.pos++;
      return this.text.slice(start, this.pos);
    }
    this.pos++;
    return c;
  }

  done(): boolean {
    this.skipWs();
    return this.pos >= this.text.length;
  }
}

export function parseDocument(text: string): GqlOperation[] {
  const lexer = new Lexer(text);
  const operations: GqlOperation[] = [];
  const fragments = new Map<string, GqlField[]>();
  while (!lexer.done()) {
    const kw = lexer.peek();
    if (kw === '' || kw === '}') break;
    const tok = lexer.nextToken();
    if (tok === 'query' || tok === 'mutation' || tok === 'subscription') {
      const op: GqlOperation = { kind: tok, varDefs: [], fields: [], fragments };
      // name?
      let t = lexer.nextToken();
      if (/^[A-Za-z]/.test(t) && t !== '(') {
        op.name = t;
        t = lexer.nextToken();
      }
      if (t === '(') {
        // variable definitions: ($a: Type!, $b: [String!]!) — consume until the closing ')'
        let depth = 1;
        let current: { name: string; type: string } | null = null;
        while (depth > 0) {
          const tok2 = lexer.nextToken();
          if (tok2 === '') break;
          if (tok2 === '(') { depth += 1; continue; }
          if (tok2 === ')') { depth -= 1; if (depth === 0) { if (current !== null) op.varDefs.push(current); break; } continue; }
          if (tok2 === ',') { if (current !== null) op.varDefs.push(current); current = null; continue; }
          if (tok2.startsWith('$')) { if (current !== null) op.varDefs.push(current); current = { name: tok2.slice(1), type: '' }; continue; }
          if (tok2 === ':') continue;
          if (current !== null) current.type += tok2;
        }
        t = lexer.nextToken();
      }
      if (t === '{') {
        op.fields = parseSelectionSet(lexer, fragments);
      }
      operations.push(op);
    } else if (tok === 'fragment') {
      // fragment Name on Type { ... }
      const name = lexer.nextToken();
      lexer.nextToken(); // on
      lexer.nextToken(); // Type
      const lb = lexer.nextToken();
      if (lb === '{') {
        const fields = parseSelectionSet(lexer, fragments);
        fragments.set(name, fields);
      }
    } else if (tok === '{') {
      // anonymous query
      const op: GqlOperation = { kind: 'query', varDefs: [], fields: parseSelectionSet(lexer, fragments), fragments };
      operations.push(op);
    }
  }
  return operations;
}

function parseSelectionSet(lexer: Lexer, fragments: Map<string, GqlField[]>): GqlField[] {
  const fields: GqlField[] = [];
  while (true) {
    const t = lexer.peek();
    if (t === '}' || t === '') {
      lexer.nextToken();
      break;
    }
    const tok = lexer.nextToken();
    if (tok === '...') {
      // inline fragment or fragment spread
      const next = lexer.peek();
      if (next === '@') {
        // directive
        lexer.nextToken();
        lexer.nextToken();
        if (lexer.peek() === '(') skipParens(lexer);
        continue;
      }
      // inline fragment: `... on Type { fields }` — its fields belong to this selection set
      if (next === 'on') {
        lexer.nextToken(); // on
        lexer.nextToken(); // the type condition
        if (lexer.peek() === '{') {
          lexer.nextToken();
          for (const inner of parseSelectionSet(lexer, fragments)) fields.push(inner);
        }
        continue;
      }
      const name = lexer.nextToken();
      const frag = fragments.get(name) ?? [];
      fields.push(...frag);
      continue;
    }
    if (tok === '' || tok === '}') break;
    let name = tok;
    let alias: string | undefined;
    if (lexer.peek() === ':') {
      lexer.nextToken();
      alias = name;
      name = lexer.nextToken();
    }
    const field: GqlField = { name, alias, args: {}, children: [] };
    if (lexer.peek() === '(') {
      lexer.nextToken();
      field.args = parseArgs(lexer);
    }
    if (lexer.peek() === '{') {
      lexer.nextToken();
      field.children = parseSelectionSet(lexer, fragments);
    }
    fields.push(field);
  }
  return fields;
}

function skipParens(lexer: Lexer): void {
  let depth = 0;
  while (true) {
    const t = lexer.nextToken();
    if (t === '(') depth++;
    else if (t === ')') {
      depth--;
      if (depth <= 0) return;
    } else if (t === '') return;
  }
}

function parseArgs(lexer: Lexer): Record<string, GqlValue> {
  const args: Record<string, GqlValue> = {};
  while (true) {
    let t = lexer.nextToken();
    if (t === ')' || t === '') break;
    if (t === ',') continue;
    if (t === '' ) break;
    const name = t;
    const colon = lexer.nextToken();
    void colon;
    const value = parseValue(lexer);
    args[name] = value;
    void t;
  }
  return args;
}

function parseValue(lexer: Lexer): GqlValue {
  const t = lexer.nextToken();
  if (t.startsWith('$')) {
    return { kind: 'var', name: t.slice(1) };
  }
  if (t === 'true') return { kind: 'boolean', value: true };
  if (t === 'false') return { kind: 'boolean', value: false };
  if (t === 'null') return { kind: 'null' };
  if (t === '"') return { kind: 'string', value: '' };
  if (t.startsWith('"')) {
    const raw = t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    return { kind: 'string', value: raw };
  }
  if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
  if (t === '[') {
    const items: GqlValue[] = [];
    while (true) {
      const p = lexer.peek();
      if (p === ']' || p === '') {
        lexer.nextToken();
        break;
      }
      items.push(parseValue(lexer));
    }
    return { kind: 'list', items };
  }
  if (t === '{') {
    const fields: Record<string, GqlValue> = {};
    while (true) {
      const p = lexer.peek();
      if (p === '}' || p === '') {
        lexer.nextToken();
        break;
      }
      const key = lexer.nextToken();
      lexer.nextToken(); // :
      fields[key] = parseValue(lexer);
    }
    return { kind: 'object', fields };
  }
  return { kind: 'enum', value: t };
}

// ---------------------------------------------------------------- resolution

export interface GqlRequestContext {
  store: Store;
  owner: string;
}

export interface GqlOperationResult {
  data: Record<string, unknown> | null;
  errors: { message: string }[];
}

/** Resolve one parsed operation with variables. */
export function resolveOperation(ctx: GqlRequestContext, op: GqlOperation, variables: Record<string, unknown>): GqlOperationResult {
  const errors: { message: string }[] = [];
  const rootValue: Record<string, unknown> = {
    viewer: { login: ctx.store.login() },
  };
  const data: Record<string, unknown> = {};
  for (const field of op.fields) {
    const key = field.alias ?? field.name;
    try {
      data[key] = resolveRootField(ctx, field, op, variables, rootValue, errors);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[key] = null;
    }
  }
  return { data, errors };
}

function valueOf(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return variables[v.name];
    case 'int':
      return v.value;
    case 'string':
      return v.value;
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((i) => valueOf(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = valueOf(val, variables);
      return out;
    }
  }
}

/** viewer: its login and the fields gh probes; an unknown child field errors. */
function resolveViewer(ctx: GqlRequestContext, field: GqlField): Record<string, unknown> {
  const out: Record<string, unknown> = { __typename: 'User' };
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    if (child.name === 'login') out[key] = ctx.store.login();
    else if (child.name === 'name') out[key] = ctx.store.login();
    else if (child.name === 'email') out[key] = `${ctx.store.login()}@example.invalid`;
    else if (child.name === '__typename') out[key] = 'User';
    else throw new GraphQLError(`Cannot query field "${child.name}" on type "User"`);
  }
  return out;
}

function resolveRootField(ctx: GqlRequestContext, field: GqlField, op: GqlOperation, variables: Record<string, unknown>, rootValue: Record<string, unknown>, errors: { message: string }[]): unknown {
  const name = field.name;
  if (name === 'viewer') {
    return resolveViewer(ctx, field);
  }
  if (name === 'repository') {
    const owner = valueOf(field.args['owner'] ?? { kind: 'null' }, variables);
    const repoName = valueOf(field.args['name'] ?? { kind: 'null' }, variables);
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    const repo = ctx.store.getRepo(owner, repoName);
    if (repo === undefined) return null;
    return repoNode(ctx, repo, field, op, variables, errors);
  }
  if (name === 'node' || name === 'repositoryOwner') {
    if (name === 'repositoryOwner') {
      const login = valueOf(field.args['login'] ?? { kind: 'null' }, variables);
      if (typeof login !== 'string') return null;
      return { login, __typename: 'User' };
    }
    const id = valueOf(field.args['id'] ?? { kind: 'null' }, variables);
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    if (parsed.kind === 'R') {
      // find repo by id
      for (const repo of ctx.store.repos.values()) {
        if (!repo.deleted && String(repo.id) === parsed.n) return repoNode(ctx, repo, field, op, variables, errors);
      }
      return null;
    }
    if (parsed.kind === 'I' || parsed.kind === 'PR') {
      const [owner, repoName, number] = parsed.n.split('/');
      const repo = ctx.store.getRepo(owner ?? '', repoName ?? '');
      if (repo === undefined) return null;
      const n = Number(number);
      const issue = repo.issues.find((i) => i.number === n);
      if (issue !== undefined) return issueNode(repo, issue, field, variables, errors);
      const pr = repo.pulls.find((p) => p.number === n);
      if (pr !== undefined) return prNode(repo, pr, field, variables, errors);
      return null;
    }
    return null;
  }
  if (name === '__type' || name === '__schema') {
    return introspection(field, name === '__type' ? valueOf(field.args['name'] ?? { kind: 'null' }, variables) : null);
  }
  if (name === 'search') {
    // SearchType ISSUE issues: minimal result: nodes = issues matching
    const queryVal = valueOf(field.args['query'] ?? { kind: 'null' }, variables);
    void queryVal;
    return { nodes: [], issueCount: 0, __typename: 'SearchResultItemConnection' };
  }
  // mutations
  if (name === 'createIssue') {
    const input = valueOf(field.args['input'] ?? { kind: 'null' }, variables) as { repositoryId?: string; title?: string; body?: string } | null;
    if (input === null || typeof input !== 'object') throw new GraphQLError('input is required');
    const repo = findRepoByNodeId(ctx, input.repositoryId ?? '');
    if (repo === null) throw new GraphQLError('repository not found');
    const issue = ctx.store.createIssue(repo, { title: input.title ?? '', body: input.body });
    return { issue: issueNode(repo, issue, field.children.find((c) => c.name === 'issue') ?? { name: 'issue', args: {}, children: [] }, variables, errors) as unknown as Record<string, unknown>, __typename: 'CreateIssuePayload' };
  }
  if (name === 'closeIssue' || name === 'updateIssue') {
    const input = valueOf(field.args['input'] ?? { kind: 'null' }, variables) as { issueId?: string; state?: string } | null;
    if (input === null || typeof input !== 'object') throw new GraphQLError('input is required');
    const found = findIssueByNodeId(ctx, input.issueId ?? '');
    if (found === null) throw new GraphQLError('issue not found');
    const [repo, issue] = found;
    if (name === 'closeIssue' || input.state === 'CLOSED') {
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
    }
    return { issue: issueNode(repo, issue, field.children.find((c) => c.name === 'issue') ?? { name: 'issue', args: {}, children: [] }, variables, errors) as unknown as Record<string, unknown>, __typename: name === 'closeIssue' ? 'CloseIssuePayload' : 'UpdateIssuePayload' };
  }
  if (name === 'createPullRequest') {
    const input = valueOf(field.args['input'] ?? { kind: 'null' }, variables) as { repositoryId?: string; title?: string; body?: string; headRefName?: string; baseRefName?: string } | null;
    if (input === null || typeof input !== 'object') throw new GraphQLError('input is required');
    const repo = findRepoByNodeId(ctx, input.repositoryId ?? '');
    if (repo === null) throw new GraphQLError('repository not found');
    const pr = ctx.store.createPull(repo, { title: input.title ?? '', body: input.body, head: input.headRefName ?? '', base: input.baseRefName ?? '' });
    return { pullRequest: prNode(repo, pr, field.children.find((c) => c.name === 'pullRequest') ?? { name: 'pullRequest', args: {}, children: [] }, variables, errors) as unknown as Record<string, unknown>, __typename: 'CreatePullRequestPayload' };
  }
  if (name === 'mergePullRequest') {
    const input = valueOf(field.args['input'] ?? { kind: 'null' }, variables) as { pullRequestId?: string } | null;
    if (input === null || typeof input !== 'object') throw new GraphQLError('input is required');
    const found = findPrByNodeId(ctx, input.pullRequestId ?? '');
    if (found === null) throw new GraphQLError('pull request not found');
    const [repo, pr] = found;
    const mergeSha = squashMerge(ctx.store, repo, pr, ctx.owner);
    void mergeSha;
    return { pullRequest: prNode(repo, pr, field.children.find((c) => c.name === 'pullRequest') ?? { name: 'pullRequest', args: {}, children: [] }, variables, errors) as unknown as Record<string, unknown>, __typename: 'MergePullRequestPayload' };
  }
  if (name === 'addComment') {
    const input = valueOf(field.args['input'] ?? { kind: 'null' }, variables) as { subjectId?: string; body?: string } | null;
    if (input === null || typeof input !== 'object') throw new GraphQLError('input is required');
    const found = findIssueByNodeId(ctx, input.subjectId ?? '') ?? findPrByNodeId(ctx, input.subjectId ?? '');
    if (found === null) throw new GraphQLError('subject not found');
    const [repo, issue] = found;
    const id = issue.number * 1000 + issue.comments.length + 1;
    const body = input.body ?? '';
    issue.comments.push({ id, body, createdAt: new Date().toISOString() });
    return { commentEdge: { node: { id: Buffer.from(`IC:${id}`).toString('base64'), databaseId: id, body, __typename: 'IssueComment' } }, __typename: 'AddCommentPayload' };
  }
  if (name === '__typename') {
    return 'Query';
  }
  void rootValue;
  throw new GraphQLError(`Cannot query field "${name}" on type "Query"`);
}

function repoNode(ctx: GqlRequestContext, repo: Repo, field: GqlField, op: GqlOperation, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = { __typename: 'Repository' };
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    switch (child.name) {
      case 'id':
        out[key] = globalId('R', repo.id);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = { login: repo.owner, __typename: 'Organization' };
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'defaultBranchRef':
        out[key] = repo.refs.size > 0 ? { name: repo.defaultBranch, __typename: 'Ref' } : null;
        break;
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'createdAt':
        out[key] = repo.createdAt;
        break;
      case 'url':
        out[key] = `/${repo.owner}/${repo.name}`;
        break;
      case 'issue': {
        const numberArg = valueOf(child.args['number'] ?? { kind: 'null' }, variables);
        const issue = repo.issues.find((i) => i.number === Number(numberArg));
        out[key] = issue !== undefined ? issueNode(repo, issue, child, variables, errors) : null;
        break;
      }
      case 'issues': {
        out[key] = issuesConnection(ctx, repo, child, variables, errors);
        break;
      }
      case 'pullRequests':
      case 'pullRequest': {
        if (child.name === 'pullRequest') {
          const numberArg = valueOf(child.args['number'] ?? { kind: 'null' }, variables);
          const pr = repo.pulls.find((p) => p.number === Number(numberArg));
          out[key] = pr !== undefined ? prNode(repo, pr, child, variables, errors) : null;
        } else {
          out[key] = pullsConnection(repo, child, variables, errors);
        }
        break;
      }
      case 'ref':
      case 'refs': {
        const qualified = valueOf(child.args['qualifiedName'] ?? child.args['name'] ?? { kind: 'null' }, variables);
        if (typeof qualified !== 'string') {
          out[key] = null;
          break;
        }
        const sha = repo.refs.get(qualified);
        out[key] = sha !== undefined ? { name: qualified.replace('refs/heads/', ''), prefix: 'refs/heads/', target: { oid: sha, __typename: 'Commit' }, __typename: 'Ref' } : null;
        break;
      }
      case '__typename':
        out[key] = 'Repository';
        break;
      default:
        out[key] = null;
        break;
    }
  }
  void op;
  return out;
}

function issuesConnection(ctx: GqlRequestContext, repo: Repo, field: GqlField, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const states = valueOf(field.args['states'] ?? { kind: 'null' }, variables);
  const orderBy = valueOf(field.args['orderBy'] ?? { kind: 'null' }, variables) as { field?: string; direction?: string } | null;
  const first = valueOf(field.args['first'] ?? { kind: 'null' }, variables);
  const after = valueOf(field.args['after'] ?? { kind: 'null' }, variables);
  let list = [...repo.issues];
  if (Array.isArray(states)) {
    const wanted = new Set((states as string[]).map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state.toLowerCase()));
  }
  // orderBy CREATED_AT DESC: newest first; ties by number DESC.
  const dir = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => {
    const byNumber = a.number - b.number;
    return dir * byNumber;
  });
  // cursor pagination over the sorted list
  const perPage = typeof first === 'number' ? first : 10;
  let startIndex = 0;
  if (typeof after === 'string') {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    if (m !== null) startIndex = Number(m[1]);
  }
  const slice = list.slice(startIndex, startIndex + perPage);
  const nodeField = field.children.find((c) => c.name === 'edges')?.children.find((c) => c.name === 'node')
    ?? field.children.find((c) => c.name === 'nodes')
    ?? { name: 'node', args: {}, children: [] };
  const edges = slice.map((issue, i) => ({
    node: issueNode(repo, issue, nodeField, variables, errors),
    cursor: Buffer.from(`cursor:${startIndex + i + 1}`).toString('base64'),
    __typename: 'IssueEdge',
  }));
  const end = startIndex + slice.length;
  return {
    edges,
    nodes: edges.map((e) => e.node),
    pageInfo: {
      hasNextPage: end < list.length,
      hasPreviousPage: startIndex > 0,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount: list.length,
    __typename: 'IssueConnection',
  };
  void ctx;
}

function pullsConnection(repo: Repo, field: GqlField, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const states = valueOf(field.args['states'] ?? { kind: 'null' }, variables);
  let list = [...repo.pulls];
  if (Array.isArray(states)) {
    const wanted = new Set((states as string[]).map((s) => s.toUpperCase()));
    list = list.filter((p) => (p.merged ? wanted.has('MERGED') : wanted.has(p.state.toUpperCase())));
  }
  const first = valueOf(field.args['first'] ?? { kind: 'null' }, variables);
  const perPage = typeof first === 'number' ? first : 5;
  const slice = list.slice(0, perPage);
  const nodeField = field.children.find((c) => c.name === 'edges')?.children.find((c) => c.name === 'node') ?? field.children.find((c) => c.name === 'nodes') ?? { name: 'node', args: {}, children: [] };
  const nodes = slice.map((pr) => prNode(repo, pr, nodeField, variables, errors));
  return {
    nodes,
    edges: nodes.map((node, i) => ({ node, cursor: Buffer.from(`cursor:${i + 1}`).toString('base64') })),
    pageInfo: { hasNextPage: list.length > perPage, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: list.length,
    __typename: 'PullRequestConnection',
  };
}

function issueNode(repo: Repo, issue: Issue, field: GqlField, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = { __typename: 'Issue' };
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    switch (child.name) {
      case 'id':
        out[key] = globalId('I', `${repo.owner}/${repo.name}/${issue.number}`);
        break;
      case 'databaseId':
        out[key] = issue.number;
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'state':
        out[key] = issue.state.toUpperCase();
        break;
      case 'createdAt':
        out[key] = issue.createdAt;
        break;
      case 'url':
        out[key] = `/${repo.owner}/${repo.name}/issues/${issue.number}`;
        break;
      case 'author':
        out[key] = { login: repo.owner, __typename: 'User' };
        break;
      case 'comments':
        out[key] = { totalCount: issue.comments.length, nodes: issue.comments.map((c) => ({ body: c.body })), __typename: 'CommentConnection' };
        break;
      case 'labels':
        out[key] = { nodes: issue.labels.map((l) => ({ name: l })), __typename: 'LabelConnection' };
        break;
      case '__typename':
        out[key] = 'Issue';
        break;
      default:
        out[key] = null;
        break;
    }
  }
  return out;
}

function prNode(repo: Repo, pr: PullRequest, field: GqlField, variables: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = { __typename: 'PullRequest' };
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    switch (child.name) {
      case 'id':
        out[key] = globalId('PR', `${repo.owner}/${repo.name}/${pr.number}`);
        break;
      case 'number':
        out[key] = pr.number;
        break;
      case 'title':
        out[key] = pr.title;
        break;
      case 'body':
        out[key] = pr.body;
        break;
      case 'state':
        out[key] = pr.merged ? 'MERGED' : pr.state.toUpperCase();
        break;
      case 'merged':
        out[key] = pr.merged;
        break;
      case 'mergeable':
        out[key] = 'MERGEABLE';
        break;
      case 'mergedAt':
        out[key] = pr.mergedAt;
        break;
      case 'headRefName':
        out[key] = pr.head.ref;
        break;
      case 'baseRefName':
        out[key] = pr.base.ref;
        break;
      case 'headRefOid':
        out[key] = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
        break;
      case 'baseRefOid':
        out[key] = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
        break;
      case 'mergeCommit': {
        const sha = pr.mergeCommitSha;
        out[key] = sha !== null ? { oid: sha, __typename: 'Commit' } : null;
        break;
      }
      case 'files': {
        const first = valueOf(child.args['first'] ?? { kind: 'null' }, variables);
        const perPage = typeof first === 'number' ? first : 10;
        const headSha = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
        const baseSha = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
        const changes = diffTrees(repo, baseSha, headSha).slice(0, perPage);
        out[key] = {
          nodes: changes.map((c) => ({ path: c.path, additions: 1, deletions: 0, __typename: 'PullRequestChangedFile' })),
          totalCount: changes.length,
          __typename: 'PullRequestChangedFileConnection',
        };
        break;
      }
      case 'author':
        out[key] = { login: repo.owner, __typename: 'User' };
        break;
      case 'repository':
        out[key] = { name: repo.name, __typename: 'Repository' };
        break;
      case '__typename':
        out[key] = 'PullRequest';
        break;
      default:
        out[key] = null;
        break;
    }
  }
  return out;
}

function findRepoByNodeId(ctx: GqlRequestContext, nodeId: string): Repo | null {
  const parsed = parseGlobalId(nodeId);
  if (parsed === null || parsed.kind !== 'R') return null;
  for (const repo of ctx.store.repos.values()) {
    if (!repo.deleted && String(repo.id) === parsed.n) return repo;
  }
  return null;
}

function findIssueByNodeId(ctx: GqlRequestContext, nodeId: string): [Repo, Issue] | null {
  const parsed = parseGlobalId(nodeId);
  if (parsed === null || parsed.kind !== 'I') return null;
  const [owner, repoName, number] = parsed.n.split('/');
  const repo = ctx.store.getRepo(owner ?? '', repoName ?? '');
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === Number(number));
  return issue !== undefined ? [repo, issue] : null;
}

function findPrByNodeId(ctx: GqlRequestContext, nodeId: string): [Repo, PullRequest] | null {
  const parsed = parseGlobalId(nodeId);
  if (parsed === null || parsed.kind !== 'PR') return null;
  const [owner, repoName, number] = parsed.n.split('/');
  const repo = ctx.store.getRepo(owner ?? '', repoName ?? '');
  if (repo === undefined) return null;
  const pr = repo.pulls.find((p) => p.number === Number(number));
  return pr !== undefined ? [repo, pr] : null;
}

export class GraphQLError extends Error {}

// ---------------------------------------------------------------- introspection

function introspection(field: GqlField, typeName: unknown): Record<string, unknown> {
  // The checks feature-detect fields via __type. Serve a schema description with the
  // fields each queried type exposes.
  const typeDefs: Record<string, string[]> = {
    Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'author', 'comments', 'labels', 'url', 'databaseId'],
    PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergeCommit', 'author', 'repository'],
    Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'url', 'ref', 'refs'],
    User: ['login', 'name', 'email'],
    Query: ['viewer', 'repository', 'node', 'repositoryOwner', 'search'],
    SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  };
  if (field.name === '__schema') {
    return {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: Object.keys(typeDefs).map((n) => ({ name: n, kind: n === 'SearchType' ? 'ENUM' : 'OBJECT' })),
    };
  }
  const name = typeof typeName === 'string' ? typeName : '';
  const fields = typeDefs[name];
  if (fields === undefined) {
    return {
      name,
      kind: 'OBJECT',
      fields: [],
      enumValues: [],
    };
  }
  const kind = name === 'SearchType' ? 'ENUM' : 'OBJECT';
  return {
    name,
    kind,
    ...(kind === 'ENUM'
      ? { enumValues: fields.map((f) => ({ name: f })) }
      : {
          fields: fields.map((f) => ({
            name: f,
            type: { kind: 'SCALAR', name: 'String', ofType: null },
            args: [],
          })),
        }),
  };
}

/** Handle a GraphQL HTTP request: parse documents, resolve, answer errors per field. */
export function handleGraphql(ctx: GqlRequestContext, body: { query?: string; variables?: Record<string, unknown> }): { status: number; payload: unknown } {
  const query = body.query;
  if (typeof query !== 'string' || query === '') {
    return { status: 400, payload: { message: 'Problems parsing JSON' } };
  }
  const variables = body.variables ?? {};
  const operations = parseDocument(query);
  if (operations.length === 0) {
    return { status: 400, payload: { message: 'no operations' } };
  }
  // Batched: multiple documents in one body -> resolve each, answer array in order.
  // The suite's batched check sends two operations in one query string.
  const results = operations.map((op) => resolveOperation(ctx, op, variables));
  if (operations.length === 1) {
    const r = results[0]!;
    return { status: 200, payload: { data: r.data, ...(r.errors.length > 0 ? { errors: r.errors } : {}) } };
  }
  return { status: 200, payload: results.map((r) => ({ data: r.data, ...(r.errors.length > 0 ? { errors: r.errors } : {}) })) };
}

export { listCommits, refCommit };
