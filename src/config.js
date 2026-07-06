/**
 * config.js — Script Properties の読み出しとプロジェクト全体の定数。
 *
 * 必要な Script Properties（GASエディタ > プロジェクトの設定 > スクリプト プロパティ）:
 *   STRIPE_SECRET_KEY : Stripe テストモードのシークレットキー (sk_test_...)
 *   WEBHOOK_TOKEN     : Webhook URL の ?token= に付与する自前のランダム文字列
 *   SPREADSHEET_ID    : 会員DB/イベントログを持つスプレッドシートの ID
 *   ANTHROPIC_API_KEY : Claude API のキー (sk-ant-...)。機能②の月次レポートで使用
 *   SLACK_BOT_TOKEN   : Slack Bot の OAuth トークン (xoxb-...)。機能③の通知で使用。
 *                       必要な Bot Token Scopes は chat:write + im:write
 *   SLACK_SUMMARY_CHANNEL : 運営サマリーの投稿先チャンネル ID (C...)。
 *                           Bot をそのチャンネルに /invite しておくこと
 */

const SHEET_MEMBERS = 'Members';
const SHEET_EVENT_LOG = 'EventLog';
const SHEET_REPORTS = 'Reports';
const SHEET_SLACK_LOG = 'SlackLog';

const MEMBER_STATUS = {
  ACTIVE: 'active',
  CANCELED: 'canceled',
};

const VERIFICATION = {
  VERIFIED: 'verified',
  TOKEN_NG: 'token_ng',
  NOT_FOUND: 'not_found_on_stripe',
  PARSE_ERROR: 'parse_error',
};

const PROCESSING = {
  PROCESSED: 'processed',
  DUPLICATE: 'duplicate',
  TYPE_IGNORED: 'type_ignored',
  ERROR: 'error',
};

const LOCK_TIMEOUT_MS = 10000;
const SUMMARY_MAX_LENGTH = 500;

const CONFIG_PROPERTY_NAMES = {
  stripeSecretKey: 'STRIPE_SECRET_KEY',
  webhookToken: 'WEBHOOK_TOKEN',
  spreadsheetId: 'SPREADSHEET_ID',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  slackBotToken: 'SLACK_BOT_TOKEN',
  slackSummaryChannel: 'SLACK_SUMMARY_CHANNEL',
};

// 1実行内でのキャッシュ（ロック保持中の Properties/openById 再取得を避ける）
let cachedConfig_ = null;
let cachedSpreadsheet_ = null;

function getConfig_() {
  if (cachedConfig_) {
    return cachedConfig_;
  }
  const props = PropertiesService.getScriptProperties();
  cachedConfig_ = {
    stripeSecretKey: props.getProperty('STRIPE_SECRET_KEY'),
    webhookToken: props.getProperty('WEBHOOK_TOKEN'),
    spreadsheetId: props.getProperty('SPREADSHEET_ID'),
    anthropicApiKey: props.getProperty('ANTHROPIC_API_KEY'),
    slackBotToken: props.getProperty('SLACK_BOT_TOKEN'),
    slackSummaryChannel: props.getProperty('SLACK_SUMMARY_CHANNEL'),
  };
  return cachedConfig_;
}

/**
 * 使う場面で必要なプロパティだけを検証して返す。
 * 全プロパティを一括必須にすると、Stripeキー未設定の段階で
 * initializeSheets 等のセットアップ関数まで動かなくなるため。
 */
function requireConfig_(key) {
  const value = getConfig_()[key];
  if (!value) {
    throw new Error(
      'Script Property が未設定です: ' + CONFIG_PROPERTY_NAMES[key]
    );
  }
  return value;
}

function getSpreadsheet_() {
  if (!cachedSpreadsheet_) {
    cachedSpreadsheet_ = SpreadsheetApp.openById(requireConfig_('spreadsheetId'));
  }
  return cachedSpreadsheet_;
}

function getSheet_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('シートが見つかりません: ' + sheetName + '（manualTests.js の initializeSheets を実行してください）');
  }
  return sheet;
}

/**
 * シートへ書く自由文字列の数式インジェクション対策。
 * setValue/appendRow は先頭が = の文字列を数式として解釈し、+ - @ も
 * 編集やCSV再取込で数式化しうるため、先頭にアポストロフィを付けて
 * テキスト扱いを強制する（表示上は見えない）。
 */
function sanitizeForSheet_(value) {
  const text = value === undefined || value === null ? '' : String(value);
  if (text && '=+-@'.indexOf(text.charAt(0)) !== -1) {
    return "'" + text;
  }
  return text;
}

/**
 * タイミング攻撃耐性のある文字列比較。SHA-256ダイジェスト同士を
 * 早期リターンなしで全バイト比較する。
 */
function secureEquals_(a, b) {
  const digestA = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(a), Utilities.Charset.UTF_8
  );
  const digestB = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(b), Utilities.Charset.UTF_8
  );
  let diff = 0;
  for (let i = 0; i < digestA.length; i++) {
    diff |= digestA[i] ^ digestB[i];
  }
  return diff === 0;
}
