// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at /mcp.
// Serves the modern 2026-07-28 revision (server/discover) and the legacy
// initialize handshake, with the six required tools.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, type Issue, type PullRequest, type Repo, globalId, nowIso } from './store.ts';
import { squashMerge } from './rest-merge.ts';

export interface McpContext {
  store: Store;
  owner: string;
  token: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, all' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Map the documented argument names onto the tool's own property names. */
function mapArgs(tool: (typeof TOOLS)[number], args: Record<string, unknown>): Record<string, unknown> | null {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    // exact match
    if (key in props) {
      out[key] = value;
      continue;
    }
    // normalized match
    const norm = key.toLowerCase().replace(/_/g, '');
    const hit = Object.keys(props).find((p) => p.toLowerCase().replace(/_/g, '') === norm);
    if (hit !== undefined) out[hit] = value;
  }
  // full_name: fill from owner/repo
  if ('full_name' in props && out['full_name'] === undefined) {
    const owner = out['owner'] ?? out['owner_login'] ?? out['org'] ?? out['organization'];
    const repo = out['repo'] ?? out['repository'] ?? out['name'];
    if (typeof owner === 'string' && typeof repo === 'string') out['full_name'] = `${owner}/${repo}`;
  }
  // owner fallbacks: org, organization, user...
  if (!('owner' in out) || out['owner'] === undefined) {
    const alt = out['owner_login'] ?? out['org'] ?? out['organization'] ?? out['organisation'] ?? out['user'] ?? out['user_login'] ?? out['login'] ?? out['account'] ?? out['namespace'] ?? out['owner_name'];
    if (typeof alt === 'string') out['owner'] = alt;
  }
  if (!('repo' in out) || out['repo'] === undefined) {
    const alt = out['repository'] ?? out['repository_name'];
    if (typeof alt === 'string') out['repo'] = alt;
  }
  if (!('pull_number' in out) || out['pull_number'] === undefined) {
    const alt = out['number'] ?? out['pull_request_number'] ?? out['pr_number'] ?? out['issue_number'];
    if (alt !== undefined) out['pull_number'] = alt;
  }
  // check required
  const required = (tool.inputSchema.required ?? []) as string[];
  const missing = required.filter((r) => out[r] === undefined || out[r] === null || out[r] === '');
  if (missing.length > 0) return null;
  return out;
}

function issueText(issue: Issue): string {
  return `#${issue.number} ${issue.title} [${issue.state}]`;
}

function repoText(repo: Repo): string {
  return `${repo.owner}/${repo.name} (default branch: ${repo.defaultBranch}, private: ${repo.private})`;
}

function prText(pr: PullRequest): string {
  return `#${pr.number} ${pr.title} (${pr.head.ref} -> ${pr.base.ref}) [${pr.merged ? 'merged' : pr.state}]`;
}

export function handleMcp(ctx: McpContext, req: IncomingMessage, res: ServerResponse, bodyText: string): void {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(bodyText) as JsonRpcRequest;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id ?? null;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const meta = (request._meta ?? {}) as Record<string, unknown>;

  const sendResult = (result: unknown): void => {
    const revision = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
      : '2026-07-28';
    const payload = { jsonrpc: '2.0', id, result };
    sendJson(res, 200, payload, {
      'mcp-protocol-version': revision,
      'mcp-method': method,
    });
  };
  const sendError = (code: number, message: string, httpStatus = 200): void => {
    sendJson(res, httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    sendResult({
      protocolVersion: '2026-07-28',
      serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
    });
    return;
  }
  if (method === 'initialize') {
    sendResult({
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
      serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      capabilities: { tools: {} },
    });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // notifications take no response body per JSON-RPC; answer 202 like the reference
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end();
    return;
  }
  if (method === 'tools/list') {
    sendResult({ tools: TOOLS });
    return;
  }
  if (method === 'ping') {
    sendResult({});
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // tool name: allow server prefixes, matched by suffix case-insensitively
    const tool = TOOLS.find((t) => {
      if (t.name === name) return true;
      const lower = name.toLowerCase();
      return lower.endsWith(t.name.toLowerCase()) && lower !== t.name.toLowerCase();
    });
    if (tool === undefined) {
      sendError(-32602, `Unknown tool: ${name}`);
      return;
    }
    const mapped = mapArgs(tool, args);
    if (mapped === null) {
      sendError(-32602, `Missing required arguments for ${tool.name}`);
      return;
    }
    try {
      const result = callTool(ctx, tool.name, mapped);
      sendResult({ content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }], isError: false });
    } catch (err) {
      sendResult({
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      });
    }
    return;
  }
  sendError(-32601, `Method not found: ${method}`);
}

function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args['name'] ?? '');
      const repo = ctx.store.createRepo(null, repoName, {
        description: args['description'] !== undefined ? String(args['description']) : null,
        private: args['private'] === true,
      });
      return repoText(repo);
    }
    case 'get_repo': {
      const repo = ctx.store.getRepo(String(args['owner'] ?? ''), String(args['repo'] ?? ''));
      if (repo === undefined) throw new Error('repository not found');
      return repoText(repo);
    }
    case 'create_issue': {
      const repo = ctx.store.getRepo(String(args['owner'] ?? ''), String(args['repo'] ?? ''));
      if (repo === undefined) throw new Error('repository not found');
      const issue = ctx.store.createIssue(repo, { title: String(args['title'] ?? ''), body: args['body'] !== undefined ? String(args['body']) : '' });
      return issueText(issue);
    }
    case 'list_issues': {
      const repo = ctx.store.getRepo(String(args['owner'] ?? ''), String(args['repo'] ?? ''));
      if (repo === undefined) throw new Error('repository not found');
      const state = args['state'] !== undefined ? String(args['state']) : 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.number - a.number);
      return list.map(issueText).join('\n');
    }
    case 'create_pull_request': {
      const repo = ctx.store.getRepo(String(args['owner'] ?? ''), String(args['repo'] ?? ''));
      if (repo === undefined) throw new Error('repository not found');
      const pr = ctx.store.createPull(repo, {
        title: String(args['title'] ?? ''),
        head: String(args['head'] ?? ''),
        base: String(args['base'] ?? ''),
      });
      return prText(pr);
    }
    case 'merge_pull_request': {
      const repo = ctx.store.getRepo(String(args['owner'] ?? ''), String(args['repo'] ?? ''));
      if (repo === undefined) throw new Error('repository not found');
      const number = Number(args['pull_number']);
      const pr = repo.pulls.find((p) => p.number === number);
      if (pr === undefined) throw new Error('pull request not found');
      const sha = squashMerge(ctx.store, repo, pr, ctx.owner);
      return `merged #${pr.number} as ${sha}`;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export { globalId, nowIso };
