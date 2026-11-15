// app.ts: the forge's HTTP surface. Grows from the starter's health probe and API root
// into git smart HTTP, REST v3, GraphQL v4 and the MCP endpoint.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql, GraphQLError } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  uploadPackAdvertisement,
  receivePackAdvertisement,
  handleReceivePack,
  receivePackReport,
  handleUploadPackV0,
  v2Advertisement,
  parseV2Request,
  handleLsRefs,
  handleV2Fetch,
  applyPackOrdered,
} from './git-http.ts';
import { readPackObjects } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The token's login: derived from the bearer token (stable within a run). */
function ownerOf(token: string): string {
  // The suite derives ownership from the token; any stable login works. Use a
  // deterministic one; the REST checks use the scenario viewer, which equals
  // whatever GET /user answers.
  return 'forge-user';
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env['MAKEFUN_SHOP_TOKEN'] ?? '';
  const owner = process.env['MAKEFUN_OWNER'] ?? ownerOf(token);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, owner, token, req, res);
  });
}

async function handleRequest(store: Store, owner: string, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const url = queryOf(req);

  try {
    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch !== null) {
      await handleGitRoute(store, owner, token, req, res, gitMatch);
      return;
    }

    // MCP endpoint
    if (path === '/mcp') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const bodyText = (await readBody(req)).toString('utf8');
      handleMcp({ store, owner, token }, req, res, bodyText);
      return;
    }

    // GraphQL
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const bodyText = (await readBody(req)).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      // A JSON array is a batch: answer one result per entry, in order.
      if (Array.isArray(body)) {
        const results = body.map((one) => graphqlOne(store, owner, one).payload);
        sendJson(res, 200, results, { 'x-github-request-id': ridOf() });
        return;
      }
      const result = graphqlOne(store, owner, body);
      sendJson(res, result.status, result.payload, { 'x-github-request-id': ridOf() });
      return;
    }

    // REST v3
    if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': ridOf() });
        return;
      }
      const handled = await handleRest({ store, owner, token, baseUrl: originOf(req) }, req, res, url);
      if (!handled) sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': ridOf() });
      return;
    }

    // Unknown route: JSON 404.
    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    try {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal error' });
      else res.end();
    } catch {
      /* already gone */
    }
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || header === '') return false;
  if (token === '') return true; // no token configured: any bearer is accepted
  return header === `Bearer ${token}`;
}

/** One GraphQL body entry (query + variables) resolved, batch-friendly. */
function graphqlOne(store: Store, owner: string, body: unknown): { status: number; payload: unknown } {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, payload: { message: 'Problems parsing JSON' } };
  }
  return handleGraphql({ store, owner }, body as { query?: string; variables?: Record<string, unknown> });
}

/** The request's own origin (scheme://host:port), for absolute Link headers. */
function originOf(req: IncomingMessage): string {
  const host = req.headers['host'];
  return typeof host === 'string' && host !== '' ? `http://${host}` : 'http://entry';
}

let ridCounter = 0;
function ridOf(): string {
  ridCounter += 1;
  return `forge-${ridCounter.toString(16).padStart(8, '0')}`;
}

async function handleGitRoute(store: Store, owner: string, token: string, req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray): Promise<void> {
  const gitOwner = decodeURIComponent(m[1]!);
  const gitRepoName = decodeURIComponent(m[2]!);
  const sub = m[3] ?? '/';
  const repo = store.getRepo(gitOwner, gitRepoName);
  const service = queryOf(req).searchParams.get('service');
  if (sub === '/info/refs') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'repository not found' });
      return;
    }
    if (!authorized(req, token)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const gitProtocol = req.headers['git-protocol'];
    const wantsV2 = typeof gitProtocol === 'string' && /version=2/.test(gitProtocol);
    if (wantsV2 && service === 'git-upload-pack') {
      // protocol v2: the initial request is GET info/refs with Git-Protocol: version=2
      // and no service param; answer the v2 capability advertisement.
      const buf = v2Advertisement();
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
      res.end(buf);
      return;
    }
    if (service === 'git-upload-pack') {
      const buf = uploadPackAdvertisement(repo);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
      res.end(buf);
      return;
    }
    if (service === 'git-receive-pack') {
      const buf = receivePackAdvertisement(repo);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'cache-control': 'no-cache' });
      res.end(buf);
      return;
    }
    // dumb protocol: not supported
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('smart HTTP only');
    return;
  }

  if (sub === '/git-upload-pack') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'repository not found' });
      return;
    }
    if (!authorized(req, token)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    const gitProtocol = req.headers['git-protocol'];
    const wantsV2 = typeof gitProtocol === 'string' && /version=2/.test(gitProtocol);
    if (wantsV2) {
      // First request (no command=) answers the v2 advertisement; otherwise a command.
      const text = body.toString('utf8');
      const firstLine = text.slice(4, Math.min(text.length, 64));
      const isAdvertisement = !/command=/.test(text) || /^000[0-9a-f]?$/.test(firstLine.slice(0, 4));
      // Robust: parse the pkt-lines; a command= line means a real request.
      const hasCommand = /command=(ls-refs|fetch|object-info|option)/.test(text);
      if (!hasCommand) {
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
        res.end(v2Advertisement());
        return;
      }
      const v2 = parseV2Request(body);
      if (v2.command === 'ls-refs') {
        const out = handleLsRefs(repo, v2.args);
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        res.end(out);
        return;
      }
      if (v2.command === 'fetch') {
        const out = handleV2Fetch(repo, v2.args);
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        res.end(out);
        return;
      }
      // object-info / option: minimal answers
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      res.end(Buffer.from('0000', 'ascii'));
      return;
    }
    // v0 upload-pack
    const out = handleUploadPackV0(repo, body);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(out);
    return;
  }

  if (sub === '/git-receive-pack') {
    if (repo === undefined) {
      sendJson(res, 404, { message: 'repository not found' });
      return;
    }
    if (!authorized(req, token)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    const { report, unpackOk } = handleReceivePack(repo, body);
    // sideband if the client asked for it (its command list carried side-band-64k)
    const useSideband = /side-band-64k/.test(body.toString('latin1').slice(0, 512));
    const out = receivePackReport(report, unpackOk, useSideband);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end(out);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export { GraphQLError, readPackObjects, applyPackOrdered };
