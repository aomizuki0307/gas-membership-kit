/**
 * eventLog.js — EventLog シートへの追記と、処理済みイベントの重複判定。
 *
 * 設計メモ:
 * - GAS の Web アプリは HTTP ステータスコードを制御できないため、拒否した
 *   リクエストも含めて全経路で必ず1行記録する。このシートが唯一の観測手段。
 * - 冪等性キーは event_id。ただし「処理が完了した(processed / type_ignored)」
 *   記録だけを重複とみなす。error で終わった過去の受信は再送時に再処理させる。
 */

const EVENT_LOG_HEADERS = [
  'received_at',
  'event_id',
  'event_type',
  'livemode',
  'verification',
  'processing',
  'customer_id',
  'summary',
  'error_message',
];

const EVENT_LOG_COL_EVENT_ID = 2;
const EVENT_LOG_COL_PROCESSING = 6;

const COMPLETED_PROCESSING_STATES = [PROCESSING.PROCESSED, PROCESSING.TYPE_IGNORED];

/**
 * EventLog に1行追記する。entry は部分的でよい（未指定カラムは空欄）。
 * 検証前の受信ペイロード由来の値も渡ってくるため、全フィールドを
 * sanitizeForSheet_ で数式インジェクション対策してから書く。
 */
function logEvent_(entry) {
  const sheet = getSheet_(SHEET_EVENT_LOG);
  sheet.appendRow([
    new Date(),
    sanitizeForSheet_(entry.eventId),
    sanitizeForSheet_(entry.eventType),
    typeof entry.livemode === 'boolean'
      ? entry.livemode
      : sanitizeForSheet_(entry.livemode),
    entry.verification || '',
    entry.processing || '',
    sanitizeForSheet_(entry.customerId),
    sanitizeForSheet_(String(entry.summary || '').slice(0, SUMMARY_MAX_LENGTH)),
    sanitizeForSheet_(String(entry.errorMessage || '').slice(0, SUMMARY_MAX_LENGTH)),
  ]);
}

/**
 * この event_id が既に処理完了しているか（= 再送を弾くべきか）を返す。
 */
function isProcessedEvent_(eventId) {
  if (!eventId) {
    return false;
  }
  const sheet = getSheet_(SHEET_EVENT_LOG);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return false;
  }
  const matches = sheet
    .getRange(2, EVENT_LOG_COL_EVENT_ID, lastRow - 1, 1)
    .createTextFinder(eventId)
    .matchEntireCell(true)
    .findAll();
  return matches.some((cell) => {
    const processing = sheet
      .getRange(cell.getRow(), EVENT_LOG_COL_PROCESSING)
      .getValue();
    return COMPLETED_PROCESSING_STATES.indexOf(processing) !== -1;
  });
}
