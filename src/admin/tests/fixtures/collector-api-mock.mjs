// collector:install系のAPI呼出しを検証するfetch mock。
// root CLIを子processで起動しても効くよう、--importで先に読み込ませる。
// 実API・実networkへは接続せず、request（URL・method・Authorization・body）をlogへ記録する。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const specPath = process.env.YORI_TEST_API_SPEC;
const logPath = process.env.YORI_TEST_API_LOG;

if (specPath !== undefined && logPath !== undefined) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init.headers);
    appendFileSync(
      logPath,
      `${JSON.stringify({
        url,
        method: init.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init.body === 'string' ? init.body : null,
      })}\n`,
    );

    const queue = JSON.parse(readFileSync(specPath, 'utf8'));
    const response = queue.shift();
    if (response === undefined) {
      return new Response('{"error":"mock_exhausted"}', { status: 500, headers: { 'content-type': 'application/json' } });
    }
    writeFileSync(specPath, JSON.stringify(queue));
    if (response.networkError === true) {
      throw new TypeError('fetch failed');
    }
    const body = response.body === undefined ? '' : typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } });
  };
}
