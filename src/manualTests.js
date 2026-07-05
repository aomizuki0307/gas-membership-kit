/**
 * manualTests.js — GASエディタから手動実行するセットアップ/テスト補助。
 *
 * 使い方: GASエディタで関数を選んで「実行」。結果は実行ログ（Ctrl+Enter）と
 * スプレッドシートで確認する。Webhook 経由の結合テスト（curl / stripe trigger）
 * の手順は docs/setup-stripe.md を参照。
 */

/**
 * セットアップ第1歩: Members / EventLog シートを作成しヘッダー行を整える。
 * 既存シートがあればヘッダーだけ上書きする（データ行は触らない）。
 */
function initializeSheets() {
  const spreadsheet = getSpreadsheet_();
  // シートの表示タイムゾーンはスプレッドシート設定に従う（GASプロジェクトの
  // timeZone とは別物）。月次KPIの境界がずれないよう明示的に揃える
  spreadsheet.setSpreadsheetTimeZone('Asia/Tokyo');
  [
    { name: SHEET_MEMBERS, headers: MEMBER_HEADERS },
    { name: SHEET_EVENT_LOG, headers: EVENT_LOG_HEADERS },
  ].forEach((def) => {
    let sheet = spreadsheet.getSheetByName(def.name);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(def.name);
    }
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sheet.setFrozenRows(1);
    console.log('initialized sheet: ' + def.name);
  });
}

/**
 * Script Properties が揃っているかの確認（値そのものは出力しない）。
 */
function checkConfig() {
  const config = getConfig_();
  Object.keys(CONFIG_PROPERTY_NAMES).forEach((key) => {
    const value = config[key];
    console.log(
      CONFIG_PROPERTY_NAMES[key] + ': ' +
      (value ? 'set (length=' + value.length + ')' : 'MISSING')
    );
  });
  if (config.spreadsheetId) {
    console.log('spreadsheet name: ' + getSpreadsheet_().getName());
  }
}

/**
 * Stripe API への疎通確認。テストモードのキーで残高APIを叩くだけ。
 */
function checkStripeConnection() {
  const res = stripeGet_('/balance');
  console.log('GET /v1/balance -> HTTP ' + res.code);
  if (res.code !== 200) {
    console.log(res.body);
  }
}

/**
 * 会員起票の単体テスト: モック会員を upsert → 退会 → 再入会して
 * Members シートの動きを目視確認する。
 */
function testMemberLifecycle() {
  const mock = {
    customerId: 'cus_MANUAL_TEST',
    subscriptionId: 'sub_MANUAL_TEST',
    email: 'manual-test@example.com',
    name: 'Manual Test',
    plan: 'price_MANUAL_TEST',
  };
  upsertMember_(mock);
  console.log('1. 入会起票: Members に cus_MANUAL_TEST が active で追加されたはず');

  const found = markMemberCanceled_('sub_MANUAL_TEST', 'cus_MANUAL_TEST');
  console.log('2. 退会起票: found=' + found + '（status=canceled になったはず）');

  upsertMember_(mock);
  console.log('3. 再入会: status=active に戻り canceled_at がクリアされたはず');
  console.log('確認後、Members の cus_MANUAL_TEST 行は手動で削除してください');
}

/**
 * 冪等性判定の単体テスト: 同じ event_id を processed で記録した後に
 * isProcessedEvent_ が true を返すことを確認する。
 */
function testIdempotency() {
  const eventId = 'evt_MANUAL_TEST_' + new Date().getTime();
  console.log('before log: isProcessedEvent_=' + isProcessedEvent_(eventId) + '（false のはず）');
  logEvent_({
    eventId: eventId,
    eventType: 'manual.test',
    verification: VERIFICATION.VERIFIED,
    processing: PROCESSING.PROCESSED,
    summary: 'manual idempotency test',
  });
  console.log('after log: isProcessedEvent_=' + isProcessedEvent_(eventId) + '（true のはず）');
}
