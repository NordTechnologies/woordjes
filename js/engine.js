/* Woordjes — learning engine (v0)
 * Implements "Learning Mechanics Spec (v0).md": 7-box Leitner, due logic,
 * difficulty ramp, MC generation, typing judgement, Learned rule, streak + freeze.
 * Pure logic + a thin localStorage adapter. No framework, no network. */
(function (global) {
  'use strict';

  // ---- §10 constants (single source of truth) ----
  const C = {
    INTERVALS_DAYS: [0, 1, 2, 4, 8, 16, 32], // index = box
    MAX_BOX: 6,
    DEMOTE_STEP: 2,
    MIN_BOX_ON_WRONG: 1,
    NEW_WORDS_PER_DAY: 7,
    REVIEW_BACKLOG_PAUSE: 30,
    SESSION_SIZE: 15,
    OPTIONS_PER_MC: 4,
    LEARNED_MIN_BOX: 5,
    LEARNED_MIN_DAYS: 3,
    RETRY_GAP_IN_SESSION: 3,
    FREEZE_EARN_DAYS: 7,
    TYPO_EDIT_DISTANCE: 1
  };

  // ---- date helpers (calendar dates, local tz, YYYY-MM-DD) ----
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parse(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return todayStr(d); }
  function dayDiff(fromS, toS) { return Math.round((parse(toS) - parse(fromS)) / 86400000); }

  // ---- storage adapter (two stores, plan §5) ----
  const KEY_CARDS = 'wj.cards.v0';
  const KEY_USER = 'wj.user.v0';

  function defaultUser() {
    return {
      currentStreak: 0, longestStreak: 0, lastCompletedDay: null,
      freezeAvailable: false, daysSinceFreezeGranted: 0,
      hardModeEnabled: false,
      lastNewDay: null, newCountToday: 0,
      reminderTime: null,
      onboarded: false
    };
  }
  const Store = {
    loadCards() { try { return JSON.parse(localStorage.getItem(KEY_CARDS)) || {}; } catch (e) { return {}; } },
    saveCards(c) { localStorage.setItem(KEY_CARDS, JSON.stringify(c)); },
    loadUser() { try { return Object.assign(defaultUser(), JSON.parse(localStorage.getItem(KEY_USER)) || {}); } catch (e) { return defaultUser(); } },
    saveUser(u) { localStorage.setItem(KEY_USER, JSON.stringify(u)); },
    reset() { localStorage.removeItem(KEY_CARDS); localStorage.removeItem(KEY_USER); }
  };

  // ---- card lifecycle ----
  function newCard(wordId, today) {
    return {
      wordId: wordId, box: 0, nextDue: null, lastReviewed: null,
      consecutiveCorrect: 0, distinctCorrectDays: 0, lastCorrectDay: null,
      lastResult: null, lapses: 0, learned: false, firstSeenDay: today
    };
  }

  function isDue(card, today) {
    return !!card && card.box != null && card.box >= 1 && card.nextDue != null && dayDiff(card.nextDue, today) >= 0;
  }

  function recordDistinctCorrectDay(card, today) {
    if (today !== card.lastCorrectDay) { card.distinctCorrectDays += 1; card.lastCorrectDay = today; }
  }
  function updateLearned(card) {
    if (card.box >= C.LEARNED_MIN_BOX && card.distinctCorrectDays >= C.LEARNED_MIN_DAYS && card.lastResult === 'CORRECT') {
      const wasLearned = card.learned; card.learned = true; return !wasLearned; // returns true if newly learned
    }
    return false;
  }

  // returns {newlyLearned: bool}
  function onCorrect(card, today) {
    card.box = Math.min(card.box + 1, C.MAX_BOX);
    card.nextDue = addDays(today, C.INTERVALS_DAYS[card.box]);
    card.consecutiveCorrect += 1;
    card.lastReviewed = today;
    card.lastResult = 'CORRECT';
    recordDistinctCorrectDay(card, today);
    return { newlyLearned: updateLearned(card) };
  }
  function onWrong(card, today) {
    if (card.box === 0) {
      // brand new, never promoted: keep at 0, re-show this session
    } else {
      card.box = Math.max(card.box - C.DEMOTE_STEP, C.MIN_BOX_ON_WRONG);
    }
    card.consecutiveCorrect = 0;
    card.lapses += 1;
    card.lastReviewed = today;
    card.lastResult = 'WRONG';
    card.nextDue = today; // due again today
    if (card.learned) {
      card.learned = false;
      card.distinctCorrectDays = 2; // keep most credit; needs one more good day
    }
  }

  // ---- session building (§6) ----
  function allowedNewToday(cards, user, today, dueCount) {
    let introduced = (user.lastNewDay === today) ? user.newCountToday : 0;
    if (dueCount >= C.REVIEW_BACKLOG_PAUSE) return 0;
    return Math.max(0, C.NEW_WORDS_PER_DAY - introduced);
  }

  // words: array of content; returns ordered array of {wordId, isNew}
  // opts.force: ignore the daily new-word cap + backlog pause, and when no new words
  // remain, top up the session with existing cards (lowest box first, learned last)
  // so "Learn new words / Practice" always has something to do.
  function buildSession(words, cards, user, today, opts) {
    const force = !!(opts && opts.force);
    const due = words
      .map(w => cards[w.id])
      .filter(c => isDue(c, today))
      .sort((a, b) => dayDiff(a.nextDue, today) - dayDiff(b.nextDue, today)) // most overdue first
      .reverse()
      .map(c => ({ wordId: c.wordId, isNew: false }));

    const reviews = due.slice(0, C.SESSION_SIZE);
    let queue = reviews.slice();

    let remaining = C.SESSION_SIZE - queue.length;
    if (remaining > 0) {
      const nAllowed = force ? remaining : Math.min(remaining, allowedNewToday(cards, user, today, due.length));
      if (nAllowed > 0) {
        const unseen = words
          .filter(w => !cards[w.id])
          .sort((a, b) => a.listOrder - b.listOrder)
          .slice(0, nAllowed)
          .map(w => ({ wordId: w.id, isNew: true }));
        queue = interleave(reviews, unseen); // interleave new words rather than dumping at the end
      }
    }

    // Forced "keep going": if still short (no due, cap-free, and all words already seen),
    // fill with existing cards for extra review — lowest box first, recently learned included.
    if (force && queue.length < C.SESSION_SIZE) {
      const inQueue = new Set(queue.map(i => i.wordId));
      const extra = words
        .map(w => cards[w.id])
        .filter(c => c && !inQueue.has(c.wordId))
        .sort((a, b) => a.box - b.box)
        .slice(0, C.SESSION_SIZE - queue.length)
        .map(c => ({ wordId: c.wordId, isNew: false, extra: true }));
      queue = queue.concat(extra);
    }
    return queue;
  }

  function interleave(reviews, news) {
    if (!news.length) return reviews;
    if (!reviews.length) return news;
    const out = []; let ni = 0, ri = 0;
    while (ri < reviews.length || ni < news.length) {
      // pattern: review, review, new, review, review, new ...
      for (let k = 0; k < 2 && ri < reviews.length; k++) out.push(reviews[ri++]);
      if (ni < news.length) out.push(news[ni++]);
    }
    return out;
  }

  // ---- difficulty ramp (§3) ----
  // returns 'PREVIEW' | 'MC_NL_EN' | 'MC_EN_NL' | 'TYPING'
  function exerciseFor(card, user, previewedThisSession) {
    if (card.box === 0 && !previewedThisSession) return 'PREVIEW';
    if (card.box <= 1) return 'MC_NL_EN';
    if (card.box <= 3) return 'MC_EN_NL';
    return user.hardModeEnabled ? 'TYPING' : 'MC_EN_NL';
  }

  // ---- multiple choice generation (§4) ----
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  function answerText(word, dir) { return dir === 'NL_EN' ? word.en : word.nl; }

  // dir: 'NL_EN' (prompt nl, answers en) or 'EN_NL' (prompt en, answers nl)
  function generateMC(target, words, dir) {
    const correctText = answerText(target, dir);
    const sameTypeTopic = words.filter(w => w.id !== target.id && w.type === target.type && w.topic === target.topic);
    const sameType = words.filter(w => w.id !== target.id && w.type === target.type && w.topic !== target.topic);
    const anyOther = words.filter(w => w.id !== target.id && w.type !== target.type);
    const tiers = [shuffle(sameTypeTopic), shuffle(sameType), shuffle(anyOther)];

    const picked = []; const usedText = new Set([correctText.toLowerCase()]);
    const want = Math.min(C.OPTIONS_PER_MC - 1, Math.max(1, words.length - 1));
    for (const tier of tiers) {
      for (const w of tier) {
        if (picked.length >= want) break;
        const t = answerText(w, dir);
        if (!t || usedText.has(t.toLowerCase())) continue; // no dup/synonym strings
        usedText.add(t.toLowerCase());
        picked.push({ text: t, wordId: w.id, correct: false });
      }
      if (picked.length >= want) break;
    }
    const options = shuffle(picked.concat([{ text: correctText, wordId: target.id, correct: true }]));
    const prompt = dir === 'NL_EN'
      ? (target.type === 'noun' && target.article ? target.article + ' ' + target.nl : target.nl) // show article in recognition
      : target.en;
    return { dir, prompt, options, correctWordId: target.id };
  }

  // ---- typing judgement (§7.2) ----
  const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
  function stripDiacritics(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function normalize(s) { return stripDiacritics((s || '').trim().toLowerCase()).replace(/\s+/g, ' '); }
  function levenshtein(a, b) {
    const m = a.length, n = b.length; const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[m][n];
  }
  // for distance 1, return the set of chars involved in the single edit
  function singleEditChars(a, b) {
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return [a[i], b[i]];
      return [];
    }
    const [shortS, longS] = a.length < b.length ? [a, b] : [b, a];
    for (let i = 0; i < shortS.length; i++) if (shortS[i] !== longS[i]) return [longS[i]];
    return [longS[longS.length - 1]];
  }
  function expectedTyped(word) {
    return word.type === 'noun' && word.article ? word.article + ' ' + word.nl : word.nl;
  }
  // returns 'CORRECT' | 'ALMOST' | 'WRONG'
  function judgeTyped(typed, word) {
    const t = normalize(typed), e = normalize(expectedTyped(word));
    if (t === e) return 'CORRECT';
    if (levenshtein(t, e) === C.TYPO_EDIT_DISTANCE) {
      const chars = singleEditChars(t, e);
      const involvesVowel = chars.some(ch => VOWELS.has(ch));
      if (!involvesVowel) return 'ALMOST'; // consonant slip — forgive, retype once
    }
    return 'WRONG';
  }

  // ---- streak (§8) ----
  function refillFreeze(user) {
    if (!user.freezeAvailable && user.daysSinceFreezeGranted >= C.FREEZE_EARN_DAYS) {
      user.freezeAvailable = true; user.daysSinceFreezeGranted = 0;
    }
  }
  function updateStreak(user, today) {
    if (user.lastCompletedDay === today) return; // already counted today
    if (user.lastCompletedDay == null) {
      user.currentStreak = 1;
    } else {
      const gap = dayDiff(user.lastCompletedDay, today);
      if (gap === 1) { user.currentStreak += 1; }
      else if (gap === 2 && user.freezeAvailable) { user.currentStreak += 1; user.freezeAvailable = false; }
      else { user.currentStreak = 1; }
    }
    user.lastCompletedDay = today;
    user.longestStreak = Math.max(user.longestStreak, user.currentStreak);
    user.daysSinceFreezeGranted += 1;
    refillFreeze(user);
  }

  // ---- progress helpers ----
  function dueCount(words, cards, today) {
    return words.reduce((n, w) => n + (isDue(cards[w.id], today) ? 1 : 0), 0);
  }
  function learnedCount(cards) {
    return Object.values(cards).filter(c => c.learned).length;
  }

  global.WJ = {
    C, todayStr, addDays, dayDiff,
    Store, newCard, isDue, onCorrect, onWrong, updateLearned,
    buildSession, allowedNewToday, exerciseFor,
    generateMC, judgeTyped, expectedTyped, normalize, levenshtein,
    updateStreak, dueCount, learnedCount
  };
})(window);
