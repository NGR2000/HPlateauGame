// 写真の取得とデコードをまとめて制限し、携帯の一時的な画像メモリを抑える。
export function createTileLoader({ concurrency = 4, timeoutMs = 20000, retries = 1 } = {}) {
  let active = 0;
  const queue = [];
  function pump() {
    while (active < concurrency && queue.length) {
      const { url, resolve, reject } = queue.shift();
      active++;
      load(url).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }
  async function load(url) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status = 0;
      try {
        const res = await fetch(url, { signal: controller.signal });
        status = res.status;
        if (!res.ok) throw new Error(`tile HTTP ${status}`);
        return await createImageBitmap(await res.blob());
      } catch (error) {
        if (attempt >= retries || status === 404) throw error;
      } finally { clearTimeout(timer); }
    }
  }
  return url => new Promise((resolve, reject) => { queue.push({ url, resolve, reject }); pump(); });
}
