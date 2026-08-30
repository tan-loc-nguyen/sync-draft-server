import { describe, expect, it } from 'vitest';
import * as A from '@automerge/automerge';

import { applyContentUpdate, createDoc, SyncDoc, syncPeers } from './document-sync.js';

describe('applyContentUpdate', () => {
  it('applies an insertion', () => {
    const doc = applyContentUpdate(createDoc('hello'), 'hello world');

    expect(doc.content).toBe('hello world');
  });

  it('applies a deletion', () => {
    const doc = applyContentUpdate(createDoc('hello world'), 'hello');

    expect(doc.content).toBe('hello');
  });

  it('applies a replacement in the middle', () => {
    const doc = applyContentUpdate(createDoc('<p>hello world</p>'), '<p>hello brave world</p>');

    expect(doc.content).toBe('<p>hello brave world</p>');
  });

  // A replica that has not synced yet has no `content` field at all. Splicing
  // into a field that does not exist throws, so the first edit has to create it.
  it('seeds the field when editing a replica that has never synced', () => {
    const fresh = A.init<SyncDoc>();

    const doc = applyContentUpdate(fresh, '<p>typed before sync</p>');

    expect(doc.content).toBe('<p>typed before sync</p>');
  });

  it('leaves an unsynced empty replica untouched when nothing is typed', () => {
    const doc = applyContentUpdate(A.init<SyncDoc>(), '');

    expect(doc.content ?? '').toBe('');
  });

  it('records no change when the content is identical', () => {
    const before = createDoc('same');
    const after = applyContentUpdate(before, 'same');

    expect(A.getHeads(after)).toEqual(A.getHeads(before));
  });
});

describe('concurrent editing', () => {
  // This is the behaviour the original implementation could not provide: it
  // rebuilt both documents with automerge.from() on every keystroke, so the two
  // sides shared no history and one edit simply replaced the other.
  it('keeps both edits when two peers change different regions at once', () => {
    const server = createDoc('<p>intro</p><p>conclusion</p>');

    // Both peers start from the same shared history.
    let alice = A.clone<SyncDoc>(server);
    let bob = A.clone<SyncDoc>(server);

    alice = applyContentUpdate(alice, '<p>intro rewritten</p><p>conclusion</p>');
    bob = applyContentUpdate(bob, '<p>intro</p><p>conclusion expanded</p>');

    const merged = A.merge(A.merge(A.clone<SyncDoc>(server), alice), bob);

    expect(merged.content).toContain('intro rewritten');
    expect(merged.content).toContain('conclusion expanded');
  });

  it('converges to the same content on both peers regardless of merge order', () => {
    const base = createDoc('start');
    let alice = A.clone<SyncDoc>(base);
    let bob = A.clone<SyncDoc>(base);

    alice = applyContentUpdate(alice, 'start alpha');
    bob = applyContentUpdate(bob, 'beta start');

    const aliceFirst = A.merge(A.clone<SyncDoc>(alice), bob);
    const bobFirst = A.merge(A.clone<SyncDoc>(bob), alice);

    expect(aliceFirst.content).toBe(bobFirst.content);
  });
});

describe('syncPeers', () => {
  it('brings an empty peer up to date with the document', () => {
    const server = createDoc('<p>shared text</p>');
    const client = A.init<SyncDoc>();

    const [, syncedClient] = syncPeers(server, client);

    expect(syncedClient.content).toBe('<p>shared text</p>');
  });

  it('carries a peer edit back to the other side', () => {
    const server = createDoc('base');
    const [server2, client] = syncPeers(server, A.init<SyncDoc>());

    const edited = applyContentUpdate(client, 'base plus more');
    const [server3] = syncPeers(server2, edited);

    expect(server3.content).toBe('base plus more');
  });
});
