/* Tester: headless logic tests for the learning engine (no browser needed).
   Run: node tests/engine.test.js  */
const fs = require('fs');
const path = require('path');

// --- load engine.js with browser globals stubbed ---
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
global.window = {};
const code = fs.readFileSync(path.join(__dirname, '../public/js/engine.js'), 'utf8');
eval(code);
const W = global.window.WJ;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error('  ✗ FAIL:', name); } }
function eq(name, a, b) { ok(name + ` (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

const words = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/words.json'), 'utf8')).words;

// ---- dates ----
eq('addDays +1', W.addDays('2026-06-17', 1), '2026-06-18');
eq('addDays month roll', W.addDays('2026-06-30', 1), '2026-07-01');
eq('dayDiff', W.dayDiff('2026-06-17', '2026-06-20'), 3);

// ---- Leitner promotion / due ----
let c = W.newCard(45, '2026-06-17'); // het brood
eq('new card box 0', c.box, 0);
ok('box0 not due', !W.isDue(c, '2026-06-17'));
W.onCorrect(c, '2026-06-17');
eq('promote to box1', c.box, 1);
eq('due +1 day', c.nextDue, '2026-06-18');
ok('due next day', W.isDue(c, '2026-06-18'));
ok('overdue still due', W.isDue(c, '2026-06-25'));

// ---- gentle demotion: box5 wrong -> box3, due today ----
let h = W.newCard(35, '2026-06-01'); h.box = 5; h.nextDue = '2026-06-10';
W.onWrong(h, '2026-06-15');
eq('demote by 2', h.box, 3);
eq('wrong -> due today', h.nextDue, '2026-06-15');
// box1 wrong stays at 1
let lo = W.newCard(36, '2026-06-01'); lo.box = 1; W.onWrong(lo, '2026-06-15');
eq('box1 wrong floor', lo.box, 1);

// ---- Learned requires 3 distinct days ----
let L = W.newCard(48, '2026-06-01'); // het water
// simulate correct answers on the SAME day many times -> must NOT be learned
L.box = 5;
for (let i = 0; i < 5; i++) { L.lastResult = 'CORRECT'; W.onCorrect(L, '2026-06-10'); }
ok('not learned same-day repeats', L.learned === false);
// now correct on three distinct days at high box
let M = W.newCard(49, '2026-06-01'); M.box = 4;
W.onCorrect(M, '2026-06-02'); // ->5, day1
W.onCorrect(M, '2026-06-10'); // ->6, day2
W.onCorrect(M, '2026-06-20'); // stays 6, day3 -> learned
ok('learned after 3 distinct days & box>=5', M.learned === true);
// miss a learned word -> drops out
W.onWrong(M, '2026-06-21');
ok('learned drops on miss', M.learned === false);

// ---- MC generation ----
const target = words.find(w => w.id === 45); // brood (noun, food)
const mc = W.generateMC(target, words, 'EN_NL');
eq('mc 4 options', mc.options.length, 4);
ok('mc one correct', mc.options.filter(o => o.correct).length === 1);
ok('mc no dup strings', new Set(mc.options.map(o => o.text.toLowerCase())).size === mc.options.length);
ok('mc correct is target', mc.options.find(o => o.correct).wordId === 45);

// ---- typing judgement ----
const brood = words.find(w => w.id === 45); // het brood
eq('typed exact w/ article', W.judgeTyped('het brood', brood), 'CORRECT');
eq('typed missing article strict', W.judgeTyped('brood', brood), 'WRONG');
eq('typed wrong article strict', W.judgeTyped('de brood', brood), 'WRONG');
const werken = words.find(w => w.id === 17);
eq('typed verb exact', W.judgeTyped('werken', werken), 'CORRECT');
eq('typed case-insensitive', W.judgeTyped('Werken', werken), 'CORRECT');
eq('typed consonant substitution -> ALMOST', W.judgeTyped('werkem', werken), 'ALMOST'); // n->m, both consonants
eq('typed vowel slip -> WRONG (meaning)', W.judgeTyped('werkon', werken), 'WRONG');

// consonant deletion 'werken'->'werke' (drop final n, a consonant) should be ALMOST
eq('drop final consonant -> ALMOST', W.judgeTyped('werke', werken), 'ALMOST');
// vowel deletion 'werken'->'wrken' should be WRONG
eq('drop a vowel -> WRONG', W.judgeTyped('wrken', werken), 'WRONG');

// ---- streak + freeze ----
let u = W.Store.loadUser();
W.updateStreak(u, '2026-06-01'); eq('streak start', u.currentStreak, 1);
W.updateStreak(u, '2026-06-02'); eq('streak consecutive', u.currentStreak, 2);
W.updateStreak(u, '2026-06-02'); eq('same day no double', u.currentStreak, 2);
W.updateStreak(u, '2026-06-04'); eq('2-day gap no freeze resets', u.currentStreak, 1);
// build to earn a freeze (7 consecutive), then a 1-day miss is forgiven
let u2 = W.Store.loadUser();
let day = '2026-07-01';
for (let i = 0; i < 7; i++) { W.updateStreak(u2, W.addDays('2026-07-01', i)); }
ok('freeze earned after 7 days', u2.freezeAvailable === true);
eq('streak is 7', u2.currentStreak, 7);
W.updateStreak(u2, W.addDays('2026-07-01', 8)); // skipped day index 7 -> gap 2, freeze used
eq('freeze bridges 1 missed day', u2.currentStreak, 8);
ok('freeze consumed', u2.freezeAvailable === false);

// ---- buildSession respects new-word cap ----
const fresh = {};
const u3 = W.Store.loadUser();
const session = W.buildSession(words, fresh, u3, '2026-06-17');
ok('session non-empty', session.length > 0);
ok('session new words <= cap', session.filter(i => i.isNew).length <= W.C.NEW_WORDS_PER_DAY);

// ---- forced session (the "Learn new words" button) ----
const uCap = W.Store.loadUser(); uCap.lastNewDay = '2026-06-17'; uCap.newCountToday = 7;
eq('normal session empty when capped & nothing due', W.buildSession(words, {}, uCap, '2026-06-17').length, 0);
const forced = W.buildSession(words, {}, uCap, '2026-06-17', { force: true });
ok('forced session ignores daily cap', forced.length > 0);
ok('forced session pulls new words', forced.some(i => i.isNew));
// forced fill from existing when everything already seen
const allSeen = {};
words.forEach(w => { allSeen[w.id] = W.newCard(w.id, '2026-06-01'); allSeen[w.id].box = 3; allSeen[w.id].nextDue = '2026-12-01'; });
const forced2 = W.buildSession(words, allSeen, W.Store.loadUser(), '2026-06-17', { force: true });
eq('forced fills from existing when all seen', forced2.length, W.C.SESSION_SIZE);
ok('forced extra are review (not new)', forced2.every(i => !i.isNew));

// ---- expanded data integrity ----
const ids = new Set(words.map(w => w.id));
eq('all word ids unique', ids.size, words.length);
ok('expanded to >= 170 words', words.length >= 170);
ok('every word has nl+en', words.every(w => w.nl && w.en));
ok('every noun has article+plural', words.filter(w => w.type === 'noun').every(w => (w.article === 'de' || w.article === 'het') && w.plural));
ok('every verb has 3 forms', words.filter(w => w.type === 'verb').every(w => w.pastSimple && w.perfect));
const topicIds = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data/words.json'), 'utf8')).topics.map(t => t.id));
ok('every word maps to a real topic', words.every(w => topicIds.has(w.topic)));

// ---- summary ----
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
