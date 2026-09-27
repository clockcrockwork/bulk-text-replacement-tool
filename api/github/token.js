import { handleTokenExchange, readExchangeConfig } from '../_lib/githubTokenExchange.js';

/**
 * POST /api/github/token — GitHub App の認可コードをアクセストークンへ交換する。
 *
 * 中身は `api/_lib/githubTokenExchange.js`。ここは環境変数と実際の fetch を渡すだけ。
 * POST 以外のメソッドも同じ関数へ通し、405 を返させる（許可の判定を1か所にまとめる）。
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
function handle(request) {
  return handleTokenExchange(request, readExchangeConfig(process.env), fetch);
}

export {
  handle as DELETE,
  handle as GET,
  handle as OPTIONS,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
