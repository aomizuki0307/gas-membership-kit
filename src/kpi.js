/**
 * kpi.js — 機能④: KPIダッシュボード（会員数・継続率の自動集計）。
 *
 * 時刻トリガー（毎月1日 11時 JST。9時=レポート生成、10時=Slack配信の後）が
 * rebuildKpiDashboard を起動し、KPI シートに月次集計表とチャート3枚を
 * 全再構築する。GASエディタからの手動実行でいつでも再計算できる。
 *
 * 設計メモ:
 * - 一次データソースは Members ではなく EventLog のリプレイ。
 *   upsertMember_ は再入会時に joined_at を上書きし canceled_at をクリアする
 *   ため、Members だけでは過去月の会員数を復元できない。EventLog は
 *   追記オンリーで、processing=processed かつ event_type が入会/退会の
 *   2種に絞れば duplicate / type_ignored / manual.test は自然に除外される。
 * - 冪等性は「毎回全再構築」で担保する（追記オンリーではない）。
 *   既存チャート削除→clearContents→一括書き込み→チャート再挿入なので、
 *   何度実行しても行もチャートも増えない。
 * - ロックは KPI シートへの書き込み区間（チャート削除→再挿入）だけ短く握る。
 *   トリガーと手動実行が並走すると、片方の removeChart ともう片方の
 *   insertChart が交錯してチャート重複や表との不整合を作るため。
 *   集計（読み取り）ではロックを握らない: webhook.doPost と共有のロックを
 *   バッチで握ると Stripe イベント喪失リスク（report.js の設計メモ参照）を
 *   作る。書き込み区間は数秒で、report.js の1会員分保持と同等以下。
 *   並走する doPost との読み取り競合は最悪「最新1イベントが今回の集計に
 *   入らない」だけで、次回実行で自己修復する。
 * - クロスチェック: リプレイ最終状態のアクティブ数と Members の実アクティブ数を
 *   突き合わせて固定セルに表示する。退会イベントが error（行未発見）で終わった
 *   場合は Members 側も active のままなので両者は一致する。つまり差分が出るのは
 *   手動編集・モック行の消し忘れ・真の起票漏れだけ（データ異常の検知器）。
 * - 既知の近似: received_at は受信時刻であり Stripe のイベント発生時刻ではない
 *   （再送遅延で月境界が±1ヶ月ずれうるが月次KPIでは許容）。当月行は月途中の
 *   実行では速報値になる。過去月はどの実行でも同じ確定値が再現される。
 * - new_joins / cancels は「状態遷移した」イベントのみ数える。これにより
 *   active_end = active_start + new_joins - cancels の恒等式が全行で成立し、
 *   表が自己検証可能になる。遷移しないイベント（active中の入会・inactiveへの
 *   退会）は冪等性ガードが正常なら発生しないはずのもので、warning として
 *   ログに出す。
 * - チャーン率はコホート定義: 分子は「月初に在籍していた会員のうち当月退会
 *   した数」に限定する。分子を cancels 列（全退会）にすると、同月入会即退会が
 *   月初在籍数を超えて churn > 100% / 継続率マイナスという意味不明な表示に
 *   なりうる（レビューで検出）。コホート定義なら構造的に 0〜100% に収まる。
 *   同月入会即退会の事実は new_joins / cancels 列とチャートで見える。
 */

const KPI_HEADERS = [
  'month',
  'active_start',
  'new_joins',
  'cancels',
  'active_end',
  'churn_rate',
  'retention_rate',
];

// EventLog の読み出し列（eventLog.js の EVENT_LOG_HEADERS に対応する 0-based index）
const KPI_EVENT_COL = {
  RECEIVED_AT: 0,
  EVENT_TYPE: 2,
  PROCESSING: 5,
  CUSTOMER_ID: 6,
};

// チャートのアンカー列（L列）と縦位置。固定位置にすることで再構築のたびに
// 同じ見た目になり、デモスクショが安定する
const KPI_CHART_ANCHOR_COLUMN = 12;
const KPI_CHART_ROWS = { JOINS_CANCELS: 1, ACTIVE_TREND: 20, RETENTION: 39 };
const KPI_CHART_WIDTH = 480;
const KPI_CHART_HEIGHT = 300;

// 整合性チェックブロックの位置（I1:J5）。データ表と分離した固定セルなので
// 月数が増えても位置が変わらない
const KPI_CHECK_ANCHOR = { ROW: 1, COLUMN: 9 };

// GAS のトリガー実行は約6分で強制終了されるため、集計が終わった時点で
// 予算超過なら書き込みへ進まず明確なログで失敗させる（report.js と同じ値）。
// ここに達するのは EventLog が異常肥大したときだけで、旧い KPI シートは
// 無傷のまま残る（全再構築方式なので中途半端な状態にならない）
const KPI_TIME_BUDGET_MS = 4.5 * 60 * 1000;

/**
 * KPIダッシュボード再構築の本体。時刻トリガーの起点であり、GASエディタから
 * そのまま手動実行してもよい（読み取り専用＋全再構築なので何度でも安全）。
 */
function rebuildKpiDashboard() {
  const startedAtMs = Date.now();
  try {
    const now = new Date();
    const currentMonthKey = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM');
    const events = readMembershipEvents_();
    const result = computeMonthlyKpis_(events, currentMonthKey);
    result.warnings.forEach((warning) => {
      console.warn('rebuildKpiDashboard: ' + warning);
    });

    const membersActive = getActiveMembers_().length;
    if (Date.now() - startedAtMs > KPI_TIME_BUDGET_MS) {
      console.error(
        'rebuildKpiDashboard: 集計だけで実行時間の予算を超えました' +
        '（EventLog ' + events.length + '件対象）。KPI シートは前回のまま残しています。' +
        'EventLog の異常肥大（token_ng の大量記録等）を確認し、アーカイブを検討してください'
      );
      return;
    }

    // 書き込み区間のみロック。rebuild 同士の並走（トリガー×手動）で
    // チャート削除と再挿入が交錯するのを防ぐ。取れなければ書かずに終了
    //（もう片方が同じ結果を書くので損失はない）
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      console.error(
        'rebuildKpiDashboard: script lock timeout (' + LOCK_TIMEOUT_MS + 'ms)。' +
        '別の実行が進行中の可能性が高いため、書き込みせず終了します'
      );
      return;
    }
    try {
      const sheet = getSheet_(SHEET_KPI);
      writeKpiSheet_(sheet, result.rows, {
        replayActive: result.replayActive,
        membersActive: membersActive,
        checkedAt: now,
      });
      rebuildKpiCharts_(sheet, result.rows.length);
    } finally {
      lock.releaseLock();
    }

    if (result.replayActive !== membersActive) {
      console.warn(
        'rebuildKpiDashboard: リプレイ(' + result.replayActive +
        ')と Members(' + membersActive + ')のアクティブ数が不一致です。' +
        'Members の手動編集・モック行・起票漏れを確認してください'
      );
    }
    console.log(
      'rebuildKpiDashboard: 対象イベント=' + events.length +
      ' 月数=' + result.rows.length +
      ' replay_active=' + result.replayActive +
      ' members_active=' + membersActive +
      (result.rows.length === 0 ? '（イベント0件: 表とチャートは未作成）' : '')
    );
  } catch (err) {
    // サイレントに死なないよう必ずログを残す（report.js と同型）
    console.error('rebuildKpiDashboard: 予期しないエラー: ' + String((err && err.stack) || err));
  }
}

/**
 * EventLog から会員数の増減に効くイベントだけを時系列順に読み出す。
 * processed 以外（duplicate / type_ignored / error）と対象外イベントは除外。
 *
 * @return {Array<{time: Date, monthKey: string, type: string, customerId: string}>}
 *         type は 'join' | 'cancel'
 */
function readMembershipEvents_() {
  const sheet = getSheet_(SHEET_EVENT_LOG);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  const rows = sheet
    .getRange(2, 1, lastRow - 1, EVENT_LOG_HEADERS.length)
    .getValues();
  const events = [];
  rows.forEach((row, index) => {
    if (row[KPI_EVENT_COL.PROCESSING] !== PROCESSING.PROCESSED) {
      return;
    }
    const eventType = row[KPI_EVENT_COL.EVENT_TYPE];
    let type = null;
    if (eventType === STRIPE_EVENT_CHECKOUT_COMPLETED) {
      type = 'join';
    } else if (eventType === STRIPE_EVENT_SUBSCRIPTION_DELETED) {
      type = 'cancel';
    } else {
      return;
    }
    const customerId = String(row[KPI_EVENT_COL.CUSTOMER_ID] || '').trim();
    if (!customerId) {
      return;
    }
    const receivedAt = row[KPI_EVENT_COL.RECEIVED_AT];
    if (!(receivedAt instanceof Date) || isNaN(receivedAt.getTime())) {
      console.warn(
        'readMembershipEvents_: received_at が日付でない行をスキップ（EventLog ' +
        (index + 2) + '行目）'
      );
      return;
    }
    events.push({
      time: receivedAt,
      monthKey: Utilities.formatDate(receivedAt, 'Asia/Tokyo', 'yyyy-MM'),
      type: type,
      customerId: customerId,
    });
  });
  // 時刻昇順。同時刻は join を先に処理する（checkout→deleted の論理順）
  events.sort((a, b) => {
    const diff = a.time.getTime() - b.time.getTime();
    if (diff !== 0) {
      return diff;
    }
    if (a.type === b.type) {
      return 0;
    }
    return a.type === 'join' ? -1 : 1;
  });
  return events;
}

/**
 * イベント列をリプレイして月次KPI行を組み立てる純関数。
 * シート・ネットワークに触らないため、testKpiReplay でモック配列を使って
 * エッジケースを検証できる。
 *
 * @param {Array} events readMembershipEvents_ の戻り値（時系列順が前提）
 * @param {string} currentMonthKey 'yyyy-MM'。表はこの月まで欠損なく埋める
 * @return {{rows: Array, replayActive: number, warnings: Array<string>}}
 */
function computeMonthlyKpis_(events, currentMonthKey) {
  if (events.length === 0) {
    return { rows: [], replayActive: 0, warnings: [] };
  }
  // Object.create(null) でプロトタイプなしの辞書にする。customerId は
  // Stripe 再照会を通った値だが、'__proto__' 等の継承キーと衝突しない
  // 構造にしておく（外部由来文字列をキーに使う際の多層防御）
  const active = Object.create(null);
  const warnings = [];
  const rows = [];
  let monthKey = events[0].monthKey;
  let i = 0;
  // 無限ループ防止の安全弁（100年分。monthKey の生成バグで currentMonthKey に
  // 到達しない事態をデータ全損ではなくログで検知する）
  let guard = 1200;
  while (guard-- > 0) {
    const activeStart = Object.keys(active).length;
    // チャーン率の分子は「月初に在籍していた会員の退会」に限定する
    // （コホート定義。ファイル冒頭の設計メモ参照）
    const startCohort = Object.create(null);
    Object.keys(active).forEach((customerId) => {
      startCohort[customerId] = true;
    });
    let joins = 0;
    let cancels = 0;
    let cohortCancels = 0;
    while (i < events.length && events[i].monthKey === monthKey) {
      const event = events[i++];
      if (event.type === 'join') {
        if (active[event.customerId]) {
          warnings.push('active中の入会イベントを無視: ' + event.customerId + ' (' + monthKey + ')');
        } else {
          active[event.customerId] = true;
          joins++;
        }
      } else {
        if (active[event.customerId]) {
          delete active[event.customerId];
          cancels++;
          if (startCohort[event.customerId]) {
            cohortCancels++;
            // 同月内の退会→再入会→再退会で二重カウントしない
            delete startCohort[event.customerId];
          }
        } else {
          warnings.push('inactive への退会イベントを無視: ' + event.customerId + ' (' + monthKey + ')');
        }
      }
    }
    // 月初0会員の churn は 0/0 で未定義なので空欄にする（0 と書くと
    // 「解約ゼロの好調月」と区別できなくなる）
    const churn = activeStart > 0 ? cohortCancels / activeStart : '';
    rows.push({
      month: monthKey,
      activeStart: activeStart,
      joins: joins,
      cancels: cancels,
      activeEnd: Object.keys(active).length,
      churn: churn,
      retention: churn === '' ? '' : 1 - churn,
    });
    if (monthKey === currentMonthKey) {
      break;
    }
    monthKey = nextMonthKey_(monthKey);
  }
  if (guard <= 0) {
    warnings.push('月の走査が上限に達しました（currentMonthKey=' + currentMonthKey + ' に未到達）');
  }
  return {
    rows: rows,
    replayActive: Object.keys(active).length,
    warnings: warnings,
  };
}

/**
 * 'yyyy-MM' の翌月キーを返す。Date を経由しない文字列演算にすることで
 * タイムゾーン起因のずれを構造的に排除する。
 */
function nextMonthKey_(monthKey) {
  const parts = monthKey.split('-');
  let year = Number(parts[0]);
  let month = Number(parts[1]) + 1;
  if (month > 12) {
    month = 1;
    year++;
  }
  return year + '-' + (month < 10 ? '0' + month : String(month));
}

/**
 * KPI シートを全再構築する。チャートは clearContents では消えないため、
 * 先に removeChart で明示的に消すのが冪等性の要。
 *
 * @param {Sheet} sheet KPI シート
 * @param {Array} rows computeMonthlyKpis_ の rows
 * @param {{replayActive: number, membersActive: number, checkedAt: Date}} check
 */
function writeKpiSheet_(sheet, rows, check) {
  sheet.getCharts().forEach((chart) => {
    sheet.removeChart(chart);
  });
  sheet.clearContents();

  const table = [KPI_HEADERS];
  rows.forEach((row) => {
    table.push([
      // '2026-07' はシートに日付として自動解釈されるため、アポストロフィで
      // テキスト扱いを強制する（report.js の冪等性キーと同じ罠対策）
      "'" + row.month,
      row.activeStart,
      row.joins,
      row.cancels,
      row.activeEnd,
      row.churn,
      row.retention,
    ]);
  });
  sheet.getRange(1, 1, table.length, KPI_HEADERS.length).setValues(table);
  if (rows.length > 0) {
    sheet
      .getRange(2, 6, rows.length, 2)
      .setNumberFormat('0.0%');
  }

  const diff = check.replayActive - check.membersActive;
  sheet
    .getRange(KPI_CHECK_ANCHOR.ROW, KPI_CHECK_ANCHOR.COLUMN, 5, 2)
    .setValues([
      ['replay_active', check.replayActive],
      ['members_active', check.membersActive],
      ['diff', diff],
      ['status', diff === 0 ? 'ok' : 'MISMATCH'],
      ['checked_at', check.checkedAt],
    ]);
  sheet.setFrozenRows(1);
}

/**
 * チャート3枚を固定位置（L列アンカー）に挿入する。データ0行なら何もしない
 * （空レンジのチャートはエラーや空枠になるだけで情報がない）。
 */
function rebuildKpiCharts_(sheet, rowCount) {
  if (rowCount === 0) {
    return;
  }
  const lastDataRow = rowCount + 1;
  const monthRange = sheet.getRange(1, 1, lastDataRow, 1);

  const joinsCancelsChart = sheet
    .newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(monthRange)
    .addRange(sheet.getRange(1, 3, lastDataRow, 2))
    .setNumHeaders(1)
    .setOption('useFirstColumnAsDomain', true)
    .setOption('title', '月次 入会・退会数')
    .setOption('legend', { position: 'bottom' })
    .setOption('width', KPI_CHART_WIDTH)
    .setOption('height', KPI_CHART_HEIGHT)
    .setPosition(KPI_CHART_ROWS.JOINS_CANCELS, KPI_CHART_ANCHOR_COLUMN, 0, 0)
    .build();
  sheet.insertChart(joinsCancelsChart);

  const activeTrendChart = sheet
    .newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(monthRange)
    .addRange(sheet.getRange(1, 5, lastDataRow, 1))
    .setNumHeaders(1)
    .setOption('useFirstColumnAsDomain', true)
    .setOption('title', 'アクティブ会員数の推移')
    .setOption('legend', { position: 'bottom' })
    .setOption('width', KPI_CHART_WIDTH)
    .setOption('height', KPI_CHART_HEIGHT)
    .setPosition(KPI_CHART_ROWS.ACTIVE_TREND, KPI_CHART_ANCHOR_COLUMN, 0, 0)
    .build();
  sheet.insertChart(activeTrendChart);

  // 継続率が '' の月は点を打たずギャップとして見せる（interpolateNulls は
  // 使わない。「データなし」を補間で塗りつぶすと誤読を招く）
  const retentionChart = sheet
    .newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(monthRange)
    .addRange(sheet.getRange(1, 7, lastDataRow, 1))
    .setNumHeaders(1)
    .setOption('useFirstColumnAsDomain', true)
    .setOption('title', '継続率の推移')
    .setOption('legend', { position: 'bottom' })
    .setOption('width', KPI_CHART_WIDTH)
    .setOption('height', KPI_CHART_HEIGHT)
    .setPosition(KPI_CHART_ROWS.RETENTION, KPI_CHART_ANCHOR_COLUMN, 0, 0)
    .build();
  sheet.insertChart(retentionChart);
}

/**
 * 純ロジックの手動テスト: モックイベントで computeMonthlyKpis_ のエッジケースを
 * 検証する。シート・ネットワークに一切触れない。
 * 期待値と実際を console に並べるので、目視で PASS/FAIL を確認する。
 */
function testKpiReplay() {
  const mk = (iso, type, customerId) => ({
    time: new Date(iso),
    monthKey: iso.slice(0, 7),
    type: type,
    customerId: customerId,
  });
  const events = [
    mk('2026-04-10T10:00:00+09:00', 'join', 'cus_A'),    // 4月: 入会
    mk('2026-04-20T10:00:00+09:00', 'join', 'cus_B'),    // 4月: 入会
    mk('2026-04-25T10:00:00+09:00', 'cancel', 'cus_B'),  // 4月: 同月入会退会
    mk('2026-05-05T10:00:00+09:00', 'cancel', 'cus_A'),  // 5月: 退会
    mk('2026-05-06T10:00:00+09:00', 'cancel', 'cus_A'),  // 5月: inactiveへの退会 → warning
    // 6月: イベントなし（ギャップ月が0行で埋まること）
    mk('2026-07-01T10:00:00+09:00', 'join', 'cus_A'),    // 7月: 再入会
    mk('2026-07-02T10:00:00+09:00', 'join', 'cus_A'),    // 7月: active中の入会 → warning
    // 8月: 月初在籍者(A)がいる月の同月入会即退会。コホート定義なら
    // churn=0%（Aは退会していない）。全退会を分子にすると 1/1=100% に化ける
    mk('2026-08-10T10:00:00+09:00', 'join', 'cus_D'),
    mk('2026-08-20T10:00:00+09:00', 'cancel', 'cus_D'),
  ];
  const result = computeMonthlyKpis_(events, '2026-08');
  const expected = [
    // [month, active_start, joins, cancels, active_end, churn, retention]
    ['2026-04', 0, 2, 1, 1, '', ''],
    ['2026-05', 1, 0, 1, 0, 1, 0],
    ['2026-06', 0, 0, 0, 0, '', ''],
    ['2026-07', 0, 1, 0, 1, '', ''],
    ['2026-08', 1, 1, 1, 1, 0, 1],
  ];
  let pass = result.rows.length === expected.length && result.replayActive === 1;
  result.rows.forEach((row, i) => {
    const actual = [row.month, row.activeStart, row.joins, row.cancels, row.activeEnd, row.churn, row.retention];
    const ok = JSON.stringify(actual) === JSON.stringify(expected[i]);
    if (!ok) {
      pass = false;
    }
    console.log((ok ? 'OK  ' : 'NG  ') + JSON.stringify(actual) +
      (ok ? '' : ' expected=' + JSON.stringify(expected[i])));
  });
  console.log('warnings(2件のはず): ' + JSON.stringify(result.warnings));
  if (result.warnings.length !== 2) {
    pass = false;
  }
  console.log('testKpiReplay: ' + (pass ? 'PASS' : 'FAIL'));
}

/**
 * 手動テスト用: 実データで全経路（EventLog読み→リプレイ→シート再構築→
 * チャート）を通す。rebuildKpiDashboard を呼ぶだけだが、テスト意図を
 * 名前に残すため別関数にしている。
 */
function testRebuildKpi() {
  rebuildKpiDashboard();
  console.log('testRebuildKpi: KPI シートの表・チェックブロック(I1:J5)・チャート3枚を目視確認してください');
}

/**
 * 月次トリガーを設定する（毎月1日 11時 JST）。GASエディタから1回実行。
 * 既存の同名トリガーは先に削除するので、何度実行しても1本に保たれる。
 * 11時の理由: 9時=レポート生成、10時=Slack配信（予約枠）の後に置き、
 * 月次処理の時系列を 9→10→11 で一貫させる。
 */
function setupMonthlyKpiTrigger() {
  deleteMonthlyKpiTrigger();
  ScriptApp.newTrigger('rebuildKpiDashboard')
    .timeBased()
    .onMonthDay(1)
    .atHour(11)
    .create();
  console.log('setupMonthlyKpiTrigger: 毎月1日 11時台に rebuildKpiDashboard を設定しました');
}

/**
 * 月次トリガーを撤去する。
 */
function deleteMonthlyKpiTrigger() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'rebuildKpiDashboard') {
      ScriptApp.deleteTrigger(trigger);
      console.log('deleteMonthlyKpiTrigger: 既存トリガーを削除しました');
    }
  });
}
