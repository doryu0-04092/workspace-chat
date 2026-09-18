import { createContext, type ReactNode, useContext } from 'react';

/** `readOnly`: アーカイブ済みのチャンネル（読むだけ。投稿・返信・編集・削除の操作を出さない。機能一覧 3.2）。 */
type MessageChannel = { workspaceId: string; channelId: string; readOnly: boolean };

const MessageChannelContext = createContext<MessageChannel | null>(null);

/**
 * メッセージが属するワークスペースとチャンネル（F-13 の編集・削除が api を呼ぶのに要る）。
 * **チャンネルの画面が1回だけ置く**——一覧（`PagedMessages` → `LoadedList`）とスレッドの部品に id を渡して回さないため。
 */
export function MessageChannelProvider({
  workspaceId,
  channelId,
  readOnly,
  children,
}: MessageChannel & { children: ReactNode }) {
  return (
    <MessageChannelContext.Provider value={{ workspaceId, channelId, readOnly }}>
      {children}
    </MessageChannelContext.Provider>
  );
}

/** 置かれていなければ null（編集・削除の操作を出さない）。 */
export function useMessageChannel(): MessageChannel | null {
  return useContext(MessageChannelContext);
}
