/* Woordjes v0 — UI controller. Wires engine.js to the screens in the Design Spec. */
(function () {
  'use strict';
  const W = window.WJ;
  const $app = document.getElementById('app');
  const $nav = document.getElementById('bottomnav');
  const $live = document.getElementById('live');

  const S = { words: [], byId: {}, topics: [], topicById: {}, cards: {}, user: null, today: null, session: null };

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function announce(msg) { $live.textContent = msg; }
  function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }
  function save() { W.Store.saveCards(S.cards); W.Store.saveUser(S.user); }
  function ensureCard(id) { if (!S.cards[id]) S.cards[id] = W.newCard(id, S.today); return S.cards[id]; }

  // ---------- bootstrap ----------
  async function init() {
    S.today = W.todayStr();
    S.cards = W.Store.loadCards();
    S.user = W.Store.loadUser();
    const res = await fetch('./data/words.json', { cache: 'no-store' });
    const data = await res.json();
    S.words = data.words;
    S.topics = data.topics;
    S.words.forEach(w => { S.byId[w.id] = w; });
    S.topics.forEach(t => { S.topicById[t.id] = t; });

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    $nav.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => go(b.dataset.nav)));

    if (!S.user.onboarded) { startSession(); }   // drop straight into learning on first open
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
        <button class="streak-pill" id="settingsBtn" aria-label="Streak and settings">🔥 ${S.user.currentStreak}</button>
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
    $app.innerHTML = `<h1 class="title">Topics</h1><div class="list">${rows}</div>`;
    $app.querySelectorAll('[data-topic]').forEach(b => b.addEventListener('click', () => renderTopicDetail(b.dataset.topic)));
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
        <div class="nl" lang="nl">${esc(w.nl)}</div>
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
      return `<span class="badge ${cls}">${esc(w.article)}</span>
        <div class="nl" lang="nl">${esc(w.nl)}</div>${pl}
        <div class="en" lang="en">${esc(w.en)}</div>`;
    }
    return `<div class="nl" lang="nl">${esc(w.nl)}</div><div class="en" lang="en">${esc(w.en)}</div>`;
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
        <label style="display:flex;justify-content:space-between;align-items:center;cursor:pointer">
          <span>Hard mode (typing)<br><span class="muted" style="font-size:.8rem">Type the Dutch word once you know it well</span></span>
          <input type="checkbox" id="hardmode" ${S.user.hardModeEnabled ? 'checked' : ''} style="transform:scale(1.4)">
        </label>
      </div>
      <h2 class="section">Reset</h2>
      <button class="btn btn-secondary" id="reset">Reset all progress</button>
      <p class="muted" style="font-size:.8rem;margin-top:16px">Woordjes v0 prototype · words pending native-speaker proofread</p>`;
    document.getElementById('back').addEventListener('click', () => go('today'));
    document.getElementById('hardmode').addEventListener('change', e => { S.user.hardModeEnabled = e.target.checked; save(); });
    document.getElementById('reset').addEventListener('click', () => {
      if (confirm('Reset all progress? This cannot be undone.')) { W.Store.reset(); S.cards = {}; S.user = W.Store.loadUser(); go('today'); }
    });
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
        .slice(0, W.C.SESSION_SIZE).map(w => ({ wordId: w.id, isNew: true }));
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
      pendingNoun: null
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

  function requeue(wordId) {
    const s = S.session;
    const pos = Math.min(s.idx + 1 + W.C.RETRY_GAP_IN_SESSION, s.queue.length);
    s.queue.splice(pos, 0, { wordId, isNew: false, retry: true });
  }

  function renderStep() {
    const s = S.session, item = curItem(), w = S.byId[item.wordId], card = ensureCard(item.wordId);
    if (item.isNew && !s.previewed.has(item.wordId) && card.box === 0 && card.firstSeenDay === S.today) {
      // count a new introduction once
    }
    const ex = W.exerciseFor(card, S.user, s.previewed.has(item.wordId));
    const progress = Math.round(100 * s.idx / s.queue.length);
    const topHTML = `<div class="train-top">
        <button class="close" id="closeT" aria-label="Close">✕</button>
        <span class="bar"><span style="width:${progress}%"></span></span>
        <span class="count">${s.idx + 1}/${s.queue.length}</span></div>`;

    if (ex === 'PREVIEW') {
      $app.innerHTML = topHTML + `<div class="card wordcard" style="margin-top:24px">
          <div class="muted" style="font-size:.85rem;margin-bottom:4px">New word</div>
          ${wordCardInner(w)}</div>
        <button class="btn btn-primary" id="gotit" style="margin-top:20px">Got it ✓</button>`;
      bindClose();
      document.getElementById('gotit').addEventListener('click', () => {
        s.previewed.add(item.wordId);
        if (!s.reviewed.has(item.wordId)) { s.newIntroduced++; }
        introduceNewDay();
        renderStep(); // now becomes MC_NL_EN
      });
      return;
    }

    if (ex === 'TYPING') { renderTyping(topHTML, w, card); return; }

    // multiple choice
    const dir = (ex === 'MC_NL_EN') ? 'NL_EN' : 'EN_NL';
    const mc = W.generateMC(w, S.words, dir);
    const ask = dir === 'NL_EN' ? 'What does this mean?' : 'How do you say this in Dutch?';
    const promptHTML = dir === 'NL_EN'
      ? `<div class="word" lang="nl">${esc(mc.prompt)}</div>`
      : `<div class="word" lang="en">${esc(mc.prompt)}</div>`;
    const opts = mc.options.map((o, i) =>
      `<button class="opt" data-i="${i}" lang="${dir === 'NL_EN' ? 'en' : 'nl'}">${esc(o.text)}</button>`).join('');
    $app.innerHTML = topHTML +
      `<div class="prompt"><div class="ask">${ask}</div>${promptHTML}</div>
       <div class="options">${opts}</div>
       <div class="feedback" id="fb"></div>`;
    bindClose();
    $app.querySelectorAll('.opt').forEach(btn => btn.addEventListener('click', () =>
      onMcAnswer(btn, mc, w, card, dir)));
  }

  function onMcAnswer(btn, mc, w, card, dir) {
    const i = +btn.dataset.i, chosen = mc.options[i];
    const opts = $app.querySelectorAll('.opt');
    opts.forEach(o => o.classList.add('locked'));
    const correctIdx = mc.options.findIndex(o => o.correct);

    if (chosen.correct) {
      // noun de/het follow-up only for production direction at box>=2
      if (dir === 'EN_NL' && w.type === 'noun' && w.article && card.box >= 2) {
        btn.classList.add('correct'); btn.classList.remove('locked');
        opts.forEach(o => o.classList.add('locked'));
        askDeHet(w, card);
        return;
      }
      btn.classList.add('correct'); btn.innerHTML += '<span class="mark">✓</span>';
      buzz(10); announce('Correct');
      scoreCorrect(w, card);
      setTimeout(advance, 650);
    } else {
      btn.classList.add('wrong', 'nudge'); btn.innerHTML += '<span class="mark">✕</span>';
      opts[correctIdx].classList.remove('locked'); opts[correctIdx].classList.add('correct');
      buzz([10, 40, 10]);
      const ans = mc.options[correctIdx].text;
      showFeedback(false, `Almost — it's “${esc(ans)}”`);
      scoreWrong(w, card);
      requeue(w.id);
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
        buzz(10); announce('Correct'); scoreCorrect(w, card); setTimeout(advance, 650);
      } else {
        b.classList.add('wrong');
        showFeedback(false, `Almost — it's “${w.article} ${esc(w.nl)}”`);
        scoreWrong(w, card); requeue(w.id); addNextButton();
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
        scoreCorrect(w, card); setTimeout(advance, 700);
      } else if (verdict === 'ALMOST' && !attempted) {
        attempted = true; showFeedback(false, 'Almost! Check your spelling and try again.'); input.select();
      } else {
        showFeedback(false, `It's “${esc(expected)}”`); buzz([10, 40, 10]); input.disabled = true;
        scoreWrong(w, card); requeue(w.id); addNextButton();
      }
    };
    document.getElementById('check').addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    document.getElementById('reveal').addEventListener('click', () => {
      showFeedback(false, `It's “${esc(expected)}”`); input.disabled = true;
      scoreWrong(w, card); requeue(w.id); addNextButton();
    });
  }

  // ---------- scoring ----------
  function scoreCorrect(w, card) {
    const r = W.onCorrect(card, S.today);
    S.session.answered++; S.session.correct++; S.session.reviewed.add(w.id);
    if (r.newlyLearned) S.session.learnedNames.push(w);
    save();
  }
  function scoreWrong(w, card) {
    W.onWrong(card, S.today);
    S.session.answered++; S.session.reviewed.add(w.id);
    save();
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
  function renderLearned() {
    const learned = Object.values(S.cards).filter(c => c.learned).map(c => S.byId[c.wordId]).filter(Boolean);
    const recent = learned.slice(-12).reverse();
    const total = learned.length;
    const totalWords = S.words.length;
    const rows = recent.length ? recent.map(w => {
      const art = w.type === 'noun' ? `<span class="badge ${w.article === 'het' ? 'het' : 'de'}" style="font-size:.65rem;padding:2px 8px">${w.article}</span>` : '';
      return `<div class="learned-row"><span class="lw" lang="nl">${esc(w.nl)}</span> ${art}<span class="lt" lang="en">${esc(w.en)}</span></div>`;
    }).join('') : `<p class="muted">No words learned yet — finish a few sessions and they'll appear here. 🌱</p>`;

    const topicRows = S.topics.map(t => {
      const tw = topicWords(t.id), l = topicLearned(t.id), pct = Math.round(100 * l / tw.length);
      return `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:.9rem">
        <span>${t.emoji} ${esc(t.name)}</span><span class="muted">${l}/${tw.length}</span></div>
        <span class="bar success"><span style="width:${pct}%"></span></span></div>`;
    }).join('');

    $app.innerHTML = `
      <h1 class="title">Learned</h1>
      <div class="card" style="display:flex;align-items:center;justify-content:space-between">
        <div><div class="stat-big">${total}</div><div class="muted">of ${totalWords} words</div></div>
        <div class="streak-pill big">🔥 ${S.user.currentStreak} days</div>
      </div>
      <h2 class="section">By topic</h2>
      <div class="card">${topicRows}</div>
      <h2 class="section">Recently learned</h2>
      <div class="card">${rows}</div>`;
  }

  init();
})();
