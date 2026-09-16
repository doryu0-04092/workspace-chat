import type { Failure } from './failure';

/** 断られた要求を、利用者に見せる文にする。ログインの失敗の理由は区別しない（機能一覧 1.2）。 */
export function failureMessage(failure: Failure): string {
  if (failure.status === 0) return '通信に失敗しました。接続を確かめてから、やり直してください。';
  if (failure.status === 429) {
    return failure.retryAfterSeconds === undefined
      ? '試行が多すぎます。しばらく待ってから、やり直してください。'
      : `試行が多すぎます。${failure.retryAfterSeconds} 秒ほど待ってから、やり直してください。`;
  }
  switch (failure.code) {
    case 'invalid_credentials':
      return 'ユーザーID かパスワードが違います。';
    case 'user_id_taken':
      return 'このユーザーID は既に使われています。別の ID を選んでください。';
    case 'registration_disabled':
      return '現在、新規登録を受け付けていません。';
    case 'validation_failed':
    case 'invalid_body':
      return '入力の形が正しくありません。各項目の条件を確かめてください。';
    case 'channel_name_taken':
      return 'このワークスペースには同じ名前のチャンネルがあります。別の名前を選んでください。';
    case 'channel_archived':
      return 'アーカイブ済みのチャンネルです。';
    case 'not_a_channel_member':
      return 'このチャンネルに参加していません。';
    case 'already_channel_member':
      return '既に参加しています。';
    case 'owner_only':
      return 'この操作は、ワークスペースのオーナーだけが行えます。';
    case 'already_invited':
      return '既にこの利用者を招待しています。承諾されるまでお待ちください。';
    case 'already_member':
      return '既にこのワークスペースのメンバーです。';
    case 'invitee_not_found':
      return 'そのユーザーID の利用者はいません。綴りを確かめてください。';
    case 'owner_cannot_leave':
      return 'オーナーは退出できません。オーナーの権限を他の人に渡す機能が無いためです。';
    case 'not_found':
      return '見つかりません。一覧を開き直してください。';
    default:
      return 'うまくいきませんでした。時間をおいて、やり直してください。';
  }
}
