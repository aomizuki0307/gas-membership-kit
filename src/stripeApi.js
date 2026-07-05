/**
 * stripeApi.js — UrlFetchApp による Stripe API 呼び出しラッパ。
 *
 * 本プロジェクトの検証方式の核心:
 * GAS の doPost は HTTP ヘッダーを受け取れないため Stripe-Signature の
 * HMAC 検証ができない。代わりに受信ペイロードの event.id で
 * GET /v1/events/{id} を叩き直し、Stripe から返ってきたイベント
 * オブジェクトだけを正として処理する（受信ペイロード自体は信用しない）。
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Stripe API への GET。{ code, body } を返す（body は生テキスト）。
 */
function stripeGet_(path) {
  const response = UrlFetchApp.fetch(STRIPE_API_BASE + path, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + requireConfig_('stripeSecretKey') },
    muteHttpExceptions: true,
  });
  return {
    code: response.getResponseCode(),
    body: response.getContentText(),
  };
}

/**
 * イベントIDを Stripe に再照会する。
 * 404（実在しない=偽装疑い）と、それ以外の失敗（キー失効401 /
 * レート制限429 / Stripe障害5xx）を区別して返す。後者を not_found に
 * 丸めると、キー失効時に全イベントが偽装に見えて原因を追えなくなる。
 *
 * @return {{status: 'ok'|'not_found'|'api_error', event?: Object, code?: number}}
 */
function fetchStripeEvent_(eventId) {
  const res = stripeGet_('/events/' + encodeURIComponent(eventId));
  if (res.code === 200) {
    return { status: 'ok', event: JSON.parse(res.body) };
  }
  if (res.code === 404) {
    return { status: 'not_found', code: 404 };
  }
  return { status: 'api_error', code: res.code };
}

/**
 * サブスクリプションIDから price ID（= plan 列の値）を取得する。
 * 取得できない場合は空文字を返し、起票処理は続行させる。
 */
function fetchSubscriptionPlan_(subscriptionId) {
  if (!subscriptionId) {
    return '';
  }
  try {
    const res = stripeGet_('/subscriptions/' + encodeURIComponent(subscriptionId));
    if (res.code !== 200) {
      return '';
    }
    const subscription = JSON.parse(res.body);
    const item =
      subscription.items && subscription.items.data && subscription.items.data[0];
    return item && item.price ? item.price.id : '';
  } catch (err) {
    return '';
  }
}
