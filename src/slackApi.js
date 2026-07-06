/**
 * slackApi.js — UrlFetchApp による Slack Web API 呼び出しラッパ。
 *
 * claudeApi.js と同じ流儀（muteHttpExceptions + ネットワーク層例外の
 * try/catch + エラー種別を丸めない）に加えて、Slack 固有の仕様として
 * 「エラーの多くが HTTP 200 + {ok:false, error:"..."} で返る」ため、
 * HTTP コードと body.ok の両方を必ず検査する。
 *
 * 認証: Authorization: Bearer <SLACK_BOT_TOKEN>
 * 必要スコープ: chat:write（postMessage）+ im:write（conversations.open）。
 * auth.test はスコープ不要。
 */

const SLACK_API_BASE_URL = 'https://slack.com/api/';

/**
 * Slack Web API を1メソッド呼ぶ共通ラッパ。
 *
 * @param {string} method 'chat.postMessage' 等のAPIメソッド名
 * @param {Object} payload JSONボディ
 * @return {{status: 'ok', body: Object}
 *        | {status: 'api_error', code: number, message: string}}
 *   code=0 はネットワーク層エラー。code=200 + message は ok:false の
 *   Slackエラーコード（invalid_auth / channel_not_found / ratelimited 等）
 */
function slackApi_(method, payload) {
  let response;
  try {
    response = UrlFetchApp.fetch(SLACK_API_BASE_URL + method, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      headers: {
        Authorization: 'Bearer ' + requireConfig_('slackBotToken'),
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    // muteHttpExceptions が抑止するのは 4xx/5xx 応答のみ。DNS失敗・
    // タイムアウト等のネットワーク層エラーはここで拾う（code=0 で区別）
    return { status: 'api_error', code: 0, message: String(err).slice(0, 300) };
  }
  const code = response.getResponseCode();
  const bodyText = response.getContentText();
  if (code !== 200) {
    // 429 は Retry-After 秒数を残す（この規模ではリトライせず再実行で回復）
    let message = String(bodyText).slice(0, 300);
    if (code === 429) {
      const retryAfter = response.getHeaders()['Retry-After'];
      message = 'ratelimited (retry-after: ' + retryAfter + 's)';
    }
    return { status: 'api_error', code: code, message: message };
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (err) {
    return { status: 'api_error', code: 200, message: 'invalid json response' };
  }
  // Slack はエラーでも HTTP 200 を返すため、成否の正は body.ok
  if (body.ok !== true) {
    return {
      status: 'api_error',
      code: 200,
      message: String(body.error || 'unknown slack error').slice(0, 300),
    };
  }
  return { status: 'ok', body: body };
}

/**
 * auth.test による疎通確認。トークンの有効性とワークスペースを返す。
 * @return {{status: 'ok', team: string, botUserId: string}
 *        | {status: 'api_error', code: number, message: string}}
 */
function slackAuthTest_() {
  const result = slackApi_('auth.test', {});
  if (result.status !== 'ok') {
    return result;
  }
  return {
    status: 'ok',
    team: String(result.body.team || ''),
    botUserId: String(result.body.user_id || ''),
  };
}

/**
 * 会員とのDMチャンネルを開く（既に開いていれば既存を返す＝冪等）。
 * chat.postMessage への U-ID 直渡しは公式ドキュメント内で記述が矛盾して
 * いるため、一意に文書化されている conversations.open 経由に統一する。
 *
 * @param {string} userId Slack メンバーID (U.../W...)
 * @return {{status: 'ok', channelId: string}
 *        | {status: 'api_error', code: number, message: string}}
 */
function openSlackDm_(userId) {
  const result = slackApi_('conversations.open', { users: userId });
  if (result.status !== 'ok') {
    return result;
  }
  const channelId = result.body.channel && result.body.channel.id;
  if (!channelId) {
    return { status: 'api_error', code: 200, message: 'no channel id in response' };
  }
  return { status: 'ok', channelId: String(channelId) };
}

/**
 * Slack の特殊構文を無害化するエスケープ。
 * & < > を実体参照にすると <!channel> <@U...> <url|label> 等の
 * メンション・リンク構文は構造的に成立しなくなる。& を最初に変換すること。
 * https://docs.slack.dev/messaging/formatting-message-text
 */
function escapeSlackText_(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * chat.postMessage でテキストを1件投稿する。
 * escapeSlackText_ をここで無条件に適用する。呼び出し側の規約任せにすると
 * 将来の経路追加でエスケープ漏れ＝メンション構文注入が復活するため、
 * 送信の最終関門で構造的に強制する（Slack構文を意図的に使う経路は無い）。
 *
 * @param {string} channelId 投稿先 (C... / D...)
 * @param {string} text 生テキスト（エスケープ不要）
 * @return {{status: 'ok', ts: string}
 *        | {status: 'api_error', code: number, message: string}}
 */
function postSlackMessage_(channelId, text) {
  const result = slackApi_('chat.postMessage', {
    channel: channelId,
    text: escapeSlackText_(text),
  });
  if (result.status !== 'ok') {
    return result;
  }
  return { status: 'ok', ts: String(result.body.ts || '') };
}
