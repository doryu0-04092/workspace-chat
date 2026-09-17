import { type FormEvent, useState } from 'react';
import { errorMessage } from '../api/client';
import { type Profile, useMyProfile, useUpdateProfile } from './queries';

/** 自分のプロフィールの画面（F-04。機能一覧 1.3）。表示名とステータスを変える。ユーザーID は変えられず、アバター画像は api にまだ無い。 */
export function ProfilePage() {
  const profile = useMyProfile();

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold">プロフィール</h1>
      {profile.isError && (
        <p role="alert" className="mt-4 text-red-700">
          プロフィールを読み込めませんでした。{errorMessage(profile.error)}
        </p>
      )}
      {profile.data && <ProfileForm profile={profile.data} />}
    </main>
  );
}

/**
 * 編集のフォーム。入力欄は開いた時点のプロフィールで埋める。
 * **ステータスは絵文字とテキストの1セット**——両方を空にすると消し（null を送る）、片方だけなら送らずに理由を出す（api も 400 で断る）。
 */
function ProfileForm({ profile }: { profile: Profile }) {
  const update = useUpdateProfile();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [emoji, setEmoji] = useState(profile.status?.emoji ?? '');
  const [text, setText] = useState(profile.status?.text ?? '');
  const [invalid, setInvalid] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if ((emoji === '') !== (text === '')) {
      setInvalid('ステータスは、絵文字とテキストの両方を入れるか、両方を空にしてください。');
      // 前の保存の結果（「保存しました」や断られた理由）を残さない
      update.reset();
      return;
    }
    setInvalid(null);
    update.mutate({ displayName, status: emoji === '' ? null : { emoji, text } });
  }

  return (
    <form className="mt-6 flex flex-col gap-4" onSubmit={submit}>
      <p className="text-sm text-slate-600">{`@${profile.userId}`}</p>
      <div className="flex flex-col gap-1">
        <label htmlFor="profile-displayName">表示名</label>
        <input
          id="profile-displayName"
          className="rounded border px-2 py-1"
          required
          aria-describedby="profile-displayName-hint"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <span id="profile-displayName-hint" className="text-xs text-slate-600">
          1〜50文字（空白だけは不可）
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="profile-status-emoji">ステータスの絵文字</label>
        <input
          id="profile-status-emoji"
          className="w-20 rounded border px-2 py-1"
          aria-describedby="profile-status-hint"
          value={emoji}
          onChange={(event) => setEmoji(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="profile-status-text">ステータスのテキスト</label>
        <input
          id="profile-status-text"
          className="rounded border px-2 py-1"
          aria-describedby="profile-status-hint"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <span id="profile-status-hint" className="text-xs text-slate-600">
          絵文字1つとテキスト（1〜100文字）の1セット。両方を空にするとステータスを消す
        </span>
      </div>
      {invalid && (
        <p role="alert" className="text-red-700">
          {invalid}
        </p>
      )}
      {update.isError && (
        <p role="alert" className="text-red-700">
          保存できませんでした。{errorMessage(update.error)}
        </p>
      )}
      {update.isSuccess && (
        <p role="status" className="text-slate-700">
          保存しました。
        </p>
      )}
      <button
        className="self-start rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
        disabled={update.isPending}
      >
        保存する
      </button>
    </form>
  );
}
