/* converter.js — 가져오기(파일/링크) · 메타데이터 추출 · MP3 변환
 *
 * 사용하는 라이브러리 (CDN, 처음 필요할 때만 불러오고 서비스 워커가 캐시해서 이후엔 오프라인에서도 사용)
 *  - lamejs  : MP3 인코더. Web Audio의 decodeAudioData로 디코딩한 PCM을 MP3로 인코딩. 가볍고 iOS Safari에서도 안정적 → 1순위
 *  - FFmpeg WASM (@ffmpeg/ffmpeg, @ffmpeg/util, @ffmpeg/core) : 브라우저가 직접 디코딩하지 못하는 형식용 → 2순위 (최초 약 30MB)
 * 모든 변환은 브라우저 안에서만 이뤄지며 파일은 서버로 업로드되지 않는다.
 * 변환에 모두 실패했지만 브라우저가 원본을 재생할 수 있으면 원본 그대로 저장한다.
 */
export class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function friendlyError(e) {
  if (e instanceof AppError) return e.message;
  if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) return '저장 공간이 부족해서 음악을 추가할 수 없습니다.';
  return '알 수 없는 문제가 발생했어요. 잠시 후 다시 시도해 주세요.';
}

const LAME_URL = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
const FF_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd';
const FF_UTIL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js';
const FF_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|wave|ogg|oga|opus|flac|weba|webm|mp4|caf|aif|aiff)$/i;
const MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', wave: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf' };
const EXT_OF_MIME = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'weba' };

const extOf = (name) => (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || '';
const guessMime = (name) => MIME[extOf(name)] || '';
export const isMp3 = (file, name) => /\.mp3$/i.test(name) || /^audio\/(mpeg|mp3)$/.test(file.type);

const loaded = {};
function loadScript(src) {
  return loaded[src] || (loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => { delete loaded[src]; rej(new AppError('offline', '변환 도구를 불러오지 못했어요. 인터넷에 연결한 뒤 다시 시도해 주세요.')); };
    document.head.appendChild(s);
  }));
}

/* ───── 재생 시간 확인 (동시에 "재생 가능한 파일인지" 검사) ───── */
export function probeDuration(blob) {
  return new Promise((resolve, reject) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    let timer;
    const done = (fn, v) => {
      clearTimeout(timer);
      a.onloadedmetadata = a.onerror = null;
      a.removeAttribute('src');
      URL.revokeObjectURL(url);
      fn(v);
    };
    timer = setTimeout(() => done(reject, new Error('timeout')), 15000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => (Number.isFinite(a.duration) && a.duration > 0 ? done(resolve, a.duration) : done(reject, new Error('no duration')));
    a.onerror = () => done(reject, new Error('decode'));
    a.src = url;
  });
}

/* ───── 메타데이터: ID3v2(MP3) ───── */
const synch = (u, o) => ((u[o] & 127) << 21) | ((u[o + 1] & 127) << 14) | ((u[o + 2] & 127) << 7) | (u[o + 3] & 127);
const u32 = (u, o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;

function decodeText(bytes) {
  if (!bytes.length) return '';
  const enc = bytes[0];
  let body = bytes.subarray(1);
  let label = 'iso-8859-1';
  if (enc === 1) {
    if (body[0] === 0xff && body[1] === 0xfe) { label = 'utf-16le'; body = body.subarray(2); }
    else if (body[0] === 0xfe && body[1] === 0xff) { label = 'utf-16be'; body = body.subarray(2); }
    else label = 'utf-16le';
  } else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  return new TextDecoder(label).decode(body).replace(/\0+$/g, '').trim();
}

function parseId3(buf) {
  const u = new Uint8Array(buf);
  const out = {};
  if (u[0] !== 0x49 || u[1] !== 0x44 || u[2] !== 0x33 || u[3] < 3) return out; // v2.3/v2.4만 지원
  const ver = u[3];
  const end = Math.min(10 + synch(u, 6), u.length);
  let o = 10;
  if (u[5] & 0x40) o += ver === 4 ? synch(u, o) : u32(u, o) + 4;
  while (o + 10 <= end) {
    const id = String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fs = ver === 4 ? synch(u, o + 4) : u32(u, o + 4);
    const s = o + 10, e = s + fs;
    if (fs <= 0 || e > end) break;
    if (id === 'TIT2') out.title = decodeText(u.subarray(s, e));
    else if (id === 'TPE1') out.artist = decodeText(u.subarray(s, e));
    else if (id === 'TALB') out.album = decodeText(u.subarray(s, e));
    else if (id === 'APIC' && !out.cover) {
      const enc = u[s];
      let p = s + 1;
      while (p < e && u[p] !== 0) p++;
      const mime = new TextDecoder('iso-8859-1').decode(u.subarray(s + 1, p));
      p += 2; // 널 + 그림 종류 바이트
      if (enc === 0 || enc === 3) { while (p < e && u[p] !== 0) p++; p += 1; }
      else { while (p + 1 < e && !(u[p] === 0 && u[p + 1] === 0)) p += 2; p += 2; }
      if (p < e) out.cover = new Blob([u.slice(p, e)], { type: mime.includes('/') ? mime : 'image/jpeg' });
    }
    o = e;
  }
  return out;
}

/* ───── 메타데이터: MP4/M4A atom (moov > udta > meta > ilst) ───── */
function parseMp4(buf) {
  const dv = new DataView(buf);
  const out = {};
  const str = (o, l) => String.fromCharCode(...new Uint8Array(buf, o, l));
  const utf8 = new TextDecoder('utf-8');
  function walk(s, e, inIlst) {
    let o = s;
    while (o + 8 <= e) {
      let size = dv.getUint32(o);
      const type = str(o + 4, 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = e - o;
      if (size < hdr) break;
      const bs = o + hdr, be = Math.min(o + size, e);
      if (inIlst) {
        if (bs + 16 <= be && str(bs + 4, 4) === 'data') {
          const flags = dv.getUint32(bs + 8) & 0xffffff;
          const ps = bs + 16, pe = Math.min(bs + dv.getUint32(bs), be);
          if (type === '\u00a9nam') out.title = utf8.decode(new Uint8Array(buf, ps, pe - ps));
          else if (type === '\u00a9ART') out.artist = utf8.decode(new Uint8Array(buf, ps, pe - ps));
          else if (type === '\u00a9alb') out.album = utf8.decode(new Uint8Array(buf, ps, pe - ps));
          else if (type === 'covr') out.cover = new Blob([buf.slice(ps, pe)], { type: flags === 14 ? 'image/png' : 'image/jpeg' });
        }
      } else if (type === 'moov' || type === 'udta') walk(bs, be, false);
      else if (type === 'meta') walk(bs + 4, be, false);
      else if (type === 'ilst') walk(bs, be, true);
      o += size;
    }
  }
  walk(0, buf.byteLength, false);
  return out;
}

function fromName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || '제목 없음';
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: base };
}

async function readTags(file, name) {
  let t = {};
  try {
    if (/\.(m4a|mp4|aac)$/i.test(name) || /mp4|m4a/.test(file.type)) {
      if (file.size < 120e6) t = parseMp4(await file.arrayBuffer());
    } else {
      const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
        t = parseId3(await file.slice(0, Math.min(synch(head, 6) + 10, file.size)).arrayBuffer());
      }
    }
  } catch (e) { console.warn('tag parse', e); }
  const f = fromName(name);
  return { title: t.title || f.title, artist: t.artist || f.artist || '', album: t.album || '', cover: t.cover || null };
}

/* ───── MP3 변환 ───── */
async function viaLame(file, onProgress, signal) {
  await loadScript(LAME_URL);
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let buf;
  try {
    const ab = await file.arrayBuffer();
    buf = await new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
  } finally { ctx.close && ctx.close().catch(() => {}); }
  const ch = Math.min(2, buf.numberOfChannels);
  const enc = new window.lamejs.Mp3Encoder(ch, buf.sampleRate, 192);
  const L = buf.getChannelData(0), R = ch > 1 ? buf.getChannelData(1) : null;
  const toI16 = (f, s, e) => {
    const o = new Int16Array(e - s);
    for (let i = s; i < e; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i - s] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    return o;
  };
  const chunks = [];
  const BS = 1152 * 20, total = L.length;
  for (let i = 0, n = 0; i < total; i += BS, n++) {
    if (signal?.aborted) throw new AppError('cancel', '취소되었어요.');
    const e = Math.min(i + BS, total);
    const out = R ? enc.encodeBuffer(toI16(L, i, e), toI16(R, i, e)) : enc.encodeBuffer(toI16(L, i, e));
    if (out.length) chunks.push(out);
    onProgress(e / total);
    if (n % 20 === 0) await new Promise((r) => setTimeout(r)); // 화면이 멈추지 않도록 양보
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(tail);
  return new Blob(chunks, { type: 'audio/mpeg' });
}

let ffmpeg = null, ffProgress = () => {};
async function viaFfmpeg(file, name, onProgress, signal) {
  await loadScript(`${FF_BASE}/ffmpeg.js`);
  await loadScript(FF_UTIL);
  const { FFmpeg } = window.FFmpegWASM;
  const { toBlobURL, fetchFile } = window.FFmpegUtil;
  if (!ffmpeg) {
    const ff = new FFmpeg();
    ff.on('progress', ({ progress }) => ffProgress(Math.max(0, Math.min(1, progress))));
    await ff.load({
      coreURL: await toBlobURL(`${FF_CORE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${FF_CORE}/ffmpeg-core.wasm`, 'application/wasm'),
      classWorkerURL: await toBlobURL(`${FF_BASE}/814.ffmpeg.js`, 'text/javascript'),
    });
    ffmpeg = ff;
  }
  ffProgress = onProgress;
  const inName = 'in.' + (extOf(name) || 'bin');
  await ffmpeg.writeFile(inName, await fetchFile(file));
  try {
    if (signal?.aborted) throw new AppError('cancel', '취소되었어요.');
    const code = await ffmpeg.exec(['-i', inName, '-vn', '-codec:a', 'libmp3lame', '-b:a', '192k', 'out.mp3']);
    if (code !== 0) throw new Error('ffmpeg exit ' + code);
    const data = await ffmpeg.readFile('out.mp3');
    return new Blob([data.buffer], { type: 'audio/mpeg' });
  } finally {
    ffmpeg.deleteFile(inName).catch(() => {});
    ffmpeg.deleteFile('out.mp3').catch(() => {});
  }
}

export async function convertToMp3(file, name, onProgress = () => {}, signal) {
  try { return await viaLame(file, onProgress, signal); }
  catch (e) { if (e.code === 'cancel') throw e; console.warn('lamejs 변환 실패, FFmpeg로 재시도', e); }
  onProgress(0);
  return viaFfmpeg(file, name, onProgress, signal);
}

/* ───── 가져오기 준비: 검사 → 태그 → (필요시) 변환 ───── */
export async function prepareAudio(file, name, onStatus = () => {}, signal) {
  if (!AUDIO_EXT.test(name) && !/^audio\//.test(file.type)) {
    throw new AppError('unsupported', '지원하지 않는 파일 형식이에요. mp3, m4a, wav, aac, ogg, flac 파일을 선택해 주세요.');
  }
  onStatus({ stage: 'probe', progress: 0 });
  const tags = await readTags(file, name);
  const native = await probeDuration(file).catch(() => null); // null이면 브라우저가 직접 재생 못하는 파일
  let blob = file, mimeType = file.type || guessMime(name), converted = false, notice = null;

  if (isMp3(file, name)) {
    if (!native) throw new AppError('corrupt', '손상되었거나 재생할 수 없는 파일이에요.');
  } else if (file.size > 150e6 && native) {
    notice = '파일이 너무 커서 변환하지 않고 원본 형식 그대로 저장했어요.';
  } else {
    onStatus({ stage: 'convert', progress: 0 });
    try {
      blob = await convertToMp3(file, name, (p) => onStatus({ stage: 'convert', progress: p }), signal);
      mimeType = 'audio/mpeg';
      converted = true;
    } catch (e) {
      if (e.code === 'cancel') throw e;
      console.warn('변환 실패', e);
      if (!native) throw new AppError('convert', e instanceof AppError && e.code === 'offline' ? e.message : '변환에 실패했어요. 파일이 손상되었거나 지원하지 않는 형식일 수 있어요.');
      notice = 'MP3 변환에 실패해서 원본 형식 그대로 저장했어요.';
    }
  }
  const duration = converted ? await probeDuration(blob).catch(() => native) : native;
  if (!duration) throw new AppError('corrupt', '손상되었거나 재생할 수 없는 파일이에요.');
  return { blob, mimeType, duration, tags, notice, converted };
}

/* ───── 링크 다운로드 ───── */
export async function fetchAudio(raw, { signal, onProgress = () => {} } = {}) {
  let u;
  try { u = new URL(String(raw).trim()); }
  catch { throw new AppError('url', '올바른 링크가 아니에요. https:// 로 시작하는 주소를 입력해 주세요.'); }
  if (!/^https?:$/.test(u.protocol)) throw new AppError('url', '올바른 링크가 아니에요. https:// 로 시작하는 주소를 입력해 주세요.');
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(u.hostname)) {
    throw new AppError('stream', 'YouTube 같은 스트리밍 서비스 링크는 지원하지 않아요. mp3, m4a처럼 바로 내려받을 수 있는 음원 파일 링크만 사용할 수 있어요.');
  }
  if (!navigator.onLine) throw new AppError('offline', '인터넷에 연결되어 있지 않아요. 연결한 뒤 다시 시도해 주세요.');

  let res;
  try { res = await fetch(u.href, { signal, mode: 'cors', credentials: 'omit' }); }
  catch (e) {
    if (e.name === 'AbortError') throw new AppError('cancel', '취소되었어요.');
    throw new AppError('cors', '링크에서 파일을 가져오지 못했어요. 서버가 다른 사이트에서의 다운로드(CORS)를 허용하지 않거나 네트워크가 불안정할 수 있어요. 파일을 직접 저장한 뒤 "파일에서 가져오기"를 이용해 주세요.');
  }
  if (!res.ok) throw new AppError('http', `다운로드에 실패했어요. (서버 응답 ${res.status})`);
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith('text/') || ct === 'application/json') throw new AppError('html', '음원 파일이 아니라 웹페이지 링크예요. 파일을 바로 내려받는 주소를 입력해 주세요.');

  let name = '';
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  if (m) { try { name = decodeURIComponent(m[1]); } catch { name = m[1]; } }
  if (!name) { try { name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; } }
  if (!name) name = 'download';
  if (!extOf(name) && EXT_OF_MIME[ct]) name += '.' + EXT_OF_MIME[ct];

  const total = +res.headers.get('content-length') || 0;
  const chunks = [];
  let got = 0;
  try {
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total) onProgress(got / total);
      }
    } else chunks.push(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) throw new AppError('cancel', '취소되었어요.');
    throw new AppError('network', '다운로드 도중 연결이 끊겼어요. 네트워크 상태를 확인하고 다시 시도해 주세요.');
  }
  onProgress(1);
  return { blob: new Blob(chunks, { type: ct.startsWith('audio/') ? ct : guessMime(name) }), name };
}
