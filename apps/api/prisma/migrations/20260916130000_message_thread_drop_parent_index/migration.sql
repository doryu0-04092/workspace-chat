-- スレッドの返信の一覧の索引を、チャンネルの一覧の索引に寄せる（F-17。#488。PR #489 第1巡）。
-- 返信の一覧は必ず channelId を伴って引くため、("channelId", "parentId", "id" DESC) の前方で足りる。
-- DropIndex
DROP INDEX "Message_parentId_id_idx";
