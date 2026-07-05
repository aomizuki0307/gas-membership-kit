/**
 * claudeApi.js — UrlFetchApp による Claude Messages API 呼び出しラッパ。
 *
 * GAS には公式 SDK がないため raw HTTP で叩く。外向きリクエストは
 * ヘッダーを自由に付けられる（制約があるのは受信側 doPost のみ）。
 *
 * モデルはコスト最優先で Haiku 4.5 固定（$1/$5 per MTok）。
 * 1レポート ≈ 入力800 + 出力400 トークン ≈ $0.003。会員100人でも月 ≈ $0.3。
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const REPORT_MODEL = 'claude-haiku-4-5';
const REPORT_MAX_TOKENS = 1024;

/**
 * Claude Messages API を1回呼び、テキスト応答を返す。
 * Stripe ラッパ（fetchStripeEvent_）と同じく、失敗の種類を丸めずに返す:
 * 401（キー不正）/ 429（レート制限）/ 529（過負荷）を区別できないと
 * エラー行から原因を追えなくなる。
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @return {{status: 'ok', text: string, inputTokens: number, outputTokens: number}
 *        | {status: 'api_error', code: number, message: string}}
 */
function callClaudeMessages_(systemPrompt, userPrompt) {
  const payload = {
    model: REPORT_MODEL,
    max_tokens: REPORT_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };
  let response;
  try {
    response = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': requireConfig_('anthropicApiKey'),
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (err) {
    // muteHttpExceptions が抑止するのは 4xx/5xx 応答のみ。DNS失敗・
    // タイムアウト等のネットワーク層エラーは throw されるのでここで拾い、
    // 呼び出し側が error 行として処理できる形に揃える（code=0 で区別）
    return { status: 'api_error', code: 0, message: String(err).slice(0, 300) };
  }
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) {
    // エラー本文は {error: {type, message}} 形式。message だけ抜いて短く残す
    let message = body;
    try {
      const parsed = JSON.parse(body);
      message = (parsed.error && parsed.error.message) || body;
    } catch (err) {
      // JSONでなければ生テキストのまま
    }
    return { status: 'api_error', code: code, message: String(message).slice(0, 300) };
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch (err) {
    return { status: 'api_error', code: 200, message: 'invalid json response' };
  }
  // refusal / max_tokens 打ち切りは正常応答(200)で返るため stop_reason を確認する
  if (result.stop_reason !== 'end_turn') {
    return {
      status: 'api_error',
      code: 200,
      message: 'unexpected stop_reason: ' + result.stop_reason,
    };
  }
  const textBlock = (result.content || []).filter((b) => b.type === 'text')[0];
  if (!textBlock || !textBlock.text) {
    return { status: 'api_error', code: 200, message: 'no text block in response' };
  }
  return {
    status: 'ok',
    text: textBlock.text,
    // シートに書く値なので、API応答の形を無条件には信用せず数値に強制する
    inputTokens: Number(result.usage && result.usage.input_tokens) || 0,
    outputTokens: Number(result.usage && result.usage.output_tokens) || 0,
  };
}
