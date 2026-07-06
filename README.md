# gas-membership-kit

会員制コミュニティの運用を Google Apps Script だけで自動化する個人プロジェクト。Stripe の入退会を Webhook で受けてスプレッドシートの会員DBに起票し、月次レポート生成（Claude API）、Slack 通知、KPI集計（会員数・継続率）まで全機能を実装済み。サーバは立てない。ランニングコストは Claude API の従量課金のみ。

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
    Sheet -- report_text --> Slack[Slack 配信<br>会員DM + 運営サマリー]
    Sheet -- EventLog リプレイ --> KPI[KPIダッシュボード<br>kpi.js]
    KPI -- 集計表 + チャート --> Sheet
```

シーケンスの詳細は [docs/architecture.md](docs/architecture.md)。

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
| 3 | Slack Bot 通知（会員DM + 運営サマリー投稿） | 実装済み（slack.js + slackApi.js） |
| 4 | KPIダッシュボード（会員数・継続率の自動集計） | 実装済み（kpi.js） |

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

## Slack 配信（機能3）

Reports シートの report_text を、会員の Slack DM（`Members.slack_user_id`、当面手入力）へ配信し、実行結果の集計を運営チャンネルへ投稿する。起点は `sendMonthlyReportsToSlack` の**手動実行**。LLM 生成文を会員へ送る前に運営が Reports を目視するゲートを挟む運用で、トリガーは意図的に設置していない（無人化する場合は `setupMonthlySlackTrigger` で毎月1日10時台に設定できる）。

会員DMの実受信（Bot が生成済みの report_text をそのまま届ける）:

![DM受信](docs/images/demo-slack-dm-received.png)

運営チャンネルのサマリー。1回目「送信: 1」の直後に再実行した2回目が「送信: 0 / 済みスキップ: 1」になっており、冪等性が実測で効いている:

![運営サマリー受信](docs/images/demo-slack-summary-received.png)

SlackLog には DM 送信・サマリー投稿・宛先なしスキップの全経路が slack_ts 付きで残る:

![SlackLog起票](docs/images/demo-slacklog-sheet.png)

```
sendMonthlyReportsToSlack（手動実行。4.5分で打ち切り→再実行で残りを処理）
 ├─ 当月の Reports(status=generated) を抽出（同一会員は先勝ちで1件）
 ├─ 会員ごとに（1会員分だけスクリプトロックを保持）
 │    ├─ 冪等性チェック ──── (report_month, customer_id, dm) が sent/blocked 済み: スキップ
 │    ├─ 宛先の解決 ──────── active でない / slack_user_id 未設定・形式不正: skipped_no_slack_id
 │    ├─ 検証ゲート ──────── NG: blocked（送信しない）
 │    └─ conversations.open → chat.postMessage → SlackLog に起票
 └─ 運営チャンネルへ実行サマリー投稿（件数のみの固定フォーマット）
```

設計判断:

- **送信前の検証ゲート**。report_text は LLM 出力＝信頼できない文字列で、会員名（Stripe Checkout の自由入力）経由のプロンプトインジェクションがありうる。長さ 20〜500 字・URL/スキーム省略ドメイン/IP アドレス・制御文字/bidi 制御/ゼロ幅文字をすべて拒否し、NG は blocked として SlackLog に残して送信しない。想定文面（日本語のお礼 150〜250 字）にドメイン様の文字列が出ること自体が異常なので、誤検知は許容する設計
- **エスケープは送信の最終関門で強制**。`postSlackMessage_` 内部で & < > を無条件に実体参照化するため、`<!channel>` や `<@U...>` などのメンション・リンク構文は経路を問わず構造的に成立しない（ゲートとの二重防御）
- **冪等性キーは (report_month, stripe_customer_id, channel_type=dm)**。「済み」は sent と blocked のみ。blocked を済みに含めないと再実行のたびに blocked 行が増殖する。error と skipped_no_slack_id は済みに含めず、**slack_user_id を後から手入力して再実行すれば送られる**（これが正規の運用導線）
- **at-least-once に倒す**。送信成功→ログ書き込み前のクラッシュは「重複DM」として現れる。逆順（先にログ）だと「送っていないのに sent」という検知不能な不整合になるため採らない
- **運営サマリーは件数のみの固定フォーマット**（LLM テキスト・会員名を含めない＝この経路にインジェクション面はない）。冪等ブロックもしない。再実行の回復結果こそ運営が見たい情報で、全スキップの「0 sent / N skipped」もハートビートとして機能する
- **Slack API はエラーを HTTP 200 + `{ok:false}` で返す**ため、ラッパは HTTP コードと `body.ok` の両方を検査する（`channel_not_found`=bot の /invite 漏れ、`invalid_auth`=トークン不備が全部 200 で来る）
- DM は `chat.postMessage` への U-ID 直渡しではなく `conversations.open`（冪等）→ D-ID 宛て投稿。公式ドキュメント内で直渡しの挙動記述が矛盾しているため、一意に文書化されている経路に統一した

実測済み: 宛先なしフォールバック（運営チャンネルへ `[DMテスト代替]`）→ DM 実送信 → 同月再実行で「送信=0 / 済みスキップ=1」の冪等性まで全経路を確認。

テスト用の関数（GASエディタから実行）: `checkSlackConnection`（auth.test 疎通）/ `testValidateReportText`（ゲート単体・ネットワーク不要）/ `testSendSingleReportToSlack`（1件だけ全経路。会員0件・slack_user_id 未設定でも運営チャンネル代替で動く）。

### Slack アプリのセットアップ

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App（From scratch）
2. OAuth & Permissions → Bot Token Scopes に **`chat:write`** と **`im:write`** を追加
3. Install to Workspace → `xoxb-` トークンを Script Properties の **`SLACK_BOT_TOKEN`** へ
4. 運営チャンネルで `/invite @ボット名` → チャンネルID (C...) を **`SLACK_SUMMARY_CHANNEL`** へ
5. 会員のDM宛先: Slack プロフィール → 「メンバーIDをコピー」(U...) を Members シートの `slack_user_id` に手入力

## KPIダッシュボード（機能4）

毎月1日 11時台 JST の時刻トリガー（9時=レポート生成、10時=Slack配信の後）が `rebuildKpiDashboard` を起動し、KPI シートに月次集計表（会員数・新規入会・退会・チャーン率・継続率）とチャート3枚を全再構築する。GASエディタからの手動実行でいつでも再計算できる。

![KPIシート](docs/images/demo-kpi-sheet.png)

```
rebuildKpiDashboard（トリガー起点 兼 手動実行可。読むだけ＋KPIシート再構築なので何度でも安全）
 ├─ EventLog 読み出し ── processed かつ入会/退会イベントのみ抽出・時系列ソート
 ├─ リプレイ ──────────── 会員ごとの active 状態を月毎に再構成（最古月〜当月、欠損月なし）
 ├─ KPIシート全再構築 ── 既存チャート削除 → clearContents → 一括書き込み → チャート再挿入
 └─ 整合性チェック ────── リプレイの最終アクティブ数 vs Members の実アクティブ数（I1:J5 に表示）
```

設計判断:

- **データソースは Members ではなく EventLog のリプレイ**。再入会時に Members の joined_at は上書きされるため、Members だけでは過去月の会員数を復元できない。追記オンリーの EventLog から `processing=processed` かつ入会/退会の2イベントだけを取り出して状態を再構成すれば、duplicate / type_ignored / テスト行は自然に除外され、どの実行でも過去月は同じ確定値が再現される
- **冪等性は「毎回全再構築」で担保**（追記オンリーではない）。チャートは `clearContents` では消えないため、先に `removeChart` で明示削除してから再挿入するのが要
- **スクリプトロックは握らない**。読み取り＋専用シート書き込みのみで、webhook と共有のロックをバッチで握ると Stripe イベント喪失リスク（機能2と同じ理由）を作る。並走受信との競合は最悪「最新1イベントが今回の集計に入らない」だけで、次回実行で自己修復する
- **チャーン率 = 当月退会数 ÷ 月初アクティブ数**。月初0会員の月は 0/0 で未定義なので空欄にする（0 と書くと「解約ゼロの好調月」と区別できない）。継続率 = 1 − チャーン率
- **入会・退会は「状態遷移した」イベントのみカウント**。これにより `月末 = 月初 + 入会 − 退会` の恒等式が全行で成立し、表が自己検証可能になる。遷移しないイベント（active中の入会等）は冪等性ガードが正常なら発生しないはずのもので、warning としてログに出す
- **整合性チェック**が `MISMATCH` になるのは、Members の手動編集・モック行の消し忘れ・起票漏れがあるときだけ（退会イベントが error で終わったケースは両者とも active のままなので一致する）。データ異常の検知器として機能する
- 既知の近似: received_at は受信時刻であり Stripe のイベント発生時刻ではない（月次KPIでは許容）。当月行は月途中の実行では速報値

テスト用の関数（GASエディタから実行）: `testKpiReplay`（リプレイ純ロジック。再入会・同月入会退会・ギャップ月をモックで検証、ネットワーク/シート不要）/ `testRebuildKpi`（実データで全経路）/ `setupMonthlyKpiTrigger`・`deleteMonthlyKpiTrigger`（トリガー管理）。

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

**SlackLog**（追記オンリー。DM の冪等性キー = report_month + stripe_customer_id + channel_type）

| カラム | 用途 |
|---|---|
| sent_at | 記録日時 |
| report_month | 'yyyy-MM'。冪等性キーの一部 |
| stripe_customer_id | 対象会員（サマリー行は空） |
| channel_type | dm / summary |
| target | 実際の送信先（D... / C...） |
| status | sent / blocked / error / skipped_no_slack_id |
| slack_ts | chat.postMessage 応答の ts。送信の一次証跡 |
| error_message | blocked/skipped/error の理由 |

**KPI**（毎回全再構築。冪等性キーなし＝再実行で常に同じ結果になる）

| カラム | 用途 |
|---|---|
| month | 'yyyy-MM'（テキスト強制） |
| active_start / active_end | 月初・月末のアクティブ会員数 |
| new_joins / cancels | 当月の入会・退会数（状態遷移のみカウント） |
| churn_rate / retention_rate | 退会率と継続率（月初0会員の月は空欄） |
| I1:J5 チェックブロック | リプレイ vs Members の整合性（ok / MISMATCH） |

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
