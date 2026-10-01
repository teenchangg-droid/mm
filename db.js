/* db.js — IndexedDB 저장소
 * tracks : 곡 정보(title, artist, album, duration, mimeType, cover, createdAt, lastPlayedAt, playCount, size)
 * blobs  : 음원 Blob 본체 (목록을 불러올 때 큰 파일이 같이 읽히지 않도록 분리해서 저장)
 * meta   : 재생 상태(마지막 곡, 위치, 반복/셔플, 대기열, 볼륨), 정렬 설정
 */
const NAME = 'my-music';
let dbp;

function open() {
  return dbp || (dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 2);
    req.onupgradeneeded = (ev) => {
      const d = req.result;
      if (ev.oldVersion < 1) {
        d.createObjectStore('tracks', { keyPath: 'id' });
        d.createObjectStore('blobs', { keyPath: 'id' });
        d.createObjectStore('meta');
      }
      if (ev.oldVersion < 2) d.createObjectStore('playlists', { keyPath: 'id' }); // 플레이리스트 {id, name, trackIds[], createdAt}
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
  }));
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getAllTracks() {
  const d = await open();
  return wrap(d.transaction('tracks').objectStore('tracks').getAll());
}

export async function getBlob(id) {
  const d = await open();
  const rec = await wrap(d.transaction('blobs').objectStore('blobs').get(id));
  return rec ? rec.blob : null;
}

/** 곡 정보와 음원을 한 트랜잭션으로 저장 (둘 중 하나만 실패해서 반쪽 데이터가 남는 일 방지) */
export async function putTrack(track, blob) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['tracks', 'blobs'], 'readwrite');
    t.objectStore('tracks').put(track);
    if (blob) t.objectStore('blobs').put({ id: track.id, blob });
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export async function updateTrack(id, patch) {
  const d = await open();
  const store = d.transaction('tracks', 'readwrite').objectStore('tracks');
  const cur = await wrap(store.get(id));
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await wrap(store.put(next));
  return next;
}

export async function deleteTrack(id) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['tracks', 'blobs'], 'readwrite');
    t.objectStore('tracks').delete(id);
    t.objectStore('blobs').delete(id);
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export async function getMeta(key) {
  const d = await open();
  return wrap(d.transaction('meta').objectStore('meta').get(key));
}

export async function setMeta(key, value) {
  const d = await open();
  return wrap(d.transaction('meta', 'readwrite').objectStore('meta').put(value, key));
}

/** navigator.storage.estimate() — 사용량/한도 (지원하지 않으면 null) */
export async function storageInfo() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null;
  } catch { return null; }
}

/** 브라우저가 저장소를 임의로 지우지 않도록 요청 (허용 여부는 브라우저 판단) */
export async function requestPersist() {
  try { return (await navigator.storage?.persist?.()) || false; } catch { return false; }
}

/* ───── 플레이리스트 ───── */
export async function getAllPlaylists() {
  const d = await open();
  return wrap(d.transaction('playlists').objectStore('playlists').getAll());
}
export async function putPlaylist(p) {
  const d = await open();
  return wrap(d.transaction('playlists', 'readwrite').objectStore('playlists').put(p));
}
export async function deletePlaylist(id) {
  const d = await open();
  return wrap(d.transaction('playlists', 'readwrite').objectStore('playlists').delete(id));
}
