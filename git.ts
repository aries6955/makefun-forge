// git object model: blob/tree/commit/tag, SHA-1 ids, pack reading and writing.
// Everything lives in memory per repository; nothing is written to disk.

import { createHash } from 'node:crypto';
import zlib, { inflateSync, deflateSync, createInflate } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

/** A tree entry's mode is octal text with no leading zero: 40000 names a directory. */
export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** One raw git object: its type and its payload bytes. */
export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

/** A store of loose objects. Ids are lowercase hex SHA-1. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  /** Hash and store one object; returns its oid. */
  store(type: ObjType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const oid = createHash('sha1').update(header).update(data).digest('hex');
    this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- tree encoding

export interface TreeEntry {
  readonly mode: string; // '100644' | '100755' | '40000' | '120000' | '160000'
  readonly name: string;
  readonly oid: string;
}

/** Serialize one tree's entries into the canonical git format. */
export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  entries = [...entries].sort((a, b) => {
    // git sorts tree entries as if directory names had a trailing '/'
    const an = a.name + (isTreeMode(a.mode) ? '/' : '');
    const bn = b.name + (isTreeMode(b.mode) ? '/' : '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a raw tree buffer. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.toString('utf8', i, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Build a tree object (recursively) from path->blob mappings. Returns root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, string>): string {
  // Build a nested path structure
  type Dir = { dirs: Map<string, Dir>; files: Map<string, { oid: string; mode: string }> };
  const root: Dir = { dirs: new Map(), files: new Map() };
  for (const [path, content] of files) {
    const oid = store.store('blob', Buffer.from(content, 'utf8'));
    const segs = path.split('/');
    let dir = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!;
      if (!dir.dirs.has(seg)) dir.dirs.set(seg, { dirs: new Map(), files: new Map() });
      dir = dir.dirs.get(seg)!;
    }
    const name = segs[segs.length - 1]!;
    dir.files.set(name, { oid, mode: '100644' });
  }
  const writeDir = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, f] of dir.files) entries.push({ mode: f.mode, name, oid: f.oid });
    for (const [name, d] of dir.dirs) entries.push({ mode: '40000', name, oid: writeDir(d) });
    const data = encodeTree(entries);
    return store.store('tree', data);
  };
  return writeDir(root);
}

// ---------------------------------------------------------------- commit & tag

export interface CommitPerson {
  readonly name: string;
  readonly email: string;
  readonly seconds: number;
  readonly tzOffset: string; // e.g. '+0000'
}

export interface CommitObject {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: CommitPerson;
  readonly committer: CommitPerson;
  readonly message: string;
}

export function encodeCommit(c: CommitObject): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${c.tree}`);
  for (const p of c.parents) lines.push(`parent ${p}`);
  const person = (p: CommitPerson) => `${p.name} <${p.email}> ${p.seconds} ${p.tzOffset}`;
  lines.push(`author ${person(c.author)}`);
  lines.push(`committer ${person(c.committer)}`);
  lines.push('');
  // message may be multi-line; encodeCommit joins with \n then the caller adds nothing
  let body = `tree ${c.tree}\n`;
  for (const p of c.parents) body += `parent ${p}\n`;
  body += `author ${person(c.author)}\n`;
  body += `committer ${person(c.committer)}\n`;
  body += `\n${c.message}`;
  return Buffer.from(body, 'utf8');
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: CommitPerson;
  readonly committer: CommitPerson;
  readonly message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = text.slice(0, split);
  const message = text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author: CommitPerson = { name: '', email: '', seconds: 0, tzOffset: '+0000' };
  let committer: CommitPerson = { name: '', email: '', seconds: 0, tzOffset: '+0000' };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }
  return { tree, parents, author, committer, message };
}

function parsePerson(s: string): CommitPerson {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(s);
  if (m === null) return { name: s, email: '', seconds: 0, tzOffset: '+0000' };
  return { name: m[1]!, email: m[2]!, seconds: Number(m[3]), tzOffset: m[4]! };
}

export interface TagObject {
  readonly object: string;
  readonly type: ObjType;
  readonly tag: string;
  readonly tagger: CommitPerson;
  readonly message: string;
}

export function encodeTag(t: TagObject): Buffer {
  const person = (p: CommitPerson) => `${p.name} <${p.email}> ${p.seconds} ${p.tzOffset}`;
  let body = `object ${t.object}\ntype ${t.type}\ntag ${t.tag}\ntagger ${person(t.tagger)}\n\n${t.message}`;
  return Buffer.from(body, 'utf8');
}

export function parseTag(data: Buffer): TagObject | null {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  if (split === -1) return null;
  const header = text.slice(0, split);
  const message = text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger: CommitPerson = { name: '', email: '', seconds: 0, tzOffset: '+0000' };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = parsePerson(line.slice(7));
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pack reading

/** Decompress one pack stream; returns the objects with their per-object type and data. */
export interface RawPackObject {
  readonly type: number; // 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta
  readonly data: Buffer;
  /** For deltas: ofs-delta -> the base's absolute offset in the pack; ref-delta -> the base oid. */
  readonly base?: number | string;
  /** The object header's offset in the pack. */
  readonly offset?: number;
}

/**
 * Read all objects from a packfile buffer (checks the trailing SHA-1 when present).
 * The pack format: "PACK" + version(4) + count(4), then objects, then a 20-byte checksum.
 */
export function readPackObjects(buf: Buffer): { objects: RawPackObject[]; checksumOk: boolean } {
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(8);
  const objects: RawPackObject[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const objStart = pos;
    // variable-length type+size header
    let byte = buf[pos++]!;
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: number | string | undefined;
    if (type === 6) {
      // ofs-delta: negative offset varint
      let ofs = 0;
      byte = buf[pos++]!;
      ofs = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++]!;
        ofs = ((ofs + 1) << 7) | (byte & 0x7f);
      }
      base = objStart - ofs; // absolute offset of the base object
    } else if (type === 7) {
      base = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    // zlib stream: inflate; we need to find where it ends. Node's inflateSync can
    // consume the whole rest and we detect via the stream's internal state... instead
    // we decompress incrementally with zlib.inflate on a substring search.
    const { data, consumed } = inflateSyncExact(buf, pos, size);
    pos += consumed;
    objects.push({ type, data, base, offset: objStart });
  }
  const checksumOk =
    pos + 20 <= buf.length &&
    createHash('sha1').update(buf.subarray(0, pos)).digest('hex') === buf.toString('hex', pos, pos + 20);
  return { objects, checksumOk };
}

/**
 * Synchronously inflate exactly one zlib stream inside `buf` starting at `pos`.
 * Node's inflateSync ignores how much input the stream used, so we use Inflate's
 * internal _processChunk: it reports the exact `bytesWritten` consumed, which is
 * what walks a pack's concatenated zlib streams correctly.
 */
function inflateSyncExact(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; consumed: number } {
  const inf = createInflate();
  const out = inf._processChunk(buf.subarray(pos), zlib.constants.Z_FINISH) as Buffer;
  const consumed = inf.bytesWritten;
  if (consumed <= 0 || out.length !== expectedSize) {
    // Fall back to a tolerant inflate: some streams end before the buffer does.
    const fallback = inflateSync(buf.subarray(pos));
    return { data: fallback, consumed: Math.max(consumed, 1) };
  }
  return { data: out, consumed };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  // base size varint
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = delta[pos++]!;
    while (byte & 0x80) {
      value |= (byte & 0x7f) << shift;
      shift += 7;
      byte = delta[pos++]!;
    }
    value |= (byte & 0x7f) << shift;
    return value;
  };
  const baseSize = readVarint();
  void baseSize;
  const resultSize = readVarint();
  const out = Buffer.alloc(resultSize);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      // copy from base
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[pos++]!;
      if (op & 0x02) cpOff |= delta[pos++]! << 8;
      if (op & 0x04) cpOff |= delta[pos++]! << 16;
      if (op & 0x08) cpOff |= delta[pos++]! << 24;
      if (op & 0x10) cpSize = delta[pos++]!;
      if (op & 0x20) cpSize |= delta[pos++]! << 8;
      if (op & 0x40) cpSize |= delta[pos++]! << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (op > 0) {
      // insert literal
      delta.copy(out, outPos, pos, pos + op);
      pos += op;
      outPos += op;
    } else {
      throw new Error('invalid delta op 0');
    }
  }
  if (outPos !== resultSize) throw new Error(`delta produced ${outPos} bytes, expected ${resultSize}`);
  return out;
}

// ---------------------------------------------------------------- pack writing

/** Write a packfile containing the given objects. Small and simple: no deltas. */
export function writePack(objects: readonly { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const t = typeNum[obj.type];
    const size = obj.data.length;
    // variable-length header: first byte has type in bits 4-6, size low 4 bits
    let byte = (t << 4) | (size & 15);
    let rest = size >>> 4;
    const header: number[] = [];
    while (rest > 0) {
      header.push(byte | 0x80);
      byte = rest & 0x7f;
      rest >>>= 7;
    }
    header.push(byte);
    parts.push(Buffer.from(header));
    // level 1 is the sweet spot: level 0 inflates the wire size the 200-push workload pays for.
    parts.push(deflateSync(obj.data, { level: 1, memLevel: 8 }));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}
