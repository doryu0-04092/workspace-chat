import { describe, expect, it } from 'vitest';
import { API_SETTINGS, type ApiSettings, resolveApiConfig } from './api-config';

// 起動の失敗はログに出る。値に秘密（資格情報・鍵）が入る設定は、resolve 関数が値をメッセージに埋めても漏らさない。
// いまの resolve 関数は値を埋めないため、**すべての resolve 関数を値を埋めるものに差し替え、集約の側で止まることを確かめる。**
// 秘密かどうかは設定の表（API_SETTINGS）の各行が型で必ず持つため、設定を足すと下の検査の対象にも自動で入る。

/** すべての設定の resolve 関数を、受け取った値をメッセージに埋めて落ちるものに差し替えた表。 */
function leakySettings(): ApiSettings {
  return Object.fromEntries(
    Object.entries(API_SETTINGS).map(([key, setting]) => [
      key,
      {
        ...setting,
        resolve: (raw: string | undefined) => {
          throw new Error(`${setting.env} の値が不正です: ${raw}`);
        },
      },
    ]),
  ) as unknown as ApiSettings;
}

function messageOf(env: Record<string, string | undefined>, settings: ApiSettings): string {
  try {
    resolveApiConfig(env, settings);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('resolveApiConfig が落ちなかった');
}

const secretSettings = Object.values(API_SETTINGS).filter((setting) => setting.secret);
const plainSettings = Object.values(API_SETTINGS).filter((setting) => !setting.secret);

describe('起動の設定の失敗のメッセージと秘密', () => {
  it('接続先（DATABASE_URL / REDIS_URL）は秘密を持つ設定として扱う', () => {
    expect(API_SETTINGS.databaseUrl.secret).toBe(true);
    expect(API_SETTINGS.redisUrl.secret).toBe(true);
  });

  it.each(secretSettings.map((setting) => [setting.env, setting] as const))(
    '%s の値が不正でも、名前と手がかりだけを出し、値を載せない',
    (env, setting) => {
      const raw = `https://user:secret-${env}-9x@host.internal/`;
      const message = messageOf({ [env]: raw }, leakySettings());
      expect(message).toContain(env);
      if (setting.secret) expect(message).toContain(setting.hint);
      expect(message).not.toContain(raw);
      expect(message).not.toContain(`secret-${env}-9x`);
    },
  );

  // 秘密を持たない設定は、何が不正か（値を含む）をそのまま知らせる。
  it.each(plainSettings.map((setting) => [setting.env] as const))(
    '%s は resolve 関数のメッセージをそのまま出す',
    (env) => {
      expect(messageOf({ [env]: 'bad-value' }, leakySettings())).toContain(
        `${env} の値が不正です: bad-value`,
      );
    },
  );

  // 未設定・空のときは載せる値が無いため、秘密を持つ設定でも resolve 関数のメッセージ（何を渡せばよいか）を出す。
  it.each(secretSettings.map((setting) => [setting.env] as const))(
    '%s が空なら、resolve 関数のメッセージをそのまま出す',
    (env) => {
      expect(messageOf({ [env]: '' }, leakySettings())).toContain(`${env} の値が不正です: `);
    },
  );
});
