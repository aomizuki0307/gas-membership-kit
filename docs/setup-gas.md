# セットアップ (Google 側)

所要 20〜30分。先にこちらを済ませてから [setup-stripe.md](setup-stripe.md) に進む。

## 1. スプレッドシート作成

1. [sheets.new](https://sheets.new) で新規スプレッドシートを作成（名前は例: `membership-db`）
2. URL の `/d/` と `/edit` の間の文字列（スプレッドシートID）を控える

シート（Members / EventLog）とヘッダー行は後述の `initializeSheets` が作るので手作業不要。

## 2. Apps Script API を有効化

[script.google.com/home/usersettings](https://script.google.com/home/usersettings) で「Google Apps Script API」をONにする。**これを忘れると `clasp push` が 403 で失敗する。**

## 3. clasp セットアップ

```powershell
npm install -g @google/clasp
clasp login          # ブラウザが開くのでGoogleアカウントで認可
```

リポジトリのルートで GAS プロジェクトを作成する:

```powershell
clasp create --type standalone --title "gas-membership-kit" --rootDir src
```

- standalone にする理由: Web アプリのデプロイ管理がスプレッドシートから独立して素直になるため（シートには `SpreadsheetApp.openById` でアクセスする）
- 生成された `.clasp.json` は scriptId を含むので **コミットしない**（gitignore 済み）
- `clasp create` が `src/appsscript.json` を上書きした場合は `git checkout src/appsscript.json` で戻す（timeZone=Asia/Tokyo と webapp 設定が必要）

コードを反映する:

```powershell
clasp push
```

## 4. Script Properties 登録

GASエディタ（`clasp open` で開ける）> プロジェクトの設定 > スクリプト プロパティ:

| キー | 値 |
|---|---|
| `SPREADSHEET_ID` | 手順1で控えたID |
| `WEBHOOK_TOKEN` | 自分で生成したランダム文字列。例: `openssl rand -hex 32` や PowerShell `-join ((1..32) | %{ '{0:x2}' -f (Get-Random -Max 256) })` |
| `STRIPE_SECRET_KEY` | Stripe テストモードの `sk_test_...`（setup-stripe.md 手順3で取得） |

機能2/3 の着手時に `ANTHROPIC_API_KEY` / `SLACK_BOT_TOKEN` を追加する予定。

## 5. シート初期化と設定確認

GASエディタで以下を順に実行（初回は権限承認ダイアログが出る）:

1. `initializeSheets` — Members / EventLog シートとヘッダー行を作成
2. `checkConfig` — Script Properties が揃っているか確認
3. `checkStripeConnection` — Stripe キー設定後に。`HTTP 200` が出ればOK

## 6. Web アプリとしてデプロイ

GASエディタ > デプロイ > 新しいデプロイ > 種類「ウェブアプリ」:

- 実行ユーザー: **自分**
- アクセスできるユーザー: **全員**（匿名含む。Stripe は認証なしで POST してくるため必須。ここを間違えると Stripe の POST がログイン画面にリダイレクトされて無言で失敗する）

デプロイ後に表示される **デプロイID** と **URL（`https://script.google.com/macros/s/<ID>/exec`）** を控える。

### 以降のコード更新はこの2コマンド

```powershell
clasp push
clasp deploy -i <デプロイID> -d "update"
```

**`clasp push` だけでは `/exec` に反映されない**（最頻出のハマりどころ）。また `-i` を付けずに `clasp deploy` すると新しいURLが生えて Stripe 側の登録と食い違うので、必ず既存デプロイIDを指定する。

## 7. 疎通確認（Stripe 登録前にできる）

```powershell
# T1: トークンなし → EventLog に token_ng が1行増えるのが正解
curl.exe -sL "https://script.google.com/macros/s/<デプロイID>/exec" -H "Content-Type: application/json" -d '{"id":"evt_fake"}'

# T2: トークンあり + 偽イベントID → not_found_on_stripe が正解（STRIPE_SECRET_KEY 設定後）
curl.exe -sL "https://script.google.com/macros/s/<デプロイID>/exec?token=<WEBHOOK_TOKEN>" -H "Content-Type: application/json" -d '{"id":"evt_fake123","type":"checkout.session.completed","livemode":false}'
```

GAS Web アプリは 302 リダイレクトを挟むので curl には `-L` が必要。どちらも応答は `{"received":true}` になる（HTTPステータスで拒否を表現できないため）。判定は EventLog シートで行う。
