# アーキテクチャ

## 全体図

```mermaid
graph LR
    subgraph Stripe[Stripe テストモード]
        PL[Payment Link<br>テスト決済導線]
        WH[Webhookエンドポイント設定]
        API[Stripe API]
    end
    subgraph Google
        GAS[GAS Webアプリ<br>doPost]
        SS[(スプレッドシート)]
        M[Members シート]
        E[EventLog シート]
        T[時刻トリガー 月次]
    end
    PL --> WH
    WH -- "POST /exec?token=..." --> GAS
    GAS -- "GET /v1/events/{id}<br>再照会検証" --> API
    GAS --> M
    GAS --> E
    SS --- M
    SS --- E
    T -.-> R[report.js 予定<br>Claude API]
    R -.-> SL[slack.js 予定]
    M -.-> K[kpi.js 予定]
```

点線は未実装（機能2〜4）。

## 機能1: Webhook受信のシーケンス

```mermaid
sequenceDiagram
    participant S as Stripe
    participant G as GAS doPost
    participant E as EventLog
    participant M as Members

    S->>G: POST /exec?token=xxx (event payload)
    G->>G: 1. トークン照合
    alt トークン不一致
        G->>E: token_ng を記録
        G-->>S: 200 {received:true}
    end
    G->>G: 2. JSONパース / 3. ScriptLock取得
    G->>E: 4. event_id の処理済みチェック
    alt 処理済み（Stripeの再送）
        G->>E: duplicate を記録
        G-->>S: 200 {received:true}
    end
    G->>S: 5. GET /v1/events/{id}（再照会）
    alt Stripeに実在しない
        G->>E: not_found_on_stripe を記録
        G-->>S: 200 {received:true}
    end
    S-->>G: 本物のイベントオブジェクト
    Note over G: 以降は再照会で得たオブジェクトのみを使う
    G->>M: 6. 入会upsert / 退会更新
    G->>E: verified + processed を記録
    G-->>S: 200 {received:true}
```

## 設計上の割り切り

- **GASはHTTPステータスを制御できない** ため、どの結果でも 200 相当を返す。障害検知とリカバリは EventLog シート + Stripe ダッシュボードの再送機能に寄せる
- **ロック → 冪等性チェック → 再照会 → 起票** の順序は固定。ロックより先に冪等性を見ると同時リトライで二重起票する
- 会員行は物理削除しない。`status` の更新のみ。継続率KPI（機能4）が joined_at / canceled_at の履歴に依存するため
