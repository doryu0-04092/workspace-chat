import { createContext, type ReactNode, useContext } from 'react';

type MessageChannel = { workspaceId: string; channelId: string };

const MessageChannelContext = createContext<MessageChannel | null>(null);

/**
 * メッセージが属するワークスペースとチャンネル（F-13 の編集・削除が api を呼ぶのに要る）。
 * **チャンネルの画面が1回だけ置く**——一覧（`PagedMessages` → `LoadedList`）とスレッドの部品に id を渡して回さないため。
 */
export function MessageChannelProvider({
  workspaceId,
  channelId,
  children,
}: MessageChannel & { children: ReactNode }) {
  return (
    <MessageChannelContext.Provider value={{ workspaceId, channelId }}>
      {children}
    </MessageChannelContext.Provider>
  );
}

/** 置かれていなければ null（編集・削除の操作を出さない）。 */
export function useMessageChannel(): MessageChannel | null {
  return useContext(MessageChannelContext);
}
