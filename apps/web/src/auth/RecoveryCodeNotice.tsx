import { useState } from 'react';
import { useNavigate } from 'react-router';

export const LOSS_WARNING =
  'リカバリーコードを失うと、アカウントを復旧できません。パスワードを忘れたときの唯一の手段です（メールでの再設定はありません）。';

/**
 * リカバリーコードを1度だけ見せ、控えたことを選ぶまで先へ進めない（登録と再設定。機能一覧 1.1）。
 * **コードは呼び出し側の部品の状態にだけ持ち、保存しない。** 画面を離れれば消え、再表示はできない。
 */
export function RecoveryCodeNotice({ lead, recoveryCode }: { lead: string; recoveryCode: string }) {
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-2xl font-bold">リカバリーコード</h1>
      <p className="mt-4">{lead}</p>
      <p className="mt-4 rounded bg-slate-100 p-3 text-center font-mono text-lg">{recoveryCode}</p>
      <p className="mt-4 text-red-700">{LOSS_WARNING}</p>
      <label className="mt-6 flex items-center gap-2">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
        />
        リカバリーコードを控えました
      </label>
      <button
        type="button"
        className="mt-4 w-full rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50"
        disabled={!saved}
        onClick={() => navigate('/login', { replace: true })}
      >
        ログインの画面へ進む
      </button>
    </main>
  );
}
