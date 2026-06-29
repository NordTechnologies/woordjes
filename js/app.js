/* Woordjes v0 — UI controller. Wires engine.js to the screens in the Design Spec. */
(function () {
  'use strict';
  const BUILD = '2026-06-18.3';   // visible in Settings + console; bump on each deploy
  try { console.log('Woordjes build', BUILD); } catch (e) {}
  const W = window.WJ;
  const $app = document.getElementById('app');
  const $nav = document.getElementById('bottomnav');
  const $live = document.getElementById('live');

  const S = { words: [], byId: {}, topics: [], topicById: {}, cards: {}, user: null, today: null, session: null };

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function announce(msg) { $live.textContent = msg; }
  function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }
  let _voices = [];
  function dutchVoice() {
    if ((!_voices || !_voices.length) && 'speechSynthesis' in window) _voices = speechSynthesis.getVoices();
    return (_voices || []).find(v => /^nl/i.test(v.lang)) || null;
  }
  function speak(text) {
    if (!('speechSynthesis' in window) || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'nl-NL'; u.rate = 0.92;
      const v = dutchVoice(); if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  function speakBtn(text) { return `<button class="speak" type="button" data-speak="${esc(text)}" aria-label="Listen to pronunciation">🔊</button>`; }
  function save() { W.Store.saveCards(S.cards); W.Store.saveUser(S.user); idbBackup(); }
  function ensureCard(id) { if (!S.cards[id]) S.cards[id] = W.newCard(id, S.today); return S.cards[id]; }
  function markKnown(id) { // user already knows this word -> straight to the Learned list
    const c = ensureCard(id);
    c.box = W.C.MAX_BOX; c.learned = true;
    c.distinctCorrectDays = W.C.LEARNED_MIN_DAYS; c.lastCorrectDay = S.today;
    c.consecutiveCorrect = W.C.LEARNED_MIN_DAYS; c.lastResult = 'CORRECT'; c.lastReviewed = S.today;
    c.nextDue = W.addDays(S.today, W.C.INTERVALS_DAYS[W.C.MAX_BOX]);
    save();
  }
  function addToPriority(id) { // queue a searched word to be introduced next
    if (S.cards[id]) return false; // already started/learned
    S.user.priorityQueue = S.user.priorityQueue || [];
    if (S.user.priorityQueue.includes(id)) return false;
    S.user.priorityQueue.push(id); save(); return true;
  }

  // ---- durable storage: iOS standalone PWAs can wipe localStorage between launches,
  //      so we mirror progress into IndexedDB and rehydrate from it on startup ----
  function idbOpen() {
    return new Promise((res, rej) => {
      try { const r = indexedDB.open('woordjes', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  }
  function idbGet(key) {
    return idbOpen().then(db => new Promise(res => {
      try { const q = db.transaction('kv', 'readonly').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }
      catch (e) { res(null); }
    })).catch(() => null);
  }
  function idbSet(key, val) {
    return idbOpen().then(db => new Promise(res => {
      try { const q = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key); q.onsuccess = () => res(true); q.onerror = () => res(false); }
      catch (e) { res(false); }
    })).catch(() => {});
  }
  function idbBackup() { idbSet('cards', S.cards); idbSet('user', S.user); }
  async function hydrateFromIDB() {
    try {
      if (!localStorage.getItem('wj.user.v0')) { const u = await idbGet('user'); if (u) localStorage.setItem('wj.user.v0', JSON.stringify(u)); }
      if (!localStorage.getItem('wj.cards.v0')) { const c = await idbGet('cards'); if (c) localStorage.setItem('wj.cards.v0', JSON.stringify(c)); }
    } catch (e) {}
  }
  function requestPersist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} }

  // ---------- bootstrap ----------
  async function init() {
    S.today = W.todayStr();
    requestPersist();
    await hydrateFromIDB();                 // restore progress if localStorage was evicted
    S.cards = W.Store.loadCards();
    S.user = W.Store.loadUser();
    const res = await fetch('./data/words.json', { cache: 'no-store' });
    const data = await res.json();
    S.words = data.words;
    S.topics = data.topics;
    S.words.forEach(w => { S.byId[w.id] = w; });
    S.topics.forEach(t => { S.topicById[t.id] = t; });

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      // auto-update: when a new service worker takes control, reload once to load fresh code
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) { refreshing = true; location.reload(); }
      });
      navigator.serviceWorker.register('./sw.js').then(reg => { try { reg.update(); } catch (e) {} }).catch(() => {});
    }
    $nav.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));

    // delegated audio: any element with data-speak pronounces its Dutch text on tap
    $app.addEventListener('click', e => {
      const b = e.target.closest('[data-speak]');
      if (b) { e.stopPropagation(); speak(b.getAttribute('data-speak')); }
    });
    if ('speechSynthesis' in window) {
      try { _voices = speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => { _voices = speechSynthesis.getVoices(); }; } catch (e) {}
    }

    if (!S.user.onboarded) { renderWelcome(); }   // first open: find the learner's level
    else { go('today'); }
  }

  function go(view) {
    S.session = null;
    $app.classList.remove('training');
    $nav.hidden = false;
    $nav.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
    if (view === 'today') renderToday();
    else if (view === 'topics') renderTopics();
    else if (view === 'learned') renderLearned();
    window.scrollTo(0, 0);
  }

  // ---------- topic progress helpers ----------
  function topicWords(tid) { return S.words.filter(w => w.topic === tid); }
  function topicLearned(tid) { return topicWords(tid).filter(w => S.cards[w.id] && S.cards[w.id].learned).length; }
  function topicStarted(tid) { return topicWords(tid).filter(w => S.cards[w.id]).length; }

  // ---------- TODAY ----------
  function renderToday() {
    const due = W.dueCount(S.words, S.cards, S.today);
    const shown = Math.min(due, W.C.SESSION_SIZE);
    const hasNew = S.words.some(w => !S.cards[w.id]);
    const greet = greeting();
    let heroInner;
    if (shown > 0) {
      heroInner = `<div class="big-num">${shown}</div><div class="sub">word${shown === 1 ? '' : 's'} due today · ~5 min</div>
        <button class="btn btn-on-hero" id="startBtn">Start ▸</button>`;
    } else if (hasNew) {
      heroInner = `<div class="big-num">0</div><div class="sub">All caught up 🎉 Learn some new words?</div>
        <button class="btn btn-on-hero" id="startBtn">Learn new words ▸</button>`;
    } else {
      heroInner = `<div class="big-num">🎉</div><div class="sub">You're all caught up. Come back tomorrow!</div>
        <button class="btn btn-on-hero" id="startBtn">Practice anyway</button>`;
    }

    const topicRows = S.topics.map(t => {
      const tw = topicWords(t.id), learned = topicLearned(t.id), pct = Math.round(100 * learned / tw.length);
      return `<button class="row" data-topic="${t.id}">
        <span class="emoji">${t.emoji}</span>
        <span class="row-main"><span class="row-title">${esc(t.name)}</span>
          <span class="row-meta">${learned}/${tw.length} learned</span>
          <span class="bar"><span style="width:${pct}%"></span></span>
        </span><span class="chev">›</span></button>`;
    }).join('');

    $app.innerHTML = `
      <div class="topbar">
        <div class="greeting">${greet} 👋</div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="level-pill">${S.user.level || 'A1'}</span>
          <button class="streak-pill" id="settingsBtn" aria-label="Streak and settings">🔥 ${S.user.currentStreak}</button>
        </div>
      </div>
      <h1 class="title">Today</h1>
      <div class="hero">${heroInner}</div>
      <h2 class="section">Your topics</h2>
      <div class="list">${topicRows}</div>`;

    const forceMode = shown === 0; // when nothing is due, the button means "learn new / practice"
    document.getElementById('startBtn').addEventListener('click', () => startSession({ force: forceMode }));
    document.getElementById('settingsBtn').addEventListener('click', renderSettings);
    $app.querySelectorAll('[data-topic]').forEach(b => b.addEventListener('click', () => renderTopicDetail(b.dataset.topic)));
  }
  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Goedemorgen'; if (h < 18) return 'Goedemiddag'; return 'Goedenavond';
  }

  // ---------- TOPICS ----------
  function renderTopics() {
    const rows = S.topics.map(t => {
      const tw = topicWords(t.id), learned = topicLearned(t.id), started = topicStarted(t.id), pct = Math.round(100 * learned / tw.length);
      const chip = started === 0 ? `<span class="chip-new">New</span>` : '';
      return `<button class="row" data-topic="${t.id}">
        <span class="emoji">${t.emoji}</span>
        <span class="row-main"><span class="row-title">${esc(t.name)} ${chip}</span>
          <span class="row-meta">${learned}/${tw.length} learned · ${pct}%</span>
          <span class="bar success"><span style="width:${pct}%"></span></span>
        </span><span class="chev">›</span></button>`;
    }).join('');
    $app.innerHTML = `<h1 class="title">Topics</h1>
      <input id="search" class="search-input" type="search" placeholder="Search a word to learn next…" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <div id="searchResults"></div>
      <div class="list">${rows}</div>`;
    $app.querySelectorAll('[data-topic]').forEach(b => b.addEventListener('click', () => renderTopicDetail(b.dataset.topic)));
    const si = document.getElementById('search');
    si.addEventListener('input', () => renderSearchResults(si.value.trim()));
  }

  function renderSearchResults(q) {
    const box = document.getElementById('searchResults');
    if (!box) return;
    if (q.length < 2) { box.innerHTML = ''; return; }
    const ql = q.toLowerCase();
    const hits = S.words.filter(w => w.nl.toLowerCase().includes(ql) || w.en.toLowerCase().includes(ql)).slice(0, 12);
    if (!hits.length) { box.innerHTML = `<p class="muted" style="padding:8px 4px">No words found.</p>`; return; }
    box.innerHTML = `<div class="list" style="margin:8px 0 16px">` + hits.map(w => {
      const c = S.cards[w.id];
      const queued = (S.user.priorityQueue || []).includes(w.id);
      const disp = (w.type === 'noun' && w.article) ? w.article + ' ' + w.nl : w.nl;
      let action;
      if (c && c.learned) action = `<span class="muted" style="font-size:.8rem">🏆 learned</span>`;
      else if (c) action = `<span class="muted" style="font-size:.8rem">in progress</span>`;
      else if (queued) action = `<span class="chip-new">added ✓</span>`;
      else action = `<button class="btn btn-secondary addw" data-id="${w.id}" style="width:auto;min-height:36px;padding:6px 14px">+ Learn</button>`;
      return `<div class="row" style="cursor:default"><span class="row-main"><span class="row-title" lang="nl">${esc(disp)}</span>
        <span class="row-meta"><span lang="en">${esc(w.en)}</span> · ${w.level}</span></span>${action}</div>`;
    }).join('') + `</div>`;
    box.querySelectorAll('.addw').forEach(b => b.addEventListener('click', () => {
      if (addToPriority(+b.dataset.id)) { announce('Added to your next lesson'); renderSearchResults(q); }
    }));
  }

  function renderTopicDetail(tid) {
    const t = S.topicById[tid], tw = topicWords(tid);
    const rows = tw.map(w => {
      const c = S.cards[w.id];
      const status = c && c.learned ? '🏆' : (c ? '•' : '');
      const sub = w.type === 'noun' ? `${w.article} ${w.nl}` : w.nl;
      return `<button class="row" data-word="${w.id}">
        <span class="row-main"><span class="row-title">${esc(sub)}</span>
          <span class="row-meta">${esc(w.en)}</span></span>
        <span class="chev">${status}</span></button>`;
    }).join('');
    $app.innerHTML = `
      <div class="topbar"><button class="btn-ghost" id="back">‹ Topics</button><span></span></div>
      <h1 class="title">${t.emoji} ${esc(t.name)}</h1>
      <button class="btn btn-primary" id="trainTopic">Train this topic</button>
      <h2 class="section">All words (${tw.length})</h2>
      <div class="list">${rows}</div>`;
    document.getElementById('back').addEventListener('click', () => go('topics'));
    document.getElementById('trainTopic').addEventListener('click', () => startSession({ topic: tid }));
    $app.querySelectorAll('[data-word]').forEach(b => b.addEventListener('click', () => renderBrowseCard(+b.dataset.word, tid)));
  }

  // ---------- BROWSE word card ----------
  function renderBrowseCard(id, tid) {
    const w = S.byId[id];
    $app.innerHTML = `
      <div class="topbar"><button class="btn-ghost" id="back">‹ Back</button><span></span></div>
      <div class="card wordcard">${wordCardInner(w)}</div>`;
    document.getElementById('back').addEventListener('click', () => renderTopicDetail(tid));
  }
  function wordCardInner(w) {
    if (w.type === 'verb') {
      return `<span class="badge verb">verb</span>
        <div class="nl-row"><div class="nl" lang="nl">${esc(w.nl)}</div>${speakBtn(w.nl)}</div>
        <div class="verbforms">
          <div class="vf"><span class="lbl">infinitive</span><span lang="nl">${esc(w.nl)}</span></div>
          <div class="vf"><span class="lbl">past</span><span lang="nl">${esc(w.pastSimple)}</span></div>
          <div class="vf"><span class="lbl">perfect</span><span lang="nl">${esc(w.perfect)}</span></div>
        </div>
        <div class="en" lang="en">${esc(w.en)}</div>`;
    }
    if (w.type === 'noun') {
      const cls = w.article === 'het' ? 'het' : 'de';
      const pl = (w.plural && w.plural !== '—') ? `<div class="plural">pl. ${esc(w.plural)}</div>` : '';
      const say = (w.article ? w.article + ' ' : '') + w.nl;
      return `<span class="badge ${cls}">${esc(w.article)}</span>
        <div class="nl-row"><div class="nl" lang="nl">${esc(w.nl)}</div>${speakBtn(say)}</div>${pl}
        <div class="en" lang="en">${esc(w.en)}</div>`;
    }
    return `<div class="nl-row"><div class="nl" lang="nl">${esc(w.nl)}</div>${speakBtn(w.nl)}</div>
      <div class="en" lang="en">${esc(w.en)}</div>`;
  }

  // ---------- SETTINGS ----------
  function renderSettings() {
    $app.innerHTML = `
      <div class="topbar"><button class="btn-ghost" id="back">‹ Today</button><span></span></div>
      <h1 class="title">You</h1>
      <div class="card">
        <div class="srow" style="display:flex;justify-content:space-between;padding:6px 0">
          <span>🔥 Current streak</span><strong>${S.user.currentStreak} day${S.user.currentStreak === 1 ? '' : 's'}</strong></div>
        <div class="srow" style="display:flex;justify-content:space-between;padding:6px 0">
          <span>Longest streak</span><strong>${S.user.longestStreak}</strong></div>
        <div class="srow" style="display:flex;justify-content:space-between;padding:6px 0">
          <span>Streak freeze</span><strong>${S.user.freezeAvailable ? 'Ready ❄️' : 'Earning…'}</strong></div>
      </div>
      <h2 class="section">Settings</h2>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <span>Your level<br><span class="muted" style="font-size:.8rem">New words come from here and up</span></span>
          <button class="btn btn-secondary" id="changeLevel" style="width:auto;padding:8px 16px;min-height:40px">${S.user.level || 'A1'} ›</button>
        </div>
        <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;border-top:1px solid var(--c-border);padding-top:14px">
          <span>Hard mode (typing)<br><span class="muted" style="font-size:.8rem">Type the Dutch word once you know it well</span></span>
          <input type="checkbox" id="hardmode" ${S.user.hardModeEnabled ? 'checked' : ''} style="transform:scale(1.4)">
        </label>
        <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;border-top:1px solid var(--c-border);padding-top:14px;margin-top:14px">
          <span>Daily reminder<br><span class="muted" style="font-size:.8rem">One gentle nudge (delivered in the installed app)</span></span>
          <input type="checkbox" id="reminder" ${S.user.reminderOn ? 'checked' : ''} style="transform:scale(1.4)">
        </label>
        <div id="reminderTimeRow" style="display:${S.user.reminderOn ? 'flex' : 'none'};justify-content:space-between;align-items:center;margin-top:10px">
          <span class="muted" style="font-size:.85rem">Reminder time</span>
          <input type="time" id="reminderTime" value="${S.user.reminderTime || '19:00'}" style="font-size:1rem;padding:6px 8px;border:1px solid var(--c-border);border-radius:8px;background:var(--c-surface);color:var(--t-1)">
        </div>
      </div>
      <h2 class="section">Reset</h2>
      <button class="btn btn-secondary" id="reset">Reset all progress</button>
      <p class="muted" style="font-size:.8rem;margin-top:16px">Woordjes v0 prototype · build ${BUILD}<br>words pending native-speaker proofread</p>`;
    document.getElementById('back').addEventListener('click', () => go('today'));
    document.getElementById('changeLevel').addEventListener('click', () => renderLevelPick(true));
    document.getElementById('hardmode').addEventListener('change', e => { S.user.hardModeEnabled = e.target.checked; save(); });
    const rem = document.getElementById('reminder');
    rem.addEventListener('change', async e => {
      if (e.target.checked) { // request permission IN CONTEXT (never on first launch)
        let granted = true;
        if ('Notification' in window) {
          try { granted = Notification.permission === 'granted' ? true : (await Notification.requestPermission()) === 'granted'; }
          catch (_) { granted = false; }
        }
        S.user.reminderOn = granted; e.target.checked = granted;
        document.getElementById('reminderTimeRow').style.display = granted ? 'flex' : 'none';
      } else {
        S.user.reminderOn = false;
        document.getElementById('reminderTimeRow').style.display = 'none';
      }
      save();
    });
    document.getElementById('reminderTime').addEventListener('change', e => { S.user.reminderTime = e.target.value; save(); });
    document.getElementById('reset').addEventListener('click', () => {
      if (confirm('Reset all progress? This cannot be undone.')) { W.Store.reset(); S.cards = {}; S.user = W.Store.loadUser(); go('today'); }
    });
  }

  // ---------- ONBOARDING / LEVEL ----------
  const LEVEL_DESC = {
    A1: 'Beginner — just starting out',
    A2: 'Elementary — basic everyday Dutch',
    B1: 'Intermediate — everyday conversations',
    B2: 'Upper-intermediate — more complex topics'
  };
  function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  function renderWelcome() {
    $nav.hidden = true; $app.classList.remove('training');
    $app.innerHTML = `
      <div class="welcome">
        <div class="welcome-emoji">🇳🇱</div>
        <h1 class="title">Welkom bij Woordjes</h1>
        <p class="secondary-text">Learn the Dutch words you need — 5 minutes a day, no typing required.</p>
        <p class="muted" style="margin-top:8px">Let's find your level so you start in the right place, not from scratch.</p>
        <button class="btn btn-primary" id="takeTest" style="margin-top:28px">Take a 1-minute level check</button>
        <button class="btn btn-secondary" id="pickLevel" style="margin-top:12px">I'll choose my level</button>
      </div>`;
    document.getElementById('takeTest').addEventListener('click', startPlacement);
    document.getElementById('pickLevel').addEventListener('click', () => renderLevelPick(false));
  }

  function renderLevelPick(fromSettings) {
    $nav.hidden = true; $app.classList.remove('training');
    const rows = W.LEVELS.map(l => `<button class="row level-row" data-level="${l}">
        <span class="level-badge">${l}</span>
        <span class="row-main"><span class="row-title">${l}</span><span class="row-meta">${LEVEL_DESC[l]}</span></span>
        <span class="chev">›</span></button>`).join('');
    $app.innerHTML = `
      <div class="topbar">${fromSettings ? `<button class="btn-ghost" id="back">‹ Back</button>` : '<span></span>'}<span></span></div>
      <h1 class="title">Choose your level</h1>
      <p class="muted">You can change this anytime in settings.</p>
      <div class="list" style="margin-top:12px">${rows}</div>`;
    if (fromSettings) document.getElementById('back').addEventListener('click', renderSettings);
    $app.querySelectorAll('[data-level]').forEach(b => b.addEventListener('click', () => setLevel(b.dataset.level, fromSettings)));
  }
  function setLevel(level, fromSettings) {
    S.user.level = level; S.user.onboarded = true; save();
    if (fromSettings) go('today'); else renderLevelResult(level, false);
  }

  // Adaptive staircase level check with a confirmation probe (see engine.js placementNext).
  // Climb level-by-level; a failed level isn't final until a 3-word probe of the level
  // above also fails. Fresh words every run, never repeated within a run.
  function startPlacement() {
    $nav.hidden = true; $app.classList.add('training');
    S.placement = { levelIdx: 0, mode: 'eval', batchWords: [], batchCorrect: 0,
                    idxInBatch: 0, fallbackLevel: null, usedIds: new Set() };
    startBatch(0, 'eval');
  }
  function pickPlacementWords(level, count) {
    const p = S.placement;
    const pool = shuffleArr(S.words.filter(w => w.level === level && !p.usedIds.has(w.id) && !W.isGuessableCognate(w.nl, w.en)));
    const picked = pool.slice(0, Math.min(count, pool.length));
    picked.forEach(w => p.usedIds.add(w.id));
    return picked;
  }
  function startBatch(levelIdx, mode) {
    const p = S.placement;
    p.levelIdx = levelIdx; p.mode = mode; p.batchCorrect = 0; p.idxInBatch = 0;
    const count = mode === 'probe' ? W.C.PLACEMENT_PROBE : W.C.PLACEMENT_N;
    p.batchWords = pickPlacementWords(W.LEVELS[levelIdx], count);
    renderPlacementStep();
  }
  function placementSteps() {
    const p = S.placement;
    return W.LEVELS.map((l, i) => {
      let cls = '';
      if (i < p.levelIdx) cls = 'done';                       // climbed past
      else if (i === p.levelIdx) cls = p.mode === 'probe' ? 'probing' : 'current';
      const tick = cls === 'done' ? ' ✓' : '';
      return `<span class="lvl-step ${cls}">${l}${tick}</span>`;
    }).join('');
  }
  function renderPlacementStep() {
    const p = S.placement;
    const word = p.batchWords[p.idxInBatch];
    const mc = W.generateMC(word, S.words, 'NL_EN');
    const progress = Math.round(100 * p.idxInBatch / p.batchWords.length);
    const label = p.mode === 'probe' ? `Quick check · ${W.LEVELS[p.levelIdx]}` : `Level ${W.LEVELS[p.levelIdx]}`;
    const opts = mc.options.map((o, i) => `<button class="opt" data-i="${i}" lang="en">${esc(o.text)}</button>`).join('');
    $app.innerHTML = `
      <div class="lvl-steps">${placementSteps()}</div>
      <div class="train-top"><span class="count">${label}</span><span class="bar"><span style="width:${progress}%"></span></span><span class="count">${p.idxInBatch + 1}/${p.batchWords.length}</span></div>
      <div class="prompt"><div class="ask">What does this mean?</div><div class="word" lang="nl">${esc(word.nl)}${speakBtn(word.nl)}</div></div>
      <div class="options">${opts}</div>
      <button class="btn btn-ghost" id="dunno" style="margin-top:16px">I don't know this one</button>`;
    const advance = (right) => {
      if (right) p.batchCorrect++;
      p.idxInBatch++;
      if (p.idxInBatch < p.batchWords.length) { setTimeout(renderPlacementStep, 350); return; }
      const next = W.placementNext(p.levelIdx, p.mode, p.batchCorrect, p.fallbackLevel);
      if (next.action === 'finish') { setTimeout(() => finishPlacement(next.level), 350); return; }
      if (next.fallbackLevel) p.fallbackLevel = next.fallbackLevel;
      setTimeout(() => startBatch(next.levelIdx, next.mode), 350);
    };
    $app.querySelectorAll('.opt').forEach(btn => btn.addEventListener('click', () => {
      const o = mc.options[+btn.dataset.i]; $app.querySelectorAll('.opt').forEach(x => x.classList.add('locked'));
      const ci = mc.options.findIndex(x => x.correct);
      if (o.correct) { btn.classList.add('correct'); } else { btn.classList.add('wrong'); $app.querySelectorAll('.opt')[ci].classList.add('correct'); }
      advance(o.correct);
    }));
    document.getElementById('dunno').addEventListener('click', () => advance(false));
  }
  function finishPlacement(level) {
    S.user.level = level; S.user.onboarded = true; save();
    renderLevelResult(level, true);
  }
  function renderLevelResult(level, fromTest) {
    $nav.hidden = true; $app.classList.remove('training');
    $app.innerHTML = `
      <div class="complete">
        <div class="emoji celebrate">🎯</div>
        <h1>You're starting at ${level}</h1>
        <p class="secondary-text">${fromTest ? 'Based on your quick check. ' : ''}We'll suggest new words from <strong>${level}</strong> and up — change it anytime in settings.</p>
        <button class="btn btn-primary" id="go" style="margin-top:22px">Start learning ▸</button>
      </div>`;
    document.getElementById('go').addEventListener('click', () => startSession());
  }

  // ---------- TRAINING SESSION ----------
  function startSession(opts) {
    opts = opts || {};
    const topicFilter = opts.topic || null;
    let queue;
    if (topicFilter) {
      // train a specific topic: due cards of topic first, then unseen of topic (respect overall daily cap loosely)
      const tw = topicWords(topicFilter);
      const due = tw.filter(w => W.isDue(S.cards[w.id], S.today)).map(w => ({ wordId: w.id, isNew: false }));
      const unseen = tw.filter(w => !S.cards[w.id]).sort((a, b) => a.listOrder - b.listOrder)
        .slice(0, W.C.NEW_PER_SESSION).map(w => ({ wordId: w.id, isNew: true }));
      queue = due.concat(unseen).slice(0, W.C.SESSION_SIZE);
      if (!queue.length) { // nothing new/due in topic -> practice a few learned/started for review
        queue = tw.filter(w => S.cards[w.id]).slice(0, W.C.SESSION_SIZE).map(w => ({ wordId: w.id, isNew: false }));
      }
    } else {
      queue = W.buildSession(S.words, S.cards, S.user, S.today, { force: !!opts.force });
    }
    if (!queue.length) { go('today'); return; }
    S.session = {
      queue, idx: 0, previewed: new Set(), answered: 0, correct: 0,
      newIntroduced: 0, reviewed: new Set(), learnedNames: [], topicFilter: topicFilter || null,
      newReps: {}, newAttempts: {}, shown: 0
    };
    $nav.hidden = true;
    $app.classList.add('training');
    renderStep();
  }

  function curItem() { return S.session.queue[S.session.idx]; }

  function advance() {
    S.session.idx++;
    if (S.session.idx >= S.session.queue.length) finishSession();
    else renderStep();
  }

  function isDrill(card) { return card.box === 0; } // box-0 = still being learned -> drill in-session
  function requeueCurrent() { // re-insert the current word later in this session so it repeats
    const s = S.session, item = curItem(), card = ensureCard(item.wordId);
    const pos = Math.min(s.idx + 1 + W.C.RETRY_GAP_IN_SESSION, s.queue.length);
    s.queue.splice(pos, 0, { wordId: item.wordId, isNew: card.box === 0 });
  }

  function renderStep() {
    const s = S.session;
    if (s.shown >= W.C.MAX_SESSION_SCREENS) { finishSession(); return; } // hard cap: keep the exercise short
    s.shown++;
    const item = curItem(), w = S.byId[item.wordId], card = ensureCard(item.wordId);
    // Brand-new words are DRILLED several times within the session (preview -> recognise ->
    // produce -> ...) before graduating to the next-day spaced schedule. Reviews use the box ramp.
    const drill = isDrill(card);
    let ex;
    if (drill && !s.previewed.has(item.wordId)) ex = 'PREVIEW';
    else if (drill) {
      const r = s.newReps[item.wordId] || 0;
      ex = r === 0 ? 'MC_NL_EN' : (r === 1 ? 'MC_EN_NL' : (S.user.hardModeEnabled ? 'TYPING' : 'MC_EN_NL'));
    } else {
      ex = W.exerciseFor(card, S.user, true);
    }
    const progress = Math.round(100 * s.idx / s.queue.length);
    const topHTML = `<div class="train-top">
        <button class="close" id="closeT" aria-label="Close">✕</button>
        <span class="bar"><span style="width:${progress}%"></span></span>
        <span class="count">${s.idx + 1}/${s.queue.length}</span></div>`;

    if (ex === 'PREVIEW') {
      $app.innerHTML = topHTML + `<div class="card wordcard" style="margin-top:24px">
          <div class="muted" style="font-size:.85rem;margin-bottom:4px">New word</div>
          ${wordCardInner(w)}</div>
        <button class="btn btn-primary" id="gotit" style="margin-top:20px">Got it ✓</button>
        <button class="btn btn-ghost" id="knowit" style="margin-top:8px">I already know this</button>`;
      bindClose();
      document.getElementById('gotit').addEventListener('click', () => {
        s.previewed.add(item.wordId);
        if (!s.reviewed.has(item.wordId)) { s.newIntroduced++; }
        introduceNewDay();
        renderStep(); // now becomes MC_NL_EN
      });
      document.getElementById('knowit').addEventListener('click', () => {
        markKnown(item.wordId);                 // skip drilling -> straight to Learned
        s.knownSkipped = (s.knownSkipped || 0) + 1;
        announce('Marked as known');
        advance();
      });
      return;
    }

    if (ex === 'TYPING') { renderTyping(topHTML, w, card); return; }

    // multiple choice
    const dir = (ex === 'MC_NL_EN') ? 'NL_EN' : 'EN_NL';
    // Active de/het test on review-level production questions; new-word drilling shows the article instead.
    const dehet = dir === 'EN_NL' && w.type === 'noun' && !!w.article && card.box >= 2;
    const mc = W.generateMC(w, S.words, dir, dehet); // bare nouns only when de/het is asked separately
    const ask = dir === 'NL_EN' ? 'What does this mean?' : 'How do you say this in Dutch?';
    const promptHTML = dir === 'NL_EN'
      ? `<div class="word" lang="nl">${esc(mc.prompt)}${speakBtn(mc.prompt)}</div>`
      : `<div class="word" lang="en">${esc(mc.prompt)}</div>`;
    const opts = mc.options.map((o, i) =>
      `<button class="opt" data-i="${i}" lang="${dir === 'NL_EN' ? 'en' : 'nl'}">${esc(o.text)}</button>`).join('');
    $app.innerHTML = topHTML +
      `<div class="prompt"><div class="ask">${ask}</div>${promptHTML}</div>
       <div class="options">${opts}</div>
       <div class="feedback" id="fb"></div>`;
    bindClose();
    $app.querySelectorAll('.opt').forEach(btn => btn.addEventListener('click', () =>
      onMcAnswer(btn, mc, w, card, dehet)));
  }

  function onMcAnswer(btn, mc, w, card, dehet) {
    const i = +btn.dataset.i, chosen = mc.options[i];
    const opts = $app.querySelectorAll('.opt');
    opts.forEach(o => o.classList.add('locked'));
    const correctIdx = mc.options.findIndex(o => o.correct);

    if (chosen.correct) {
      if (dehet) { // right noun picked -> now actively test the article
        btn.classList.add('correct'); opts.forEach(o => o.classList.add('locked'));
        askDeHet(w, card); return;
      }
      btn.classList.add('correct'); btn.innerHTML += '<span class="mark">✓</span>';
      buzz(10); announce('Correct');
      if (scoreCorrect(w, card)) requeueCurrent();
      setTimeout(advance, 650);
    } else {
      btn.classList.add('wrong', 'nudge'); btn.innerHTML += '<span class="mark">✕</span>';
      opts[correctIdx].classList.remove('locked'); opts[correctIdx].classList.add('correct');
      buzz([10, 40, 10]);
      const ans = mc.options[correctIdx].text;
      showFeedback(false, `Almost — it's “${esc(ans)}”`);
      if (scoreWrong(w, card)) requeueCurrent();
      addNextButton();
    }
  }


  function askDeHet(w, card) {
    const fb = document.getElementById('fb');
    fb.innerHTML = `<div class="dehet"><div class="q">Is it <strong>de</strong> or <strong>het</strong> ${esc(w.nl)}?</div>
      <div class="btn-row"><button class="btn btn-secondary" data-a="de">de</button>
      <button class="btn btn-secondary" data-a="het">het</button></div></div>`;
    fb.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
      const right = b.dataset.a === w.article;
      fb.querySelectorAll('[data-a]').forEach(x => x.classList.add('locked'));
      if (right) {
        b.classList.remove('btn-secondary'); b.classList.add('btn-primary');
        buzz(10); announce('Correct'); if (scoreCorrect(w, card)) requeueCurrent(); setTimeout(advance, 650);
      } else {
        b.classList.add('wrong');
        showFeedback(false, `Almost — it's “${w.article} ${esc(w.nl)}”`);
        if (scoreWrong(w, card)) requeueCurrent(); addNextButton();
      }
    }));
  }

  function renderTyping(topHTML, w, card) {
    const expected = W.expectedTyped(w);
    $app.innerHTML = topHTML +
      `<div class="prompt"><div class="ask">Type the Dutch for</div><div class="word" lang="en">${esc(w.en)}</div></div>
       <div class="typing">
         <input id="tin" type="text" autocomplete="off" autocapitalize="off" autocorrect="off"
            spellcheck="false" inputmode="text" enterkeyhint="done" placeholder="type here…" lang="nl" />
         <div class="tip">${w.type === 'noun' ? 'Tip: include the article (de / het).' : 'Tip: mind the spelling.'}</div>
       </div>
       <div class="feedback" id="fb"></div>
       <div class="sticky-action"><button class="btn btn-primary" id="check">Check</button>
         <button class="btn btn-ghost" id="reveal">Show answer</button></div>`;
    bindClose();
    const input = document.getElementById('tin');
    let attempted = false;
    input.focus();
    const submit = () => {
      const verdict = W.judgeTyped(input.value, w);
      if (verdict === 'CORRECT') {
        showFeedback(true, 'Goed zo! ✓'); buzz(10); input.disabled = true;
        if (scoreCorrect(w, card)) requeueCurrent(); setTimeout(advance, 700);
      } else if (verdict === 'ALMOST' && !attempted) {
        attempted = true; showFeedback(false, 'Almost! Check your spelling and try again.'); input.select();
      } else {
        showFeedback(false, `It's “${esc(expected)}”`); buzz([10, 40, 10]); input.disabled = true;
        if (scoreWrong(w, card)) requeueCurrent(); addNextButton();
      }
    };
    document.getElementById('check').addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    document.getElementById('reveal').addEventListener('click', () => {
      showFeedback(false, `It's “${esc(expected)}”`); input.disabled = true;
      if (scoreWrong(w, card)) requeueCurrent(); addNextButton();
    });
  }

  // ---------- scoring ---------- (return true if the word should repeat later this session)
  function scoreCorrect(w, card) {
    const s = S.session; s.answered++; s.correct++; s.reviewed.add(w.id);
    if (isDrill(card)) {
      s.newReps[w.id] = (s.newReps[w.id] || 0) + 1;
      s.newAttempts[w.id] = (s.newAttempts[w.id] || 0) + 1;
      if (s.newReps[w.id] >= W.C.NEW_REPS_TARGET) { // drilled enough -> graduate to next-day review
        const r = W.onCorrect(card, S.today); if (r.newlyLearned) s.learnedNames.push(w); save(); return false;
      }
      save(); return true; // keep repeating within this session
    }
    const r = W.onCorrect(card, S.today); if (r.newlyLearned) s.learnedNames.push(w); save(); return false;
  }
  function scoreWrong(w, card) {
    const s = S.session; s.answered++; s.reviewed.add(w.id);
    if (isDrill(card)) {
      s.newReps[w.id] = Math.max(0, (s.newReps[w.id] || 0) - 1);
      s.newAttempts[w.id] = (s.newAttempts[w.id] || 0) + 1;
      if (s.newAttempts[w.id] >= W.C.MAX_DRILL_ATTEMPTS) { // struggling -> stop looping, try again tomorrow
        card.box = 1; card.nextDue = W.addDays(S.today, 1); card.lastReviewed = S.today; card.lastResult = 'WRONG'; save(); return false;
      }
      save(); return true;
    }
    W.onWrong(card, S.today); save(); return true;
  }
  function introduceNewDay() {
    if (S.user.lastNewDay !== S.today) { S.user.lastNewDay = S.today; S.user.newCountToday = 0; }
    S.user.newCountToday++; save();
  }

  function showFeedback(good, html) {
    const fb = document.getElementById('fb');
    if (fb) { fb.className = 'feedback ' + (good ? 'good' : 'bad'); fb.innerHTML = html; }
    announce(good ? 'Correct' : 'Almost');
  }
  function addNextButton() {
    const fb = document.getElementById('fb');
    const b = document.createElement('button');
    b.className = 'btn btn-primary'; b.textContent = 'Next ▸'; b.style.marginTop = '18px';
    b.addEventListener('click', advance);
    fb.after(b);
  }
  function bindClose() {
    const c = document.getElementById('closeT');
    if (c) c.addEventListener('click', () => { if (S.session.answered >= 1) finishSession(); else go('today'); });
  }

  // ---------- session complete ----------
  function finishSession() {
    const s = S.session;
    // don't orphan new words that were started but not finished (cap hit / early exit):
    // move them onto the next-day spaced schedule so they continue tomorrow.
    s.previewed.forEach(id => {
      const c = S.cards[id];
      if (c && c.box === 0 && !c.learned) { c.box = 1; c.nextDue = W.addDays(S.today, 1); c.lastReviewed = S.today; }
    });
    if (s.answered >= 1) W.updateStreak(S.user, S.today);
    S.user.onboarded = true;
    save();
    const dueTomorrow = W.dueCount(S.words, S.cards, W.addDays(S.today, 1));
    const reviewed = s.reviewed.size;
    const learnedHtml = s.learnedNames.length
      ? `<div class="srow"><span>🏆 Moved to Learned</span><strong>${s.learnedNames.length}</strong></div>`
      : '';
    const learnedNames = s.learnedNames.length && s.learnedNames.length <= 3
      ? `<p class="muted" style="font-size:.85rem">${s.learnedNames.map(w => esc(w.nl)).join(', ')} — nice! 🏆</p>` : '';
    const nextUp = dueTomorrow > 0
      ? `Come back tomorrow — about <strong>${Math.min(dueTomorrow, W.C.SESSION_SIZE)}</strong> words due`
      : `Nothing due tomorrow — add new words any time`;

    $app.classList.remove('training');
    $app.innerHTML = `
      <div class="complete">
        <div class="emoji celebrate">🎉</div>
        <h1>Nice work!</h1>
        <p class="secondary-text">You finished today's session.</p>
        <div class="card summary">
          <div class="srow"><span>✓ Correct</span><strong>${s.correct}/${s.answered}</strong></div>
          <div class="srow"><span>📚 Words practised</span><strong>${reviewed}</strong></div>
          <div class="srow"><span>🌱 New words started</span><strong>${s.newIntroduced}</strong></div>
          ${learnedHtml}
        </div>
        ${learnedNames}
        <div class="streak-pill big celebrate">🔥 ${S.user.currentStreak}-day streak</div>
        ${weekDots()}
        <p class="muted" style="margin-top:16px">${nextUp}</p>
        <button class="btn btn-primary" id="done" style="margin-top:16px">Done</button>
        ${s.topicFilter ? '' : ''}
      </div>`;
    document.getElementById('done').addEventListener('click', () => { S.user.onboarded = true; save(); go('today'); });
  }

  function weekDots() {
    // show last 7 days; mark completed (approx: today on) — simple visual
    let dots = '';
    for (let i = 6; i >= 0; i--) {
      const d = W.addDays(S.today, -i);
      const isToday = i === 0;
      const on = (S.user.lastCompletedDay && W.dayDiff(d, S.user.lastCompletedDay) >= 0 &&
        W.dayDiff(d, S.user.lastCompletedDay) < S.user.currentStreak) || isToday;
      dots += `<span class="dot ${on ? 'on' : ''} ${isToday ? 'today' : ''}"></span>`;
    }
    return `<div class="weekdots">${dots}</div>`;
  }

  // ---------- LEARNED ----------
  function wordLine(w, mark) {
    const disp = (w.type === 'noun' && w.article) ? w.article + ' ' + w.nl : w.nl;
    return `<div class="learned-row"><span class="lmark">${mark}</span><span class="lw" lang="nl">${esc(disp)}</span><span class="lt" lang="en">${esc(w.en)}</span></div>`;
  }
  function renderLearned() {
    const totalLearned = Object.values(S.cards).filter(c => c.learned).length;
    const totalProgress = Object.values(S.cards).filter(c => !c.learned).length;
    const totalWords = S.words.length;

    const sections = S.topics.map(t => {
      const tw = topicWords(t.id);
      const learned = tw.filter(w => S.cards[w.id] && S.cards[w.id].learned);
      const prog = tw.filter(w => S.cards[w.id] && !S.cards[w.id].learned);
      if (!learned.length && !prog.length) return '';
      return `<details class="topic-acc">
        <summary><span>${t.emoji} ${esc(t.name)}</span><span class="muted" style="font-size:.78rem">${learned.length} 🏆 · ${prog.length} learning</span></summary>
        ${learned.length ? `<div class="acc-sub">Learned</div>${learned.map(w => wordLine(w, '🏆')).join('')}` : ''}
        ${prog.length ? `<div class="acc-sub">In progress</div>${prog.map(w => wordLine(w, '•')).join('')}` : ''}
      </details>`;
    }).join('');

    $app.innerHTML = `
      <h1 class="title">Your words</h1>
      <div class="card" style="display:flex;justify-content:space-around;text-align:center">
        <div><div class="stat-big">${totalLearned}</div><div class="muted">learned</div></div>
        <div><div class="stat-big" style="color:var(--c-accent-text)">${totalProgress}</div><div class="muted">in progress</div></div>
        <div><div class="stat-big" style="color:var(--t-3)">${totalWords}</div><div class="muted">total</div></div>
      </div>
      <p class="muted" style="margin:14px 2px 6px;font-size:.85rem">Tap a topic to expand 🔥 ${S.user.currentStreak}-day streak</p>
      ${sections || `<p class="muted" style="margin-top:16px">Start a session and your words will show up here. 🌱</p>`}`;
  }

  init();
})();
