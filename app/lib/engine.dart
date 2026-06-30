// Woordjes learning engine — Dart port of public/js/engine.js.
// Pure logic (no Flutter imports) so it's unit-testable with `dart test`.
import 'dart:math';

class C {
  static const List<int> intervalsDays = [0, 1, 2, 4, 8, 16, 32];
  static const int maxBox = 6;
  static const int demoteStep = 2;
  static const int minBoxOnWrong = 1;
  static const int newWordsPerDay = 10;
  static const int newPerSession = 5;
  static const int newRepsTarget = 2;
  static const int maxDrillAttempts = 6;
  static const int reviewBacklogPause = 30;
  static const int sessionSize = 10;
  static const int maxSessionScreens = 22;
  static const int maxInProgress = 15; // cap on words being learned at once (Learning Expert)
  static const int optionsPerMc = 4;
  static const int learnedMinBox = 5;
  static const int learnedMinDays = 3;
  static const int retryGapInSession = 3;
  static const int freezeEarnDays = 7;
  static const int typoEditDistance = 1;
  // ---- adaptive placement (level check) ----
  static const int placementN = 6; // words per full level evaluation
  static const int placementT = 5; // correct needed to pass an evaluation
  static const int placementProbe = 3; // words from the level above on a failure
  static const int placementProbePass = 3; // probe words needed to promote (climb)
  static const double placementCognateSim = 0.6; // exclude test words this similar to their English
}

const List<String> levels = ['A1', 'A2', 'B1', 'B2'];
int levelRank(String? l) {
  final i = levels.indexOf(l ?? '');
  return i < 0 ? 0 : i;
}

// ---- adaptive placement decision (pure; mirrors engine.js placementNext) ----
// You are assigned level L only when you fail eval(L) AND fail probe(L+1).
class PlacementStep {
  final String action; // 'finish' | 'batch'
  final String? level; // for finish
  final int levelIdx; // for batch
  final String mode; // for batch: 'eval' | 'probe'
  final String? fallbackLevel; // carried into a probe
  const PlacementStep.finish(this.level)
      : action = 'finish',
        levelIdx = 0,
        mode = 'eval',
        fallbackLevel = null;
  const PlacementStep.batch(this.levelIdx, this.mode, {this.fallbackLevel})
      : action = 'batch',
        level = null;
}

PlacementStep placementNext(int levelIdx, String mode, double batchCorrect, String? fallbackLevel) {
  final last = levels.length - 1;
  final L = levels[levelIdx];
  if (mode == 'eval') {
    if (batchCorrect >= C.placementT) {
      if (levelIdx == last) return PlacementStep.finish(L); // passed top -> cap
      return PlacementStep.batch(levelIdx + 1, 'eval');
    }
    if (levelIdx == last) return PlacementStep.finish(L); // failed top -> assign top
    return PlacementStep.batch(levelIdx + 1, 'probe', fallbackLevel: L);
  }
  // probe: levelIdx is the level above the failed one
  if (batchCorrect >= C.placementProbePass) {
    return PlacementStep.batch(levelIdx, 'eval'); // full re-eval of this higher level
  }
  return PlacementStep.finish(fallbackLevel); // confirmed: stuck one level below
}

// True when the Dutch word is so close to its English translation that a learner
// could guess it without knowing Dutch (a cognate, e.g. water->water, drinken->to
// drink). Excluded from the placement test so spelling similarity can't inflate it.
bool isGuessableCognate(String nl, String en) {
  final a = normalize(nl);
  final b = normalize(en).replaceFirst(RegExp(r'^to\s+'), '');
  if (a.isEmpty || b.isEmpty) return false;
  final sim = 1 - levenshtein(a, b) / max(a.length, b.length);
  return sim >= C.placementCognateSim;
}

// ---- dates as YYYY-MM-DD (local calendar) ----
String _two(int n) => n < 10 ? '0$n' : '$n';
String todayStr([DateTime? d]) {
  d ??= DateTime.now();
  return '${d.year}-${_two(d.month)}-${_two(d.day)}';
}

// Parse as UTC midnight so day differences are exact (no DST 23/25-hour skew,
// which could otherwise reset a streak on clock-change days).
DateTime _parse(String s) {
  final p = s.split('-').map(int.parse).toList();
  return DateTime.utc(p[0], p[1], p[2]);
}

String addDays(String s, int n) {
  final d = _parse(s).add(Duration(days: n));
  return '${d.year}-${_two(d.month)}-${_two(d.day)}';
}

int dayDiff(String from, String to) => _parse(to).difference(_parse(from)).inDays;

// ---- models ----
class Word {
  final int id, listOrder;
  final String type, topic, level, nl, en;
  final String? article, plural, pastSimple, perfect;
  Word({
    required this.id,
    required this.listOrder,
    required this.type,
    required this.topic,
    required this.level,
    required this.nl,
    required this.en,
    this.article,
    this.plural,
    this.pastSimple,
    this.perfect,
  });
  factory Word.fromJson(Map<String, dynamic> j) => Word(
        id: j['id'] as int,
        listOrder: (j['listOrder'] ?? j['id']) as int,
        type: j['type'] as String,
        topic: j['topic'] as String,
        level: j['level'] as String,
        nl: j['nl'] as String,
        en: j['en'] as String,
        article: j['article'] as String?,
        plural: j['plural'] as String?,
        pastSimple: j['pastSimple'] as String?,
        perfect: j['perfect'] as String?,
      );
}

class Wcard {
  int wordId, box, consecutiveCorrect, distinctCorrectDays, lapses;
  String? nextDue, lastReviewed, lastCorrectDay, lastResult;
  bool learned;
  String firstSeenDay;
  Wcard({
    required this.wordId,
    this.box = 0,
    this.nextDue,
    this.lastReviewed,
    this.consecutiveCorrect = 0,
    this.distinctCorrectDays = 0,
    this.lastCorrectDay,
    this.lastResult,
    this.lapses = 0,
    this.learned = false,
    required this.firstSeenDay,
  });
  factory Wcard.fromJson(Map<String, dynamic> j) => Wcard(
        wordId: j['wordId'] as int,
        box: (j['box'] ?? 0) as int,
        nextDue: j['nextDue'] as String?,
        lastReviewed: j['lastReviewed'] as String?,
        consecutiveCorrect: (j['consecutiveCorrect'] ?? 0) as int,
        distinctCorrectDays: (j['distinctCorrectDays'] ?? 0) as int,
        lastCorrectDay: j['lastCorrectDay'] as String?,
        lastResult: j['lastResult'] as String?,
        lapses: (j['lapses'] ?? 0) as int,
        learned: (j['learned'] ?? false) as bool,
        firstSeenDay: (j['firstSeenDay'] ?? todayStr()) as String,
      );
  Map<String, dynamic> toJson() => {
        'wordId': wordId,
        'box': box,
        'nextDue': nextDue,
        'lastReviewed': lastReviewed,
        'consecutiveCorrect': consecutiveCorrect,
        'distinctCorrectDays': distinctCorrectDays,
        'lastCorrectDay': lastCorrectDay,
        'lastResult': lastResult,
        'lapses': lapses,
        'learned': learned,
        'firstSeenDay': firstSeenDay,
      };
}

class UserState {
  int currentStreak, longestStreak, daysSinceFreezeGranted, newCountToday;
  String? lastCompletedDay, level, lastNewDay;
  bool freezeAvailable, hardModeEnabled, reminderOn, onboarded;
  String reminderTime;
  List<int> priorityQueue;
  UserState({
    this.currentStreak = 0,
    this.longestStreak = 0,
    this.lastCompletedDay,
    this.freezeAvailable = false,
    this.daysSinceFreezeGranted = 0,
    this.hardModeEnabled = false,
    this.level,
    List<int>? priorityQueue,
    this.reminderOn = false,
    this.reminderTime = '19:00',
    this.lastNewDay,
    this.newCountToday = 0,
    this.onboarded = false,
  }) : priorityQueue = priorityQueue ?? [];
  factory UserState.fromJson(Map<String, dynamic> j) => UserState(
        currentStreak: (j['currentStreak'] ?? 0) as int,
        longestStreak: (j['longestStreak'] ?? 0) as int,
        lastCompletedDay: j['lastCompletedDay'] as String?,
        freezeAvailable: (j['freezeAvailable'] ?? false) as bool,
        daysSinceFreezeGranted: (j['daysSinceFreezeGranted'] ?? 0) as int,
        hardModeEnabled: (j['hardModeEnabled'] ?? false) as bool,
        level: j['level'] as String?,
        priorityQueue: ((j['priorityQueue'] ?? []) as List).map((e) => e as int).toList(),
        reminderOn: (j['reminderOn'] ?? false) as bool,
        reminderTime: (j['reminderTime'] ?? '19:00') as String,
        lastNewDay: j['lastNewDay'] as String?,
        newCountToday: (j['newCountToday'] ?? 0) as int,
        onboarded: (j['onboarded'] ?? false) as bool,
      );
  Map<String, dynamic> toJson() => {
        'currentStreak': currentStreak,
        'longestStreak': longestStreak,
        'lastCompletedDay': lastCompletedDay,
        'freezeAvailable': freezeAvailable,
        'daysSinceFreezeGranted': daysSinceFreezeGranted,
        'hardModeEnabled': hardModeEnabled,
        'level': level,
        'priorityQueue': priorityQueue,
        'reminderOn': reminderOn,
        'reminderTime': reminderTime,
        'lastNewDay': lastNewDay,
        'newCountToday': newCountToday,
        'onboarded': onboarded,
      };
}

Wcard newCard(int wordId, String today) => Wcard(wordId: wordId, firstSeenDay: today);

bool isDue(Wcard? c, String today) =>
    c != null && c.box >= 1 && c.nextDue != null && dayDiff(c.nextDue!, today) >= 0;

void recordDistinctCorrectDay(Wcard c, String today) {
  if (today != c.lastCorrectDay) {
    c.distinctCorrectDays++;
    c.lastCorrectDay = today;
  }
}

bool updateLearned(Wcard c) {
  if (c.box >= C.learnedMinBox && c.distinctCorrectDays >= C.learnedMinDays && c.lastResult == 'CORRECT') {
    final was = c.learned;
    c.learned = true;
    return !was;
  }
  return false;
}

/// Returns true if the card became newly Learned.
bool onCorrect(Wcard c, String today) {
  c.box = min(c.box + 1, C.maxBox);
  c.nextDue = addDays(today, C.intervalsDays[c.box]);
  c.consecutiveCorrect++;
  c.lastReviewed = today;
  c.lastResult = 'CORRECT';
  recordDistinctCorrectDay(c, today);
  return updateLearned(c);
}

void onWrong(Wcard c, String today) {
  if (c.box != 0) c.box = max(c.box - C.demoteStep, C.minBoxOnWrong);
  c.consecutiveCorrect = 0;
  c.lapses++;
  c.lastReviewed = today;
  c.lastResult = 'WRONG';
  c.nextDue = today;
  if (c.learned) {
    c.learned = false;
    c.distinctCorrectDays = 2;
  }
}

int allowedNewToday(UserState user, String today, int dueCountVal, bool ignoreBacklog) {
  final introduced = (user.lastNewDay == today) ? user.newCountToday : 0;
  if (!ignoreBacklog && dueCountVal >= C.reviewBacklogPause) return 0;
  return max(0, C.newWordsPerDay - introduced);
}

class SessionItem {
  final int wordId;
  final bool isNew;
  SessionItem(this.wordId, this.isNew);
}

List<SessionItem> interleave(List<SessionItem> reviews, List<SessionItem> news) {
  if (news.isEmpty) return reviews;
  if (reviews.isEmpty) return news;
  final out = <SessionItem>[];
  int ni = 0, ri = 0;
  while (ri < reviews.length || ni < news.length) {
    for (int k = 0; k < 2 && ri < reviews.length; k++) out.add(reviews[ri++]);
    if (ni < news.length) out.add(news[ni++]);
  }
  return out;
}

List<SessionItem> buildSession(List<Word> words, Map<int, Wcard> cards, UserState user, String today,
    {bool force = false}) {
  final due = words.map((w) => cards[w.id]).whereType<Wcard>().where((c) => isDue(c, today)).toList()
    ..sort((a, b) => dayDiff(b.nextDue!, today) - dayDiff(a.nextDue!, today)); // most overdue first
  final dueItems = due.map((c) => SessionItem(c.wordId, false)).toList();

  // Don't introduce new words once too many are already "in progress" (not yet learned).
  // New words resume steadily as in-progress words graduate to Learned.
  final inProgress = cards.values.where((c) => !c.learned).length;
  final slots = C.maxInProgress - inProgress;
  final nAllowed = [C.newPerSession, allowedNewToday(user, today, due.length, force), slots < 0 ? 0 : slots].reduce(min);
  var newItems = <SessionItem>[];
  if (nAllowed > 0) {
    final minLvl = levelRank(user.level ?? 'A1');
    final pq = user.priorityQueue;
    final prioSet = pq.toSet();
    final prioWords = words.where((w) => prioSet.contains(w.id) && !cards.containsKey(w.id)).toList()
      ..sort((a, b) => pq.indexOf(a.id) - pq.indexOf(b.id));
    final levelWords = words
        .where((w) => !cards.containsKey(w.id) && !prioSet.contains(w.id) && levelRank(w.level) >= minLvl)
        .toList()
      ..sort((a, b) => a.listOrder - b.listOrder);
    newItems = [...prioWords, ...levelWords].take(nAllowed).map((w) => SessionItem(w.id, true)).toList();
  }
  final reviews = dueItems.take(C.sessionSize - newItems.length).toList();
  var queue = interleave(reviews, newItems);

  if (force && queue.length < C.sessionSize) {
    final inQ = queue.map((i) => i.wordId).toSet();
    final extra = words.map((w) => cards[w.id]).whereType<Wcard>().where((c) => !inQ.contains(c.wordId)).toList()
      ..sort((a, b) => a.box - b.box);
    queue = [...queue, ...extra.take(C.sessionSize - queue.length).map((c) => SessionItem(c.wordId, false))];
  }
  return queue;
}

/// 'PREVIEW' | 'MC_NL_EN' | 'MC_EN_NL' | 'TYPING'
String exerciseFor(Wcard c, UserState user, bool previewed) {
  if (c.box == 0 && !previewed) return 'PREVIEW';
  if (c.box <= 1) return 'MC_NL_EN';
  if (c.box <= 3) return 'MC_EN_NL';
  return user.hardModeEnabled ? 'TYPING' : 'MC_EN_NL';
}

// ---- multiple choice ----
String answerText(Word w, String dir, bool bare) {
  if (dir == 'NL_EN') return w.en;
  return (!bare && w.type == 'noun' && w.article != null) ? '${w.article} ${w.nl}' : w.nl;
}

class McOption {
  final String text;
  final int wordId;
  final bool correct;
  final bool half; // placement only: right word, wrong article -> half credit
  McOption(this.text, this.wordId, this.correct, {this.half = false});
}

class McQuestion {
  final String dir, prompt;
  final List<McOption> options;
  McQuestion(this.dir, this.prompt, this.options);
}

McQuestion generateMC(Word target, List<Word> words, String dir, {bool bare = false, Random? rng}) {
  rng ??= Random();
  List<T> shuffled<T>(List<T> a) {
    final c = [...a];
    c.shuffle(rng);
    return c;
  }

  final correctText = answerText(target, dir, bare);
  final sameTypeTopic =
      words.where((w) => w.id != target.id && w.type == target.type && w.topic == target.topic).toList();
  final sameType =
      words.where((w) => w.id != target.id && w.type == target.type && w.topic != target.topic).toList();
  final anyOther = words.where((w) => w.id != target.id && w.type != target.type).toList();
  final tiers = [shuffled(sameTypeTopic), shuffled(sameType), shuffled(anyOther)];

  final picked = <McOption>[];
  final usedText = <String>{correctText.toLowerCase()};
  final want = min(C.optionsPerMc - 1, max(1, words.length - 1));
  for (final tier in tiers) {
    for (final w in tier) {
      if (picked.length >= want) break;
      final t = answerText(w, dir, bare);
      if (t.isEmpty || usedText.contains(t.toLowerCase())) continue;
      usedText.add(t.toLowerCase());
      picked.add(McOption(t, w.id, false));
    }
    if (picked.length >= want) break;
  }
  final options = shuffled([...picked, McOption(correctText, target.id, true)]);
  final prompt = dir == 'NL_EN'
      ? (target.type == 'noun' && target.article != null ? '${target.article} ${target.nl}' : target.nl)
      : target.en;
  return McQuestion(dir, prompt, options);
}

// ---- typing judgement ----
const _vowels = {'a', 'e', 'i', 'o', 'u'};
const Map<String, String> _diac = {
  'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
  'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i', 'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o',
  'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u', 'ç': 'c', 'ñ': 'n',
};
String _stripDiacritics(String s) {
  final b = StringBuffer();
  for (final ch in s.split('')) {
    b.write(_diac[ch] ?? ch);
  }
  return b.toString();
}

String normalize(String? s) =>
    _stripDiacritics((s ?? '').trim().toLowerCase()).replaceAll(RegExp(r'\s+'), ' ');

int levenshtein(String a, String b) {
  final m = a.length, n = b.length;
  final dp = List.generate(m + 1, (i) => List<int>.filled(n + 1, 0));
  for (var j = 0; j <= n; j++) dp[0][j] = j;
  for (var i = 0; i <= m; i++) dp[i][0] = i;
  for (var i = 1; i <= m; i++) {
    for (var j = 1; j <= n; j++) {
      dp[i][j] = [
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1),
      ].reduce(min);
    }
  }
  return dp[m][n];
}

List<String> _singleEditChars(String a, String b) {
  if (a.length == b.length) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return [a[i], b[i]];
    }
    return [];
  }
  final shortS = a.length < b.length ? a : b;
  final longS = a.length < b.length ? b : a;
  for (var i = 0; i < shortS.length; i++) {
    if (shortS[i] != longS[i]) return [longS[i]];
  }
  return [longS[longS.length - 1]];
}

String expectedTyped(Word w) =>
    (w.type == 'noun' && w.article != null) ? '${w.article} ${w.nl}' : w.nl;

/// 'CORRECT' | 'ALMOST' | 'WRONG'
String judgeTyped(String typed, Word w) {
  final t = normalize(typed), e = normalize(expectedTyped(w));
  if (t == e) return 'CORRECT';
  if (levenshtein(t, e) == C.typoEditDistance) {
    final chars = _singleEditChars(t, e);
    final involvesVowel = chars.any((c) => _vowels.contains(c));
    if (!involvesVowel) return 'ALMOST';
  }
  return 'WRONG';
}

// ---- streak ----
void _refillFreeze(UserState u) {
  if (!u.freezeAvailable && u.daysSinceFreezeGranted >= C.freezeEarnDays) {
    u.freezeAvailable = true;
    u.daysSinceFreezeGranted = 0;
  }
}

void updateStreak(UserState u, String today) {
  if (u.lastCompletedDay == today) return;
  if (u.lastCompletedDay == null) {
    u.currentStreak = 1;
  } else {
    final gap = dayDiff(u.lastCompletedDay!, today);
    if (gap == 1) {
      u.currentStreak++;
    } else if (gap == 2 && u.freezeAvailable) {
      u.currentStreak++;
      u.freezeAvailable = false;
    } else {
      u.currentStreak = 1;
    }
  }
  u.lastCompletedDay = today;
  u.longestStreak = max(u.longestStreak, u.currentStreak);
  u.daysSinceFreezeGranted++;
  _refillFreeze(u);
}

int dueCount(List<Word> words, Map<int, Wcard> cards, String today) =>
    words.where((w) => isDue(cards[w.id], today)).length;
int learnedCount(Map<int, Wcard> cards) => cards.values.where((c) => c.learned).length;
