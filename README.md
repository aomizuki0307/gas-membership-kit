# gas-membership-kit

会員制コミュニティの運用を Google Apps Script だけで自動化する個人プロジェクト。Stripe の入退会を Webhook で受けてスプレッドシートの会員DBに起票し、月次レポート生成（Claude API）と Slack 通知、KPI集計まで持っていく。サーバは立てない。ランニングコストは Claude API の従量課金のみ。

すべて Stripe **テストモード**で動かす前提で、実カード・実課金は一切使わない。

## 動作デモ（実測）

Payment Link をテストカード 4242 で決済すると、Webhook 経由で会員DBに自動起票される。

![入会起票](docs/images/demo-members-joined.png)

ダッシュボードからサブスクリプションをキャンセルすると `customer.subscription.deleted` が飛び、同じ行が `canceled` に更新される（行は消さない）。

![退会起票](docs/images/demo-members-canceled.png)

EventLog には受信の全経路が残る。偽イベントの拒否（`not_found_on_stripe`）、入会・退会の `processed`、そして **Stripe の再送を冪等性ガードが `duplicate` として無害化した記録**まで、1枚で追える。

![EventLog](docs/images/demo-eventlog.png)

## 構成

```mermaid
graph LR
    Stripe[Stripe テストモード] -- "Webhook POST (checkout / cancel)" --> GAS[GAS Webアプリ doPost]
    GAS -- "GET /v1/events/id で再照会" --> Stripe
    GAS -- 起票 --> Sheet[(スプレッドシート<br>Members / EventLog / Reports)]
    Trigger[時刻トリガー 月次] --> Report[月次レポート生成<br>Claude API]
    Report -- 起票 --> Sheet
    Report -.-> Slack[Slack Bot 通知]
    Sheet -.-> KPI[KPIダッシュボード]
    style Slack stroke-dasharray: 5 5
    style KPI stroke-dasharray: 5 5
```

点線は未実装（ロードマップ参照）。シーケンスの詳細は [docs/architecture.md](docs/architecture.md)。

## 設計判断: なぜ署名検証ではなく「再照会検証」なのか

Stripe Webhook の標準的な受け方は `Stripe-Signature` ヘッダーの HMAC 検証だが、**GAS の `doPost` は HTTP ヘッダーを受け取れない**。これは Google が公式に「サポートしない」と明言している仕様で（[Apps Script コミュニティでの公式回答](https://groups.google.com/g/google-apps-script-community/c/bgnzoAUV_No)）、回避策はない。つまり GAS 単体では署名検証は不可能。

プロキシサーバを挟めば署名検証できるが、それをやると「GASだけで完結・サーバ不要」という構成の利点が消える。そこでこのプロジェクトは二段の代替検証にした。

1. **URLトークン**: Webhook URL に `?token=<ランダム32hex>` を付けて登録し、`doPost` で照合する。不一致なら本文をパースすらしない
2. **再照会検証**: 受信ペイロードから `event.id` だけを取り出し、`GET /v1/events/{id}` を Stripe に叩き直す。**Stripe から返ってきたイベントオブジェクトだけを正として処理し、受信ペイロードは信用しない**。偽造リクエストは実在しないイベントIDしか持てないので、ここで落ちる

副作用がひとつあって、Stripe ダッシュボードの「テストイベントを送信」は ID が実在しない合成イベントなので、この方式では**設計どおり拒否される**。正常系のテストには Stripe CLI の `stripe trigger` か、Payment Link での実テスト決済を使う（[docs/setup-stripe.md](docs/setup-stripe.md)）。

シートへ書き込む自由入力文字列（会員の name / email、ログの summary 等）は、先頭が `=` `+` `-` `@` の場合にアポストロフィを付けてテキスト扱いを強制している。スプレッドシートをそのまま管理画面として使う構成では、Checkout で顧客が入力した請求先名などを経由した数式インジェクション（CWE-1236）が実害になるため。

もうひとつの制約として、GAS の Web アプリは HTTP ステータスコードを制御できず、拒否時も 200 相当が返る。Stripe 側からは常に成功に見えるため、受信結果は良否問わずすべて EventLog シートに記録し、そこを唯一の観測手段にしている。取りこぼしはダッシュボードの再送ボタンで手動リカバリする運用。

## 機能とロードマップ

| # | 機能 | 状態 |
|---|------|------|
| 1 | Stripe Webhook → 会員DB起票（入会/退会） | 実装済み |
| 2 | 月次バッチ → Claude API で会員ごとのレポート文生成 | 実装済み（report.js） |
| 3 | Slack Bot 通知（チャンネル投稿 + DM） | 予定（slack.js） |
| 4 | KPIダッシュボード（会員数・継続率の自動集計） | 予定（kpi.js） |

この4つで完成。機能追加はしない。

## Webhook の処理フロー（機能1）

```
doPost
 ├─ 1. URLトークン照合 ──────── 不一致: token_ng でログして終了
 ├─ 2. JSONパース ───────────── 失敗: parse_error
 ├─ 3. スクリプトロック取得 ──── 失敗: error（同時リトライの二重起票防止）
 ├─ 4. 冪等性チェック ────────── 処理済み event_id: duplicate
 ├─ 5. Stripeへ再照会 ────────── 実在しない: not_found_on_stripe
 └─ 6. 起票
      ├─ checkout.session.completed (mode=subscription のみ) → 入会 upsert
      └─ customer.subscription.deleted → status=canceled に更新
```

購読イベントはこの2つだけに絞った。`customer.created` は入会確定前にも飛び、`invoice.paid` は毎月飛んでログのノイズになる。`customer.subscription.updated` を足すと到着順序（Stripe は順序を保証しない）の考慮が要るので、状態遷移を単純に保つためにあえて入れていない。

## 月次レポート生成（機能2）

毎月1日 9時台 JST の時刻トリガーが `generateMonthlyReports` を起動し、`status=active` の会員ごとに Claude API（`claude-haiku-4-5`）で**会員本人向けの月次メッセージ**を生成して Reports シートに起票する。生成物は機能3で Slack DM 送信する素材になる。

![Reports起票](docs/images/demo-reports-sheet.png)

![月次トリガー](docs/images/demo-report-trigger.png)

```
generateMonthlyReports（トリガー起点 兼 手動実行可）
 ├─ active会員の抽出（0件なら no_members を1行記録して終了）
 └─ 会員ごとに（1会員分だけスクリプトロックを保持）
      ├─ 冪等性チェック ── (report_month, customer_id) が generated 済み: スキップ
      ├─ Claude API 呼び出し ── 失敗: error 行を残して次の会員へ
      └─ Reports に起票
```

設計判断:

- **モデルはコスト最優先で Haiku 4.5 固定**。1レポート ≈ 入力800+出力400トークン ≈ $0.003。会員100人でも月 ≈ $0.3
- **冪等性キーは (report_month, stripe_customer_id)**。トリガーの重複発火や手動再実行が二重生成・二重課金にならない。実測の落とし穴: シートは `2026-07` を日付として自動解釈して比較が素通りするため、書き込みはテキスト強制＋読み出しは正規化の両対応にした
- **ロックは1会員分だけ保持**。webhook の doPost と同じスクリプト共有ロックなので、バッチ全体で握るとレポート生成中に届いた Stripe イベントがロック待ちで死ぬ（GAS は常に200を返すため Stripe は再送しない＝イベント喪失）
- **GAS の6分強制終了対策**として4.5分で打ち切り、残りは手動再実行で処理する（生成済みはスキップされる）
- **プロンプトインジェクション緩和**: 会員名は Checkout の自由入力なので `<member_data>` タグで構造的に区切り、データとしてのみ扱うよう system プロンプトで指示。機能3で自動送信を作る際に送信前ゲートを再検討する
- LLM 出力もシートへは全フィールド `sanitizeForSheet_` 経由（機能1と同じ CWE-1236 対策）

テスト用の関数（GASエディタから実行）: `checkClaudeConnection`（疎通）/ `testGenerateSingleReport`（1件だけ全経路）/ `setupMonthlyReportTrigger`・`deleteMonthlyReportTrigger`（トリガー管理）。

## シートスキーマ

**Members**（主キー = stripe_customer_id。物理削除はしない。履歴が消えると継続率が計算できなくなる）

| カラム | 用途 |
|---|---|
| stripe_customer_id | 主キー。upsert の照合キー |
| stripe_subscription_id | 退会イベントとの突合 |
| email / name | 会員特定・レポート宛名 |
| plan | Stripe price ID |
| status | active / canceled |
| joined_at / canceled_at | 入退会日時。継続率KPIの元データ |
| last_event_at | 最終更新イベント時刻 |
| slack_user_id | 機能3のDM用（当面手入力） |

**EventLog**（追記オンリー。冪等性キー = event_id）

| カラム | 用途 |
|---|---|
| received_at / event_id / event_type / livemode | 受信イベントの同定 |
| verification | verified / token_ng / not_found_on_stripe / parse_error |
| processing | processed / duplicate / type_ignored / error |
| customer_id / summary / error_message | 調査用 |

**Reports**（追記オンリー。冪等性キー = report_month + stripe_customer_id）

| カラム | 用途 |
|---|---|
| report_month | 'yyyy-MM'。冪等性キーの片割れ |
| stripe_customer_id / name / plan | 対象会員の同定 |
| months_since_joined | 在籍月数（プロンプトの素材） |
| report_text | 生成されたメッセージ本文（機能3の送信素材） |
| model / input_tokens / output_tokens | コスト追跡 |
| status | generated / error / no_members |
| error_message / generated_at | 調査用 |

## セットアップ

1. [docs/setup-gas.md](docs/setup-gas.md) — スプレッドシート、clasp、Script Properties、Webアプリのデプロイ
2. [docs/setup-stripe.md](docs/setup-stripe.md) — Stripe テスト環境、Webhook エンドポイント登録、Stripe CLI でのテスト

シークレット（`sk_test_...` / Webhook トークン / スプレッドシートID）はすべて GAS の Script Properties に置く。リポジトリには含まれない。`.clasp.json` も scriptId を含むため gitignore 済みで、雛形は `.clasp.json.example`。

## 既知の制約

- **Stripe の配信ステータスは常に「失敗」と表示される（実測）**。GAS の Web アプリは POST 応答を 302 リダイレクトで返し、Stripe はリダイレクトを追わないため。処理は実際には成功しており、成否の正は EventLog シート。失敗扱いに伴う Stripe の自動再送は冪等性ガードが `duplicate` として無害化する（実測で再送1件をブロック済み）。ただし失敗が長期間続く扱いになるため、Stripe がエンドポイントを自動無効化する可能性には注意
- HTTP ステータスを返せないため、Stripe の自動リトライを自分側の障害時に「意図的に」誘発することもできない。EventLog を見て手動再送する
- 冪等性チェックは EventLog シートの全走査（TextFinder）。個人コミュニティの件数なら十分だが、大量イベントには向かない
- テストモード専用として設計している。本番転用するなら少なくとも署名検証（プロキシ経由）と livemode チェックの厳格化が必要

## ライセンス

MIT
