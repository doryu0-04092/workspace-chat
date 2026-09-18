/** 候補に並べる利用者（ユーザーID と表示名を持つもの）。 */
type Named = { userId: string; displayName: string };

/**
 * 入力した文字列に当たる利用者だけを、当たり方の順に並べる（#616）。**api の招待の候補（invitations.service.ts の `candidates`）と同じ並び**にする——
 * 招待の画面とチャンネルへの追加の画面で、同じ入力に違う順で出さない。
 *
 * - ユーザーID か表示名に含む人だけ（大文字小文字によらない）。空白だけの入力なら絞らずに全員を返す
 * - 並びは、ユーザーID の先頭一致 → 表示名の先頭一致 → 途中の一致の順、同じ段ではユーザーID の小文字の順
 */
export function rankCandidates<T extends Named>(people: readonly T[], input: string): T[] {
  const q = input.trim().toLowerCase();
  if (q === '') return [...people];
  const rank = (person: T): number => {
    const userId = person.userId.toLowerCase();
    const displayName = person.displayName.toLowerCase();
    if (userId.startsWith(q)) return 0;
    if (displayName.startsWith(q)) return 1;
    if (userId.includes(q) || displayName.includes(q)) return 2;
    return -1;
  };
  return people
    .map((person) => ({ person, rank: rank(person) }))
    .filter(({ rank: value }) => value >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.person.userId.toLowerCase().localeCompare(b.person.userId.toLowerCase()),
    )
    .map(({ person }) => person);
}
