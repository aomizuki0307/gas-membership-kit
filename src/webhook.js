/**
 * webhook.js — Stripe Webhook を受ける Web アプリ本体（doPost）。
 *
 * 処理フロー:
 *   1. URLトークン照合（不一致なら本文をパースせず拒否）
 *   2. JSONパース
 *   3. スクリプトロック取得（同時リトライによる二重起票の防止）
 *   4. 冪等性チェック（処理済み event_id の再送を弾く）
 *   5. Stripe への再照会検証（GET /v1/events/{id}）
 *   6. イベント種別ごとの起票
 *
 * 制約（GAS Web アプリの仕様）:
 * - HTTP ステータスコードを制御できないため、拒否でも 200 相当を返す。
 *   結果はすべて EventLog シートで観測する。
 * - 未捕捉例外は HTML エラーページになるため、全体を try/catch で包み
 *   必ず ContentService の JSON を返す。
 */

const STRIPE_EVENT_CHECKOUT_COMPLETED = 'checkout.session.completed';
const STRIPE_EVENT_SUBSCRIPTION_DELETED = 'customer.subscription.deleted';

function doPost(e) {
  let lock = null;
  const logBase = {};
  try {
    const config = getConfig_();

    // 1. トークン照合（タイミング攻撃対策でダイジェスト比較）
    const token = e && e.parameter ? e.parameter.token : '';
    if (!token || !secureEquals_(token, config.webhookToken)) {
      logEvent_({
        verification: VERIFICATION.TOKEN_NG,
        summary: 'token mismatch or missing',
      });
      return jsonResponse_({ received: true });
    }

    // 2. JSONパース
    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (err) {
      logEvent_({
        verification: VERIFICATION.PARSE_ERROR,
        errorMessage: String(err),
      });
      return jsonResponse_({ received: true });
    }
    logBase.eventId = payload.id;
    logBase.eventType = payload.type;
    logBase.livemode = payload.livemode;

    // 3. ロック取得
    lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      lock = null;
      logEvent_(withLog_(logBase, {
        processing: PROCESSING.ERROR,
        errorMessage: 'script lock timeout (' + LOCK_TIMEOUT_MS + 'ms)',
      }));
      return jsonResponse_({ received: true });
    }

    // 4. 冪等性チェック
    if (isProcessedEvent_(payload.id)) {
      logEvent_(withLog_(logBase, { processing: PROCESSING.DUPLICATE }));
      return jsonResponse_({ received: true });
    }

    // 5. 再照会検証: 以降は Stripe から返ってきた event だけを正とする
    const fetched = fetchStripeEvent_(payload.id);
    if (fetched.status === 'not_found') {
      logEvent_(withLog_(logBase, { verification: VERIFICATION.NOT_FOUND }));
      return jsonResponse_({ received: true });
    }
    if (fetched.status === 'api_error') {
      // error は冪等性チェックで再処理可能扱いなので、Stripeの再送や
      // ダッシュボードからの手動再送でリカバリできる
      logEvent_(withLog_(logBase, {
        processing: PROCESSING.ERROR,
        errorMessage: 'stripe api error: HTTP ' + fetched.code,
      }));
      return jsonResponse_({ received: true });
    }
    const event = fetched.event;

    // 6. 起票
    const result = handleStripeEvent_(event);
    logEvent_({
      eventId: event.id,
      eventType: event.type,
      livemode: event.livemode,
      verification: VERIFICATION.VERIFIED,
      processing: result.processing,
      customerId: result.customerId,
      summary: result.summary,
      errorMessage: result.errorMessage,
    });
    return jsonResponse_({ received: true });
  } catch (err) {
    try {
      logEvent_(withLog_(logBase, {
        processing: PROCESSING.ERROR,
        errorMessage: String((err && err.stack) || err),
      }));
    } catch (logErr) {
      // ログ自体が失敗した場合も応答だけは返す（console はGASの実行ログに残る）
      console.error('logEvent_ failed: ' + logErr + ' / original: ' + err);
    }
    return jsonResponse_({ received: true });
  } finally {
    if (lock) {
      lock.releaseLock();
    }
  }
}

/**
 * 検証済みイベントを種別ごとに起票する。
 * @return {{processing: string, customerId?: string, summary?: string,
 *           errorMessage?: string}}
 */
function handleStripeEvent_(event) {
  const obj = event.data && event.data.object;

  if (event.type === STRIPE_EVENT_CHECKOUT_COMPLETED) {
    // 単発決済(mode=payment)でも飛ぶイベントなのでサブスクのみ処理
    if (!obj || obj.mode !== 'subscription') {
      return {
        processing: PROCESSING.TYPE_IGNORED,
        summary: 'checkout mode=' + (obj ? obj.mode : 'unknown') + ' (not subscription)',
      };
    }
    const details = obj.customer_details || {};
    upsertMember_({
      customerId: obj.customer,
      subscriptionId: obj.subscription || '',
      email: details.email || '',
      name: details.name || '',
      plan: fetchSubscriptionPlan_(obj.subscription),
    });
    return {
      processing: PROCESSING.PROCESSED,
      customerId: obj.customer,
      summary: 'member joined: ' + (details.email || obj.customer),
    };
  }

  if (event.type === STRIPE_EVENT_SUBSCRIPTION_DELETED) {
    const found = markMemberCanceled_(obj ? obj.id : '', obj ? obj.customer : '');
    if (!found) {
      return {
        processing: PROCESSING.ERROR,
        customerId: obj ? obj.customer : '',
        errorMessage: 'member row not found for subscription ' + (obj ? obj.id : '?'),
      };
    }
    return {
      processing: PROCESSING.PROCESSED,
      customerId: obj.customer,
      summary: 'member canceled: subscription ' + obj.id,
    };
  }

  return {
    processing: PROCESSING.TYPE_IGNORED,
    summary: 'unhandled event type: ' + event.type,
  };
}

/**
 * logBase（イベント同定情報）に追加フィールドを重ねた新しいオブジェクトを返す。
 */
function withLog_(logBase, extra) {
  return Object.assign({}, logBase, extra);
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON
  );
}
