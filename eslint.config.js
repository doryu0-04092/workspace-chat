import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 検査しない場所。生成物と依存パッケージ。
  { ignores: ['**/dist/**', '**/build/**', '**/coverage/**', 'reports/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
