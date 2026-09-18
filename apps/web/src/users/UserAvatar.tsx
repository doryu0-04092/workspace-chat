import { useState } from 'react';

/**
 * 利用者のアバター（F-04。機能一覧 1.3「アバターはどの画面にも出る」）。**表示名の横の飾りであり、代わりの文を持たない**
 * （同じ内容を隣の表示名が読み上げる）。アバターが無い・読めないときは表示名の頭文字を出す。
 * 退会した利用者は api が `avatarUrl` を返さない（1.5）。ここで隠すのではない。
 */
export function UserAvatar({
  user,
  size = 'h-6 w-6',
}: {
  user: { displayName: string; avatarUrl: string | null } | null;
  size?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = user?.avatarUrl;
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        className={`${size} shrink-0 self-center rounded-full border object-cover`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${size} inline-flex shrink-0 items-center justify-center self-center rounded-full bg-slate-200 text-xs text-slate-600`}
    >
      {user ? Array.from(user.displayName)[0] : '?'}
    </span>
  );
}
