import { type UploadFormatId, uploadFormatById } from '@workspace-chat/shared';
import { describe, expect, it } from 'vitest';
import { formatBySignature, isUtf8TextWithoutNul, verifiedFormatOf } from './content-format';
import { SAMPLES } from '../testing/upload-samples';

// 機能一覧 11.1: 中身から形式を検証する。マジックバイトを持つ形式はマジックバイトで、
// 持たないテキスト系は UTF-8 として正しく NUL を含まないことで検証する。拡張子や申告された Content-Type を信用しない。
describe('中身から形式を決める', () => {
  describe('マジックバイト', () => {
    it.each([
      ['jpeg', SAMPLES.jpeg],
      ['png', SAMPLES.png],
      ['gif', SAMPLES.gif],
      ['webp', SAMPLES.webp],
      ['mp4', SAMPLES.mp4],
      ['webm', SAMPLES.webm],
      ['pdf', SAMPLES.pdf],
      ['zip', SAMPLES.zip],
    ] as const)('%s の先頭のバイト列を、その形式と読む', (id, bytes) => {
      expect(formatBySignature(bytes)).toBe(id);
    });

    it.each([
      ['SVG（XML のテキスト）', SAMPLES.svg],
      ['HTML', SAMPLES.html],
      ['空', new Uint8Array()],
      ['GIF の途中で切れたもの', SAMPLES.gif.slice(0, 5)],
      ['WebP でない RIFF（WAVE）', SAMPLES.wav],
      ['mp4 でない ISO BMFF（HEIC）', SAMPLES.heic],
      ['mp4 でない ISO BMFF（QuickTime の mov）', SAMPLES.mov],
      ['WebM でない Matroska（mkv）', SAMPLES.mkv],
      ['zip の空の書庫（終端の記録だけ）', SAMPLES.emptyZip],
      ['Windows の実行形式', SAMPLES.exe],
    ])('%s は、どの形式にも当たらない', (_, bytes) => {
      expect(formatBySignature(bytes)).toBeUndefined();
    });
  });

  describe('テキスト系（UTF-8 として正しく NUL を含まない）', () => {
    it.each([
      ['ASCII', new TextEncoder().encode('a,b\n1,2\n')],
      ['日本語', new TextEncoder().encode('# 見出し\n本文')],
      ['BOM 付き', new Uint8Array([0xef, 0xbb, 0xbf, 0x61])],
      // 中身が HTML でも UTF-8 としては正しい。HTML として解釈させないのは配信のヘッダーの役目である（11.1）。
      ['HTML', SAMPLES.html],
    ])('%s は通る', (_, bytes) => {
      expect(isUtf8TextWithoutNul(bytes)).toBe(true);
    });

    it.each([
      ['UTF-8 として壊れたもの', new Uint8Array([0x61, 0xff, 0x62])],
      ['途中で切れた多バイト文字', new Uint8Array([0xe3, 0x81])],
      ['NUL を含むもの', new Uint8Array([0x61, 0x00, 0x62])],
      ['UTF-16（NUL を含む）', new Uint8Array([0xff, 0xfe, 0x61, 0x00])],
    ])('%s は通らない', (_, bytes) => {
      expect(isUtf8TextWithoutNul(bytes)).toBe(false);
    });
  });

  describe('申告と中身から、検証した形式を決める', () => {
    const verify = (declared: UploadFormatId, head: Uint8Array) =>
      verifiedFormatOf(head, uploadFormatById(declared));

    it('マジックバイトを持つものは、申告によらず中身の形式になる', () => {
      expect(verify('png', SAMPLES.jpeg)).toEqual({ id: 'jpeg', needsTextCheck: false });
      expect(verify('txt', SAMPLES.pdf)).toEqual({ id: 'pdf', needsTextCheck: false });
    });

    // docx / xlsx / pptx は zip と同じ先頭のバイト列を持ち、マジックバイトでは区別できない（11.1「検証の範囲の代償」）。
    it('zip の先頭を持つものは、申告が zip を容器とする形式ならその形式、そうでなければ zip になる', () => {
      expect(verify('docx', SAMPLES.zip)).toEqual({ id: 'docx', needsTextCheck: false });
      expect(verify('xlsx', SAMPLES.zip)).toEqual({ id: 'xlsx', needsTextCheck: false });
      expect(verify('pptx', SAMPLES.zip)).toEqual({ id: 'pptx', needsTextCheck: false });
      expect(verify('zip', SAMPLES.zip)).toEqual({ id: 'zip', needsTextCheck: false });
      expect(verify('png', SAMPLES.zip)).toEqual({ id: 'zip', needsTextCheck: false });
    });

    it('マジックバイトを持たないものは、テキスト系の申告のときだけ、全体を確かめる形式になる', () => {
      expect(verify('txt', SAMPLES.html)).toEqual({ id: 'txt', needsTextCheck: true });
      expect(verify('csv', SAMPLES.svg)).toEqual({ id: 'csv', needsTextCheck: true });
      expect(verify('md', SAMPLES.html)).toEqual({ id: 'md', needsTextCheck: true });
    });

    it.each(['png', 'jpeg', 'mp4', 'pdf', 'docx', 'zip'] as const)(
      'マジックバイトを持たないものを %s と申告しても、形式は決まらない（SVG を画像として通さない）',
      (declared) => {
        expect(verify(declared, SAMPLES.svg)).toBeUndefined();
      },
    );
  });
});
