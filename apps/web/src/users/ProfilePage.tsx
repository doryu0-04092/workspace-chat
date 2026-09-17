import { type FormEvent, useState } from 'react';
import { errorMessage } from '../api/client';
import { type Profile, useMyProfile, useUpdateProfile, useUploadAvatar } from './queries';

/** 自分のプロフィールの画面（F-04。機能一覧 1.3）。アバター画像・表示名・ステータスを変える。ユーザーID は変えられない。 */
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
      {profile.data && <AvatarField profile={profile.data} />}
      {profile.data && <ProfileForm profile={profile.data} />}
    </main>
  );
}

/** アバター画像を送る先で受け付ける形式（api の許可リストの画像。受け付けるかを決めるのは api の確定の検証である）。 */
const AVATAR_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp';

/**
 * アバター画像。**ファイルを選んだらすぐに上げる**（発行 → PUT → 確定。表示名とステータスの「保存する」とは別に送る——
 * 上げ終わるまでに確定まで済ませないと、隔離用のキーに置いたまま残るため）。通ったら画像は読み直さずに変わる。
 */
function AvatarField({ profile }: { profile: Profile }) {
  const upload = useUploadAvatar();

  return (
    <div className="mt-6 flex items-center gap-4">
      {profile.avatarUrl ? (
        <img
          src={profile.avatarUrl}
          alt="現在のアバター画像"
          className="h-16 w-16 rounded-full border object-cover"
        />
      ) : (
        <div aria-hidden="true" className="h-16 w-16 rounded-full border bg-slate-100" />
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="profile-avatar">アバター画像</label>
        <input
          id="profile-avatar"
          type="file"
          accept={AVATAR_ACCEPT}
          aria-describedby="profile-avatar-hint"
          disabled={upload.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // 同じファイルを選び直しても change が起きるよう、選んだものを入力欄から外す
            event.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
        <span id="profile-avatar-hint" className="text-xs text-slate-600">
          jpeg・png・gif・webp の画像（10 MB まで）。選ぶとすぐに変わります
        </span>
        {upload.isPending && (
          <p role="status" className="text-slate-700">
            アップロードしています…
          </p>
        )}
        {upload.isError && (
          <p role="alert" className="text-red-700">
            アバター画像を変えられませんでした。{errorMessage(upload.error)}
          </p>
        )}
      </div>
    </div>
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
