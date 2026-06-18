// Mirrors tests/engine.test.js for the Dart engine. Run with `flutter test`.
import 'package:flutter_test/flutter_test.dart';
import 'package:woordjes/engine.dart';

Word noun(int id, String nl, String en, String art, String pl, {String topic = 't', String level = 'A1', int order = 0}) =>
    Word(id: id, listOrder: order == 0 ? id : order, type: 'noun', topic: topic, level: level, nl: nl, en: en, article: art, plural: pl);
Word verb(int id, String nl, String en, String ps, String pf, {String topic = 'v', String level = 'A1', int order = 0}) =>
    Word(id: id, listOrder: order == 0 ? id : order, type: 'verb', topic: topic, level: level, nl: nl, en: en, pastSimple: ps, perfect: pf);

void main() {
  test('dates', () {
    expect(addDays('2026-06-17', 1), '2026-06-18');
    expect(addDays('2026-06-30', 1), '2026-07-01');
    expect(dayDiff('2026-06-17', '2026-06-20'), 3);
  });

  test('leitner promote + due', () {
    final c = newCard(1, '2026-06-17');
    expect(c.box, 0);
    expect(isDue(c, '2026-06-17'), false);
    onCorrect(c, '2026-06-17');
    expect(c.box, 1);
    expect(c.nextDue, '2026-06-18');
    expect(isDue(c, '2026-06-18'), true);
    expect(isDue(c, '2026-06-25'), true); // overdue
  });

  test('gentle demotion', () {
    final h = newCard(2, '2026-06-01')..box = 5..nextDue = '2026-06-10';
    onWrong(h, '2026-06-15');
    expect(h.box, 3);
    expect(h.nextDue, '2026-06-15');
    final lo = newCard(3, '2026-06-01')..box = 1;
    onWrong(lo, '2026-06-15');
    expect(lo.box, 1);
  });

  test('learned needs 3 distinct days', () {
    final L = newCard(4, '2026-06-01')..box = 5;
    for (var i = 0; i < 5; i++) {
      L.lastResult = 'CORRECT';
      onCorrect(L, '2026-06-10');
    }
    expect(L.learned, false); // same-day repeats
    final M = newCard(5, '2026-06-01')..box = 4;
    onCorrect(M, '2026-06-02');
    onCorrect(M, '2026-06-10');
    onCorrect(M, '2026-06-20');
    expect(M.learned, true);
    onWrong(M, '2026-06-21');
    expect(M.learned, false);
  });

  test('mc generation + article on options', () {
    final words = [
      noun(45, 'brood', 'bread', 'het', 'broden', topic: 'food'),
      noun(46, 'kaas', 'cheese', 'de', 'kazen', topic: 'food'),
      noun(47, 'melk', 'milk', 'de', '—', topic: 'food'),
      noun(48, 'water', 'water', 'het', '—', topic: 'food'),
      noun(49, 'appel', 'apple', 'de', 'appels', topic: 'food'),
    ];
    final target = words[0];
    final mc = generateMC(target, words, 'EN_NL');
    expect(mc.options.length, 4);
    expect(mc.options.where((o) => o.correct).length, 1);
    expect(mc.options.map((o) => o.text.toLowerCase()).toSet().length, mc.options.length);
    expect(mc.options.firstWhere((o) => o.correct).wordId, 45);
    expect(mc.options.firstWhere((o) => o.correct).text, 'het brood'); // article shown
    final bare = generateMC(target, words, 'EN_NL', bare: true);
    expect(bare.options.firstWhere((o) => o.correct).text, 'brood'); // bare for de/het test
  });

  test('typing judgement', () {
    final brood = noun(1, 'brood', 'bread', 'het', 'broden');
    expect(judgeTyped('het brood', brood), 'CORRECT');
    expect(judgeTyped('brood', brood), 'WRONG'); // missing article strict
    expect(judgeTyped('de brood', brood), 'WRONG');
    final werken = verb(2, 'werken', 'to work', 'werkte', 'gewerkt');
    expect(judgeTyped('werken', werken), 'CORRECT');
    expect(judgeTyped('Werken', werken), 'CORRECT');
    expect(judgeTyped('werkem', werken), 'ALMOST'); // consonant substitution
    expect(judgeTyped('werke', werken), 'ALMOST'); // drop final consonant
    expect(judgeTyped('wrken', werken), 'WRONG'); // drop a vowel
    expect(judgeTyped('werkon', werken), 'WRONG'); // vowel change
  });

  test('streak + freeze', () {
    final u = UserState();
    updateStreak(u, '2026-06-01');
    expect(u.currentStreak, 1);
    updateStreak(u, '2026-06-02');
    expect(u.currentStreak, 2);
    updateStreak(u, '2026-06-02');
    expect(u.currentStreak, 2);
    updateStreak(u, '2026-06-04'); // 2-day gap, no freeze
    expect(u.currentStreak, 1);
    final u2 = UserState();
    for (var i = 0; i < 7; i++) updateStreak(u2, addDays('2026-07-01', i));
    expect(u2.freezeAvailable, true);
    expect(u2.currentStreak, 7);
    updateStreak(u2, addDays('2026-07-01', 8)); // skip 1 day -> freeze bridges
    expect(u2.currentStreak, 8);
    expect(u2.freezeAvailable, false);
  });

  test('session caps + level + priority', () {
    final words = List.generate(60, (i) => noun(i + 1, 'w$i', 'm$i', i.isEven ? 'de' : 'het', 'w${i}s', topic: 't${i % 5}', level: levels[i % 4], order: i + 1));
    final fresh = <int, Wcard>{};
    final u = UserState();
    final s = buildSession(words, fresh, u, '2026-06-17');
    expect(s.isNotEmpty, true);
    expect(s.where((i) => i.isNew).length <= C.newPerSession, true);
    expect(s.length <= C.sessionSize, true);

    final uB = UserState()..level = 'B1';
    final byId = {for (final w in words) w.id: w};
    final lvl = buildSession(words, {}, uB, '2026-06-17', force: true);
    expect(lvl.where((i) => i.isNew).every((i) => levelRank(byId[i.wordId]!.level) >= levelRank('B1')), true);

    final lastId = words.last.id;
    final uP = UserState()..priorityQueue = [lastId];
    final ps = buildSession(words, {}, uP, '2026-06-17');
    expect(ps.any((i) => i.isNew && i.wordId == lastId), true);
  });
}
