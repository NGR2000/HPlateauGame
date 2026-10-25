// 外部データは取得先・時間・受信量を検査してからパーサーへ渡す。
// リダイレクトは追跡しない。転送先を検査する前に接続することを防ぐ。
export const DATA_HOSTS = Object.freeze([
  'cyberjapandata.gsi.go.jp', 'api.open-meteo.com', 'api.plateauview.mlit.go.jp',
]);
const MAX_RESOURCE_BYTES = 128 * 1024 * 1024;

export function dataError(message) {
  return Object.assign(new Error(message), { retryable: false });
}

export function assertRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw dataError('データのURLが不正です'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !DATA_HOSTS.includes(url.hostname)) {
    throw dataError('許可されていないデータ取得先です');
  }
  url.hash = '';
  return url.href;
}

export async function fetchResource(url, {
  maxBytes = 2 * 1024 * 1024, timeoutMs = 20000, headers, signal,
} = {}) {
  url = assertRemoteUrl(url);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RESOURCE_BYTES
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw dataError('データ取得の上限設定が不正です');
  }
  const controller = new AbortController();
  let reader;
  let timer;
  let abortListener;
  const interrupted = new Promise((_, reject) => {
    abortListener = () => {
      const error = signal?.reason instanceof Error ? signal.reason : new Error('データ取得を中止しました');
      controller.abort(error);
      void reader?.cancel(error).catch(() => {});
      reject(error);
    };
    signal?.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => {
      const error = new Error('データ取得がタイムアウトしました');
      controller.abort(error);
      void reader?.cancel(error).catch(() => {});
      reject(error);
    }, timeoutMs);
    if (signal?.aborted) abortListener();
  });
  const read = async () => {
    const response = await fetch(url, {
      headers, signal: controller.signal, credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (response.redirected || response.type === 'opaqueredirect'
        || (response.url && assertRemoteUrl(response.url) !== url)) {
      void response.body?.cancel().catch(() => {});
      throw dataError('データ取得の転送は許可されていません');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`データ取得失敗 HTTP ${response.status}`), {
        status: response.status, retryable: response.status >= 500 || response.status === 429,
      });
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      void response.body?.cancel().catch(() => {});
      throw dataError('データ量が上限を超えています');
    }
    if (!response.body) throw dataError('データ本体がありません');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw dataError('データ量が上限を超えています');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, status: response.status, headers: response.headers };
  };
  try { return await Promise.race([read(), interrupted]); }
  catch (error) {
    controller.abort(error);
    void reader?.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortListener);
  }
}

export async function fetchBytes(url, options) {
  return (await fetchResource(url, options)).bytes;
}

export async function fetchJson(url, { validate, ...options } = {}) {
  const { bytes, headers } = await fetchResource(url, options);
  const type = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !/^application\/[\w.-]+\+json$/.test(type || '')) {
    throw dataError('JSONではない応答です');
  }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw dataError('JSONの形式が不正です'); }
  // サイズ内でも極端に深いデータや多数の要素を処理しない。
  const pending = [[data, 0]];
  let count = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++count > 100000 || depth > 32) throw dataError('JSONの構造が上限を超えています');
    if (typeof value === 'number' && !Number.isFinite(value)) throw dataError('JSONの数値が不正です');
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push([child, depth + 1]);
    }
  }
  if (validate && validate(data) !== true) throw dataError('データの項目が不正です');
  return data;
}
