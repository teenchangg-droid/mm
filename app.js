/* app.js — 화면(UI)과 db / player / media-session / converter 모듈을 연결한다 */
import * as DB from './db.js';
import { Player } from './player.js';
import { MediaBridge, defaultCover, resizeToBlob } from './media-session.js';
import { prepareAudio, fetchAudio, AppError, friendlyError } from './converter.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const fmtBytes = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + 'GB' : Math.round(b / 1e6) + 'MB');

/* ───── 아이콘 ───── */
const S = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const F = (d) => `<svg viewBox="0 0 24 24" fill="currentColor">${d}</svg>`;
const REPEAT = '<path d="M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3"/>';
const ICONS = {
  play: F('<path d="M7 4.5v15a1 1 0 001.5.86l12-7.5a1 1 0 000-1.72l-12-7.5A1 1 0 007 4.5z"/>'),
  pause: F('<rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/>'),
  next: F('<path d="M5 5.5v13a.8.8 0 001.2.7l9-6.5a.8.8 0 000-1.4l-9-6.5A.8.8 0 005 5.5z"/><rect x="16.5" y="5" width="2.5" height="14" rx="1"/>'),
  prev: F('<path d="M19 5.5v13a.8.8 0 01-1.2.7l-9-6.5a.8.8 0 010-1.4l9-6.5A.8.8 0 0119 5.5z"/><rect x="5" y="5" width="2.5" height="14" rx="1"/>'),
  shuffle: S('<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
  repeat: S(REPEAT),
  repeat1: S(REPEAT + '<path d="M11 10.5l1.5-1v6"/>'),
  queue: S('<path d="M4 6h16M4 12h16M4 18h8"/><path d="M16 15.5l5 2.5-5 2.5z" fill="currentColor"/>'),
  down: S('<path d="M6 9l6 6 6-6"/>'),
  up: S('<path d="M6 15l6-6 6 6"/>'),
  more: F('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>'),
  plus: S('<path d="M12 5v14M5 12h14" stroke-width="2.4"/>'),
  search: S('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  x: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  check: S('<path d="M5 12l5 5 9-10"/>'),
  vol: S('<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 9a4 4 0 010 6"/>'),
  back15: S('<path d="M5 12a7 7 0 107-7H8"/><path d="M10.5 2.5L8 5l2.5 2.5"/><text x="12" y="16" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none">15</text>'),
  fwd15: S('<path d="M19 12a7 7 0 11-7-7h4"/><path d="M13.5 2.5L16 5l-2.5 2.5"/><text x="12" y="16" text-anchor="middle" font-size="7.5" font-weight="700" fill="currentColor" stroke="none">15</text>'),
};
const setIcon = (el, name) => { el.innerHTML = ICONS[name]; };
const hydrate = (root = document) => root.querySelectorAll('[data-ic]').forEach((el) => setIcon(el, el.dataset.ic));

/* ───── 상태 ───── */
const audio = $('#audio');
const tracks = new Map();
const ui = { q: '', sort: 'added' };
const SORTS = { added: '최근 추가', played: '최근 재생', title: '제목순', artist: '아티스트순', count: '재생 횟수순' };
const player = new Player(audio, (id) => tracks.get(id));
const media = new MediaBridge(player);
let dragging = false, busy = false;

// iOS Safari는 audio.volume 을 바꿔도 반영되지 않는다 → 볼륨 슬라이더 대신 안내 문구 표시
const VOL_OK = (() => { const t = new Audio(); t.volume = 0.5; return t.volume === 0.5; })();

/* ───── 공용 UI: 토스트 / 바텀 시트 ───── */
let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const sheetRoot = $('#sheetRoot');
let sheetTok = 0, sheetKind = null;
function openSheet(html, { kind = '', lock = false } = {}) {
  const tok = ++sheetTok;
  sheetKind = kind;
  sheetRoot.className = '';
  sheetRoot.innerHTML = `<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  const sh = $('.sheet', sheetRoot);
  hydrate(sh);
  if (!lock) $('.scrim', sheetRoot).onclick = () => closeSheet();
  requestAnimationFrame(() => requestAnimationFrame(() => { if (tok === sheetTok) sheetRoot.classList.add('open'); }));
  return sh;
}
function closeSheet() {
  const tok = ++sheetTok;
  sheetKind = null;
  sheetRoot.classList.remove('open');
  setTimeout(() => { if (tok === sheetTok) sheetRoot.innerHTML = ''; }, 320);
}

/* ───── 커버 이미지 ───── */
const coverCache = new Map();
function coverUrl(t, size = 160) {
  if (t.cover) {
    let c = coverCache.get(t.id);
    if (!c || c.blob !== t.cover) {
      if (c) URL.revokeObjectURL(c.url);
      c = { blob: t.cover, url: URL.createObjectURL(t.cover) };
      coverCache.set(t.id, c);
    }
    return c.url;
  }
  return defaultCover(t.artist || t.title, size);
}
const artistOf = (t) => t.artist || '알 수 없는 아티스트';

/* ───── 라이브러리 렌더링 ───── */
function sorted(list) {
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ko');
  const by = {
    added: (a, b) => b.createdAt - a.createdAt,
    played: (a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0) || b.createdAt - a.createdAt,
    title: (a, b) => cmp(a.title, b.title),
    artist: (a, b) => cmp(a.artist, b.artist) || cmp(a.title, b.title),
    count: (a, b) => (b.playCount || 0) - (a.playCount || 0) || b.createdAt - a.createdAt,
  }[ui.sort];
  return [...list].sort(by);
}
function visible() {
  const q = ui.q.trim().toLowerCase();
  let a = [...tracks.values()];
  if (q) a = a.filter((t) => [t.title, t.artist, t.album].some((v) => (v || '').toLowerCase().includes(q)));
  return sorted(a);
}

function renderLibrary() {
  const list = visible();
  const q = ui.q.trim();
  $('#sortBtn').textContent = SORTS[ui.sort] + ' ⌄';
  $('#listTitle').textContent = q ? '검색 결과' : tracks.size ? `내 음악 ${tracks.size}곡` : '내 음악';
  $('#sortBtn').hidden = tracks.size < 2;

  const empty = $('#empty');
  if (!list.length) {
    empty.hidden = false;
    empty.innerHTML = q
      ? `<b>검색 결과가 없어요</b>제목, 아티스트, 앨범으로 찾아보세요.`
      : `<b>아직 곡이 없어요</b>파일이나 링크로 첫 곡을 추가해 보세요.<br>추가한 음악은 이 기기에 저장돼요.<button class="sbtn primary" data-a="add">음악 추가</button>`;
  } else empty.hidden = true;

  $('#list').innerHTML = list.map((t) => `
    <li class="row${t.id === player.currentId ? ' playing' : ''}" data-id="${t.id}" tabindex="0">
      <img src="${coverUrl(t)}" alt="" loading="lazy">
      <div class="meta"><b>${esc(t.title)}</b><span>${esc(artistOf(t))} · ${fmt(t.duration)}</span></div>
      <button class="more" data-more="${t.id}" data-ic="more" aria-label="더보기"></button>
    </li>`).join('');
  hydrate($('#list'));

  const recent = [...tracks.values()].filter((t) => t.lastPlayedAt > 0).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 8);
  $('#recentSec').hidden = !!q || !recent.length;
  $('#recent').innerHTML = recent.map((t) => `
    <button class="rc" data-id="${t.id}"><img src="${coverUrl(t)}" alt=""><b>${esc(t.title)}</b><span>${esc(artistOf(t))}</span></button>`).join('');
}

function markPlaying() {
  document.querySelectorAll('.row').forEach((r) => r.classList.toggle('playing', r.dataset.id === player.currentId));
}

/* ───── 플레이어 UI ───── */
const seek = $('#seek');
const durOf = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : player.current?.duration || 0);

function renderTrack() {
  const t = player.current;
  document.body.classList.toggle('has-mini', !!t);
  $('#mini').hidden = !t;
  $('#player').classList.toggle('idle', !t);
  $('#pTitle').textContent = t ? t.title : '재생 중인 곡 없음';
  $('#pArtist').textContent = t ? artistOf(t) : '목록에서 곡을 선택해 주세요';
  $('#pArt').src = t ? coverUrl(t, 512) : defaultCover('My Music', 512);
  $('#mArt').src = t ? coverUrl(t, 120) : '';
  $('#mTitle').textContent = t ? t.title : '';
  $('#mArtist').textContent = t ? artistOf(t) : '';
  document.title = t ? `${t.title} · My Music` : 'My Music';
  if (!t) { closePlayer(); renderTime(0, 0); }
  markPlaying();
}

function renderTime(cur, dur) {
  const d = Number.isFinite(dur) && dur > 0 ? dur : durOf();
  if (!dragging) {
    const r = d ? Math.min(cur / d, 1) : 0;
    seek.value = Math.round(r * 1000);
    seek.style.setProperty('--p', r * 100 + '%');
    $('#tCur').textContent = fmt(cur);
  }
  $('#tDur').textContent = fmt(d);
  $('#mProg').style.width = (d ? Math.min(cur / d, 1) * 100 : 0) + '%';
}

function renderPlaying(playing) {
  for (const id of ['#bPlay', '#mPlay']) {
    setIcon($(id), playing ? 'pause' : 'play');
    $(id).setAttribute('aria-label', playing ? '일시정지' : '재생');
  }
  $('#player').classList.toggle('playing', playing);
}

const REPEAT_LABEL = { off: '반복 없음', all: '전체 반복', one: '한 곡 반복' };
function renderMode() {
  const b = $('#bRepeat');
  setIcon(b, player.repeat === 'one' ? 'repeat1' : 'repeat');
  b.classList.toggle('on', player.repeat !== 'off');
  b.setAttribute('aria-label', REPEAT_LABEL[player.repeat]);
  const s = $('#bShuffle');
  s.classList.toggle('on', player.shuffle);
  s.setAttribute('aria-pressed', String(player.shuffle));
  s.setAttribute('aria-label', player.shuffle ? '셔플 켜짐' : '셔플 꺼짐');
}

function renderVolume() {
  const v = $('#vol');
  v.value = Math.round(player.volume * 100);
  v.style.setProperty('--p', v.value + '%');
  if (!VOL_OK) { v.hidden = true; $('#volNote').hidden = false; $('#volWrap [data-ic]').hidden = true; }
}

const isOverlay = () => window.matchMedia('(max-width:699px)').matches;
function openPlayer() { if (player.current) document.body.classList.add('player-open'); }
function closePlayer() { document.body.classList.remove('player-open'); }

/* ───── 트랙 메뉴 / 수정 / 삭제 ───── */
function openTrackMenu(id) {
  const t = tracks.get(id);
  if (!t) return;
  const sh = openSheet(`
    <div class="sh-head"><img src="${coverUrl(t, 120)}" alt=""><div class="meta"><b>${esc(t.title)}</b><span>${esc(artistOf(t))}${t.album ? ' · ' + esc(t.album) : ''}</span></div></div>
    <button class="sbtn" data-a="next">다음에 재생</button>
    <button class="sbtn" data-a="last">대기열에 추가</button>
    <button class="sbtn" data-a="edit">정보 · 앨범 이미지 수정</button>
    <button class="sbtn danger" data-a="del">삭제</button>`, { kind: 'menu' });
  sh.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'next') { player.unlock(); player.addNext(id); closeSheet(); toast('다음에 재생할게요.'); }
    else if (a === 'last') { player.unlock(); player.addLast(id); closeSheet(); toast('대기열에 추가했어요.'); }
    else if (a === 'edit') openEdit(id);
    else if (a === 'del') openDelete(id);
  };
}

function openEdit(id) {
  const t = tracks.get(id);
  if (!t) return;
  let newCover; // undefined: 변경 없음 · null: 기본 이미지로 · Blob: 새 이미지
  const sh = openSheet(`
    <h3>음악 정보 수정</h3>
    <div class="cover-edit"><img id="edCover" src="${coverUrl(t, 240)}" alt="">
      <div><button class="link-btn" id="edPick">앨범 이미지 변경</button><br><button class="link-btn sub" id="edReset">기본 이미지로</button></div></div>
    <label class="field"><span>제목</span><input id="edTitle" value="${esc(t.title)}" autocomplete="off"></label>
    <label class="field"><span>아티스트</span><input id="edArtist" value="${esc(t.artist)}" autocomplete="off"></label>
    <label class="field"><span>앨범</span><input id="edAlbum" value="${esc(t.album)}" autocomplete="off"></label>
    <button class="sbtn primary" id="edSave">저장</button>`, { kind: 'edit' });
  $('#edPick', sh).onclick = () => {
    const inp = $('#imgIn');
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      if (!f.type.startsWith('image/')) { toast('이미지 파일만 선택할 수 있어요.'); return; }
      try { newCover = await resizeToBlob(f, 600); } catch { newCover = f; }
      const el = $('#edCover');
      if (el) el.src = URL.createObjectURL(newCover);
    };
    inp.click();
  };
  $('#edReset', sh).onclick = () => { newCover = null; $('#edCover').src = defaultCover(($('#edArtist').value || $('#edTitle').value), 240); };
  $('#edSave', sh).onclick = async () => {
    const patch = {
      title: $('#edTitle').value.trim() || t.title,
      artist: $('#edArtist').value.trim(),
      album: $('#edAlbum').value.trim(),
    };
    if (newCover !== undefined) patch.cover = newCover;
    try {
      const next = await DB.updateTrack(id, patch);
      if (next) tracks.set(id, next);
    } catch (e) { toast(friendlyError(e)); return; }
    closeSheet();
    renderLibrary();
    if (player.currentId === id) { renderTrack(); media.setTrack(player.current); }
    toast('저장했어요.');
  };
}

function openDelete(id) {
  const t = tracks.get(id);
  if (!t) return;
  const sh = openSheet(`
    <h3>이 곡을 삭제할까요?</h3>
    <p class="note" style="margin-top:0">「${esc(t.title)}」이(가) 이 기기에서 삭제되며<br>되돌릴 수 없어요.</p>
    <button class="sbtn danger" data-a="ok">삭제</button>
    <button class="sbtn" data-a="cancel">취소</button>`, { kind: 'confirm' });
  sh.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'cancel') closeSheet();
    if (a !== 'ok') return;
    try { await DB.deleteTrack(id); } catch (err) { toast(friendlyError(err)); return; }
    player.removeTrackEverywhere(id);
    tracks.delete(id);
    const c = coverCache.get(id);
    if (c) { URL.revokeObjectURL(c.url); coverCache.delete(id); }
    closeSheet();
    renderLibrary();
    toast('삭제했어요.');
  };
}

/* ───── 대기열 ───── */
function queueHtml() {
  const q = player.queue, i = player.idx;
  if (i < 0 || !q.length) return `<h3>대기열</h3><p class="note">재생 중인 곡이 없어요.</p>`;
  const row = (id, j, cur) => {
    const t = tracks.get(id);
    if (!t) return '';
    return `<div class="qrow${cur ? ' cur' : ''}" data-idx="${j}">
      <img src="${coverUrl(t, 120)}" alt="">
      <div class="meta"><b>${esc(t.title)}</b><span>${esc(artistOf(t))}</span></div>
      ${cur ? '' : `<button class="icon-btn" data-act="up" data-ic="up" aria-label="위로"></button>
      <button class="icon-btn" data-act="down" data-ic="down" aria-label="아래로"></button>
      <button class="icon-btn" data-act="rm" data-ic="x" aria-label="대기열에서 제거"></button>`}</div>`;
  };
  const upcoming = q.slice(i + 1).map((id, k) => row(id, i + 1 + k, false)).join('');
  return `<h3>대기열</h3>
    <div class="qh">재생 중</div>${row(q[i], i, true)}
    <div class="qh">다음 곡${player.shuffle ? ' · 셔플' : ''}${player.repeat === 'all' ? ' · 전체 반복' : ''}</div>
    ${upcoming || '<p class="note" style="text-align:left;margin-top:4px">다음 곡이 없어요. 곡 메뉴에서 대기열에 추가할 수 있어요.</p>'}`;
}
function openQueue() {
  const sh = openSheet(queueHtml(), { kind: 'queue' });
  sh.onclick = (e) => {
    const row = e.target.closest('.qrow');
    if (!row) return;
    const i = +row.dataset.idx;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'up') player.move(i, -1);
    else if (act === 'down') player.move(i, 1);
    else if (act === 'rm') player.removeAt(i);
    else if (i !== player.idx) { player.unlock(); player.playAt(i); }
  };
}
function refreshQueue() {
  if (sheetKind !== 'queue') return;
  const sh = $('.sheet', sheetRoot);
  if (!sh) return;
  const keep = sh.scrollTop;
  sh.innerHTML = `<div class="grab"></div>${queueHtml()}`;
  hydrate(sh);
  sh.scrollTop = keep;
}

/* ───── 정렬 / 안내 ───── */
function openSort() {
  const sh = openSheet(`<h3>정렬</h3>` + Object.entries(SORTS).map(([k, v]) =>
    `<button class="sbtn opt${k === ui.sort ? ' sel' : ''}" data-k="${k}" style="padding:0 6px;background:none"><span>${v}</span>${k === ui.sort ? ICONS.check.replace('<svg', '<svg style="width:20px;height:20px"') : ''}</button>`).join(''), { kind: 'sort' });
  sh.onclick = (e) => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    ui.sort = k;
    DB.setMeta('sort', k).catch(() => {});
    closeSheet();
    renderLibrary();
  };
}

function openInfo() {
  const sw = 'serviceWorker' in navigator && navigator.serviceWorker.controller;
  openSheet(`
    <h3>사용 안내와 제한사항</h3>
    <ul class="info">
      <li><b>오프라인 재생</b> — 음원은 이 기기의 브라우저 저장소(IndexedDB)에 저장돼요. 앱 화면 캐시: <b>${sw ? '사용 중' : '아직 준비 안 됨 (https 주소에서 한 번 열어야 해요)'}</b></li>
      <li><b>저장 공간</b> — 브라우저가 정한 한도까지만 저장할 수 있어요. Safari는 홈 화면에 추가하지 않은 사이트를 오래 열지 않으면 저장된 데이터를 지울 수 있어요. iPhone/iPad에서는 <b>공유 → 홈 화면에 추가</b>로 설치해서 쓰는 걸 권장해요.</li>
      <li><b>백그라운드·잠금화면</b> — 화면을 잠가도 재생되고 제어센터에서 제어할 수 있어요. 다만 iOS가 메모리 부족 등으로 앱을 종료하면 재생이 멈출 수 있어요. 다음 곡은 미리 준비해 두지만 iOS의 판단에 따라 곡이 넘어갈 때 끊길 수 있어요.</li>
      <li><b>제어센터 버튼</b> — iOS는 이전/다음 곡 버튼과 ±10초 버튼 중 보통 한 쌍만 보여줘요. 이 앱은 이전/다음 곡을 우선해요.</li>
      <li><b>볼륨</b> — iPhone/iPad의 Safari는 웹앱의 볼륨 조절을 허용하지 않아요. 기기의 볼륨 버튼을 사용해 주세요.</li>
      <li><b>변환</b> — MP3가 아닌 파일은 기기 안에서 MP3로 변환해요(서버로 업로드하지 않아요). 큰 파일은 메모리가 부족해 변환에 실패할 수 있고, 이 경우 원본 그대로 저장해요.</li>
      <li><b>링크 가져오기</b> — 서버가 다른 사이트에서의 다운로드(CORS)를 허용하는 직접 다운로드 링크만 가능해요. YouTube 같은 스트리밍 서비스 링크는 지원하지 않아요.</li>
    </ul>`, { kind: 'info' });
}

/* ───── 음악 추가 ───── */
async function openAdd() {
  const sh = openSheet(`
    <h3>음악 추가</h3>
    <button class="sbtn" data-a="file">파일에서 가져오기</button>
    <button class="sbtn" data-a="link">링크에서 가져오기</button>
    <p class="note">내 음악은 이 기기에 저장되며<br>오프라인에서도 재생할 수 있습니다.</p>
    <p class="note" id="storeNote" style="margin-top:6px"></p>`, { kind: 'add' });
  sh.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'file') { $('#fileIn').value = ''; $('#fileIn').click(); closeSheet(); } // 파일 선택창은 탭 직후 동기 호출해야 iOS에서 열린다
    else if (a === 'link') openLink();
  };
  const info = await DB.storageInfo();
  const el = $('#storeNote');
  if (info && info.quota && el) el.textContent = `저장 공간 ${fmtBytes(info.usage)} 사용 · ${fmtBytes(Math.max(0, info.quota - info.usage))} 여유`;
}

function openLink() {
  const sh = openSheet(`
    <h3>링크에서 가져오기</h3>
    <label class="field"><span>음원 링크</span><input id="urlIn" type="url" inputmode="url" placeholder="https://..." autocapitalize="off" autocorrect="off" spellcheck="false"></label>
    <button class="sbtn primary" id="urlGo">음악 가져오기</button>
    <p class="note">※ 다운로드 가능한 음원 링크만 지원합니다.</p>`, { kind: 'link' });
  const go = () => {
    const v = $('#urlIn', sh).value.trim();
    if (!v) { toast('음원 링크를 입력해 주세요.'); return; }
    runImport([{ url: v }]);
  };
  $('#urlGo', sh).onclick = go;
  $('#urlIn', sh).onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

function openProgress(onCancel) {
  openSheet(`
    <h3 id="pgTitle">준비 중</h3>
    <p class="note" id="pgSub" style="margin:0"></p>
    <div class="bar"><i id="pgFill"></i></div>
    <p class="pgtext" id="pgText">0%</p>
    <button class="sbtn" id="pgCancel">취소</button>`, { kind: 'progress', lock: true });
  $('#pgCancel').onclick = onCancel;
  return {
    set(title, p, sub) {
      const t = $('#pgTitle');
      if (!t) return;
      t.textContent = title;
      if (sub !== undefined) $('#pgSub').textContent = sub;
      const pct = Math.round(Math.max(0, Math.min(1, p || 0)) * 100);
      $('#pgFill').style.width = pct + '%';
      $('#pgText').textContent = pct + '%';
    },
  };
}

const isQuota = (e) => e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));

async function saveTrack(prep, name) {
  const { blob, mimeType, duration, tags } = prep;
  const info = await DB.storageInfo();
  if (info && info.quota && info.quota - info.usage < blob.size * 1.05) {
    throw new AppError('quota', '저장 공간이 부족해서 음악을 추가할 수 없습니다.');
  }
  let cover = tags.cover;
  if (cover && cover.size > 300e3) { try { cover = await resizeToBlob(cover, 600); } catch { /* 원본 유지 */ } }
  const t = {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2),
    title: tags.title || name, artist: tags.artist, album: tags.album,
    duration, mimeType, cover: cover || null, size: blob.size,
    createdAt: Date.now(), lastPlayedAt: 0, playCount: 0,
  };
  try { await DB.putTrack(t, blob); }
  catch (e) {
    console.error(e);
    throw isQuota(e) ? new AppError('quota', '저장 공간이 부족해서 음악을 추가할 수 없습니다.') : new AppError('db', '음악을 저장하지 못했어요. 브라우저의 저장소 설정을 확인해 주세요.');
  }
  tracks.set(t.id, t);
  renderLibrary();
  DB.requestPersist();
  return t.id;
}

async function runImport(items) {
  if (busy) { toast('이미 가져오는 중이에요.'); return; }
  busy = true;
  const ac = new AbortController();
  const pg = openProgress(() => ac.abort());
  let ok = 0;
  const errs = [], notes = [];
  for (let i = 0; i < items.length; i++) {
    if (ac.signal.aborted) break;
    const it = items[i];
    const sub = items.length > 1 ? `${i + 1} / ${items.length}` : '';
    try {
      let file = it.file, name = it.file ? it.file.name : '';
      if (it.url) {
        pg.set('음원 다운로드 중', 0, sub);
        const r = await fetchAudio(it.url, { signal: ac.signal, onProgress: (p) => pg.set('음원 다운로드 중', p, sub) });
        file = r.blob; name = r.name;
      }
      const prep = await prepareAudio(file, name, (st) => pg.set(st.stage === 'convert' ? '음원 변환 중' : '음원 확인 중', st.progress, sub), ac.signal);
      pg.set('내 음악에 저장 중', 1, sub);
      await saveTrack(prep, name);
      ok++;
      if (prep.notice) notes.push(prep.notice);
    } catch (e) {
      if ((e && e.code === 'cancel') || ac.signal.aborted) break;
      console.error(e);
      errs.push((items.length > 1 && it.file ? it.file.name + ': ' : '') + friendlyError(e));
    }
  }
  busy = false;
  closeSheet();
  const msg = [
    ok ? (ok === 1 ? '내 음악에 추가했어요.' : `${ok}곡을 내 음악에 추가했어요.`) : null,
    ...errs.slice(0, 2), errs.length > 2 ? `외 ${errs.length - 2}건 실패` : null, notes[0],
  ].filter(Boolean).join('\n');
  if (msg) toast(msg, errs.length || notes.length ? 6500 : 3000);
}

/* ───── 이벤트 연결 ───── */
function bind() {
  hydrate();

  $('#fab').onclick = openAdd;
  $('#empty').onclick = (e) => { if (e.target.closest('[data-a="add"]')) openAdd(); };
  $('#infoBtn').onclick = openInfo;
  $('#sortBtn').onclick = openSort;
  $('#fileIn').onchange = (e) => { const fs = [...e.target.files]; if (fs.length) runImport(fs.map((file) => ({ file }))); };

  $('#search').addEventListener('input', (e) => { ui.q = e.target.value; renderLibrary(); });

  const playFrom = (id) => { player.unlock(); player.playQueue(visible().map((t) => t.id), id); };
  $('#list').addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { openTrackMenu(more.dataset.more); return; }
    const row = e.target.closest('.row');
    if (row) playFrom(row.dataset.id);
  });
  $('#list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('row')) playFrom(e.target.dataset.id);
  });
  $('#recent').addEventListener('click', (e) => { const b = e.target.closest('.rc'); if (b) playFrom(b.dataset.id); });

  const toggle = () => { player.unlock(); player.toggle(); };
  $('#bPlay').onclick = toggle;
  $('#mPlay').onclick = toggle;
  $('#bNext').onclick = $('#mNext').onclick = () => { player.unlock(); player.next(); };
  $('#bPrev').onclick = $('#mPrev').onclick = () => { player.unlock(); player.prev(); };
  $('#bBack').onclick = () => player.seekBy(-15);
  $('#bFwd').onclick = () => player.seekBy(15);
  $('#bShuffle').onclick = () => { player.toggleShuffle(); toast(player.shuffle ? '셔플 켜짐 · 이후 곡을 무작위로 재생해요' : '셔플 꺼짐 · 원래 순서로 돌아왔어요', 1800); };
  $('#bRepeat').onclick = () => { player.cycleRepeat(); toast(REPEAT_LABEL[player.repeat], 1500); };
  $('#queueBtn').onclick = openQueue;
  $('#pMore').onclick = () => { if (player.currentId) openTrackMenu(player.currentId); };
  $('#miniOpen').onclick = openPlayer;
  $('#miniOpen').onkeydown = (e) => { if (e.key === 'Enter') openPlayer(); };
  $('#closePlayer').onclick = closePlayer;

  seek.addEventListener('input', () => {
    dragging = true;
    $('#tCur').textContent = fmt((seek.value / 1000) * durOf());
    seek.style.setProperty('--p', seek.value / 10 + '%');
  });
  seek.addEventListener('change', () => { player.seek((seek.value / 1000) * durOf()); dragging = false; media.position(); });

  $('#vol').addEventListener('input', (e) => {
    player.setVolume(e.target.value / 100);
    e.target.style.setProperty('--p', e.target.value + '%');
  });
  $('#vol').addEventListener('change', () => player.persist());

  // 아래로 쓸어내려 플레이어 닫기 (좁은 화면)
  const pl = $('#player');
  let sy = 0, dy = 0, tracking = false;
  pl.addEventListener('touchstart', (e) => {
    if (!isOverlay() || e.target.closest('input') || pl.scrollTop > 0) return;
    tracking = true; sy = e.touches[0].clientY; dy = 0; pl.style.transition = 'none';
  }, { passive: true });
  pl.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    dy = e.touches[0].clientY - sy;
    pl.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  }, { passive: true });
  const endDrag = () => {
    if (!tracking) return;
    tracking = false; pl.style.transition = ''; pl.style.transform = '';
    if (dy > 120) closePlayer();
  };
  pl.addEventListener('touchend', endDrag);
  pl.addEventListener('touchcancel', endDrag);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); toggle(); }
  });

  // 플레이어 이벤트
  player.on('track', () => { renderTrack(); media.setTrack(player.current); if (!player.loadedId || audio.paused) renderTime(player._resumeAt || 0, 0); });
  player.on('state', (p) => { renderPlaying(p); media.setPlaying(p); });
  player.on('time', (c, d) => { renderTime(c, d); });
  player.on('seeked', () => media.position());
  audio.addEventListener('loadedmetadata', () => media.position());
  audio.addEventListener('play', () => media.position());
  player.on('queue', refreshQueue);
  player.on('mode', renderMode);
  player.on('started', (id) => {
    const t = tracks.get(id);
    if (!t) return;
    const patch = { lastPlayedAt: Date.now(), playCount: (t.playCount || 0) + 1 };
    Object.assign(t, patch);
    DB.updateTrack(id, patch).catch(() => {});
    renderLibrary();
  });
  player.on('error', (kind) => {
    if (kind === 'missing') toast('저장된 음원을 찾을 수 없어요. 곡을 삭제하고 다시 추가해 주세요.');
    else if (kind === 'blocked') toast('재생 버튼을 눌러 음악을 시작해 주세요.');
    else toast('이 음악을 재생할 수 없어요. 파일이 손상되었을 수 있어요.');
  });

  // 앱을 나가거나 화면이 꺼지기 직전에 재생 위치 저장
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') player.persist(); });
  window.addEventListener('pagehide', () => player.persist());

  // 온라인 / 오프라인 표시
  const net = () => {
    const on = navigator.onLine;
    const el = $('#netStatus');
    el.className = 'net' + (on ? '' : ' off');
    el.innerHTML = `<i></i>${on ? '오프라인에서도 재생 가능' : '오프라인 · 저장된 음악만 재생돼요'}`;
  };
  window.addEventListener('online', net);
  window.addEventListener('offline', net);
  net();
}

/* ───── iOS 설치 안내 ───── */
function iosHint() {
  if (!IOS || STANDALONE) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('hintDismissed') === '1'; } catch { /* 저장소 차단 */ }
  if (dismissed) return;
  const h = $('#hint');
  h.hidden = false;
  h.innerHTML = `<span>공유 버튼 → <b>홈 화면에 추가</b>로 설치하면 저장된 음악이 더 오래 유지되고 잠금화면 재생도 안정적이에요.</span><button>닫기</button>`;
  h.querySelector('button').onclick = () => { h.hidden = true; try { localStorage.setItem('hintDismissed', '1'); } catch { /* 무시 */ } };
}

/* ───── 시작 ───── */
async function init() {
  bind();
  renderMode();
  renderVolume();
  renderTrack();
  try {
    (await DB.getAllTracks()).forEach((t) => tracks.set(t.id, t));
    ui.sort = (await DB.getMeta('sort')) || 'added';
  } catch (e) {
    console.error(e);
    toast('저장소를 열 수 없어요. 사생활 보호 모드이거나 브라우저가 저장소를 막고 있을 수 있어요.', 6000);
  }
  renderLibrary();
  await player.restore(); // 마지막 곡·위치·대기열·반복·셔플·볼륨 복원 (자동 재생은 하지 않음)
  renderMode();
  renderVolume();
  renderTrack();
  iosHint();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('service-worker.js').catch((e) => console.warn('서비스 워커 등록 실패', e));
  }
}
init();
