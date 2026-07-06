/**
 * slack.js — 機能③: 月次レポートの Slack 配信（会員DM + 運営サマリー）。
 *
 * Reports シートの report_text（機能②が生成した会員向け月次メッセージ）を、
 * Members.slack_user_id 宛の DM として配信し、実行結果の集計を運営チャンネルに
 * 投稿する。トリガーは設置せず手動実行が起点（LLM生成文を会員へ送る前に
 * 運営が Reports を目視するゲートを挟む運用。トリガー管理関数だけ用意しておく）。
 *
 * 設計メモ:
 * - 冪等性キーは (report_month, stripe_customer_id, channel_type=dm)。
 *   「済み」とみなすのは sent と blocked のみ。
 *     - blocked を済みに含めないと、再実行のたびに blocked 行が増殖する
 *       （同月の report_text は冪等生成で不変なので再評価しても結果は同じ）。
 *     - error（API失敗）と skipped_no_slack_id は済みに含めない。
 *       slack_user_id を後から手入力して再実行すれば送られる、が正規の運用導線。
 * - 送信は at-least-once に倒す（送信成功→ログ書き込み前のクラッシュは重複DM
 *   として現れる）。逆の at-most-once（先にログを書く）は「送っていないのに
 *   sent と記録される」= 検知不能な沈黙のデータ不整合になるため採らない。
 *   危険窓は数百msで、主因の6分強制終了は時間予算打ち切りでほぼ排除できる。
 * - report_text は LLM 出力＝信頼できない文字列。送信前に validateReportText_
 *   （長さ・URL/ドメイン禁止・制御文字/不可視文字禁止）で検査し、さらに
 *   postSlackMessage_ 内部で & < > を無条件エスケープして <!channel> や
 *   <@U...> 等のメンション・リンク構文を構造的に無害化する（二重防御）。
 * - Reports 行の error_message が非空（output truncated 等）の行は、本文だけ
 *   からは切断を検知できないため無条件で blocked にする。
 * - ロックは webhook.doPost / report.js と共有のスクリプトロック。バッチ全体で
 *   握ると Stripe イベントを喪失するため、保持は1会員分に限定する。
 * - 既知のトレードオフ: ロック保持中に Slack API を呼ぶため、Slack 側の遅延が
 *   LOCK_TIMEOUT_MS を超えると、同時刻に届いた Stripe Webhook がロック待ち
 *   タイムアウトで error 落ちしうる（report.js の Claude API 呼び出しと同じ構造）。
 *   その場合もイベントは EventLog に error として残り、Stripe ダッシュボードの
 *   手動再送でリカバリできる（サイレント喪失にはならない）。
 */

const SLACK_LOG_HEADERS = [
  'sent_at',
  'report_month',
  'stripe_customer_id',
  'channel_type',
  'target',
  'status',
  'slack_ts',
  'error_message',
];

const SLACK_LOG_COL = {
  REPORT_MONTH: 2,
  CUSTOMER_ID: 3,
  CHANNEL_TYPE: 4,
  STATUS: 6,
};

const SLACK_CHANNEL_TYPE = {
  DM: 'dm',
  SUMMARY: 'summary',
};

const SLACK_SEND_STATUS = {
  SENT: 'sent',
  BLOCKED: 'blocked',
  ERROR: 'error',
  SKIPPED_NO_SLACK_ID: 'skipped_no_slack_id',
};

// sendReportDmForMember_ の戻り値専用（行の status 列には書かない）
const SLACK_RESULT_ALREADY_HANDLED = 'already_handled';

// 冪等性チェックで「済み」とみなす状態（設計メモ参照）
const SLACK_DM_HANDLED_STATES = [
  SLACK_SEND_STATUS.SENT,
  SLACK_SEND_STATUS.BLOCKED,
];

// GAS のトリガー実行は約6分で強制終了されるため、余裕をみて打ち切る。
// 打ち切られた分は再実行で処理される（送信済みはスキップ）
const SLACK_BATCH_TIME_BUDGET_MS = 4.5 * 60 * 1000;

// レポートの想定は150〜250字。20字未満は生成異常とみなす
const SLACK_TEXT_MIN_LENGTH = 20;

// conversations.open が Tier 3（50+/分）で律速のため、会員間に1.5秒挟む
// （最大40会員/分。1秒間隔=60/分だと Tier 3 下限をわずかに超えうる）
const SLACK_SEND_INTERVAL_MS = 1500;

/**
 * 月次レポート配信の本体。GASエディタから手動実行する
 * （トリガーを設置する場合も起点はこの関数）。
 */
function sendMonthlyReportsToSlack() {
  const startedAtMs = Date.now();
  try {
    const now = new Date();
    const reportMonth = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
    const reports = getGeneratedReports_(reportMonth);
    const memberMap = {};
    getActiveMembers_().forEach((member) => {
      memberMap[member.customerId] = member;
    });

    const counts = {
      total: reports.length,
      sent: 0,
      alreadyHandled: 0,
      skipped: 0,
      blocked: 0,
      error: 0,
      remaining: 0,
    };
    for (let i = 0; i < reports.length; i++) {
      if (Date.now() - startedAtMs > SLACK_BATCH_TIME_BUDGET_MS) {
        counts.remaining = reports.length - i;
        console.error(
          'sendMonthlyReportsToSlack: 実行時間の上限が近いため打ち切り。残り ' +
          counts.remaining + '件。再実行すれば送信済み分はスキップされます'
        );
        break;
      }
      const report = reports[i];
      const result = sendReportDmForMember_(
        reportMonth, report, memberMap[report.customerId]
      );
      if (result === SLACK_SEND_STATUS.SENT) {
        counts.sent++;
      } else if (result === SLACK_RESULT_ALREADY_HANDLED) {
        counts.alreadyHandled++;
      } else if (result === SLACK_SEND_STATUS.SKIPPED_NO_SLACK_ID) {
        counts.skipped++;
      } else if (result === SLACK_SEND_STATUS.BLOCKED) {
        counts.blocked++;
      } else {
        counts.error++;
      }
      // API を呼んだ経路だけレート制限対策の間隔を空ける
      if (result === SLACK_SEND_STATUS.SENT || result === SLACK_SEND_STATUS.ERROR) {
        Utilities.sleep(SLACK_SEND_INTERVAL_MS);
      }
    }

    // 打ち切り時も沈黙せず、未処理件数を含めて必ずサマリーを投稿する
    postRunSummaryToOps_(reportMonth, counts);
    console.log(
      'sendMonthlyReportsToSlack: ' + reportMonth +
      ' 対象=' + counts.total +
      ' 送信=' + counts.sent +
      ' 済みスキップ=' + counts.alreadyHandled +
      ' 宛先なし=' + counts.skipped +
      ' ブロック=' + counts.blocked +
      ' エラー=' + counts.error +
      (counts.remaining > 0 ? ' 未処理=' + counts.remaining : '')
    );
  } catch (err) {
    // ここに来るのは想定外の例外のみ（送信失敗は sendReportDmForMember_ が
    // error 行として吸収する）。サイレントに死なないよう必ずログを残す
    console.error('sendMonthlyReportsToSlack: 予期しないエラー: ' + String((err && err.stack) || err));
    // シート未作成等でバッチが起動すらできなかった場合も、運営が Slack 側で
    // 異常を検知できるよう通知だけ試みる（これも失敗したら console のみ）
    try {
      const posted = postSlackMessage_(
        requireConfig_('slackSummaryChannel'),
        '【月次レポート配信】予期しないエラーで異常終了しました。GAS の実行ログを確認してください: ' +
          String(err).slice(0, 200)
      );
      if (posted.status !== 'ok') {
        console.error('sendMonthlyReportsToSlack: 異常終了の通知にも失敗: HTTP ' + posted.code + ' — ' + posted.message);
      }
    } catch (notifyErr) {
      console.error('sendMonthlyReportsToSlack: 異常終了の通知にも失敗: ' + String(notifyErr));
    }
  }
}

/**
 * 1会員分のDM送信。冪等性チェック→検証ゲート→DM open→送信→SlackLog起票を
 * スクリプトロックで囲み、同時実行での二重送信を防ぐ。
 * ロック保持は1会員分（数秒）に限定し、doPost を長時間待たせない。
 *
 * @param {string} reportMonth 'yyyy-MM'
 * @param {{customerId: string, reportText: string, errorMessage: string}} report
 * @param {{slackUserId: string}|undefined} member active会員（不在なら undefined）
 * @return {string} SLACK_SEND_STATUS.* / SLACK_RESULT_ALREADY_HANDLED
 */
function sendReportDmForMember_(reportMonth, report, member) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    appendSlackLogRow_({
      reportMonth: reportMonth,
      customerId: report.customerId,
      channelType: SLACK_CHANNEL_TYPE.DM,
      status: SLACK_SEND_STATUS.ERROR,
      errorMessage: 'script lock timeout (' + LOCK_TIMEOUT_MS + 'ms)',
    });
    return SLACK_SEND_STATUS.ERROR;
  }
  try {
    if (isDmHandled_(reportMonth, report.customerId)) {
      return SLACK_RESULT_ALREADY_HANDLED;
    }

    // 宛先の解決。生成後に退会した会員・slack_user_id 未設定/形式不正は
    // skipped（済み扱いにしない。ID を入力して再実行すれば送られる）
    if (!member) {
      appendSlackLogRow_({
        reportMonth: reportMonth,
        customerId: report.customerId,
        channelType: SLACK_CHANNEL_TYPE.DM,
        status: SLACK_SEND_STATUS.SKIPPED_NO_SLACK_ID,
        errorMessage: 'member not active or not found',
      });
      return SLACK_SEND_STATUS.SKIPPED_NO_SLACK_ID;
    }
    if (!isValidSlackUserId_(member.slackUserId)) {
      appendSlackLogRow_({
        reportMonth: reportMonth,
        customerId: report.customerId,
        channelType: SLACK_CHANNEL_TYPE.DM,
        target: member.slackUserId,
        status: SLACK_SEND_STATUS.SKIPPED_NO_SLACK_ID,
        errorMessage: member.slackUserId
          ? 'slack_user_id invalid format'
          : 'slack_user_id not set',
      });
      return SLACK_SEND_STATUS.SKIPPED_NO_SLACK_ID;
    }

    // 検証ゲート。Reports 行に error_message がある行（output truncated 等）は
    // 本文からは異常を検知できないため無条件でブロックする
    if (report.errorMessage) {
      appendSlackLogRow_({
        reportMonth: reportMonth,
        customerId: report.customerId,
        channelType: SLACK_CHANNEL_TYPE.DM,
        target: member.slackUserId,
        status: SLACK_SEND_STATUS.BLOCKED,
        errorMessage: 'report row has error_message: ' + report.errorMessage,
      });
      return SLACK_SEND_STATUS.BLOCKED;
    }
    const validation = validateReportText_(report.reportText);
    if (!validation.ok) {
      appendSlackLogRow_({
        reportMonth: reportMonth,
        customerId: report.customerId,
        channelType: SLACK_CHANNEL_TYPE.DM,
        target: member.slackUserId,
        status: SLACK_SEND_STATUS.BLOCKED,
        errorMessage: 'validation failed: ' + validation.reason,
      });
      return SLACK_SEND_STATUS.BLOCKED;
    }

    // DMチャンネルを開いて送信
    const opened = openSlackDm_(member.slackUserId);
    if (opened.status !== 'ok') {
      appendSlackLogRow_({
        reportMonth: reportMonth,
        customerId: report.customerId,
        channelType: SLACK_CHANNEL_TYPE.DM,
        target: member.slackUserId,
        status: SLACK_SEND_STATUS.ERROR,
        errorMessage: 'conversations.open failed: HTTP ' + opened.code + ' — ' + opened.message,
      });
      return SLACK_SEND_STATUS.ERROR;
    }
    const posted = postSlackMessage_(opened.channelId, report.reportText);
    if (posted.status !== 'ok') {
      appendSlackLogRow_({
        reportMonth: reportMonth,
        customerId: report.customerId,
        channelType: SLACK_CHANNEL_TYPE.DM,
        target: opened.channelId,
        status: SLACK_SEND_STATUS.ERROR,
        errorMessage: 'chat.postMessage failed: HTTP ' + posted.code + ' — ' + posted.message,
      });
      return SLACK_SEND_STATUS.ERROR;
    }
    appendSlackLogRow_({
      reportMonth: reportMonth,
      customerId: report.customerId,
      channelType: SLACK_CHANNEL_TYPE.DM,
      target: opened.channelId,
      status: SLACK_SEND_STATUS.SENT,
      slackTs: posted.ts,
    });
    return SLACK_SEND_STATUS.SENT;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 当月分の Reports から status=generated の行を抽出する。
 * 同一 customer_id が複数あれば先勝ちで1件に寄せる（冪等性キー上は
 * 起こらないはずだが、手動編集されたシートを信用しない）。
 *
 * @param {string} reportMonth 'yyyy-MM'
 * @return {Array<{customerId: string, reportText: string, errorMessage: string}>}
 */
function getGeneratedReports_(reportMonth) {
  const sheet = getSheet_(SHEET_REPORTS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  const rows = sheet
    .getRange(2, 1, lastRow - 1, REPORT_HEADERS.length)
    .getValues();
  const seen = {};
  const reports = [];
  rows.forEach((row) => {
    const month = normalizeReportMonth_(row[REPORT_COL.REPORT_MONTH - 1]);
    const status = row[REPORT_COL.STATUS - 1];
    const customerId = String(row[REPORT_COL.CUSTOMER_ID - 1] || '');
    if (month !== reportMonth || status !== REPORT_STATUS.GENERATED || !customerId) {
      return;
    }
    if (seen[customerId]) {
      return;
    }
    seen[customerId] = true;
    reports.push({
      customerId: customerId,
      reportText: String(row[REPORT_COL.REPORT_TEXT - 1] || ''),
      errorMessage: String(row[REPORT_COL.ERROR_MESSAGE - 1] || ''),
    });
  });
  return reports;
}

/**
 * 送信前の検証ゲート。生テキストで判定する（エスケープは送信直前に別途適用）。
 * report_text は LLM 出力で、プロンプトインジェクション成功時の典型ペイロードを
 * ここで落とす。想定文面（お礼150〜250字）に URL や制御文字が入ること自体が
 * 異常シグナルなので、誤検知コスト（blocked 行が残り運営が目視）は許容する。
 *
 * @param {string} text
 * @return {{ok: true} | {ok: false, reason: string}}
 */
function validateReportText_(text) {
  if (!text) {
    return { ok: false, reason: 'empty text' };
  }
  if (text.length < SLACK_TEXT_MIN_LENGTH) {
    return { ok: false, reason: 'too short: ' + text.length + ' chars < ' + SLACK_TEXT_MIN_LENGTH };
  }
  if (text.length > SUMMARY_MAX_LENGTH) {
    return { ok: false, reason: 'too long: ' + text.length + ' chars > ' + SUMMARY_MAX_LENGTH };
  }
  if (/https?:\/\/|www\./i.test(text)) {
    return { ok: false, reason: 'contains URL' };
  }
  // スキーム省略のドメイン様文字列（evil.com / bit.ly/x 等）も拒否する。
  // Slack はスキームなしでも自動リンク化しうる上、リンク化されなくても
  // フィッシング誘導は成立する。想定文面（日本語のお礼150〜250字）に
  // ドメイン様のASCII列が出ること自体が異常なので、誤検知は許容する
  if (/[a-z0-9-]+\.[a-z]{2,}/i.test(text)) {
    return { ok: false, reason: 'contains domain-like string' };
  }
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text)) {
    return { ok: false, reason: 'contains ip-like string' };
  }
  // 改行(\n)以外の制御文字と、表示偽装に使える Unicode 方向制御を拒否
  if (/[\x00-\x09\x0B-\x1F\x7F]/.test(text)) {
    return { ok: false, reason: 'contains control characters' };
  }
  if (/[\u202A-\u202E\u2066-\u2069]/.test(text)) {
    return { ok: false, reason: 'contains bidi control characters' };
  }
  // \u30BC\u30ED\u5E45\u6587\u5B57\u30FBBOM \u306F\u7981\u6B62\u30D1\u30BF\u30FC\u30F3\u306E\u5206\u65AD\u633F\u5165\uFF08h + ZWSP + ttps \u7B49\uFF09\u306B\u3088\u308B
  // \u6B63\u898F\u8868\u73FE\u30D0\u30A4\u30D1\u30B9\u306B\u4F7F\u3048\u308B\u305F\u3081\u62D2\u5426\u3059\u308B
  if (/[\u200B-\u200F\u2060-\u2064\uFEFF]/.test(text)) {
    return { ok: false, reason: 'contains invisible unicode characters' };
  }
  return { ok: true };
}

/**
 * Slack メンバーIDの形式チェック。U 始まり（通常）と W 始まり
 * （Enterprise Grid）を許容する。表示名や C-ID の貼り間違いを
 * skipped に落とすための防御。
 */
function isValidSlackUserId_(value) {
  return /^[UW][A-Z0-9]{4,}$/.test(String(value || ''));
}

/**
 * この (report_month, customer_id) のDMが処理済み（sent/blocked）かを返す。
 * report.js の isReportGenerated_ と同じ TextFinder 方式。
 */
function isDmHandled_(reportMonth, customerId) {
  if (!customerId) {
    return false;
  }
  const sheet = getSheet_(SHEET_SLACK_LOG);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return false;
  }
  const matches = sheet
    .getRange(2, SLACK_LOG_COL.CUSTOMER_ID, lastRow - 1, 1)
    .createTextFinder(customerId)
    .matchEntireCell(true)
    .findAll();
  return matches.some((cell) => {
    const row = cell.getRow();
    const month = sheet.getRange(row, SLACK_LOG_COL.REPORT_MONTH).getValue();
    const channelType = sheet.getRange(row, SLACK_LOG_COL.CHANNEL_TYPE).getValue();
    const status = sheet.getRange(row, SLACK_LOG_COL.STATUS).getValue();
    return (
      normalizeReportMonth_(month) === reportMonth &&
      channelType === SLACK_CHANNEL_TYPE.DM &&
      SLACK_DM_HANDLED_STATES.indexOf(status) !== -1
    );
  });
}

/**
 * SlackLog に1行追記する。entry は部分的でよい（未指定カラムは空欄）。
 */
function appendSlackLogRow_(entry) {
  const sheet = getSheet_(SHEET_SLACK_LOG);
  sheet.appendRow([
    new Date(),
    // '2026-07' はシートに日付として自動解釈されるため、アポストロフィで
    // テキスト扱いを強制する（冪等性キーの比較を文字列で安定させる）
    entry.reportMonth ? "'" + entry.reportMonth : '',
    sanitizeForSheet_(entry.customerId),
    entry.channelType || '',
    sanitizeForSheet_(entry.target),
    entry.status || '',
    sanitizeForSheet_(entry.slackTs),
    sanitizeForSheet_(String(entry.errorMessage || '').slice(0, SUMMARY_MAX_LENGTH)),
  ]);
}

/**
 * 運営チャンネルへ実行結果サマリーを投稿する。
 * - 本文は固定フォーマットの件数のみ（LLMテキストや会員名を含めない＝
 *   この経路にはインジェクション面が存在しない）
 * - 冪等ブロックはしない。サマリーは「この実行」の結果報告であり、
 *   再実行の回復結果こそ運営が見たい情報（全skippedでもハートビートになる）
 * - 失敗してもバッチ全体は成功扱い（throw せず error 行を残すだけ）
 */
function postRunSummaryToOps_(reportMonth, counts) {
  const text = [
    '【月次レポート配信結果】' + reportMonth,
    '対象レポート: ' + counts.total + '件',
    '送信: ' + counts.sent +
      ' / 済みスキップ: ' + counts.alreadyHandled +
      ' / 宛先なしスキップ: ' + counts.skipped +
      ' / ブロック: ' + counts.blocked +
      ' / エラー: ' + counts.error +
      (counts.remaining > 0 ? ' / 未処理(打ち切り): ' + counts.remaining : ''),
    '詳細は SlackLog シートを確認してください',
  ].join('\n');
  let channelId = '';
  try {
    channelId = requireConfig_('slackSummaryChannel');
    const posted = postSlackMessage_(channelId, text);
    if (posted.status !== 'ok') {
      appendSlackLogRow_({
        reportMonth: reportMonth,
        channelType: SLACK_CHANNEL_TYPE.SUMMARY,
        target: channelId,
        status: SLACK_SEND_STATUS.ERROR,
        errorMessage: 'summary post failed: HTTP ' + posted.code + ' — ' + posted.message,
      });
      return;
    }
    appendSlackLogRow_({
      reportMonth: reportMonth,
      channelType: SLACK_CHANNEL_TYPE.SUMMARY,
      target: channelId,
      status: SLACK_SEND_STATUS.SENT,
      slackTs: posted.ts,
    });
  } catch (err) {
    appendSlackLogRow_({
      reportMonth: reportMonth,
      channelType: SLACK_CHANNEL_TYPE.SUMMARY,
      target: channelId,
      status: SLACK_SEND_STATUS.ERROR,
      errorMessage: 'summary post failed: ' + String(err).slice(0, 300),
    });
  }
}

/**
 * 手動テスト用: 1件だけ送信の全経路（抽出→ゲート→送信→SlackLog起票）を通す。
 * - 当月の generated レポートがあれば先頭1件を使い、なければモック文面で代替
 * - 宛先の slack_user_id があれば本物のDM経路、なければ運営チャンネルへ
 *   [DMテスト代替] プレフィックス付きで送る
 * → 会員0件・slack_user_id 未設定でも全経路をテストできる
 *
 * 注意: DM経路で実行した場合は SlackLog に sent が記録されるため、
 * その会員は当月のバッチ送信でスキップされる（実際に届いているので正しい）。
 */
function testSendSingleReportToSlack() {
  const now = new Date();
  const reportMonth = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
  const reports = getGeneratedReports_(reportMonth);
  const report = reports.length > 0
    ? reports[0]
    : {
        customerId: 'cus_SLACK_TEST',
        reportText: 'これは Slack 配信のテストメッセージです。今月もご参加ありがとうございます。来月もどうぞよろしくお願いいたします。',
        errorMessage: '',
      };
  console.log('testSendSingleReportToSlack: 対象=' + report.customerId +
    (reports.length > 0 ? '（実データ）' : '（モック）'));

  if (report.errorMessage) {
    console.log('testSendSingleReportToSlack: Reports 行に error_message があるため送信しません: ' + report.errorMessage);
    return;
  }
  const validation = validateReportText_(report.reportText);
  if (!validation.ok) {
    console.log('testSendSingleReportToSlack: 検証ゲートNGのため送信しません: ' + validation.reason);
    return;
  }

  const memberMap = {};
  getActiveMembers_().forEach((member) => {
    memberMap[member.customerId] = member;
  });
  const member = memberMap[report.customerId];

  if (member && isValidSlackUserId_(member.slackUserId)) {
    const result = sendReportDmForMember_(reportMonth, report, member);
    console.log('testSendSingleReportToSlack: DM経路 result=' + result +
      '（Slack の DM と SlackLog シートを確認してください）');
    return;
  }

  // DM宛先がないので運営チャンネルで代替（postMessage・ゲート・ログの検証）
  const channelId = requireConfig_('slackSummaryChannel');
  const posted = postSlackMessage_(
    channelId, '[DMテスト代替] ' + report.reportText
  );
  if (posted.status !== 'ok') {
    console.log('testSendSingleReportToSlack: 送信失敗 HTTP ' + posted.code + ' — ' + posted.message +
      '（channel_not_found なら Bot の /invite 漏れ、invalid_auth ならトークンを確認）');
    return;
  }
  appendSlackLogRow_({
    reportMonth: reportMonth,
    customerId: report.customerId,
    channelType: SLACK_CHANNEL_TYPE.SUMMARY,
    target: channelId,
    status: SLACK_SEND_STATUS.SENT,
    slackTs: posted.ts,
    errorMessage: 'test fallback (no slack_user_id)',
  });
  console.log('testSendSingleReportToSlack: 運営チャンネルに送信しました ts=' + posted.ts +
    '（Slack と SlackLog シートを確認してください）');
}

/**
 * 手動テスト用: 検証ゲートとエスケープの単体テスト（ネットワーク不要）。
 * 期待値と実際の判定を並べて出力する。
 */
function testValidateReportText() {
  const longText = new Array(SUMMARY_MAX_LENGTH + 2).join('あ'); // 501字
  const cases = [
    { label: '正常文（期待: ok）', text: 'いつもご参加ありがとうございます。今月で3ヶ月目となりました。来月もどうぞよろしくお願いいたします。' },
    { label: '空文字（期待: NG empty）', text: '' },
    { label: '20字未満（期待: NG too short）', text: 'ありがとうございます。よろしく。' },
    { label: '501字（期待: NG too long）', text: longText },
    { label: 'URL入り（期待: NG contains URL）', text: 'ありがとうございます。詳細は https://example.com/phish をご覧ください。' },
    { label: 'スキーム省略ドメイン入り（期待: NG domain-like）', text: 'ありがとうございます。詳細は evil-support.com をご覧ください。' },
    { label: 'IPアドレス入り（期待: NG ip-like）', text: 'ありがとうございます。詳細は 192.168.10.1 をご覧ください。' },
    { label: '制御文字入り（期待: NG control）', text: 'ありがとうございます。\x07今後ともよろしくお願いいたします。' },
    { label: 'bidi制御入り（期待: NG bidi）', text: 'ありがとうございます。' + '\u202E' + '今後ともよろしくお願いいたします。' },
    { label: 'ゼロ幅文字入り（期待: NG invisible）', text: 'ありがとうございます。h' + '\u200B' + 'ttpsの分断挿入バイパスの検査です。' },
    { label: '改行入り（期待: ok。\\n は許可）', text: 'いつもご参加ありがとうございます。\n来月もどうぞよろしくお願いいたします。' },
  ];
  cases.forEach((c) => {
    const result = validateReportText_(c.text);
    console.log(c.label + ' → ' + (result.ok ? 'ok' : 'NG: ' + result.reason));
  });
  const escaped = escapeSlackText_('<!channel> & <@U12345> と <https://x|link>');
  console.log('escape: ' + escaped + '（期待: &lt;!channel&gt; &amp; ... とメンション構文が全て無害化）');
}

/**
 * 月次配信トリガーを設定する（毎月1日 10時台 JST = レポート生成の1時間後）。
 * ※ 現運用では設置しない方針（運営が Reports を目視してから手動実行）。
 *   無人化する場合に GASエディタから1回実行する。
 */
function setupMonthlySlackTrigger() {
  deleteMonthlySlackTrigger();
  ScriptApp.newTrigger('sendMonthlyReportsToSlack')
    .timeBased()
    .onMonthDay(1)
    .atHour(10)
    .create();
  console.log('setupMonthlySlackTrigger: 毎月1日 10時台に sendMonthlyReportsToSlack を設定しました');
}

/**
 * 月次配信トリガーを撤去する。
 */
function deleteMonthlySlackTrigger() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'sendMonthlyReportsToSlack') {
      ScriptApp.deleteTrigger(trigger);
      console.log('deleteMonthlySlackTrigger: 既存トリガーを削除しました');
    }
  });
}
