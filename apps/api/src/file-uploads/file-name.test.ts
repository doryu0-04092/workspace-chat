import { describe, expect, it } from 'vitest';
import { S3_KEY_MAX_BYTES, storedFileName, withExtension } from './file-name';

// 機能一覧 11.1 のキーの形式の行: 利用者のファイル名のうち英数字・`.`・`_`・`-` だけを残し、それ以外の文字と先頭の `.` を `_` に置き換え、
// 発行の段で書く隔離用のキー（`quarantine/` を含む）全体が 1,024 バイトに収まるよう末尾を切り詰める。
describe('保存名（キーの {ファイル名}）', () => {
  const prefix =
    'quarantine/avatars/01920000-0000-7000-8000-000000000001/01920000-0000-7000-8000-000000000002/';

  it('英数字・. ・_ ・- はそのまま残す', () => {
    expect(storedFileName('Report_2026-09.final.PDF', prefix)).toBe('Report_2026-09.final.PDF');
  });

  it.each([
    ['日本語の名前.png', '______.png'],
    ['my photo (1).jpg', 'my_photo__1_.jpg'],
    ['../../avatars/x.png', '_._.._avatars_x.png'],
    ['a/b\\c.png', 'a_b_c.png'],
    ['%2e%2e%2fx.png', '_2e_2e_2fx.png'],
    ['name?.png#frag', 'name_.png_frag'],
    // 絵文字（サロゲートペア）も1文字として1つの `_` にする
    ['😀.png', '_.png'],
  ])('許可しない文字を _ に置き換える: %j → %j', (name, expected) => {
    expect(storedFileName(name, prefix)).toBe(expected);
  });

  it('先頭の . を _ に置き換える（隠しファイルの名前にしない）', () => {
    expect(storedFileName('.htaccess', prefix)).toBe('_htaccess');
    expect(storedFileName('..png', prefix)).toBe('_.png');
  });

  it('隔離用のキー全体が 1,024 バイトに収まるよう、末尾を切り詰める', () => {
    const name = storedFileName(`${'a'.repeat(2000)}.png`, prefix);
    expect(Buffer.byteLength(`${prefix}${name}`)).toBe(S3_KEY_MAX_BYTES);
    expect(name).toBe('a'.repeat(S3_KEY_MAX_BYTES - Buffer.byteLength(prefix)));
  });

  it('収まる長さなら切り詰めない（境目ちょうど）', () => {
    const room = S3_KEY_MAX_BYTES - Buffer.byteLength(prefix);
    expect(storedFileName('b'.repeat(room), prefix)).toBe('b'.repeat(room));
    expect(storedFileName('b'.repeat(room + 1), prefix)).toBe('b'.repeat(room));
  });

  it('置き換えた後の長さで切り詰める（多バイト文字は1つの _ として数える）', () => {
    const room = S3_KEY_MAX_BYTES - Buffer.byteLength(prefix);
    expect(storedFileName('あ'.repeat(room + 5), prefix)).toBe('_'.repeat(room));
  });
});

describe('拡張子の付け替え（検証した形式の拡張子にする）', () => {
  it.each([
    ['photo.png', '.jpg', 'photo.jpg'],
    ['archive.tar.gz', '.zip', 'archive.tar.zip'],
    ['shell.jpg.php', '.png', 'shell.jpg.png'],
    ['README', '.txt', 'README.txt'],
    ['trailing.', '.pdf', 'trailing.pdf'],
    ['_htaccess', '.txt', '_htaccess.txt'],
  ])('%j に %j を付けると %j', (name, extension, expected) => {
    expect(withExtension(name, extension)).toBe(expected);
  });
});
