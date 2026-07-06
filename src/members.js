/**
 * members.js — Members シート（会員DB）の起票ロジック。
 *
 * 設計メモ:
 * - 主キーは stripe_customer_id。行の物理削除は絶対にしない
 *   （joined_at / canceled_at の履歴が消えると継続率KPIが計算不能になる）。
 * - 退会は status を canceled に更新するだけ。
 */

const MEMBER_HEADERS = [
  'stripe_customer_id',
  'stripe_subscription_id',
  'email',
  'name',
  'plan',
  'status',
  'joined_at',
  'canceled_at',
  'last_event_at',
  'slack_user_id',
];

const MEMBER_COL = {
  CUSTOMER_ID: 1,
  SUBSCRIPTION_ID: 2,
  EMAIL: 3,
  NAME: 4,
  PLAN: 5,
  STATUS: 6,
  JOINED_AT: 7,
  CANCELED_AT: 8,
  LAST_EVENT_AT: 9,
  SLACK_USER_ID: 10,
};

/**
 * 指定カラムを完全一致で検索し、ヒットした行番号を返す（なければ -1）。
 */
function findMemberRow_(sheet, column, value) {
  if (!value) {
    return -1;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return -1;
  }
  const match = sheet
    .getRange(2, column, lastRow - 1, 1)
    .createTextFinder(value)
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : -1;
}

/**
 * status=active の会員を全件返す（機能②の月次レポート対象抽出）。
 * 会員0件なら空配列。個人コミュニティ規模なので全行読みで十分。
 *
 * @return {Array<{customerId: string, subscriptionId: string, email: string,
 *                 name: string, plan: string, joinedAt: Date|string,
 *                 slackUserId: string}>}
 */
function getActiveMembers_() {
  const sheet = getSheet_(SHEET_MEMBERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  const rows = sheet
    .getRange(2, 1, lastRow - 1, MEMBER_HEADERS.length)
    .getValues();
  return rows
    .filter((row) => row[MEMBER_COL.STATUS - 1] === MEMBER_STATUS.ACTIVE)
    .map((row) => ({
      customerId: String(row[MEMBER_COL.CUSTOMER_ID - 1]),
      subscriptionId: String(row[MEMBER_COL.SUBSCRIPTION_ID - 1]),
      email: String(row[MEMBER_COL.EMAIL - 1]),
      name: String(row[MEMBER_COL.NAME - 1]),
      plan: String(row[MEMBER_COL.PLAN - 1]),
      joinedAt: row[MEMBER_COL.JOINED_AT - 1],
      slackUserId: String(row[MEMBER_COL.SLACK_USER_ID - 1] || '').trim(),
    }));
}

/**
 * 入会起票。既存会員（同じ customer_id）なら再入会として更新、
 * いなければ新規行を追記する。
 *
 * @param {{customerId: string, subscriptionId: string, email: string,
 *          name: string, plan: string}} member
 */
function upsertMember_(member) {
  if (!member.customerId) {
    throw new Error('upsertMember_: customerId がありません');
  }
  const sheet = getSheet_(SHEET_MEMBERS);
  const now = new Date();
  // email / name は Checkout で顧客が自由入力する文字列なので
  // 数式インジェクション対策が必須。他フィールドも一律サニタイズ
  // （Stripe ID は = + - @ で始まらないため実質no-op）
  const safe = {
    customerId: sanitizeForSheet_(member.customerId),
    subscriptionId: sanitizeForSheet_(member.subscriptionId),
    email: sanitizeForSheet_(member.email),
    name: sanitizeForSheet_(member.name),
    plan: sanitizeForSheet_(member.plan),
  };
  const row = findMemberRow_(sheet, MEMBER_COL.CUSTOMER_ID, safe.customerId);
  if (row === -1) {
    sheet.appendRow([
      safe.customerId,
      safe.subscriptionId,
      safe.email,
      safe.name,
      safe.plan,
      MEMBER_STATUS.ACTIVE,
      now,
      '',
      now,
      '',
    ]);
    return;
  }
  // 再入会: joined_at を今回に更新し、canceled_at をクリアする
  sheet
    .getRange(row, MEMBER_COL.SUBSCRIPTION_ID, 1, 8)
    .setValues([
      [
        safe.subscriptionId,
        safe.email,
        safe.name,
        safe.plan,
        MEMBER_STATUS.ACTIVE,
        now,
        '',
        now,
      ],
    ]);
}

/**
 * 退会起票。subscription_id で行を探し、見つからなければ customer_id で
 * フォールバック。行が見つかれば true、見つからなければ false
 * （呼び出し側で error としてログし、起票漏れを検知する）。
 *
 * フォールバック時は行の subscription_id が空の場合のみ解約する。
 * 解約→即再契約で行が新しい subscription_id に上書きされた後、
 * 旧サブスクの deleted イベントが遅延到着すると、無条件フォールバックでは
 * アクティブな新契約を誤って解約してしまうため。
 */
function markMemberCanceled_(subscriptionId, customerId) {
  const sheet = getSheet_(SHEET_MEMBERS);
  let row = findMemberRow_(sheet, MEMBER_COL.SUBSCRIPTION_ID, subscriptionId);
  if (row === -1) {
    const candidate = findMemberRow_(sheet, MEMBER_COL.CUSTOMER_ID, customerId);
    if (candidate !== -1) {
      const rowSubscriptionId = sheet
        .getRange(candidate, MEMBER_COL.SUBSCRIPTION_ID)
        .getValue();
      if (!rowSubscriptionId) {
        row = candidate;
      }
    }
  }
  if (row === -1) {
    return false;
  }
  const now = new Date();
  sheet.getRange(row, MEMBER_COL.STATUS).setValue(MEMBER_STATUS.CANCELED);
  sheet.getRange(row, MEMBER_COL.CANCELED_AT).setValue(now);
  sheet.getRange(row, MEMBER_COL.LAST_EVENT_AT).setValue(now);
  return true;
}
