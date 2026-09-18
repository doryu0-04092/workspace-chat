import { useTypingUsers } from '../realtime/use-typing';

/**
 * 「○○さんが入力中…」（F-34。機能一覧 13.3）。入力欄の上に置く。
 * **誰も打っていないときも枠を残す**——`status`（`aria-live="polite"`）は、中身が変わったときに読み上げられるため、
 * 出したときに枠ごと作ると読み上げられないことがある。高さも保ち、表示のたびに入力欄が動かないようにする。
 */
export function TypingIndicator({ channelId }: { channelId: string }) {
  const typists = useTypingUsers(channelId);
  return (
    <p role="status" aria-label="入力中の利用者" className="mt-2 min-h-5 text-sm text-slate-600">
      {typists.length > 0 &&
        `${typists.map((user) => `${user.displayName}さん`).join('、')}が入力中…`}
    </p>
  );
}
