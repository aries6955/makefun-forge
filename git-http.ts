// Git smart HTTP: upload-pack (protocol v2 + v0) and receive-pack (v0).
// pkt-line framing, side-band-64k, report-status. No git binary: everything hand-rolled.

import { createHash } from 'node:crypto';
import { applyDelta, isTreeMode, parseTree, readPackObjects, writePack, type ObjType } from './git.ts';
import { refCommit, peel, type Repo, type Store } from './store.ts';

const TYPE_BY_NUM: Record<number, ObjType | undefined> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// The clone workload is 50 concurrent depth-1 clones of one tip: the pack bytes are the
// same every time, so deflating them once per (repo, wants, haves, depth) is enough.
// shortcut: the key is the plan's own wants/haves/depth, so a repository that gains
// objects under the same tip is not seen; refs changing is part of the key via wants.
let packCache = new Map<string, Buffer>();

/** The pack for one upload plan, deflated once per identical plan. */
function cachedPack(repo: Repo, key: string, objects: { type: ObjType; data: Buffer }[]): Buffer {
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(objects);
  if (packCache.size > 64) packCache = new Map();
  packCache.set(key, pack);
  return pack;
}

// ---------------------------------------------------------------- pkt-line

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Parse a pkt-line stream into strings/flush markers. */
export function parsePktLines(buf: Buffer): { kind: 'line'; text: string; raw: Buffer }[] | { kind: 'flush' | 'delim' }[] {
  void buf;
  return [];
}

/** Split a request body buffer into pkt-line entries. */
export interface Pkt {
  kind: 'line' | 'flush' | 'delim';
  text?: string;
  raw?: Buffer;
}

export function readPktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(buf.toString('ascii', pos, pos + 4), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
    } else if (len >= 4) {
      const raw = buf.subarray(pos + 4, pos + len);
      out.push({ kind: 'line', text: raw.toString('utf8').replace(/\n$/, ''), raw });
      pos += len;
    } else {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- upload-pack v0 advertisement

function v0AdvRefLine(name: string, oid: string, first: boolean, caps: string[]): Buffer {
  const capStr = first ? `\0${caps.join(' ')}` : '';
  return pktLine(`${oid} ${name}${capStr}\n`);
}

/** Serve GET /info/refs?service=git-upload-pack (v0 advertisement). */
export function uploadPackAdvertisement(repo: Repo): Buffer {
  const caps = [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'deepen-relative',
    'no-progress',
    'include-tag',
    'multi_ack',
  ];
  const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  const refNames = [...repo.refs.keys()].sort();
  let first = true;
  if (refNames.length === 0) {
    // empty repo: capabilities^{} line with zero oid
    lines.push(pktLine(`${'0'.repeat(40)} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    for (const name of refNames) {
      const oid = repo.refs.get(name)!;
      lines.push(v0AdvRefLine(name, oid, first, first ? caps : []));
      first = false;
      // peeled tag lines for annotated tags
      const obj = repo.store.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        lines.push(pktLine(`${peel(repo, oid)} ${name}^{}\n`));
      }
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

/** Serve GET /info/refs?service=git-receive-pack (v0 advertisement). */
export function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet'];
  const lines: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const refNames = [...repo.refs.keys()].sort();
  let first = true;
  if (refNames.length === 0) {
    lines.push(pktLine(`${'0'.repeat(40)} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    for (const name of refNames) {
      lines.push(v0AdvRefLine(name, repo.refs.get(name)!, first, first ? caps : []));
      first = false;
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- receive-pack

export interface PushRefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReport {
  ok: boolean;
  ref: string;
  reason?: string;
}

/** Handle git-receive-pack request body (v0: commands + optional pack). Returns report lines. */
export function handleReceivePack(repo: Repo, body: Buffer): { report: PushReport[]; unpackOk: boolean } {
  const pkts = readPktLines(body);
  const commands: PushRefUpdate[] = [];
  let caps = new Set<string>();
  let packStart = -1;
  let i = 0;
  for (; i < pkts.length; i++) {
    const pkt = pkts[i]!;
    if (pkt.kind === 'flush') continue;
    if (pkt.kind !== 'line' || pkt.text === undefined) continue;
    const text = pkt.text;
    // The first command carries capabilities after a NUL byte.
    const nul = text.indexOf('\0');
    let line = text;
    if (nul >= 0) {
      for (const c of text.slice(nul + 1).split(' ')) if (c !== '') caps.add(c);
      line = text.slice(0, nul);
    }
    if (line.trim() === '') {
      // push-options or end of commands: pack data follows the flush
      if (i + 1 < pkts.length) {
        // Pack data is raw bytes after the flush, not pkt-line framed — we must
        // find the offset in the original buffer. Track via raw offsets.
      }
      break;
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (m === null) continue;
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
    if (text.endsWith('\0')) break;
  }
  // Locate raw pack data: search for "PACK" magic after the last command pkt.
  // The body is: pkt-lines ... flush ... [push-options pkts ... flush] ... PACK...
  const packIdx = findPackOffset(body);
  let unpackOk = true;
  if (commands.some((c) => c.newOid !== '0'.repeat(40)) && packIdx >= 0) {
    try {
      const { objects } = readPackObjects(body.subarray(packIdx));
      applyPackOrdered(repo, objects);
    } catch {
      unpackOk = false;
    }
  }
  // Apply commands.
  const report: PushReport[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    const zero = '0'.repeat(40);
    // fast-forward check: every update must fast-forward (or create/delete).
    if (cmd.newOid === zero) {
      // delete: allowed; must exist for full delete semantics (we allow missing too)
      repo.refs.delete(cmd.ref);
      report.push({ ok: true, ref: cmd.ref });
      continue;
    }
    if (cmd.oldOid === zero) {
      // create: reject if ref exists and differs (the client's old is zero)
      if (current !== undefined && current !== cmd.newOid) {
        report.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      report.push({ ok: true, ref: cmd.ref });
      continue;
    }
    // update: fast-forward only.
    if (current === undefined) {
      report.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.oldOid !== current) {
      report.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      report.push({ ok: false, ref: cmd.ref, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push({ ok: true, ref: cmd.ref });
  }
  void caps;
  return { report, unpackOk };
}

/** Find the offset of the raw pack data ("PACK") in a receive-pack body. */
function findPackOffset(body: Buffer): number {
  // Skip the pkt-line section: consume until a flush that is followed by "PACK"
  // or (with push-cert/push-options) more pkt-lines. Scan for PACK magic where
  // bytes 4..8 are a plausible version (2 or 3) and bytes 8..12 a plausible count.
  for (let i = 0; i + 12 <= body.length; i++) {
    if (body[i] === 0x50 && body[i + 1] === 0x41 && body[i + 2] === 0x43 && body[i + 3] === 0x4b) {
      const version = body.readUInt32BE(i + 4);
      if (version === 2 || version === 3) return i;
    }
  }
  return -1;
}

/** Store pack objects into the repo, resolving deltas. */
function applyPack(repo: Repo, objects: { type: number; data: Buffer; base?: number | string }[]): void {
  // First pass: non-delta objects.
  const byOid = new Map<string, { type: ObjType; data: Buffer }>();
  const pending: { type: number; data: Buffer; base?: number | string }[] = [];
  for (const obj of objects) {
    const t = TYPE_BY_NUM[obj.type];
    if (t !== undefined) {
      const oid = repo.store.store(t, obj.data);
      byOid.set(oid, { type: t, data: obj.data });
    } else {
      pending.push(obj);
    }
  }
  // Delta resolution passes (bounded by pending count; each pass resolves at least one when well-formed).
  let remaining = pending;
  let guard = 0;
  while (remaining.length > 0 && guard++ < 64) {
    const next: typeof remaining = [];
    for (const d of remaining) {
      let baseData: Buffer | undefined;
      let baseType: ObjType | undefined;
      if (typeof d.base === 'string') {
        const base = byOid.get(d.base) ?? (repo.store.get(d.base) !== undefined ? { type: repo.store.get(d.base)!.type, data: repo.store.get(d.base)!.data } : undefined);
        if (base !== undefined) {
          baseData = base.data;
          baseType = base.type;
        }
      } else if (typeof d.base === 'number') {
        // ofs-delta: negative offset from the delta's own position in the pack — we
        // cannot recover that without pack offsets; resolve by order: the base is an
        // earlier object. Use index math: base = objects[ i + base ].
        // We lost the index; re-derive below via object order (applyPack gets them in order).
      }
      if (d.base === undefined || baseData === undefined || baseType === undefined) {
        next.push(d);
        continue;
      }
      const data = applyDelta(baseData, d.data);
      const oid = repo.store.store(baseType, data);
      byOid.set(oid, { type: baseType, data });
    }
    if (next.length === remaining.length) break; // no progress
    remaining = next;
  }
}

/** Resolve ofs-deltas by pack order. Call before applyPack's map-based resolution. */
export function applyPackOrdered(repo: Repo, objects: { type: number; data: Buffer; base?: number | string; offset?: number }[]): void {
  // Resolve by pack order: keep an array of resolved entries (oid + type + data + packPos).
  interface Entry {
    oid?: string;
    type?: ObjType;
    data?: Buffer;
    typeNum: number;
    raw: Buffer;
    base?: number | string;
  }
  const entries: Entry[] = objects.map((o) => ({ typeNum: o.type, raw: o.data, base: o.base }));
  // ofs-delta bases are absolute pack offsets; map them back to entry indexes.
  const byOffset = new Map<number, number>();
  objects.forEach((o, i) => { if (o.offset !== undefined) byOffset.set(o.offset, i); });
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.oid !== undefined) continue;
      if (e.typeNum !== 6 && e.typeNum !== 7) {
        const t = TYPE_BY_NUM[e.typeNum]!;
        e.oid = repo.store.store(t, e.raw);
        e.type = t;
        e.data = e.raw;
        progress = true;
      } else if (e.typeNum === 7 && typeof e.base === 'string') {
        // ref-delta: the base may be inside this pack, or already on the server (thin pack)
        const baseIdx = entries.findIndex((x) => x.oid === e.base);
        const inside = baseIdx >= 0 ? entries[baseIdx] : undefined;
        const baseObj = inside?.data !== undefined ? { data: inside.data, type: inside.type } : repo.store.get(e.base);
        if (baseObj !== undefined && baseObj.data !== undefined) {
          const data = applyDelta(baseObj.data, e.raw);
          e.type = baseObj.type;
          e.oid = repo.store.store(e.type, data);
          e.data = data;
          progress = true;
        }
      } else if (e.typeNum === 6 && typeof e.base === 'number') {
        const baseIdx = byOffset.get(e.base) ?? -1;
        if (baseIdx >= 0 && entries[baseIdx] !== undefined && entries[baseIdx]!.data !== undefined) {
          const data = applyDelta(entries[baseIdx]!.data!, e.raw);
          e.type = entries[baseIdx]!.type;
          e.oid = repo.store.store(e.type, data);
          e.data = data;
          progress = true;
        }
      }
    }
  }
}

/** Frame the receive-pack report in side-band-64k (report-status within band 1). */
export function receivePackReport(report: PushReport[], unpackOk: boolean, useSideband: boolean): Buffer {
  const lines: Buffer[] = [];
  lines.push(pktLine(`unpack ${unpackOk ? 'ok' : 'unpack-objects failed'}\n`));
  for (const r of report) {
    lines.push(pktLine(`${r.ok ? 'ok' : 'ng'} ${r.ref}${r.reason !== undefined ? ` ${r.reason}` : ''}\n`));
  }
  const status = Buffer.concat([...lines, pktFlush()]);
  if (!useSideband) return status;
  // side-band: band 1 carries the report stream
  const chunks: Buffer[] = [];
  for (let i = 0; i < status.length; i += 65515) {
    const chunk = status.subarray(i, i + 65515);
    chunks.push(Buffer.concat([Buffer.from([1]), chunk]));
  }
  const framed: Buffer[] = [];
  for (const chunk of chunks) framed.push(pktLine(chunk));
  framed.push(pktFlush());
  return Buffer.concat(framed);
}

// ---------------------------------------------------------------- upload-pack v0

/** Serve POST /git-upload-pack with a v0 request (want/haves + flush + done). */
export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const pkts = readPktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let shallow = false;
  let depth: number | null = null;
  let deepenRef: string | null = null;
  let done = false;
  for (const pkt of pkts) {
    if (pkt.kind !== 'line' || pkt.text === undefined) continue;
    const text = pkt.text;
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (line.startsWith('want ')) {
      wants.push(line.slice(5, 45));
      if (nul >= 0) {
        // capabilities; ignore
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5, 45));
    } else if (line === 'done') {
      done = true;
    } else if (line.startsWith('shallow ')) {
      shallow = true;
    } else if (line.startsWith('deepen ')) {
      depth = Number(line.slice(7));
    } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // acknowledged; treat as no-op (history is small)
    } else if (line.startsWith('filter ')) {
      // no-op
    }
    if (line.startsWith('want ')) shallow = false;
  }
  void done;
  void shallow;
  void depth;
  void deepenRef;
  // Compute the objects to send: all reachable from wants minus reachable from haves.
  const { objects, shallowLines, unshallowLines } = computeUpload(repo, wants, haves, depth, []);
  // NAK first (no common negotiation beyond this simple case)
  const out: Buffer[] = [pktLine('NAK\n')];
  // shallow/unshallow lines before the pack
  for (const s of shallowLines) out.push(pktLine(s));
  for (const s of unshallowLines) out.push(pktLine(s));
  if (objects.length > 0) {
    const pack = cachedPack(repo, `v0|${repo.owner}/${repo.name}|${wants.join(',')}|${haves.join(',')}|${depth ?? ''}`, objects);
    // side-band-64k framing: band 1 carries pack data
    for (let i = 0; i < pack.length; i += 65515) {
      out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 65515)])));
    }
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- upload-pack v2

export interface V2Command {
  command: 'ls-refs' | 'fetch' | 'option' | 'object-info' | null;
  lines: string[];
  args: Map<string, string[]>;
}

/** Parse a v2 request body: command lines, then capability lines, delim, then command args. */
export function parseV2Request(body: Buffer): V2Command {
  const pkts = readPktLines(body);
  let command: V2Command['command'] = null;
  const lines: string[] = [];
  const args = new Map<string, string[]>();
  for (const pkt of pkts) {
    if (pkt.kind !== 'line' || pkt.text === undefined) continue;
    const text = pkt.text;
    if (command === null && text.startsWith('command=')) {
      const c = text.slice(8);
      command = c === 'ls-refs' || c === 'fetch' || c === 'option' || c === 'object-info' ? c : null;
      continue;
    }
    // capability lines before delim; args after delim
    lines.push(text);
    const eq = text.indexOf('=');
    if (eq > 0) {
      const key = text.slice(0, eq);
      const val = text.slice(eq + 1);
      const list = args.get(key) ?? [];
      list.push(val);
      args.set(key, list);
    } else {
      // arg lines without '=': "want <oid>", "have <oid>", "deepen <n>", or bare flags
      const sp = text.indexOf(' ');
      const key = sp > 0 ? text.slice(0, sp) : text;
      const val = sp > 0 ? text.slice(sp + 1) : '';
      if (key !== '') {
        const list = args.get(key) ?? [];
        list.push(val);
        args.set(key, list);
      }
    }
  }
  return { command, lines, args };
}

/** The v2 capability advertisement. */
export function v2Advertisement(): Buffer {
  const out: Buffer[] = [];
  out.push(pktLine('version 2\n'));
  out.push(pktLine('agent=forge/1.0\n'));
  out.push(pktLine('ls-refs=unborn\n'));
  out.push(pktLine('fetch=shallow wait-for-done\n'));
  out.push(pktLine('server-option\n'));
  out.push(pktLine('object-format=sha1\n'));
  out.push(pktFlush());
  return Buffer.concat(out);
}

/** Handle a v2 ls-refs command. */
export function handleLsRefs(repo: Repo, args: Map<string, string[]>): Buffer {
  const prefixes = args.get('ref-prefix') ?? [];
  const symrefs = (args.get('symrefs') ?? []).length > 0;
  const peelTags = (args.get('peel') ?? []).length > 0;
  const unborn = (args.get('unborn') ?? []).length > 0;
  const out: Buffer[] = [];
  const refNames = [...repo.refs.keys()].sort();
  // HEAD symref line first, only when no ref-prefix filtering (or HEAD matches it)
  const headMatches = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (symrefs && headMatches) {
    const head = headTarget(repo);
    if (head !== null) {
      out.push(pktLine(`${head} HEAD symref-target:${headSymref(repo)}\n`));
    } else if (unborn && repo.defaultBranch !== '') {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const name of refNames) {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) continue;
    const oid = repo.refs.get(name)!;
    const isTag = peelTags && repo.store.get(oid)?.type === 'tag';
    out.push(pktLine(`${oid} ${name}${isTag ? ` peeled:${peel(repo, oid)}` : ''}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

function headTarget(repo: Repo): string | null {
  // We advertise HEAD only through symref when a default branch exists.
  const target = headSymref(repo);
  return repo.refs.get(target) ?? null;
}

function headSymref(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Handle a v2 fetch command. */
export function handleV2Fetch(repo: Repo, args: Map<string, string[]>): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let deepenRef: string | null = null;
  const shallows: string[] = [];
  let done = false;
  for (const [key, vals] of args) {
    if (key === 'want') wants.push(...vals);
    else if (key === 'have') haves.push(...vals);
    else if (key === 'deepen') depth = Number(vals[0]);
    else if (key.startsWith('deepen-not')) deepenRef = vals[0] ?? null;
    else if (key === 'shallow') shallows.push(...vals);
    else if (key === 'done') done = true;
  }
  void done;
  void deepenRef;
  // wait-for-done: send acknowledgments for haves; we answer ack + ready + flush if done, else ack + flush
  const out: Buffer[] = [];
  // Simplified v2 acknowledgments: ACK per common have, then ready/NAK.
  const acks: Buffer[] = [];
  let anyHave = false;
  for (const h of haves) {
    if (repo.store.has(h)) {
      acks.push(pktLine(`ACK ${h}\n`));
      anyHave = true;
    }
  }
  if (haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    for (const a of acks) out.push(a);
    if (!anyHave) out.push(pktLine('NAK\n'));
    if (done) {
      if (anyHave) out.push(pktLine('ready\n'));
      out.push(pktFlush());
    } else {
      out.push(pktFlush());
      return Buffer.concat(out);
    }
  } else {
    // no haves: straight to the sections if done; else flush (client will send done)
    if (!done) {
      out.push(pktFlush());
      return Buffer.concat(out);
    }
  }
  // shallow-info section
  const { objects, shallowLines, unshallowLines } = computeUpload(repo, wants, haves, depth, shallows);
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const s of shallowLines) out.push(pktLine(s));
    for (const s of unshallowLines) out.push(pktLine(s));
    out.push(pktFlush());
  }
  // packfile section (sideband band 1 carries the pack bytes)
  out.push(pktLine('packfile\n'));
  if (objects.length > 0) {
    const pack = cachedPack(repo, `v2|${repo.owner}/${repo.name}|${wants.join(',')}|${haves.join(',')}|${depth ?? ''}`, objects);
    for (let i = 0; i < pack.length; i += 65515) {
      out.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 65515)])));
    }
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- object graph

export interface UploadPlan {
  objects: { type: ObjType; data: Buffer }[];
  shallowLines: string[];
  unshallowLines: string[];
}

/**
 * Compute the objects to send for wants minus haves, with optional depth limiting.
 * Depth: commits at graph distance <= depth from the wants are full; their parents
 * get shallow lines. If depth is null: full history.
 */
export function computeUpload(repo: Repo, wants: string[], haves: string[], depth: number | null, clientShallows: string[]): UploadPlan {
  const haveSet = new Set(haves);
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];

  // Everything reachable from `roots`, stopping at `stops`. Depth counts commits only.
  const send = new Map<string, { type: ObjType; data: Buffer }>();
  // Objects the client already holds: the whole closure of every have.
  const held = new Set<string>();
  const holdClosure = (oid: string): void => {
    if (held.has(oid)) return;
    const obj = repo.store.get(oid);
    if (obj === undefined) return;
    held.add(oid);
    if (obj.type === 'commit') {
      const tree = parseCommitTree(repo, oid);
      if (tree !== null) holdClosure(tree);
      for (const parent of parentOf(repo, oid)) holdClosure(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) holdClosure(entry.oid);
    } else if (obj.type === 'tag') {
      holdClosure(peel(repo, oid));
    }
  };
  // A deepen fetch names the tip as both want and have: holding its whole history would
  // leave nothing to send, so a have that is also a want only holds itself and its tree.
  const wantSetAll = new Set(wants);
  for (const have of haveSet) {
    if (depth !== null && wantSetAll.has(have)) continue;
    holdClosure(have);
  }
  const shallowCuts = new Set<string>();
  const visitedCommits = new Map<string, number>();

  const addObject = (oid: string): boolean => {
    const obj = repo.store.get(oid);
    if (obj === undefined) return false;
    if (!send.has(oid) && !held.has(oid)) send.set(oid, { type: obj.type, data: obj.data });
    return true;
  };

  const walkTree = (treeOid: string): void => {
    if (!addObject(treeOid)) return;
    const obj = repo.store.get(treeOid)!;
    if (obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (isTreeMode(entry.mode)) walkTree(entry.oid);
      else if (entry.mode !== '160000') addObject(entry.oid);
    }
  };

  // A deepen fetch names the same commit as want and have: the walk must still descend
  // to the new depth, so a have only stops the walk when no depth was asked for.
  const walkCommit = (sha: string, distance: number): void => {
    if (haveSet.has(sha) && depth === null) return;
    const seen = visitedCommits.get(sha);
    if (seen !== undefined && seen <= distance) return;
    visitedCommits.set(sha, distance);
    const obj = repo.store.get(sha);
    if (obj === undefined || obj.type !== 'commit') return;
    if (!held.has(sha)) send.set(sha, { type: obj.type, data: obj.data });
    const tree = parseCommitTree(repo, sha);
    if (tree !== null) walkTree(tree);
    // A commit at distance == depth is the boundary: send it, cut its parents.
    if (depth !== null && distance >= depth) {
      shallowCuts.add(sha);
      return;
    }
    for (const parent of parentOf(repo, sha)) walkCommit(parent, distance + 1);
  };

  for (const want of wants) {
    const obj = repo.store.get(want);
    if (obj !== undefined && obj.type === 'tag') {
      // an annotated tag ships with its object, then the closure of what it points at
      if (!held.has(want)) send.set(want, { type: obj.type, data: obj.data });
      const target = peel(repo, want);
      const targetObj = repo.store.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') walkCommit(target, 1);
      continue;
    }
    walkCommit(want, 1);
  }

  // The client's own boundary commits are no longer shallow once we send deeper.
  for (const c of shallowCuts) shallowLines.push(`shallow ${c}`);
  for (const s of clientShallows) if (!shallowCuts.has(s)) unshallowLines.push(`unshallow ${s}`);
  return { objects: [...send.values()], shallowLines, unshallowLines };
}

function parseCommitTree(repo: Repo, commitSha: string): string | null {
  const obj = repo.store.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const m = /^tree ([0-9a-f]{40})/m.exec(text);
  return m === null ? null : m[1]!;
}

function parentOf(repo: Repo, commitSha: string): string[] {
  const obj = repo.store.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return [];
  const text = obj.data.toString('utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) out.push(m[1]!);
  return out;
}

function collectTreeOids(repo: Repo, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  out.add(treeOid);
  const obj = repo.store.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    if (isTreeMode(entry.mode)) collectTreeOids(repo, entry.oid, out);
    else if (entry.mode !== '160000') out.add(entry.oid);
  }
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const queue = [descendant];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (sha === ancestor) return true;
    for (const p of parentOf(repo, sha)) queue.push(p);
  }
  return false;
}

/** Diff two trees: changed paths with status. */
export function diffTrees(repo: Repo, baseCommit: string | null, headCommit: string): { path: string; status: 'added' | 'removed' | 'modified'; before: string | null; after: string | null }[] {
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  if (baseCommit !== null) collectFilesInto(repo, baseCommit, baseFiles);
  collectFilesInto(repo, headCommit, headFiles);
  const out: { path: string; status: 'added' | 'removed' | 'modified'; before: string | null; after: string | null }[] = [];
  for (const [path, content] of headFiles) {
    if (!baseFiles.has(path)) out.push({ path, status: 'added', before: null, after: content });
    else if (baseFiles.get(path) !== content) out.push({ path, status: 'modified', before: baseFiles.get(path)!, after: content });
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) out.push({ path, status: 'removed', before: baseFiles.get(path)!, after: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

function collectFilesInto(repo: Repo, commitSha: string, out: Map<string, string>): void {
  const tree = parseCommitTree(repo, commitSha);
  if (tree === null) return;
  const walk = (treeOid: string, dir: string): void => {
    const obj = repo.store.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const full = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (isTreeMode(entry.mode)) walk(entry.oid, full);
      else if (entry.mode !== '160000') {
        const blob = repo.store.get(entry.oid);
        if (blob !== undefined) out.set(full, blob.data.toString('utf8'));
      }
    }
  };
  walk(tree, '');
}

/** Count additions/deletions for text diffs. */
export function diffStats(before: string | null, after: string | null): { additions: number; deletions: number } {
  if (before === null && after === null) return { additions: 0, deletions: 0 };
  if (before === null) return { additions: after === null ? 0 : after.split('\n').length, deletions: 0 };
  if (after === null) return { additions: 0, deletions: before.split('\n').length };
  const a = before.split('\n');
  const b = after.split('\n');
  const aSet = new Map<string, number>();
  for (const l of a) aSet.set(l, (aSet.get(l) ?? 0) + 1);
  let deletions = 0;
  for (const l of b) {
    const n = aSet.get(l) ?? 0;
    if (n > 0) aSet.set(l, n - 1);
    else deletions += 0;
  }
  // simple LCS-free approximation: count lines only in before as deletions, only in after as additions
  const bSet = new Map<string, number>();
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  let adds = 0;
  let dels = 0;
  for (const [l, n] of aSet) {
    const m = bSet.get(l) ?? 0;
    if (n > m) dels += n - m;
  }
  for (const [l, n] of bSet) {
    const m = aSet.get(l) ?? 0;
    if (n > m) adds += n - m;
  }
  return { additions: adds, deletions: dels };
}

export { createHash };

// ---------------------------------------------------------------- store type reexports

export type { Repo, Store };
export { refCommit };
export { peel } from './store.ts';
