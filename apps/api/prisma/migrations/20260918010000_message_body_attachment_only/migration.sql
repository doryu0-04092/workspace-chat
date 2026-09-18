-- 本文の検査制約を「4000 文字まで」に緩める（#614）。
-- 添付が1件以上ある投稿は本文が空・空白だけでもよい（画像だけの投稿）。添付の有無は同じ行の検査制約では見られないため、
-- 空・空白だけを断るのは REST の仕様（CreateMessageRequest の if/else）が持つ。上限の 4000 文字は DB でも止める。
ALTER TABLE "Message" DROP CONSTRAINT "Message_body_check";
ALTER TABLE "Message"
    ADD CONSTRAINT "Message_body_check" CHECK (char_length("body") <= 4000);
