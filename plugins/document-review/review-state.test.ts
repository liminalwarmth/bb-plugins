import { committedContent } from './review-state';
import { describe, expect, it } from 'vitest';
import { proposeDocument, decideChange, editDocument, editUntrackedDocument, mergeConcurrent, migrateLegacy, reconcileDisk, repairCommentAnchors } from './review-state';
import { computeChanges, makeAnchor, type Session } from './model';
import { sessionFixture } from './fixtures';
function valid(s: Session) { for (const c of s.changes) { expect(s.content.slice(c.start, c.end)).toBe(c.after); expect(c.decision).toBe('pending'); } }

describe('one editable document', () => {
  it('keeps pending proposals in the current text and archives both decisions', () => {
    const s = sessionFixture(); proposeDocument(s, s.content.replace('like cats', 'love cats').replace('tea', 'coffee'));
    expect(s.content).toContain('love cats'); const [a, b] = s.changes;
    const accepted = decideChange(s, a!.id, 'accepted'); expect(s.changes).toHaveLength(1); expect(accepted.kind).toBe('accepted');
    const rejected = decideChange(s, b!.id, 'rejected'); expect(s.changes).toHaveLength(0); expect(rejected.kind).toBe('rejected');
    expect(s.content).toContain('love cats'); expect(s.content).toContain('tea');
  });
  it('preserves pending IDs and completed choices through a mid-stream rewrite', () => {
    const s = sessionFixture('A old one.\n\nB old two.\n\nC old three.\n');
    proposeDocument(s, s.content.replaceAll('old', 'new')); const [a, b, c] = s.changes;
    decideChange(s, a!.id, 'accepted');
    proposeDocument(s, s.content.replace('C new three', 'C better three'));
    expect(s.changes.find(x => x.id === b!.id)?.after).toBe('new');
    expect(s.changes.find(x => x.id === c!.id)).toMatchObject({ before: 'old', after: 'better' });
    expect(s.content).toContain('A new one'); valid(s);
    decideChange(s, c!.id, 'rejected'); expect(s.content).toContain('C old three'); expect(s.content).toContain('A new one'); valid(s);
  });
  it('combines overlapping suggestions with their original rejection text', () => {
    const s = sessionFixture('Old opening.\n\nOld ending.\n'); const original = s.content;
    proposeDocument(s, 'New opening.\n\nNew ending.\n');
    proposeDocument(s, 'A completely different document.\n'); valid(s);
    while (s.changes.length) decideChange(s, s.changes[0]!.id, 'rejected'); expect(s.content).toBe(original);
  });
  it('refuses to build source from an invalid pending patch', () => {
    const s = sessionFixture('Original.'); proposeDocument(s, 'Proposed.'); s.changes[0]!.after = 'Does not match';
    expect(() => committedContent(s)).toThrow(/no longer matches/);
  });
  it('treats direct edits as author decisions and preserves unrelated suggestions', () => {
    const s = sessionFixture(); proposeDocument(s, s.content.replace('like cats', 'love cats').replace('tea', 'coffee')); const second = s.changes[1]!.id;
    const history = editDocument(s, s.content.replace('love cats', 'prefer dogs'));
    expect(history.some(h => h.kind === 'edited')).toBe(true); expect(s.changes).toHaveLength(1); expect(s.changes[0]!.id).toBe(second); valid(s);
  });
  it.each([
    ['Keep old passage.\n', 'Keep new passage.\n', 'Keep .\n'],
    ['Keep native.\n', 'Keep agent native.\n', 'Keep .\n'],
    ['Keep old passage.\n', 'Keep new passage.\n', 'Keep revised passage.\n'],
    ['Keep old passage.\n', 'Keep new passage.\n', 'Keep n!ew passage.\n'],
  ])('commits untracked mixed edits without creating suggestions: %s', (original, proposed, edited) => {
    const s = sessionFixture(original + '\nUntouched old ending.\n');
    proposeDocument(s, proposed + '\nUntouched new ending.\n');
    const untouched = s.changes.at(-1)!;
    s.comments.push({ id: 'note', body: 'Keep this conversation', anchor: makeAnchor(s.content, 5, 8), status: 'open', replies: [], createdAt: '' });
    const history = editUntrackedDocument(s, edited + '\nUntouched new ending.\n');
    expect(s.changes.map(c => c.id)).toEqual([untouched.id]); expect(history.some(h => h.kind === 'edited')).toBe(true);
    expect(committedContent(s)).toBe(edited + '\nUntouched old ending.\n'); expect(s.comments[0]!.body).toBe('Keep this conversation'); valid(s);
    decideChange(s, untouched.id, 'rejected'); expect(s.content).toBe(edited + '\nUntouched old ending.\n');
  });
  it('keeps a pending deletion when typing beside its point and removes it only when deleting across it', () => {
    const s = sessionFixture('Keep. Removed. End.\n'); proposeDocument(s, 'Keep. End.\n');
    const pending = s.changes[0]!;
    editUntrackedDocument(s, s.content.slice(0, pending.start) + 'X' + s.content.slice(pending.start));
    expect(s.changes).toHaveLength(1); expect(s.changes[0]!.id).toBe(pending.id);
    expect(committedContent(s)).toBe('Keep. Removed. XEnd.\n'); valid(s);
    editUntrackedDocument(s, 'Keepnd.\n');
    expect(s.changes).toHaveLength(0); expect(committedContent(s)).toBe('Keepnd.\n');
  });
  it('keeps comments anchored to edited proposed text', () => {
    const s = sessionFixture('A new sentence.\n'); const start = s.content.indexOf('new');
    s.comments.push({ id: 'note', body: 'shorter', anchor: makeAnchor(s.content, start, start + 3), status: 'open', replies: [], createdAt: '' });
    editDocument(s, 'A better sentence.\n'); expect(s.comments[0]!.anchor?.quote).toBe('new'); expect(s.content.slice(s.comments[0]!.anchor!.start, s.comments[0]!.anchor!.end)).toBe('better'); valid(s);
  });
  it('tracks and coalesces your typing, including deletion and formatting, with reversible original text', () => {
    const s = sessionFixture('Hello world.\n');
    proposeDocument(s, 'Hello world. My', 'user'); const id = s.changes[0]!.id;
    proposeDocument(s, 'Hello world. My words', 'user');
    expect(s.changes).toHaveLength(1); expect(s.changes[0]!.id).toBe(id); expect(s.changes[0]!.source).toBe('user'); valid(s);
    decideChange(s, id, 'rejected'); expect(s.content).toBe('Hello world.\n');
    proposeDocument(s, 'Hello **world**.\n', 'user'); expect(s.changes).toHaveLength(1); valid(s);
    for (const c of [...s.changes]) decideChange(s, c.id, 'rejected'); expect(s.content).toBe('Hello world.\n');
    proposeDocument(s, 'Hello worl.\n', 'user'); const deletion = s.changes[0]!.id;
    proposeDocument(s, 'Hello wor.\n', 'user'); expect(s.changes).toHaveLength(1); valid(s);
    decideChange(s, deletion, 'rejected'); expect(s.content).toBe('Hello world.\n');
  });
  it('keeps a commented deletion visible and threads revisions and decisions without resolving the conversation', () => {
    const s = sessionFixture('Hello old world.\n');
    s.comments.push({ id: 'note', body: 'Change this', anchor: makeAnchor(s.content, 6, 9), status: 'open', replies: [{ body: 'Keep context', createdAt: '' }], createdAt: '' });
    proposeDocument(s, 'Hello world.\n', 'user'); const note = () => s.comments[0]!;
    expect(note().anchor).toMatchObject({ start: 6, end: 6, quote: 'old', orphaned: false, removed: true });
    expect(note().replies.map(r => r.kind)).toEqual([undefined, 'revision']); valid(s);
    decideChange(s, s.changes[0]!.id, 'rejected');
    expect(note().anchor).toMatchObject({ start: 6, end: 10, orphaned: false, removed: false });
    expect(note().replies.map(r => r.kind)).toEqual([undefined, 'revision', 'rejected']); expect(note().status).toBe('open');
    proposeDocument(s, 'Hello better world.\n');
    expect(s.content.slice(note().anchor!.start, note().anchor!.end)).toBe('better ');
    decideChange(s, s.changes[0]!.id, 'accepted');
    expect(note().replies.at(-1)?.kind).toBe('accepted'); expect(note().body).toBe('Change this'); expect(note().status).toBe('open');
  });
  it('keeps the removed comment marker after accepting deletion and tracks links as one decision', () => {
    const s = sessionFixture('A short sentence.\n');
    s.comments.push({ id: 'note', body: 'Discuss', anchor: makeAnchor(s.content, 2, 7), status: 'open', replies: [], createdAt: '' });
    proposeDocument(s, 'A sentence.\n'); decideChange(s, s.changes[0]!.id, 'accepted');
    expect(s.comments[0]!.anchor).toMatchObject({ removed: true, orphaned: false }); expect(s.comments[0]!.replies.at(-1)?.kind).toBe('accepted');
    const before = s.content; proposeDocument(s, 'A [sentence](https://example.com).\n', 'user');
    expect(s.changes).toHaveLength(1); valid(s); decideChange(s, s.changes[0]!.id, 'rejected'); expect(s.content).toBe(before);
  });
  it('repairs an old orphan from saved text after a covering rewrite without resetting decisions', () => {
    const s = sessionFixture('Intro. We should make it easy for readers.\n');
    const original = makeAnchor(s.content, 7, 29);
    proposeDocument(s, 'Intro. You control every edit.\n'); decideChange(s, s.changes[0]!.id, 'accepted');
    s.comments.push({ id: 'legacy', body: 'Shorten', anchor: { ...original, orphaned: true }, status: 'addressed', replies: [], createdAt: '' });
    expect(repairCommentAnchors(s)).toBe(true); const a = s.comments[0]!.anchor!;
    expect(a.orphaned).toBe(false); expect(s.content.slice(a.start, a.end)).toBe('You control every edit'); expect(s.changes).toHaveLength(0);
    expect(repairCommentAnchors(s)).toBe(false);
  });
  it('merges concurrent typing and agent edits on different passages', () => {
    expect(mergeConcurrent('one two three', 'ONE two three', 'one two THREE')).toBe('ONE two THREE');
    expect(() => mergeConcurrent('one two', 'ONE two', 'OTHER two')).toThrow(/overlaps/);
    expect(mergeConcurrent('one', 'ONE', 'ONE')).toBe('ONE');
  });
  it('rebases external edits, prunes overlapping suggestions, and keeps a recovery draft on conflict', () => {
    const s = sessionFixture('A old.\n\nB old.\n'); proposeDocument(s, 'A new.\n\nB new.\n');
    const secondId = s.changes[1]!.id;
    const result = reconcileDisk(s, 'A external.\n\nB old.\n', 'external-sha');
    expect(s.content).toBe('A external.\n\nB new.\n'); expect(s.changes).toHaveLength(1); expect(s.changes[0]!.id).toBe(secondId); expect(result.history[0]!.snapshot).toContain('A new.'); valid(s);
  });
  it('migrates existing pending, accepted, and rejected choices to the editable workspace', () => {
    const base = 'A old.\n\nB old.\n\nC old.\n', changes = computeChanges(base, base.replaceAll('old', 'new'));
    changes[0]!.decision = 'accepted'; changes[1]!.decision = 'rejected';
    const { session: s, history } = migrateLegacy({ ...sessionFixture(base), formatVersion: undefined, base, baseSha: 'sha', proposal: base.replaceAll('old', 'new'), savedContent: null, savedSha: null, changes });
    expect(s.content).toBe('A new.\n\nB old.\n\nC new.\n'); expect(s.changes).toHaveLength(1); expect(history).toHaveLength(2); valid(s);
  });
  it('maintains valid ranges across repeated revisions, direct edits, and decisions', () => {
    for (let i = 0; i < 50; i++) {
      const s = sessionFixture(`first ${i} old.\n\nsecond old.\n\nthird old.\n`);
      proposeDocument(s, s.content.replaceAll('old', 'new')); valid(s);
      decideChange(s, s.changes[0]!.id, i % 2 ? 'accepted' : 'rejected'); valid(s);
      proposeDocument(s, s.content.replace('second new', 'second wonderful')); valid(s);
      editDocument(s, 'Prefix.\n\n' + s.content); valid(s);
      for (const c of [...s.changes]) { decideChange(s, c.id, 'rejected'); valid(s); }
    }
  });
});
