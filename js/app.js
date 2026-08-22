/* Capisco — Italian listening comprehension app
   Single-file SPA. Hash-based routing. Data loaded from /data/*.json. */

const state = {
  shows: null,
  episodesByShow: {},   // showId -> [episode summaries]
  episodeData: {},      // "showId/episodeId" -> full episode object (blocks/cards)
  progress: loadProgress(),
  tab: 'text',           // current card tab: text | translation | audio
  speed: 1,
};

const SPEEDS = [0.75, 1, 1.25, 1.5];

// ---------------- Progress persistence ----------------
function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem('capisco:progress') || '{}');
  } catch (e) { return {}; }
}
function saveProgress() {
  localStorage.setItem('capisco:progress', JSON.stringify(state.progress));
}
function cardKey(showId, episodeId, blockId, cardId) {
  return `${showId}/${episodeId}/${blockId}/${cardId}`;
}
function isCardDone(showId, episodeId, blockId, cardId) {
  return !!state.progress[cardKey(showId, episodeId, blockId, cardId)];
}
function setCardDone(showId, episodeId, blockId, cardId, done) {
  const k = cardKey(showId, episodeId, blockId, cardId);
  if (done) state.progress[k] = true; else delete state.progress[k];
  saveProgress();
}
function blockDoneCount(showId, episodeId, block) {
  return block.cards.filter(c => isCardDone(showId, episodeId, block.id, c.id)).length;
}
function episodeDoneCount(showId, episodeId, blocks) {
  let total = 0, done = 0;
  blocks.forEach(b => { total += b.cards.length; done += blockDoneCount(showId, episodeId, b); });
  return { done, total };
}
function firstUnstudiedIndex(showId, episodeId, block) {
  const idx = block.cards.findIndex(c => !isCardDone(showId, episodeId, block.id, c.id));
  return idx === -1 ? 0 : idx; // all done (or empty) -> start over from the top
}

// ---------------- Data loading ----------------
async function loadShows() {
  if (state.shows) return state.shows;
  const res = await fetch('data/shows.json');
  state.shows = res.ok ? await res.json() : [];
  return state.shows;
}
async function loadEpisodes(showId) {
  if (state.episodesByShow[showId]) return state.episodesByShow[showId];
  try {
    const res = await fetch(`data/${showId}/episodes.json`);
    state.episodesByShow[showId] = res.ok ? await res.json() : [];
  } catch (e) { state.episodesByShow[showId] = []; }
  return state.episodesByShow[showId];
}
async function loadEpisode(showId, episodeId) {
  const key = `${showId}/${episodeId}`;
  if (state.episodeData[key]) return state.episodeData[key];
  const res = await fetch(`data/${showId}/${episodeId}.json`);
  const data = res.ok ? await res.json() : null;
  state.episodeData[key] = data;
  return data;
}

// ---------------- Router ----------------
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

function parseHash() {
  const parts = (location.hash || '#/').slice(2).split('/').filter(Boolean);
  // parts: [show, showId, episodeId, blockId, cardIndex]
  return parts;
}

async function route() {
  const app = document.getElementById('app');
  const parts = parseHash();
  try {
    if (parts[0] === 'show' && parts[1] && parts[2] && parts[3] && parts[4] !== undefined) {
      await renderCard(app, parts[1], parts[2], parts[3], parseInt(parts[4], 10));
    } else if (parts[0] === 'show' && parts[1] && parts[2]) {
      await renderBlocks(app, parts[1], parts[2]);
    } else if (parts[0] === 'show' && parts[1]) {
      await renderEpisodes(app, parts[1]);
    } else {
      await renderLibrary(app);
    }
  } catch (err) {
    app.innerHTML = `<div class="empty-state">Something went wrong loading this screen.<br><small>${escapeHtml(err.message || String(err))}</small></div>`;
    console.error(err);
  }
}

function go(hash) { location.hash = hash; }

// ---------------- Views ----------------

function topbar({ left, title, right }) {
  return `<div class="topbar">${left || ''}${title ? `<div class="topbar-title">${escapeHtml(title)}</div>` : '<div style="flex:1"></div>'}${right || ''}</div>`;
}
const backBtn = (hash) => `<button class="icon-btn" onclick="go('${hash}')">&#8592;</button>`;
const closeBtn = (hash) => `<button class="icon-btn" onclick="go('${hash}')">&#10005;</button>`;

async function renderLibrary(app) {
  const shows = await loadShows();
  let cards = '';
  for (const show of shows) {
    const eps = await loadEpisodes(show.id);
    let done = 0, total = 0;
    for (const ep of eps) {
      const full = await loadEpisode(show.id, ep.id);
      if (!full) continue;
      const c = episodeDoneCount(show.id, ep.id, full.blocks);
      done += c.done; total += c.total;
    }
    const initials = show.title.slice(0, 1).toUpperCase();
    cards += `
      <button class="show-card" style="width:100%;text-align:left" onclick="go('#/show/${show.id}')">
        <div class="show-cover" style="background:${show.color || '#5B4FE9'}">${initials}</div>
        <div class="show-meta">
          <p class="show-name">${escapeHtml(show.title)}</p>
          <p class="show-sub">${eps.length} episode${eps.length === 1 ? '' : 's'}${total ? ` · ${done}/${total} phrases studied` : ''}</p>
        </div>
        <div class="chevron">&#8250;</div>
      </button>`;
  }
  app.innerHTML = `
    ${topbar({ title: 'Capisco' })}
    <div class="scroll-area">
      <div class="section-label">Your shows</div>
      ${cards || '<div class="empty-state">No shows yet. Ask Claude to add a podcast to get started.</div>'}
    </div>`;
}

async function renderEpisodes(app, showId) {
  const shows = await loadShows();
  const show = shows.find(s => s.id === showId);
  const eps = await loadEpisodes(showId);
  let rows = '';
  for (const [i, ep] of eps.entries()) {
    const full = await loadEpisode(showId, ep.id);
    const blocks = full ? full.blocks : [];
    const { done, total } = episodeDoneCount(showId, ep.id, blocks);
    const pct = total ? Math.round((done / total) * 100) : 0;
    rows += `
      <button class="episode-row" style="width:100%" onclick="go('#/show/${showId}/${ep.id}')">
        <div class="episode-index">${i + 1}</div>
        <div class="episode-meta">
          <p class="episode-title">${escapeHtml(ep.title)}</p>
          <div class="episode-progress-track"><div class="episode-progress-fill" style="width:${pct}%"></div></div>
          <p class="episode-sub">${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${done}/${total} studied</p>
        </div>
        <div class="chevron">&#8250;</div>
      </button>`;
  }
  app.innerHTML = `
    ${topbar({ left: backBtn('#/'), title: show ? show.title : 'Show' })}
    <div class="scroll-area">
      <div class="section-label">Episodes</div>
      ${rows || '<div class="empty-state">No episodes processed yet for this show.</div>'}
    </div>`;
}

async function renderBlocks(app, showId, episodeId) {
  const full = await loadEpisode(showId, episodeId);
  if (!full) { app.innerHTML = '<div class="empty-state">Episode not found.</div>'; return; }
  let tiles = '';
  full.blocks.forEach((b, i) => {
    const done = blockDoneCount(showId, episodeId, b);
    const total = b.cards.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const isDone = total > 0 && done === total;
    const startIdx = firstUnstudiedIndex(showId, episodeId, b);
    tiles += `
      <button class="block-tile" style="text-align:left" onclick="go('#/show/${showId}/${episodeId}/${b.id}/${startIdx}')">
        ${isDone ? '<div class="block-check">&#10003;</div>' : ''}
        <p class="block-tile-title">${escapeHtml(b.label || `Block ${i + 1}`)}</p>
        <p class="block-tile-sub">${total} phrase${total === 1 ? '' : 's'}</p>
        <div class="episode-progress-track"><div class="episode-progress-fill" style="width:${pct}%"></div></div>
      </button>`;
  });
  app.innerHTML = `
    ${topbar({ left: backBtn(`#/show/${showId}`), title: full.title })}
    <div class="scroll-area">
      <div class="section-label">5-minute blocks</div>
      <div class="block-grid">${tiles}</div>
      ${full.sourceUrl ? `<div class="section-label">Source</div><a class="source-link" href="${full.sourceUrl}" target="_blank" rel="noopener">${full.sourceUrl}</a>` : ''}
    </div>`;
}

let audioEl = null;

async function renderCard(app, showId, episodeId, blockId, cardIndex) {
  const full = await loadEpisode(showId, episodeId);
  if (!full) { app.innerHTML = '<div class="empty-state">Episode not found.</div>'; return; }
  const blockIdx = full.blocks.findIndex(b => b.id === blockId);
  const block = full.blocks[blockIdx];
  if (!block || !block.cards[cardIndex]) { app.innerHTML = '<div class="empty-state">Card not found.</div>'; return; }
  const card = block.cards[cardIndex];
  state.tab = state.tab || 'text';
  const done = isCardDone(showId, episodeId, block.id, card.id);

  const hasPrev = cardIndex > 0;
  const hasNextInBlock = cardIndex < block.cards.length - 1;
  const hasNextBlock = blockIdx < full.blocks.length - 1;

  let pickerHtml = '<div class="card-picker">';
  block.cards.forEach((c, i) => {
    const cDone = isCardDone(showId, episodeId, block.id, c.id);
    const isCurrent = i === cardIndex;
    pickerHtml += `<button class="card-dot ${cDone ? 'done' : ''} ${isCurrent ? 'current' : ''}" onclick="go('#/show/${showId}/${episodeId}/${block.id}/${i}')">${cDone && !isCurrent ? '&#10003;' : i + 1}</button>`;
  });
  pickerHtml += '</div>';

  let bodyHtml = '';
  if (state.tab === 'text') {
    bodyHtml = `<p class="italian-text">${escapeHtml(card.italian)}</p>`;
  } else if (state.tab === 'translation') {
    bodyHtml = `<p class="italian-text">${escapeHtml(card.italian)}</p><div class="translation-box">${escapeHtml(card.english)}</div>`;
  } else {
    bodyHtml = `<div class="audio-only-hint"><span class="big-icon">&#127911;</span>Just listen — no text.<br>Switch to "Text" if you get stuck.</div>`;
  }

  app.innerHTML = `
    ${topbar({
      left: closeBtn(`#/show/${showId}/${episodeId}`),
      title: '',
      right: `<div class="card-position">${cardIndex + 1} / ${block.cards.length}</div>`
    })}
    ${pickerHtml}
    <div class="scroll-area">
      <div class="card-body">${bodyHtml}</div>
      <button class="mark-done-row ${done ? 'checked' : ''}" id="markDoneBtn">
        <span class="dot">${done ? '&#10003;' : ''}</span>
        ${done ? 'Marked as studied' : 'Mark as studied'}
      </button>
      <div class="nav-arrows">
        <button class="nav-arrow-btn" id="prevBtn" ${hasPrev ? '' : 'disabled'}>&#8592; Previous</button>
        <button class="nav-arrow-btn" id="nextBtn" ${(hasNextInBlock || hasNextBlock) ? '' : 'disabled'}>Next &#8594;</button>
      </div>
    </div>
    <div class="player-panel">
      <div class="seek-row">
        <span class="time-label" id="curTime">0:00</span>
        <input type="range" class="seek-bar" id="seekBar" min="0" max="100" value="0">
        <span class="time-label" id="remTime">-0:00</span>
      </div>
      <div class="controls-row">
        <button class="control-btn secondary" id="speedBtn">${state.speed}x<div style="font-size:11px;font-weight:500">Speed</div></button>
        <button class="play-btn" id="playBtn">&#9658;</button>
        <button class="control-btn secondary" id="loopBtn">&#8635;<div style="font-size:11px;font-weight:500">Loop</div></button>
      </div>
      <div class="tab-bar">
        <button class="tab-btn ${state.tab === 'text' ? 'active' : ''}" data-tab="text">Text</button>
        <button class="tab-btn ${state.tab === 'translation' ? 'active' : ''}" data-tab="translation">Translation</button>
        <button class="tab-btn ${state.tab === 'audio' ? 'active' : ''}" data-tab="audio">Audio</button>
      </div>
    </div>`;

  // ---- wire up audio ----
  if (!audioEl) { audioEl = new Audio(); audioEl.preload = 'metadata'; }
  const src = card.audio;
  if (audioEl.dataset.src !== src) {
    audioEl.pause();
    audioEl.src = src;
    audioEl.dataset.src = src;
    audioEl.currentTime = 0;
  }
  audioEl.playbackRate = state.speed;
  audioEl.loop = !!state.loop;

  const playBtn = document.getElementById('playBtn');
  const seekBar = document.getElementById('seekBar');
  const curTime = document.getElementById('curTime');
  const remTime = document.getElementById('remTime');
  const speedBtn = document.getElementById('speedBtn');
  const loopBtn = document.getElementById('loopBtn');

  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function refreshTimes() {
    const dur = audioEl.duration || (card.end - card.start) || 0;
    seekBar.max = Math.max(dur, 0.1);
    seekBar.value = audioEl.currentTime;
    curTime.textContent = fmt(audioEl.currentTime);
    remTime.textContent = `-${fmt(dur - audioEl.currentTime)}`;
  }
  audioEl.ontimeupdate = refreshTimes;
  audioEl.onloadedmetadata = refreshTimes;
  audioEl.onplay = () => { playBtn.innerHTML = '&#10073;&#10073;'; };
  audioEl.onpause = () => { playBtn.innerHTML = '&#9658;'; };
  audioEl.onended = () => {
    playBtn.innerHTML = '&#9658;';
    if (!done) { setCardDone(showId, episodeId, block.id, card.id, true); route(); }
  };
  refreshTimes();
  loopBtn.style.color = audioEl.loop ? 'var(--purple)' : 'var(--text-gray)';

  playBtn.onclick = () => { audioEl.paused ? audioEl.play() : audioEl.pause(); };
  seekBar.oninput = () => { audioEl.currentTime = parseFloat(seekBar.value); };
  speedBtn.onclick = () => {
    const idx = SPEEDS.indexOf(state.speed);
    state.speed = SPEEDS[(idx + 1) % SPEEDS.length];
    audioEl.playbackRate = state.speed;
    speedBtn.innerHTML = `${state.speed}x<div style="font-size:11px;font-weight:500">Speed</div>`;
  };
  loopBtn.onclick = () => {
    state.loop = !state.loop;
    audioEl.loop = state.loop;
    loopBtn.style.color = state.loop ? 'var(--purple)' : 'var(--text-gray)';
  };

  document.getElementById('markDoneBtn').onclick = () => {
    setCardDone(showId, episodeId, block.id, card.id, !done);
    route();
  };
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => { state.tab = btn.dataset.tab; route(); };
  });
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  if (hasPrev) prevBtn.onclick = () => go(`#/show/${showId}/${episodeId}/${block.id}/${cardIndex - 1}`);
  if (hasNextInBlock) {
    nextBtn.onclick = () => go(`#/show/${showId}/${episodeId}/${block.id}/${cardIndex + 1}`);
  } else if (hasNextBlock) {
    const nextBlock = full.blocks[blockIdx + 1];
    nextBtn.onclick = () => go(`#/show/${showId}/${episodeId}/${nextBlock.id}/0`);
  }
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// expose for inline onclick handlers
window.go = go;

// ---------------- Service worker registration ----------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
