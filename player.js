/* player.js — 재생 엔진 (HTML5 <audio> + 대기열/반복/셔플/상태 저장)
 *
 * iOS 백그라운드 재생 핵심 원칙
 *  1) 항상 같은 <audio> 요소 하나만 사용한다 (곡이 바뀌어도 src만 교체).
 *  2) 첫 사용자 탭에서 unlock()으로 요소를 "재생 허용" 상태로 만든다 (autoplay 정책 회피).
 *  3) 곡이 끝나는 순간 IndexedDB를 읽으면 화면 잠금 상태에서 끊길 수 있어서,
 *     다음 곡 Blob을 미리 읽어 objectURL로 준비해 두고(_pre) 'ended' 안에서 동기적으로 src를 바꾼다.
 */
import * as DB from './db.js';

// 길이 0의 무음 WAV — 첫 탭에서 audio 요소를 잠금 해제하는 용도
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

const shuffleArr = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export class Player {
  constructor(audio, getTrack) {
    this.a = audio;
    this.getTrack = getTrack;
    this.queue = [];     // 실제 재생 순서 (셔플 시 섞인 순서)
    this.base = [];      // 원래 순서 (셔플 해제 시 복귀용)
    this.idx = -1;
    this.repeat = 'off'; // 'off' | 'all' | 'one'
    this.shuffle = false;
    this.volume = 1;
    this.loadedId = null;
    this.url = null;
    this._pre = null;
    this._tok = 0;
    this._last = 0;
    this._resumeAt = 0;
    this.unlocked = false;
    this.h = {};
    this._bind();
  }

  on(evt, fn) { (this.h[evt] ||= []).push(fn); }
  emit(evt, ...args) { (this.h[evt] || []).forEach((f) => f(...args)); }

  get currentId() { return this.queue[this.idx] || null; }
  get current() { const id = this.currentId; return id ? this.getTrack(id) || null : null; }

  _bind() {
    const a = this.a;
    a.addEventListener('play', () => this.emit('state', true));
    a.addEventListener('playing', () => this.emit('state', true));
    a.addEventListener('pause', () => { this.emit('state', false); this.persist(); });
    a.addEventListener('timeupdate', () => {
      if (!this.loadedId) return;
      this.emit('time', a.currentTime, a.duration);
      const now = Date.now();
      if (now - this._last > 3000) { this._last = now; this.persist(); }
    });
    a.addEventListener('durationchange', () => this.emit('time', a.currentTime, a.duration));
    a.addEventListener('seeked', () => this.emit('seeked'));
    a.addEventListener('ended', () => this._ended());
    a.addEventListener('error', () => { if (this.loadedId) this.emit('error', 'playback'); });
  }

  /** 반드시 사용자 탭 핸들러 안에서, await 이전에 동기적으로 호출 */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    if (this.loadedId) this._resumeAt = this.a.currentTime || this._resumeAt;
    this.loadedId = null;
    this.a.src = SILENT;
    const p = this.a.play();
    if (p) p.catch(() => {});
  }

  /* ───── 로드 / 재생 ───── */
  async load(id, { autoplay = false, startAt = 0 } = {}) {
    const tok = ++this._tok;
    let url;
    if (this._pre && this._pre.id === id) {
      url = this._pre.url; this._pre = null;
    } else {
      let blob;
      try { blob = await DB.getBlob(id); } catch { this.emit('error', 'missing', id); return; }
      if (tok !== this._tok) return;
      if (!blob) { this.emit('error', 'missing', id); return; }
      url = URL.createObjectURL(blob);
    }
    this._setSrc(id, url, startAt, autoplay);
  }

  _setSrc(id, url, startAt, autoplay) {
    const a = this.a;
    const old = this.url;
    this.url = url;
    this.loadedId = id;
    a.src = url;
    a.loop = this.repeat === 'one';
    if (startAt > 0) {
      a.addEventListener('loadedmetadata', () => { try { a.currentTime = startAt; } catch {} }, { once: true });
    }
    if (old && old !== url) URL.revokeObjectURL(old);
    this.emit('track', this.current);
    if (autoplay) {
      const p = a.play();
      if (p) p.catch((e) => this._playErr(e));
      this.emit('started', id);
    }
    this._prefetch();
    this.persist();
  }

  _playErr(e) {
    if (e && e.name === 'AbortError') return;
    this.emit('error', e && e.name === 'NotAllowedError' ? 'blocked' : 'playback');
  }

  /** 다음 곡이 미리 준비돼 있으면 동기적으로, 아니면 DB에서 읽어서 재생 */
  _go(id) {
    if (this._pre && this._pre.id === id) {
      const url = this._pre.url; this._pre = null; this._tok++;
      this._setSrc(id, url, 0, true);
    } else {
      this.load(id, { autoplay: true });
    }
  }

  play() {
    if (!this.currentId) return;
    if (this.loadedId && this.loadedId === this.currentId) {
      const p = this.a.play();
      if (p) p.catch((e) => this._playErr(e));
    } else {
      this.load(this.currentId, { autoplay: true, startAt: this._resumeAt || 0 });
    }
  }
  pause() { this.a.pause(); }
  toggle() { (this.loadedId && !this.a.paused) ? this.pause() : this.play(); }

  playQueue(ids, startId) {
    this.base = [...ids];
    this.queue = this.shuffle ? [startId, ...shuffleArr(ids.filter((x) => x !== startId))] : [...ids];
    this.idx = this.queue.indexOf(startId);
    this._resumeAt = 0;
    this.emit('queue');
    this.load(startId, { autoplay: true });
  }

  playAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.idx = i; this._resumeAt = 0;
    this.emit('queue');
    this._go(this.queue[i]);
  }

  _ended() {
    if (this.repeat === 'one') { this.a.currentTime = 0; const p = this.a.play(); if (p) p.catch(() => {}); return; }
    this.next(true);
  }

  next(auto = false) {
    if (!this.queue.length) return;
    let n = this.idx + 1;
    if (n >= this.queue.length) {
      if (this.repeat === 'all' || !auto) n = 0;
      else { // 반복 없음: 마지막 곡이 끝나면 정지
        this.a.pause(); this.seek(0); this.emit('state', false); return;
      }
    }
    if (n === this.idx) { this.seek(0); const p = this.a.play(); if (p) p.catch(() => {}); return; }
    this.idx = n; this._resumeAt = 0;
    this.emit('queue');
    this._go(this.queue[n]);
  }

  prev() {
    if (!this.queue.length) return;
    if ((this.a.currentTime || 0) > 3 || (this.idx <= 0 && this.repeat !== 'all')) { this.seek(0); return; }
    this.idx = this.idx <= 0 ? this.queue.length - 1 : this.idx - 1;
    this._resumeAt = 0;
    this.emit('queue');
    this.load(this.queue[this.idx], { autoplay: true });
  }

  seek(t) {
    const d = this.a.duration;
    t = Math.max(0, Number.isFinite(d) ? Math.min(t, d) : t);
    try { this.a.currentTime = t; } catch {}
    if (!this.loadedId) this._resumeAt = t;
  }
  seekBy(dt) { this.seek((this.a.currentTime || 0) + dt); }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.a.volume = this.volume; // iOS Safari에서는 무시됨(항상 1) — UI에서 안내
  }

  stop() {
    this._tok++;
    this.a.pause();
    this.loadedId = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this._dropPre();
    this.a.removeAttribute('src');
    this.a.load();
    this.queue = []; this.base = []; this.idx = -1; this._resumeAt = 0;
    this.emit('queue'); this.emit('track', null); this.emit('state', false);
    this.persist();
  }

  /* ───── 반복 / 셔플 ───── */
  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.a.loop = this.repeat === 'one';
    this.emit('mode'); this._prefetch(); this.persist();
  }

  /** 켜면: 현재 곡과 이전 곡은 그대로, 이후 곡만 무작위. 끄면: 원래 순서로 복귀 */
  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const cur = this.currentId;
    if (this.shuffle) {
      const head = this.queue.slice(0, this.idx + 1);
      this.queue = [...head, ...shuffleArr(this.queue.slice(this.idx + 1))];
    } else {
      const set = new Set(this.queue);
      const ordered = this.base.filter((id) => set.has(id));
      const extra = this.queue.filter((id) => !this.base.includes(id));
      this.queue = [...ordered, ...extra];
      this.idx = Math.max(0, this.queue.indexOf(cur));
    }
    this.emit('queue'); this.emit('mode'); this._prefetch(); this.persist();
  }

  /* ───── 대기열 편집 ───── */
  addNext(id) {
    if (!this.queue.length) { this.playQueue([id], id); return; }
    this.queue.splice(this.idx + 1, 0, id);
    const b = this.base.indexOf(this.currentId);
    this.base.splice(b >= 0 ? b + 1 : this.base.length, 0, id);
    this.emit('queue'); this._prefetch(); this.persist();
  }
  addLast(id) {
    if (!this.queue.length) { this.playQueue([id], id); return; }
    this.queue.push(id); this.base.push(id);
    this.emit('queue'); this._prefetch(); this.persist();
  }
  removeAt(i) {
    const id = this.queue[i];
    if (id === undefined) return;
    const wasPlaying = !this.a.paused;
    this.queue.splice(i, 1);
    if (!this.queue.includes(id)) { const b = this.base.indexOf(id); if (b >= 0) this.base.splice(b, 1); }
    if (i < this.idx) this.idx--;
    else if (i === this.idx) {
      if (!this.queue.length) { this.stop(); return; }
      if (this.idx >= this.queue.length) this.idx = 0;
      this.emit('queue');
      this.load(this.currentId, { autoplay: wasPlaying });
      return;
    }
    this.emit('queue'); this._prefetch(); this.persist();
  }
  move(i, d) { // 재생 예정 곡끼리만 순서 변경
    const j = i + d;
    if (i <= this.idx || j <= this.idx || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.emit('queue'); this._prefetch(); this.persist();
  }
  removeTrackEverywhere(id) {
    let i;
    while ((i = this.queue.indexOf(id)) >= 0) this.removeAt(i);
    this.base = this.base.filter((x) => x !== id);
    if (this._pre && this._pre.id === id) this._dropPre();
  }

  /* ───── 다음 곡 미리 준비 ───── */
  _peekNextId() {
    if (!this.queue.length) return null;
    let n = this.idx + 1;
    if (n >= this.queue.length) { if (this.repeat === 'all') n = 0; else return null; }
    return this.queue[n];
  }
  _dropPre() { if (this._pre) { URL.revokeObjectURL(this._pre.url); this._pre = null; } }
  async _prefetch() {
    const nid = this._peekNextId();
    if (!nid || nid === this.currentId) { this._dropPre(); return; }
    if (this._pre && this._pre.id === nid) return;
    this._dropPre();
    const tok = this._tok;
    let blob;
    try { blob = await DB.getBlob(nid); } catch { return; }
    if (tok !== this._tok || !blob || this._peekNextId() !== nid) return;
    if (this._pre && this._pre.id === nid) return;
    this._dropPre();
    this._pre = { id: nid, url: URL.createObjectURL(blob) };
  }

  /* ───── 상태 저장 / 복원 ───── */
  persist() {
    DB.setMeta('player', {
      queue: this.queue, base: this.base, idx: this.idx,
      repeat: this.repeat, shuffle: this.shuffle, volume: this.volume,
      time: this.loadedId ? (this.a.currentTime || 0) : (this._resumeAt || 0),
    }).catch(() => {});
  }

  async restore() {
    let s;
    try { s = await DB.getMeta('player'); } catch { return false; }
    if (!s) return false;
    this.repeat = s.repeat || 'off';
    this.shuffle = !!s.shuffle;
    this.setVolume(s.volume ?? 1);
    const ok = (id) => !!this.getTrack(id);
    const curId = (s.queue || [])[s.idx];
    this.queue = (s.queue || []).filter(ok);
    this.base = (s.base || []).filter(ok);
    this.idx = this.queue.indexOf(curId);
    if (this.idx < 0) this.idx = this.queue.length ? 0 : -1;
    this._resumeAt = curId === this.currentId ? (s.time || 0) : 0;
    this.emit('queue'); this.emit('mode');
    if (this.currentId) await this.load(this.currentId, { autoplay: false, startAt: this._resumeAt }); // 자동 재생은 하지 않음(iOS 정책)
    return true;
  }
}
