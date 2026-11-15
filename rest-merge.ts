// Shared squash-merge logic for REST and GraphQL.

import { collectFiles, nowIso, type PullRequest, type Repo, type Store } from './store.ts';
import { diffTrees, isAncestor } from './git-http.ts';
import { buildTreeFromFiles } from './git.ts';

/** Squash-merge `pr` onto its base branch. Returns the merge commit sha. Throws MergeConflictError on conflicts. */
export function squashMerge(store: Store, repo: Repo, pr: PullRequest, actor: string): string {
  void store;
  const headSha = repo.refs.get(`refs/heads/${pr.head.ref}`) ?? pr.head.sha;
  const baseSha = repo.refs.get(`refs/heads/${pr.base.ref}`) ?? pr.base.sha;
  const baseIsAncestor = isAncestor(repo, baseSha, headSha);
  if (!baseIsAncestor) {
    // conflict check: both sides changed the same path differently
    const mergeBase = findMergeBase(repo, baseSha, headSha);
    if (mergeBase === null) throw new MergeConflictError('no merge base');
    const baseChanges = diffTrees(repo, mergeBase, baseSha);
    const headChanges = diffTrees(repo, mergeBase, headSha);
    for (const hc of headChanges) {
      const bc = baseChanges.find((c) => c.path === hc.path);
      if (bc !== undefined && hc.after !== bc.after) throw new MergeConflictError(hc.path);
    }
  }
  const files = new Map<string, string>();
  collectFiles(repo, headSha, '', files);
  const rootTree = buildTreeFromFiles(repo.store, files);
  const now = Math.floor(Date.parse(nowIso()) / 1000);
  const message = `Squash merge PR #${pr.number}: ${pr.title}`;
  const commitData = Buffer.from(
    `tree ${rootTree}\nparent ${baseSha}\nauthor ${actor} <${actor}@example.invalid> ${now} +0000\ncommitter ${actor} <${actor}@example.invalid> ${now} +0000\n\n${message}\n`,
    'utf8',
  );
  const mergeSha = repo.store.store('commit', commitData);
  repo.refs.set(`refs/heads/${pr.base.ref}`, mergeSha);
  pr.merged = true;
  pr.mergedAt = nowIso();
  pr.mergeCommitSha = mergeSha;
  pr.state = 'closed';
  repo.pushedAt = nowIso();
  return mergeSha;
}

export class MergeConflictError extends Error {}

function findMergeBase(repo: Repo, a: string, b: string): string | null {
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
