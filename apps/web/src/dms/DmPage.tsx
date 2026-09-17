import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useSession } from '../auth/session-context';
import { MessageActionButtons } from '../messages/MessageActions';
import { MessageShell, PagedMessages } from '../messages/MessageList';
import { MessageForm } from '../messages/PostMessageForm';
import { useDmRealtime } from '../realtime/use-dm-realtime';
import { counterpartName } from './DmList';
import {
  type Dm,
  type DmMessage,
  useDeleteDmMessage,
  useDmMessages,
  useDms,
  useEditDmMessage,
  usePostDmMessage,
  useUpdateDmRead,
} from './queries';

const DM_LABELS = {
  failed: 'メッセージを読み込めませんでした。',
  empty: 'まだメッセージはありません。',
  olderFailed: '古いメッセージを読み込めませんでした。',
  loadOlder: '古いメッセージを読み込む',
};

/**
 * DM の画面（F-19。機能一覧 8）。**自分が当事者の DM の一覧にある DM だけを開く**（無ければ見つからないことを出す。当事者かの判定は api）。
 * メッセージの一覧・送信・自分のメッセージの編集と削除・未読・リアルタイムの反映を置く。
 */
export function DmPage() {
  const { workspaceId = '', dmId = '' } = useParams();
  const dms = useDms(workspaceId);
  const dm = dms.data?.find((current) => current.id === dmId);

  if (dms.isPending) {
    return (
      <p role="status" className="p-6 text-slate-600">
        読み込み中…
      </p>
    );
  }
  if (!dm) {
    return (
      <main className="mx-auto max-w-xl p-6">
        <p>DM が見つかりません。</p>
        <Link to={`/workspaces/${workspaceId}`} className="underline">
          ワークスペースへ
        </Link>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold">{`${counterpartName(dm)} との DM`}</h1>
      <Link to={`/workspaces/${workspaceId}`} className="text-sm underline">
        ワークスペースへ
      </Link>
      <DmMessages key={dm.id} workspaceId={workspaceId} dm={dm} />
    </main>
  );
}

/**
 * DM の本体。**区切り線の位置は、開いた時点の既読位置で固定する**（読み進めても動かない。機能一覧 10.1。チャンネルと同じ）。
 * **相手がメンバーでなくなった DM（`writable` が false）は、送信のフォームを出さず理由を出す**（過去のメッセージは読める。機能一覧 8・1.5・2.2。判定は api）。
 */
function DmMessages({ workspaceId, dm }: { workspaceId: string; dm: Dm }) {
  useDmRealtime(workspaceId, dm.id);
  const [unreadFrom] = useState(dm.lastReadMessageId);
  const messages = useDmMessages(workspaceId, dm.id);
  const post = usePostDmMessage(workspaceId, dm.id);
  useAdvanceDmRead(workspaceId, dm.id, messages.data?.pages[0]?.messages);

  return (
    <>
      <section aria-label="メッセージの一覧" className="mt-4">
        <PagedMessages
          pages={messages}
          labels={DM_LABELS}
          renderMessage={(message) => (
            <DmMessageItem workspaceId={workspaceId} dmId={dm.id} message={message} />
          )}
          lastReadMessageId={unreadFrom}
          joinedAt={dm.joinedAt}
        />
      </section>
      {dm.writable ? (
        <MessageForm
          submit={post.mutate}
          pending={post.isPending}
          error={post.error}
          workspaceId={workspaceId}
          label="メッセージ"
          submitLabel="送信する"
        />
      ) : (
        <p className="mt-4 rounded bg-slate-100 px-3 py-2 text-sm">
          相手がこのワークスペースのメンバーではなくなったため、送信できません。
        </p>
      )}
    </>
  );
}

/**
 * DM の1件（F-19）。枠（書き手・時刻・編集済み・削除済み）はチャンネルと同じ `MessageShell`、操作は `MessageActionButtons` を使う。
 * **自分のメッセージで削除済みでなければ、編集・削除を出す**（出し分けは画面の配慮であり、判定は api）。
 */
function DmMessageItem({
  workspaceId,
  dmId,
  message,
}: {
  workspaceId: string;
  dmId: string;
  message: DmMessage;
}) {
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const edit = useEditDmMessage(workspaceId, dmId);
  const remove = useDeleteDmMessage(workspaceId, dmId);
  const own =
    session.status === 'signedIn' &&
    message.body !== null &&
    message.author?.id === session.user.id;

  return (
    <MessageShell
      message={message}
      editor={
        own && editing ? (
          <MessageForm
            submit={(body, options) => edit.mutate({ messageId: message.id, body }, options)}
            pending={edit.isPending}
            error={edit.error}
            workspaceId={workspaceId}
            label="メッセージを編集"
            hideLabel
            submitLabel="保存する"
            initialBody={message.body ?? ''}
            clearOnSuccess={false}
            onSubmitted={() => setEditing(false)}
            onCancel={() => setEditing(false)}
            className="flex flex-col gap-2"
          />
        ) : null
      }
    >
      {own && !editing && (
        <MessageActionButtons
          onEdit={() => setEditing(true)}
          onDelete={() => remove.mutate(message.id)}
          pending={remove.isPending}
          error={remove.isError ? remove.error : null}
        />
      )}
    </MessageShell>
  );
}

/**
 * 読み込んである最新の削除されていないメッセージまで、DM の既読位置を進める（F-23。機能一覧 10.1）。
 * **削除されていないものだけを送る**——api は削除済みの id を 404 で断り、最後のメッセージが消されただけで既読が進まなくなる。
 * **同じ位置は送り直さない**——効果の依存が位置そのものであり、変わらないうちは走らない（上限は 1分 120 回）。
 */
function useAdvanceDmRead(workspaceId: string, dmId: string, newestPage: DmMessage[] | undefined) {
  const { mutate: advance } = useUpdateDmRead(workspaceId, dmId);
  const newestId = newestPage?.find((message) => !message.deleted)?.id ?? null;

  useEffect(() => {
    if (newestId !== null) advance(newestId);
  }, [newestId, advance]);
}
