import { describe, expect, it } from 'vitest';
import { toUserSummary, USER_SUMMARY_SELECT } from './user-summary';

// 機能一覧 1.3（アバターはどの画面にも出る）・1.5（退会した利用者のアバターは表示しない）。
// 要約はすべての経路がここを通るため、退会した利用者の avatarUrl を返さないことはここで担保する。
describe('利用者の要約（UserSummary）', () => {
  const user = {
    id: '01920000-0000-7000-8000-000000000001',
    loginId: 'alice',
    displayName: 'アリス',
    avatarUrl: '/avatars/01920000-0000-7000-8000-000000000001/u/a.png',
    deletedAt: null,
  };

  it('アバターの配信 URL を返す', () => {
    expect(toUserSummary(user)).toEqual({
      id: user.id,
      userId: 'alice',
      displayName: 'アリス',
      avatarUrl: user.avatarUrl,
    });
  });

  it('アバターが無ければ null を返す', () => {
    expect(toUserSummary({ ...user, avatarUrl: null }).avatarUrl).toBeNull();
  });

  it('退会した利用者のアバターは返さない', () => {
    expect(toUserSummary({ ...user, deletedAt: new Date() }).avatarUrl).toBeNull();
  });

  it('要約を作るために引く列に、アバターと退会の時刻を含める', () => {
    expect(USER_SUMMARY_SELECT).toMatchObject({ avatarUrl: true, deletedAt: true });
  });
});
