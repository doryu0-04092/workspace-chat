import type { ErrorResponse } from '../error-response';

/** オーナーだけが実行できる操作を、オーナーでないメンバーが呼んだ（403。機能一覧 2.2）。 */
export const OWNER_ONLY: ErrorResponse = {
  code: 'owner_only',
  message: 'オーナーだけが実行できます',
};

/**
 * オーナーはワークスペースから抜けられない（退出・自分のキック。403。機能一覧 F-38「オーナーが退出しようとすると拒否され、理由が画面に表示される」）。
 * オーナー権限の委譲とワークスペースの削除を対象外にしているため（要件定義書 3.4）。
 */
export const OWNER_CANNOT_LEAVE: ErrorResponse = {
  code: 'owner_cannot_leave',
  message:
    'オーナーはワークスペースから抜けられません（オーナー権限の委譲とワークスペースの削除には対応していません）',
};
