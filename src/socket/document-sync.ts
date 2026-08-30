import * as A from '@automerge/automerge';

export type SyncDoc = {
  content: string;
};

/**
 * Creates the initial document. Only ever called once per document — every
 * other participant receives this history through the sync protocol, so all
 * copies share a common ancestor and can genuinely merge.
 */
export const createDoc = (initialContent = ''): A.Doc<SyncDoc> =>
  A.from<SyncDoc>({ content: initialContent });

/**
 * Turns "here is the new full text" into the smallest possible splice.
 *
 * Editors hand back a whole document on every keystroke. Writing that string
 * into the CRDT wholesale would record it as one replacement of the entire
 * field, and two people typing at once would then conflict over the whole
 * document. Narrowing the change to the region that actually differs lets
 * Automerge merge concurrent edits character by character.
 */
export const applyContentUpdate = (doc: A.Doc<SyncDoc>, next: string): A.Doc<SyncDoc> => {
  const prev = doc.content ?? '';

  if (prev === next) {
    return doc;
  }

  // A replica that has not synced yet has no `content` field, and splicing into
  // a field that does not exist throws. Create it on the first edit instead.
  if (typeof doc.content !== 'string') {
    return A.change(doc, (draft) => {
      draft.content = next;
    });
  }

  // Longest common prefix.
  const limit = Math.min(prev.length, next.length);
  let start = 0;
  while (start < limit && prev[start] === next[start]) {
    start++;
  }

  // Longest common suffix, without overlapping the prefix.
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }

  return A.change(doc, (draft) => {
    A.splice(draft, ['content'], start, prevEnd - start, next.slice(start, nextEnd));
  });
};

/**
 * Runs the Automerge sync protocol between two documents until neither has
 * anything further to send. Used directly in tests; the socket layer drives the
 * same message exchange incrementally across the wire.
 */
export const syncPeers = (
  left: A.Doc<SyncDoc>,
  right: A.Doc<SyncDoc>
): [A.Doc<SyncDoc>, A.Doc<SyncDoc>] => {
  let leftState = A.initSyncState();
  let rightState = A.initSyncState();
  let leftDoc = left;
  let rightDoc = right;

  for (let i = 0; i < 20; i++) {
    const [nextLeftState, leftMessage] = A.generateSyncMessage(leftDoc, leftState);
    leftState = nextLeftState;

    if (leftMessage) {
      [rightDoc, rightState] = A.receiveSyncMessage(rightDoc, rightState, leftMessage);
    }

    const [nextRightState, rightMessage] = A.generateSyncMessage(rightDoc, rightState);
    rightState = nextRightState;

    if (rightMessage) {
      [leftDoc, leftState] = A.receiveSyncMessage(leftDoc, leftState, rightMessage);
    }

    if (!leftMessage && !rightMessage) {
      break;
    }
  }

  return [leftDoc, rightDoc];
};
