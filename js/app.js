/* Capisco — Italian listening comprehension app
   Single-file SPA. Hash-based routing. Data loaded from /data/*.json. */

const state = {
  shows: null,
  episodesByShow: {},   // showId -> [episode summaries]
  episodeData: {},      // "showId/episodeId" -> full episode object (blocks/cards)
  progress: loadProgress(),
  edits: loadEdits(),    // local corrections to transcriptions/translations, overlaid on shipped data
  editingField: null,    // 'italian' | 'english' | null — which field is being edited right now, on the current card
  editingCardKey: null,  // which card the above applies to (editing auto-cancels if you navigate away)
  tab: 'audio',           // current card tab: text | translation | audio
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

// ---------------- Local corrections (transcription/translation fixes) ----------------
// Whisper transcriptions and machine translations aren't always perfect. Rather than
// require a full re-deploy for every fix, cards can be corrected right on the device;
// corrections are stored locally and overlaid on top of the shipped data. Use the
// "My Corrections" screen (pencil icon on the library) to review/copy them and send
// them back to Claude so they can be folded into the real data files permanently.
function loadEdits() {
  try {
    return JSON.parse(localStorage.getItem('capisco:edits') || '{}');
  } catch (e) { return {}; }
}
function saveEdits() {
  localStorage.setItem('capisco:edits', JSON.stringify(state.edits));
}
function getEdit(showId, episodeId, blockId, cardId) {
  return state.edits[cardKey(showId, episodeId, blockId, cardId)] || null;
}
// setEditField/revertEditField re-read localStorage immediately before writing, rather
// than trusting the in-memory `state.edits` snapshot. That snapshot can go stale — e.g.
// the app open in two tabs/devices at once, or backgrounded and resumed — and writing
// through a stale copy would silently wipe out edits saved elsewhere in the meantime.
// Re-reading right before the merge makes every save atomic against what's really on disk.
function setEditField(showId, episodeId, blockId, cardId, field, value) {
  const k = cardKey(showId, episodeId, blockId, cardId);
  const current = loadEdits();
  current[k] = { ...(current[k] || {}), [field]: value };
  state.edits = current;
  saveEdits();
}
function revertEditField(showId, episodeId, blockId, cardId, field) {
  const k = cardKey(showId, episodeId, blockId, cardId);
  state.edits = loadEdits();
  if (!state.edits[k]) return;
  delete state.edits[k][field];
  if (Object.keys(state.edits[k]).length === 0) delete state.edits[k];
  saveEdits();
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
// Refresh from localStorage whenever this tab/instance comes back into view — catches
// edits or progress saved from another tab or device while this one was in the background.
// Skipped mid-edit so an in-progress, unsaved correction never gets wiped out by this.
function refreshIfIdle() { if (!state.editingField) route(); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshIfIdle(); });
window.addEventListener('pageshow', refreshIfIdle);

function parseHash() {
  const parts = (location.hash || '#/').slice(2).split('/').filter(Boolean);
  // parts: [show, showId, episodeId, blockId, cardIndex]
  return parts;
}

async function route() {
  const app = document.getElementById('app');
  const parts = parseHash();
  // Always render from the freshest data on disk, not a snapshot from whenever this
  // tab/instance first loaded — see the note above setEditField/revertEditField.
  state.progress = loadProgress();
  state.edits = loadEdits();
  try {
    if (parts[0] === 'edits') {
      await renderEditsReview(app);
    } else if (parts[0] === 'show' && parts[1] && parts[2] && parts[3] && parts[4] !== undefined) {
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
  const editsCount = Object.keys(state.edits).length;
  app.innerHTML = `
    ${topbar({
      title: 'Capisco',
      right: `<button class="icon-btn" onclick="go('#/edits')">&#9998;${editsCount ? `<span class="edit-badge">${editsCount}</span>` : ''}</button>`
    })}
    <div class="scroll-area">
      <div class="section-label">Your shows</div>
      ${cards || '<div class="empty-state">No shows yet. Ask Claude to add a podcast to get started.</div>'}
    </div>`;
}

async function renderEditsReview(app) {
  const keys = Object.keys(state.edits);
  let rows = '';
  for (const k of keys) {
    const [showId, episodeId, blockId, cardId] = k.split('/');
    const edit = state.edits[k];
    const full = await loadEpisode(showId, episodeId);
    const block = full ? full.blocks.find(b => b.id === blockId) : null;
    const idx = block ? block.cards.findIndex(c => c.id === cardId) : 0;
    rows += `
      <div class="edit-review-row">
        <p class="edit-review-key">${escapeHtml(showId)} · ${escapeHtml(episodeId)} · ${escapeHtml(blockId)} · ${escapeHtml(cardId)}</p>
        ${edit.italian != null ? `<p class="edit-review-field"><b>IT:</b> ${escapeHtml(edit.italian)}</p>` : ''}
        ${edit.english != null ? `<p class="edit-review-field"><b>EN:</b> ${escapeHtml(edit.english)}</p>` : ''}
        <button class="edit-review-open" onclick="go('#/show/${showId}/${episodeId}/${blockId}/${idx}')">Open card &#8250;</button>
      </div>`;
  }
  app.innerHTML = `
    ${topbar({ left: backBtn('#/'), title: 'My Corrections' })}
    <div class="scroll-area">
      ${keys.length ? `
        <p class="edits-intro">${keys.length} correction${keys.length === 1 ? '' : 's'} saved on this device only. Tap "Copy all as JSON" and send it to Claude to bake these into the app permanently (local corrections don't survive a Safari data clear).</p>
        <button class="pill-btn" id="copyEditsBtn" style="margin-bottom:16px">Copy all as JSON</button>
        ${rows}
      ` : '<div class="empty-state">No corrections yet. On any card, tap the pencil next to the Italian text or the translation to fix it.</div>'}
    </div>`;
  const copyBtn = document.getElementById('copyEditsBtn');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const json = JSON.stringify(state.edits, null, 2);
      try {
        await navigator.clipboard.writeText(json);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy all as JSON'; }, 1500);
      } catch (e) {
        window.prompt('Copy this text:', json);
      }
    };
  }
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
  state.tab = state.tab || 'audio';
  const done = isCardDone(showId, episodeId, block.id, card.id);

  const ck = cardKey(showId, episodeId, block.id, card.id);
  if (state.editingCardKey !== ck) { state.editingField = null; state.editingCardKey = ck; }
  const edit = getEdit(showId, episodeId, block.id, card.id) || {};
  const italianText = edit.italian != null ? edit.italian : card.italian;
  const englishText = edit.english != null ? edit.english : card.english;

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

  function fieldBlock(field, text, hasFieldEdit) {
    if (state.editingField === field) {
      return `
        <div class="edit-block">
          <textarea id="editTextarea" class="edit-textarea" rows="${field === 'italian' ? 6 : 5}">${escapeHtml(text)}</textarea>
          <div class="edit-actions">
            <button class="edit-btn save" id="saveEditBtn">Save</button>
            <button class="edit-btn cancel" id="cancelEditBtn">Cancel</button>
            ${hasFieldEdit ? '<button class="edit-btn revert" id="revertEditBtn">Revert to original</button>' : ''}
          </div>
        </div>`;
    }
    const isItalian = field === 'italian';
    return `
      <div class="text-row">
        <${isItalian ? 'p' : 'div'} class="${isItalian ? 'italian-text' : 'translation-box'}">${escapeHtml(text)}</${isItalian ? 'p' : 'div'}>
        <button class="edit-link" data-field="${field}">&#9998;${hasFieldEdit ? ' Edited' : ''}</button>
      </div>`;
  }

  let bodyHtml = '';
  if (state.tab === 'text') {
    bodyHtml = fieldBlock('italian', italianText, edit.italian != null);
  } else if (state.tab === 'translation') {
    bodyHtml = fieldBlock('italian', italianText, edit.italian != null) + fieldBlock('english', englishText, edit.english != null);
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
  document.querySelectorAll('.edit-link').forEach(btn => {
    btn.onclick = () => { state.editingField = btn.dataset.field; route(); };
  });
  const saveEditBtn = document.getElementById('saveEditBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const revertEditBtn = document.getElementById('revertEditBtn');
  if (saveEditBtn) {
    saveEditBtn.onclick = () => {
      const val = document.getElementById('editTextarea').value.trim();
      setEditField(showId, episodeId, block.id, card.id, state.editingField, val);
      state.editingField = null;
      route();
    };
  }
  if (cancelEditBtn) {
    cancelEditBtn.onclick = () => { state.editingField = null; route(); };
  }
  if (revertEditBtn) {
    revertEditBtn.onclick = () => {
      revertEditField(showId, episodeId, block.id, card.id, state.editingField);
      state.editingField = null;
      route();
    };
  }
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
