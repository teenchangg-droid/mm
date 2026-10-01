/* media-session.js — 제어센터 / 잠금화면 / 알림 미디어 컨트롤 연동
 * navigator.mediaSession.metadata 로 제목·아티스트·앨범·앨범 이미지를 전달하고,
 * setActionHandler 로 재생/일시정지/이전/다음/탐색 버튼을 앱에 연결한다.
 *
 * iOS 참고: 잠금화면은 "이전/다음 곡" 버튼과 "±10초 이동" 버튼 중 한 쌍만 보여주는 경우가 많다.
 * 음악 앱답게 이전/다음을 우선하도록 iOS에서는 seekbackward/seekforward 핸들러를 등록하지 않는다.
 * (진행바 드래그를 위한 seekto는 그대로 등록)
 */
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ───── 커버 이미지 유틸 ───── */
const defCache = new Map();
/** 앨범 이미지가 없을 때 쓰는 기본 커버 (색상은 seed 문자열로 결정, 12가지 톤) */
export function defaultCover(seed = '', size = 160) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = (h % 12) * 30;
  const key = hue + '|' + size;
  if (defCache.has(key)) return defCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, size, size);
  grd.addColorStop(0, `hsl(${hue} 72% 64%)`);
  grd.addColorStop(1, `hsl(${(hue + 40) % 360} 68% 40%)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  g.fillStyle = 'rgba(255,255,255,.88)';
  g.font = `${Math.round(size * 0.5)}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('♪', size / 2, size / 2 + size * 0.03);
  const url = c.toDataURL('image/png');
  defCache.set(key, url);
  return url;
}

function loadImg(blob) {
  return new Promise((res, rej) => {
    const i = new Image();
    const u = URL.createObjectURL(blob);
    i.onload = () => { URL.revokeObjectURL(u); res(i); };
    i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('image')); };
    i.src = u;
  });
}

function drawCover(img, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const s = Math.max(size / img.width, size / img.height);
  const w = img.width * s, h = img.height * s;
  c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return c;
}

/** 이미지를 정사각형으로 잘라 JPEG Blob으로 축소 (저장 공간 절약) */
export async function resizeToBlob(blob, size = 600) {
  const c = drawCover(await loadImg(blob), size);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('blob'))), 'image/jpeg', 0.86));
}

const artCache = new Map(); // id -> { ref, url }
async function artworkFor(t) {
  if (t.cover) {
    const hit = artCache.get(t.id);
    if (hit && hit.ref === t.cover) return { url: hit.url, type: 'image/jpeg' };
    try {
      const url = drawCover(await loadImg(t.cover), 512).toDataURL('image/jpeg', 0.85);
      artCache.set(t.id, { ref: t.cover, url });
      return { url, type: 'image/jpeg' };
    } catch { /* 기본 이미지로 대체 */ }
  }
  return { url: defaultCover(t.artist || t.title, 512), type: 'image/png' };
}

/* ───── Media Session 브리지 ───── */
export class MediaBridge {
  constructor(player) {
    this.p = player;
    this.ok = 'mediaSession' in navigator;
    this._n = 0;
    if (!this.ok) return;
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* 이 브라우저가 지원하지 않는 액션 */ } };
    set('play', () => player.play());
    set('pause', () => player.pause());
    set('previoustrack', () => player.prev());
    set('nexttrack', () => player.next());
    set('stop', () => player.pause());
    set('seekto', (d) => { player.seek(d.seekTime); this.position(); });
    if (!IOS) {
      set('seekbackward', (d) => { player.seekBy(-((d && d.seekOffset) || 10)); this.position(); });
      set('seekforward', (d) => { player.seekBy((d && d.seekOffset) || 10); this.position(); });
    }
  }

  async setTrack(t) {
    if (!this.ok) return;
    const n = ++this._n;
    const ms = navigator.mediaSession;
    if (!t) { ms.metadata = null; ms.playbackState = 'none'; return; }
    const base = { title: t.title, artist: t.artist || '', album: t.album || '' };
    ms.metadata = new MediaMetadata(base);            // 먼저 텍스트만 즉시 표시
    const art = await artworkFor(t);
    if (n !== this._n) return;                         // 그 사이 곡이 바뀌었으면 무시
    ms.metadata = new MediaMetadata({ ...base, artwork: [{ src: art.url, sizes: '512x512', type: art.type }] });
  }

  setPlaying(playing) {
    if (this.ok) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  position() {
    if (!this.ok || !navigator.mediaSession.setPositionState) return;
    const a = this.p.a;
    if (!Number.isFinite(a.duration) || a.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: a.duration, playbackRate: a.playbackRate || 1,
        position: Math.min(a.currentTime || 0, a.duration),
      });
    } catch { /* 값 범위 오류는 무시 */ }
  }
}
