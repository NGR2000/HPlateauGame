import { fetchResource, dataError } from './safeFetch.js';

// 地理院タイルのPNG/JPEGヘッダーを検査し、巨大画像の展開を防ぐ。
export function tileImageSize(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && dv.getUint32(0) === 0x89504e47 && dv.getUint32(4) === 0x0d0a1a0a
      && dv.getUint32(8) === 13 && dv.getUint32(12) === 0x49484452) {
    return { width: dv.getUint32(16), height: dv.getUint32(20), type: 'image/png' };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 3 < bytes.length) {
      if (bytes[p++] !== 0xff) break;
      while (bytes[p] === 0xff) p++;
      const marker = bytes[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (p + 2 > bytes.length) break;
      const length = dv.getUint16(p);
      if (length < 2 || p + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
        return { height: dv.getUint16(p + 3), width: dv.getUint16(p + 5), type: 'image/jpeg' };
      }
      p += length;
    }
  }
  throw dataError('地図画像の形式が不正です');
}

// 写真の取得とデコードをまとめて制限し、携帯の一時的な画像メモリを抑える。
export function createTileLoader({ concurrency = 4, timeoutMs = 20000, retries = 1,
  maxBytes = 2 * 1024 * 1024, maxDimension = 1024, maxPending = 512 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
      || !Number.isInteger(retries) || retries < 0 || retries > 2
      || !Number.isInteger(maxDimension) || maxDimension < 1 || maxDimension > 2048
      || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 1024) {
    throw dataError('地図取得の上限設定が不正です');
  }
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
      try {
        const { bytes } = await fetchResource(url, { maxBytes, timeoutMs });
        const { width, height, type } = tileImageSize(bytes);
        if (!width || !height || width > maxDimension || height > maxDimension) {
          throw dataError('地図画像の大きさが上限を超えています');
        }
        const bitmap = await createImageBitmap(new Blob([bytes], { type }));
        if (bitmap.width !== width || bitmap.height !== height) {
          bitmap.close();
          throw dataError('地図画像の大きさが一致しません');
        }
        return bitmap;
      } catch (error) {
        if (attempt >= retries || error.retryable === false) throw error;
      }
    }
  }
  return url => new Promise((resolve, reject) => {
    if (queue.length >= maxPending) { reject(dataError('地図取得の待ち件数が上限を超えています')); return; }
    queue.push({ url, resolve, reject }); pump();
  });
}
