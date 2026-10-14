# openclaw-plugin-ani-persona

在 OpenClaw 接受自然終稿前，要求**同一個 agent 再跑一輪 Ani 語氣改寫**。主要任務的上下文保留，plugin 將原稿、`skills/ani-persona/SKILL.md`、`assets/SOUL.md` 與 `assets/IDENTITY.md` 帶入修訂指令。

目前是針對 **OpenClaw 2026.10.3** 的初版；採用 `before_agent_finalize`，不是獨立 subagent，也不是送出後再補一則訊息。

## 運作方式

```text
主要任務完成 → 產生原稿 → before_agent_finalize
  → action: revise（每個 run 最多一次）
  → 同一 agent 依 Ani 人格改寫 → 正常終稿交付
```

- 只處理 `config.agentIds` 指定 agent 的 `user` trigger；跳過已知內部來源、subagent、停止 hook 的續跑，以及空白／靜默回覆。
- 以固定的 `retry.idempotencyKey` 和 `maxAttempts: 1` 使用宿主的重試上限，不維護另一套 session 狀態。
- 明確附上原稿，因為 embedded runner 修訂時會撤回有效 transcript 分支上的原稿。
- `SKILL.md` 是人格增強層，普通工作依賴 `SOUL.md` 的 focused-work register。三份檔案只作為這次回覆的寫作參考；不覆蓋 agent workspace 的人格檔案。其他 references 由模型依需求和既有工具權限讀取。
- 指令要求保留事實、失敗、限制、程式碼、連結與精確輸出格式，只調整適合改寫的敘述文字。這是模型指令，並非語意正確性的形式驗證或工具沙箱。

## 已知限制

**這不是「每一則對外文字一定改寫」的強制出口。**

1. Embedded runner 的正常終稿路徑會暫緩 block reply，接受修訂時抑制該次終稿交付。但已經送出的進度文字、工具直接發送的訊息，以及各 channel 的預覽／串流介面不在本 plugin 的完整保證內。
2. OpenClaw 2026.10.3 若判定該輪已有潛在副作用，會拒絕 rewind，即使 hook 回傳 `revise`。傳送訊息、接受子任務、建立排程，以及其他被 runtime 標為有副作用的工具工作，都可能使改寫被略過。不能把這版當成所有工作任務完成後的必經步驟。
3. `/stop`、錯誤、超時及部分特殊結束路徑不會進入自然終稿修訂。Hook 本身失敗時，宿主會記錄錯誤並繼續正常結束；其他 plugin 的 `finalize` 決策也能優先結束。
4. 官方文件列出 embedded runner 和 native hook relay 支援此 hook；Copilot harness 不支援。本專案尚未完成真實 channel／Codex relay 的端到端驗證。
5. 每次實際修訂多一次模型生成，增加延遲與 token 成本；必要時讀取技能 reference 也會增加工具往返。

若需求是連有副作用的工作、所有 channel 和進度文字都必須通過改寫，需要另做交付層整合：緩衝原文、在送出前完成獨立且無工具的改寫、處理 transcript 一致性，以及明確定義改寫失敗時的交付行為。單靠這個 finalize hook 無法提供該保證。

## 開發與驗證

需要 Node 24.16+ 或 26.1+ 的受支援版本，並提供 OpenClaw 2026.10.3 SDK：

```sh
npm ci --legacy-peer-deps
npm install --no-save --package-lock=false openclaw@2026.10.3
npm test
npm pack --dry-run
```

若已全域安裝相同版本，可將該安裝的 `openclaw` package 連結至本專案的 `node_modules/openclaw`，避免安裝第二份宿主。

測試使用 Node 內建 test runner，並呼叫 OpenClaw 真正的 `runAgentHarnessBeforeAgentFinalizeHook`，驗證每個 run 的修訂上限、原稿保留與適用範圍。這些測試不呼叫付費模型，不證明實際語氣品質或 channel 交付行為。

## 本機啟用

先建置：

```sh
npm run build
```

在現有 `openclaw.json` 合併以下設定。將 `main` 換成要啟用的 agent ID，路徑換成此專案的絕對路徑；若已有 `plugins.allow` 或 `plugins.load.paths`，保留既有項目。

```json
{
  "plugins": {
    "allow": ["ani-persona"],
    "load": {
      "paths": ["/absolute/path/to/openclaw-plugin-ani-persona"]
    },
    "entries": {
      "ani-persona": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": { "agentIds": ["main"] }
      }
    }
  }
}
```

接著檢查 runtime；程式或技能內容更新後重新 build 並 reload：

```sh
openclaw plugins inspect ani-persona --runtime --json
openclaw plugins reload ani-persona
```

啟用後先以普通文字問答驗證只有一份終稿，再測試實際使用的 channel、工具任務、取消、失敗與其他 finalize plugins。不要以 hook 註冊成功代替交付驗證。

## 參考

- [Building plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [Plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [Prompt and session hooks：finalize 與 retry](https://docs.openclaw.ai/plugins/hooks/prompt-and-session)
- [Message and delivery hooks](https://docs.openclaw.ai/plugins/hooks/messages)
