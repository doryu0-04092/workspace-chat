import { broadcastMentionsOf } from '@workspace-chat/shared';
import type { DmMessage } from '../dms/queries';
import type { Message } from '../messages/queries';

/**
 * ブラウザ通知（F-25。機能一覧 10.2）で出す中身。**種類ごとの作り方（`mentionNotificationOf` など）はこの形を返す**——
 * DM（F-19）の通知を足すときは、DM の配信から同じ形を作る関数を足し、`showBrowserNotification` に渡す。
 */
export type BrowserNotificationContent = {
  readonly title: string;
  readonly body: string;
  /** 同じ通知を複数のタブが出しても、ブラウザが1つにまとめるための鍵。 */
  readonly tag: string;
};

/** 通知の本文に載せる文字数の上限（実装時に決めた値。長い本文を通知の枠に全部は出さない）。 */
const BODY_LIMIT = 100;

/**
 * 届いたメッセージが、自分（`me`）へのメンションなら通知の中身を返す（F-25）。そうでなければ null。
 * - **対象は応答の `mentions` に自分が載っているものだけ**（投稿時に api が解決した対象。本文の `@` を画面で拾い直さない）
 * - **自分が書いたメッセージは通知しない**
 * - 本文は Markdown のまま文字として渡す（通知の本文は HTML として解釈されない）
 */
export function mentionNotificationOf(
  message: Message,
  me: { readonly id: string },
): BrowserNotificationContent | null {
  if (message.body === null || message.author?.id === me.id) return null;
  if (!message.mentions.some((mention) => mention.user?.id === me.id)) return null;
  const body =
    message.body.length > BODY_LIMIT ? `${message.body.slice(0, BODY_LIMIT)}…` : message.body;
  return {
    title: `${message.author?.displayName ?? '削除済みの利用者'} さんからのメンション`,
    body,
    tag: `mention:${message.id}`,
  };
}

/**
 * 届いた DM の通知の中身を返す（F-25。機能一覧 10.2「ブラウザ通知が出るのはメンションと DM」。#623）。自分が書いた DM・削除済みなら null。
 * DM の配信は当事者の部屋にだけ届くため、宛先の確かめは要らない（api が決める）。
 */
export function dmNotificationOf(
  message: DmMessage,
  me: { readonly id: string },
): BrowserNotificationContent | null {
  if (message.body === null || message.author?.id === me.id) return null;
  const body =
    message.body.length > BODY_LIMIT ? `${message.body.slice(0, BODY_LIMIT)}…` : message.body;
  return {
    title: `${message.author?.displayName ?? '削除済みの利用者'} さんからの DM`,
    body,
    tag: `dm:${message.id}`,
  };
}

/**
 * 届いたメッセージが一斉メンション（F-21）なら通知の中身を返す（F-25）。そうでなければ null。
 * - `@channel` は、届いたら出す（参加者全員が宛先。機能一覧 9.2 の表）
 * - `@here` は、**そのチャンネルを開いているとき（`hereOpen`）だけ**出す（開いていなければブラウザ通知もバッジも出さない。機能一覧 10.2）
 * - **自分が書いたメッセージは通知しない**。本文は Markdown のまま文字として渡す
 */
export function broadcastNotificationOf(
  message: Message,
  me: { readonly id: string },
  { hereOpen }: { readonly hereOpen: boolean },
): BrowserNotificationContent | null {
  if (message.body === null || message.author?.id === me.id) return null;
  const broadcast = broadcastMentionsOf(message.body);
  const kind = broadcast.has('channel')
    ? 'channel'
    : broadcast.has('here') && hereOpen
      ? 'here'
      : null;
  if (kind === null) return null;
  const body =
    message.body.length > BODY_LIMIT ? `${message.body.slice(0, BODY_LIMIT)}…` : message.body;
  return {
    title: `${message.author?.displayName ?? '削除済みの利用者'} さんから @${kind}`,
    body,
    // 個人のメンションと同じ鍵にする（同じメッセージで両方に当たっても、ブラウザが1つにまとめる）
    tag: `mention:${message.id}`,
  };
}

/**
 * 有効にしたかを覚える鍵。**利用者ごとに分ける**——同じブラウザで別の利用者がログインしたとき、前の利用者の設定を持ち越さない。
 * **ブラウザごとに持ち、api には保存しない**——通知の許可はブラウザ（origin）ごとのものであり、api に持つと、許可していないブラウザでも「有効」になる。
 */
function enabledKey(userId: string): string {
  return `workspace-chat.browser-notifications.${userId}`;
}

/** ブラウザが Notification API を持つか。 */
export function browserNotificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

/** 利用者が有効にしていて、ブラウザが許可しているか（両方が揃ったときだけ通知を出す）。 */
export function browserNotificationsEnabled(userId: string): boolean {
  if (!browserNotificationsSupported() || Notification.permission !== 'granted') return false;
  try {
    return localStorage.getItem(enabledKey(userId)) === 'on';
  } catch {
    return false;
  }
}

/**
 * 有効にするか無効にするかを決める（F-25）。**許可を求めるのは、利用者が有効にする操作をしたこの時点だけ**（初回訪問で求めない。機能一覧 10.2）。
 * 返すのはブラウザの許可の状態。許可されなければ有効にしない。
 */
export async function setBrowserNotificationsEnabled(
  userId: string,
  enabled: boolean,
): Promise<NotificationPermission> {
  if (!browserNotificationsSupported()) return 'denied';
  const permission =
    enabled && Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  try {
    if (enabled && permission === 'granted') localStorage.setItem(enabledKey(userId), 'on');
    else localStorage.removeItem(enabledKey(userId));
  } catch {
    // 保存できない（プライベートな閲覧など）ときは、有効にしたことを覚えられない。通知は出さない側に倒す
  }
  return permission;
}

/** 有効で許可されていれば、通知を出す。押されたら画面を前に出し、`onClick` を呼んで通知を閉じる。 */
export function showBrowserNotification(
  userId: string,
  content: BrowserNotificationContent,
  onClick: () => void,
): void {
  if (!browserNotificationsEnabled(userId)) return;
  const notification = new Notification(content.title, { body: content.body, tag: content.tag });
  notification.onclick = () => {
    window.focus();
    onClick();
    notification.close();
  };
}
