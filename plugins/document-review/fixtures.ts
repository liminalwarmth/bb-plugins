import type { Session } from './model';
export function sessionFixture(content = '# Test\n\nI like cats.\n\nYou like tea.\n'): Session {
  const now = new Date().toISOString();
  return { formatVersion: 2, trackChanges: true, id: 'review_fixture', path: '/docs/test.md', hostId: 'host-test', rootPath: '/docs', title: 'test.md', threadId: null, content, diskContent: content, diskSha: 'test-sha', changes: [], comments: [], revision: 1, dirty: false, completedAt: now, notice: null, createdAt: now, updatedAt: now };
}
