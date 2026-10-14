# openclaw-plugin-ani-persona

在 Discord 終稿送出前，以 `skills/ani-persona` 改寫回覆。主要任務完成後，`reply_payload_sending` 呼叫 `api.runtime.subagent.complete()`，使用同一個 agent 的模型設定做一次**無工具、無自動交付的獨立生成**，再替換送出的文字。

針對 **OpenClaw 2026.10.3** 開發與驗證。預設只處理 Discord，以及 `config.agentIds` 指定的 agent。

## 交付流程

```text
主 agent 完成工作 → 完整終稿 → 無工具 Ani 改寫
  → 獨立同步核准檢查 → Discord 傳送
改寫失敗／超時／未核准 → 取消交付，不回退原稿
```

- 取消中途的 `block`／`tool` payload；此宿主版本會保留可交付的完整終稿。Discord 自己的預覽與 block streaming 必須關閉，設定見下方。
- 內部生成附上原稿、最近使用者要求（最多 8,000 字元）、受眾類型，以及技能、SOUL、IDENTITY 和 references。它不會繼承完整對話或執行工具，也不會改動主 agent 的 workspace 人格檔案。
- 相同 session、run、channel、account 與原稿共用一次改寫；並行重試共用 Promise，改寫結果再次進入 hook 時直接通過。快取保留 5 分鐘、最多 128 筆，滿載時取消交付。不同原稿（例如宿主另產生的錯誤回覆）各自改寫；不保證跨重啟去重。
- `rewriteTimeoutMs` 從發起請求前開始計時，包含排隊；超時會 abort。宿主本身的 hook timeout 採 fail-open，因此另設同步核准 hook：若改寫沒完成，原稿仍會被取消。延遲完成的請求不能取得核准。
- `message_sending` 額外阻擋未核准的文字，包括直接用 message tool 送出的文字。它不會再觸發改寫。普通 Discord hook 沒有 `runId`，此時以 session、channel、account 和未過期的完整核准文字比對。
- 保留一般附件與回覆目標。含獨立文字的 rich payload（例如 embeds、presentation、interactive、fallbackText）及已合成語音會取消，避免夾帶未改寫原文；目前不做 rich card 或語音改寫。

改寫指令要求保留事實、數字、失敗、限制、連結、命令、程式碼與精確輸出格式。這是模型指令，測試不代表語意保真或人格品質已獲保證。

## 啟用

先提供相同版本的 OpenClaw SDK 並建置：

```sh
npm ci --legacy-peer-deps
npm install --no-save --package-lock=false openclaw@2026.10.3
npm run build
```

若已安裝 OpenClaw 2026.10.3，也可讓本專案的 `node_modules/openclaw` 連結至該 package。

合併以下設定至現有 `openclaw.json`，保留原有 token、channel、plugins 等設定。將 `main` 與 plugin 路徑換成實際值：

```json
{
  "channels": {
    "discord": {
      "streaming": {
        "mode": "off",
        "block": { "enabled": false }
      }
    }
  },
  "plugins": {
    "allow": ["ani-persona"],
    "load": {
      "paths": ["/absolute/path/to/openclaw-plugin-ani-persona"]
    },
    "entries": {
      "ani-persona": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "agentIds": ["main"],
          "channels": ["discord"],
          "rewriteTimeoutMs": 30000
        }
      }
    }
  }
}
```

**Discord account 若自行設定 `streaming`，會取代整個根層物件。** 每個 override 也需同時包含 `mode: "off"` 與 `block.enabled: false`。沒有 override 的 account 繼承根層設定。

設定後重新啟動 Gateway，確認 plugin 載入成功。設定不安全時 plugin 會記錄警告，保留 hooks 並阻擋符合範圍的 agent 執行和交付；不會靠拋出註冊錯誤阻止 Gateway，因為宿主可能只卸載失敗的 plugin。

每次檢查都讀取目前設定，但無法收回已顯示的預覽；請勿在執行中的回合熱啟用 Discord 預覽。程式或技能變更後須重新 build 並重新載入 plugin。

## 驗證

```sh
npm test
```

測試使用實際 OpenClaw hook runner，涵蓋 payload 合併、並行去重、重入、自己的 deadline、宿主 fail-open timeout、晚到結果、停機取消、送訊核准、Discord 設定與 rich payload 旁路。

另有隔離 Gateway 的傳輸測試，詳見 [端到端測試](test/e2e/README.md)：

- 主 agent 使用本機 mock 模型的 SSE 串流，主生成保有工具，內部 `complete()` 的實際模型請求沒有工具。
- 正式 buffered channel dispatch 經官方 `@openclaw/discord@2026.10.3` 的 `sendMessageDiscord()`，送至本機 mock Discord REST。
- 驗證成功時只有 Ani 文字，Discord 429 重試仍只有 Ani 文字且不重做內部生成；改寫超時時沒有任何 POST 訊息。

此測試未登入真實 Discord 帳號、未走 Discord inbound WebSocket，也未呼叫真實付費模型。它驗證實際宿主與 Discord 傳送程式的出口內容，不評估模型的 Ani 表現。

## 範圍與限制

- 保證範圍是已載入本 plugin、採上述安全設定的 Discord 標準文字回覆路徑。OpenClaw Control UI 的即時事件、第三方 plugin 自行發 HTTP，以及繞過標準 hooks 的路徑不在範圍內。不要讓其他 plugin 在核准之後改動送出文字。
- 失敗採取消交付，所以使用者可能收不到回覆；log 會記錄改寫失敗。成功時只記錄 run、agent、channel 與原稿／改寫稿的 SHA-256，供交付核對，不記錄回覆本文。未提供 `runId` 的終稿／跨重啟 durable replay 也會被取消。
- 原稿仍可能存在於宿主 transcript、模型記錄與 Control UI；本 plugin 替換的是 Discord 交付文字，沒有重寫歷史記錄。
- 附件本體不改寫。特殊 citation control markers 等宿主文字轉換可能讓完整核准比對不一致，此時取消交付。
- 每次改寫增加模型延遲與 token 用量，所有文字 references 都會進入內部請求。需要允許該 plugin 存取對話，並讓 Gateway 的 agent runtime 可呼叫所選模型。

## 官方文件

- [Building plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [Plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [Message and delivery hooks](https://docs.openclaw.ai/plugins/hooks/messages)
