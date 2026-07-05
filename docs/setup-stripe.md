# セットアップ (Stripe 側)

前提: [setup-gas.md](setup-gas.md) を完了し、Web アプリの URL と `WEBHOOK_TOKEN` が手元にあること。
所要 30分前後。すべて**テストモード**で行う。実カード・実課金は使わない。

## 1. アカウント作成とテストモード確認

1. [dashboard.stripe.com/register](https://dashboard.stripe.com/register) でアカウント作成（メール認証のみ。本番申請・本人確認は不要）
2. ダッシュボード右上が「テストモード」（サンドボックス）になっていることを確認。以降の操作はすべてテストモード

## 2. シークレットキー取得

開発者 > APIキー > 「シークレットキー」（`sk_test_...`）を表示してコピーし、GAS の Script Properties `STRIPE_SECRET_KEY` に登録する。公開可能キー（`pk_test_`）は今回使わない。

登録後、GASエディタで `checkStripeConnection` を実行して `HTTP 200` を確認。

## 3. 商品と Payment Link 作成

1. 商品カタログ > 商品を追加: 名前「コミュニティ会員」、料金は **継続（月次）** ¥1,000
2. 作成した価格から **Payment Link を作成**（デモ用の入会導線）。URL を控える

## 4. Webhook エンドポイント登録

開発者 > Webhook > エンドポイントを追加:

- エンドポイントURL: `https://script.google.com/macros/s/<デプロイID>/exec?token=<WEBHOOK_TOKEN>`
- 送信イベントは次の **2つだけ** 選択:
  - `checkout.session.completed`
  - `customer.subscription.deleted`

登録後に「署名シークレット」（`whsec_...`）が表示されるが、**このプロジェクトでは使わない**。GAS はリクエストヘッダーを受け取れず署名検証ができないため、URLトークン + イベント再照会で代替している（詳細は README の設計判断の節）。

## 5. Stripe CLI インストール

正常系テストには Stripe CLI がほぼ必須。ダッシュボードの「テストイベントを送信」は ID が実在しない合成イベントで、本プロジェクトの再照会検証では**設計どおり拒否される**（負のテストとしてのみ有用）。

```powershell
scoop install stripe    # または https://github.com/stripe/stripe-cli/releases から zip
stripe login             # ブラウザで認可
```

## 6. テストマトリクス

| # | テスト | 手順 | 期待結果（EventLog） |
|---|---|---|---|
| T1 | トークンなし偽POST | setup-gas.md 手順7の curl | `token_ng`、Members 不変 |
| T2 | 偽イベントID | 同上 | `not_found_on_stripe`、Members 不変 |
| T3 | ダッシュボード「テストイベントを送信」 | Webhookエンドポイント画面から | **拒否が正解**: `not_found_on_stripe`（= 再照会検証が機能している証拠） |
| T4 | 入会（本物イベント） | `stripe trigger checkout.session.completed` | `verified` + `processed`、Members に1行追加 |
| T5 | 退会（本物イベント） | `stripe trigger customer.subscription.deleted` | 該当行が `status=canceled` |
| T6 | 冪等性 | ダッシュボード > Webhook > 配信履歴から T4 のイベントを「再送信」 | `duplicate`、二重起票なし |
| T7 | E2Eデモ | Payment Link をブラウザで開き、テストカード `4242 4242 4242 4242`（有効期限は未来の任意、CVCは任意3桁）で決済 | Members に1行追加。この画面録画がデモGIFになる |

補足:

- `stripe trigger checkout.session.completed` はテスト環境に顧客・商品・Checkout セッションを実際に作ってから本物のイベントを発火する。ただし mode=payment で発火するケースがあるため、`type_ignored` になった場合は T7 の Payment Link 決済でサブスク入会を検証する
- T4〜T6 の後、テストデータはダッシュボードの「テストデータを削除」でいつでも一掃できる
- **ダッシュボードの配信履歴は「失敗」表示になるのが正常**。GAS は POST 応答を 302 リダイレクトで返し、Stripe はリダイレクトを追わないため、処理が成功していても失敗として記録される。成否の実体は必ず EventLog シートで判断する。失敗扱いによる自動再送は T6 の冪等性ガードが `duplicate` として吸収する

## 7. スクショ・録画時の注意

Webhook URL には `token=` が含まれる。**スクショやデモGIFに URL バーやエンドポイント設定画面を写す場合はトークン部分を必ずマスクする**（このプロジェクトで最もありがちな漏洩経路）。`sk_test_` も同様。テストモードとはいえ公開はしない。
