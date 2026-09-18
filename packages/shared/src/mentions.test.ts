import { describe, expect, it } from 'vitest';
import { broadcastMentionsOf } from './mentions';

// 機能一覧 9.2（F-21）: 本文から `@here` / `@channel` を拾う規則は、個人メンションの `MENTION_PATTERN` と同じで、大文字小文字によらない。
describe('broadcastMentionsOf', () => {
  it('本文の @here / @channel を、大文字小文字によらず拾う', () => {
    expect([...broadcastMentionsOf('@HERE と @Channel へ')].sort()).toEqual(['channel', 'here']);
    expect([...broadcastMentionsOf('みなさん @channel')]).toEqual(['channel']);
  });

  it('前に英数字が付く・後ろに英数字が続く綴りは拾わない', () => {
    for (const body of ['mail@here', '@heres', '@here_team', '@channels', 'x@channel']) {
      expect([...broadcastMentionsOf(body)]).toEqual([]);
    }
  });
});
