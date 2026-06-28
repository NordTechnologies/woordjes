import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:url_launcher/url_launcher.dart';
import 'engine.dart';
import 'notifications.dart';
import 'logger.dart';

// ---- audio (tap to hear the Dutch word) ----
final FlutterTts _tts = FlutterTts();
Future<void> speak(String text) async {
  try {
    await _tts.stop();
    await _tts.setLanguage('nl-NL');
    await _tts.setSpeechRate(0.45);
    await _tts.speak(text);
  } catch (_) {}
}

Widget speakBtn(String text) => IconButton(
      visualDensity: VisualDensity.compact,
      icon: const Icon(Icons.volume_up_rounded, color: inkBlue, size: 22),
      onPressed: () => speak(text),
    );

// ---- palette (from Design Spec) ----
const inkBlue = Color(0xFF1E3A5F);
const inkDeep = Color(0xFF16314F);
const orange = Color(0xFFE8743B);
const accentSoft = Color(0xFFFBEAE0);
const accentText = Color(0xFFB5531F);
const green = Color(0xFF2E9E6B);
const greenSoft = Color(0xFFE3F4EC);
const coral = Color(0xFFD9663F);
const coralSoft = Color(0xFFFBE8E1);
const bg = Color(0xFFF7F8FA);
const surface = Color(0xFFFFFFFF);
const surfaceAlt = Color(0xFFEEF1F5);
const cBorder = Color(0xFFE2E6EC);
const t1 = Color(0xFF1A1F26);
const t2 = Color(0xFF5B6470);
const t3 = Color(0xFF8A94A1);

late List<Word> words;
late Map<int, Word> byId;
late List<Map<String, String>> topics;

String dispNL(Word w) => (w.type == 'noun' && w.article != null) ? '${w.article} ${w.nl}' : w.nl;
List<Word> topicWords(String tid) => words.where((w) => w.topic == tid).toList();

// ---- storage ----
class Store {
  static late SharedPreferences sp;
  static Map<int, Wcard> cards = {};
  static UserState user = UserState();

  static Future<void> init() async {
    sp = await SharedPreferences.getInstance();
    final c = sp.getString('wj.cards');
    if (c != null) {
      final m = jsonDecode(c) as Map<String, dynamic>;
      cards = m.map((k, v) => MapEntry(int.parse(k), Wcard.fromJson(v as Map<String, dynamic>)));
    }
    final u = sp.getString('wj.user');
    if (u != null) user = UserState.fromJson(jsonDecode(u) as Map<String, dynamic>);
  }

  static Future<void> save() async {
    await sp.setString('wj.cards', jsonEncode(cards.map((k, v) => MapEntry('$k', v.toJson()))));
    await sp.setString('wj.user', jsonEncode(user.toJson()));
  }

  static Wcard ensure(int id) => cards.putIfAbsent(id, () => newCard(id, todayStr()));
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final raw = await rootBundle.loadString('assets/words.json');
  final data = jsonDecode(raw) as Map<String, dynamic>;
  words = (data['words'] as List).map((j) => Word.fromJson(j as Map<String, dynamic>)).toList();
  byId = {for (final w in words) w.id: w};
  topics = (data['topics'] as List)
      .map((t) => {'id': t['id'] as String, 'name': t['name'] as String, 'emoji': t['emoji'] as String})
      .toList();
  await initLog();
  await Store.init();
  if (Store.user.reminderOn) {
    final p = Store.user.reminderTime.split(':');
    scheduleDailyReminder(int.parse(p[0]), int.parse(p[1])); // re-arm on launch
  }
  runApp(const WoordjesApp());
}

class WoordjesApp extends StatelessWidget {
  const WoordjesApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Woordjes',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        scaffoldBackgroundColor: bg,
        colorScheme: ColorScheme.fromSeed(seedColor: inkBlue, primary: inkBlue),
        useMaterial3: true,
      ),
      home: const Root(),
    );
  }
}

// ---- root gate: onboarding vs home ----
class Root extends StatefulWidget {
  const Root({super.key});
  @override
  State<Root> createState() => _RootState();
}

class _RootState extends State<Root> {
  @override
  Widget build(BuildContext context) {
    if (!Store.user.onboarded) return OnboardingFlow(onDone: () => setState(() {}));
    return const HomeShell();
  }
}

const Map<String, String> levelDesc = {
  'A1': 'Beginner — just starting out',
  'A2': 'Elementary — basic everyday Dutch',
  'B1': 'Intermediate — everyday conversations',
  'B2': 'Upper-intermediate — complex topics',
};

class OnboardingFlow extends StatefulWidget {
  final VoidCallback onDone;
  final String startPhase; // 'welcome' (first run) or 'placement' (re-evaluate)
  const OnboardingFlow({super.key, required this.onDone, this.startPhase = 'welcome'});
  @override
  State<OnboardingFlow> createState() => _OnboardingFlowState();
}

class _OnboardingFlowState extends State<OnboardingFlow> {
  late String phase;
  // adaptive staircase + confirmation probe (see engine.dart placementNext)
  int levelIdx = 0;
  String mode = 'eval'; // 'eval' | 'probe'
  List<Word> batchWords = [];
  int batchCorrect = 0;
  int idxInBatch = 0;
  String? fallbackLevel;
  final Set<int> usedIds = {};
  McQuestion? q;
  int? chosen;
  String resultLevel = 'A1';

  @override
  void initState() {
    super.initState();
    phase = widget.startPhase;
    if (phase == 'placement') _prepPlacement(); // re-evaluate: jump straight into the check
  }

  List<Word> _pickWords(String lv, int count) {
    final pool = words.where((w) => w.level == lv && !usedIds.contains(w.id)).toList()..shuffle();
    final picked = pool.take(min(count, pool.length)).toList();
    for (final w in picked) {
      usedIds.add(w.id);
    }
    return picked;
  }

  // Builds the next batch's words + first question. Caller wraps in setState when live.
  void _startBatch(int li, String m) {
    levelIdx = li;
    mode = m;
    batchCorrect = 0;
    idxInBatch = 0;
    batchWords = _pickWords(levels[li], m == 'probe' ? C.placementProbe : C.placementN);
    q = generateMC(batchWords[0], words, 'NL_EN');
    chosen = null;
  }

  void _prepPlacement() {
    usedIds.clear();
    fallbackLevel = null;
    _startBatch(0, 'eval');
  }

  void _startPlacement() {
    _prepPlacement();
    setState(() => phase = 'placement');
  }

  void _finish(String lvl) {
    resultLevel = lvl;
    _setLevel(lvl);
    setState(() => phase = 'result');
  }

  void _answer(int i) {
    if (i >= 0 && q!.options[i].correct) batchCorrect++;
    setState(() => chosen = i >= 0 ? i : q!.options.indexWhere((o) => o.correct));
    Future.delayed(const Duration(milliseconds: 400), () {
      idxInBatch++;
      if (idxInBatch < batchWords.length) {
        setState(() {
          q = generateMC(batchWords[idxInBatch], words, 'NL_EN');
          chosen = null;
        });
        return;
      }
      final next = placementNext(levelIdx, mode, batchCorrect, fallbackLevel);
      if (next.action == 'finish') {
        _finish(next.level!);
      } else {
        if (next.fallbackLevel != null) fallbackLevel = next.fallbackLevel;
        setState(() => _startBatch(next.levelIdx, next.mode));
      }
    });
  }

  void _setLevel(String l) {
    Store.user.level = l;
    Store.user.onboarded = true;
    Store.save();
  }

  @override
  Widget build(BuildContext context) {
    Widget body;
    if (phase == 'welcome') {
      body = _welcome();
    } else if (phase == 'levelpick') {
      body = _levelPick();
    } else if (phase == 'placement') {
      body = _placement();
    } else {
      body = _result();
    }
    return Scaffold(body: SafeArea(child: Padding(padding: const EdgeInsets.all(20), child: body)));
  }

  Widget _welcome() => Column(mainAxisAlignment: MainAxisAlignment.center, children: [
        const Text('🇳🇱', style: TextStyle(fontSize: 56)),
        const SizedBox(height: 8),
        const Text('Welkom bij Woordjes', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: t1), textAlign: TextAlign.center),
        const SizedBox(height: 10),
        const Text('Learn the Dutch words you need — 5 minutes a day, no typing required.', style: TextStyle(color: t2), textAlign: TextAlign.center),
        const SizedBox(height: 8),
        const Text("Let's find your level so you start in the right place.", style: TextStyle(color: t3), textAlign: TextAlign.center),
        const SizedBox(height: 28),
        SizedBox(width: double.infinity, child: FilledButton(style: FilledButton.styleFrom(backgroundColor: inkBlue, minimumSize: const Size.fromHeight(52)), onPressed: _startPlacement, child: const Text('Take a 1-minute level check', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)))),
        const SizedBox(height: 12),
        SizedBox(width: double.infinity, child: OutlinedButton(style: OutlinedButton.styleFrom(foregroundColor: inkBlue, side: const BorderSide(color: inkBlue, width: 1.5), minimumSize: const Size.fromHeight(52)), onPressed: () => setState(() => phase = 'levelpick'), child: const Text("I'll choose my level", style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)))),
      ]);

  Widget _levelPick() => ListView(children: [
        const SizedBox(height: 8),
        const Text('Choose your level', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: t1)),
        const SizedBox(height: 6),
        const Text('You can change this anytime.', style: TextStyle(color: t3)),
        const SizedBox(height: 16),
        ...levels.map((l) => Card(
              margin: const EdgeInsets.only(bottom: 10),
              child: ListTile(
                leading: CircleAvatar(backgroundColor: inkBlue, child: Text(l, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 13))),
                title: Text(l, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text(levelDesc[l]!, style: const TextStyle(color: t3, fontSize: 13)),
                trailing: const Icon(Icons.chevron_right, color: t3),
                onTap: () {
                  resultLevel = l;
                  _setLevel(l);
                  setState(() => phase = 'result');
                },
              ),
            )),
      ]);

  Widget _levelStep(String l, int i) {
    Color bg = surfaceAlt, fg = t3;
    BoxBorder? border;
    String label = l;
    if (i < levelIdx) {
      bg = greenSoft;
      fg = green;
      label = '$l ✓';
    } else if (i == levelIdx) {
      if (mode == 'probe') {
        bg = surface;
        fg = inkBlue;
        border = Border.all(color: inkBlue, width: 1.5);
      } else {
        bg = inkBlue;
        fg = Colors.white;
      }
    }
    return Expanded(
      child: Container(
        height: 26,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: bg, border: border, borderRadius: BorderRadius.circular(999)),
        child: Text(label, style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w700)),
      ),
    );
  }

  Widget _placement() {
    final correctIdx = q!.options.indexWhere((o) => o.correct);
    final label = mode == 'probe' ? 'Quick check · ${levels[levelIdx]}' : 'Level ${levels[levelIdx]}';
    return Column(children: [
      Row(children: [
        for (int i = 0; i < levels.length; i++) ...[
          _levelStep(levels[i], i),
          if (i < levels.length - 1) const SizedBox(width: 6),
        ],
      ]),
      const SizedBox(height: 14),
      Row(children: [
        Text(label, style: const TextStyle(color: t3, fontSize: 13, fontWeight: FontWeight.w600)),
        const SizedBox(width: 12),
        Expanded(child: LinearProgressIndicator(value: idxInBatch / batchWords.length, backgroundColor: surfaceAlt, color: inkBlue, minHeight: 8, borderRadius: BorderRadius.circular(999))),
        const SizedBox(width: 12),
        Text('${idxInBatch + 1}/${batchWords.length}', style: const TextStyle(color: t3, fontSize: 13, fontWeight: FontWeight.w600)),
      ]),
      const SizedBox(height: 28),
      const Text('What does this mean?', style: TextStyle(color: t3)),
      const SizedBox(height: 8),
      Text(q!.prompt, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: t1)),
      const SizedBox(height: 24),
      ...List.generate(q!.options.length, (i) {
        final o = q!.options[i];
        Color bgc = surface, bc = cBorder;
        if (chosen != null) {
          if (i == correctIdx) {
            bgc = greenSoft;
            bc = green;
          } else if (i == chosen) {
            bgc = coralSoft;
            bc = coral;
          }
        }
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              style: OutlinedButton.styleFrom(backgroundColor: bgc, side: BorderSide(color: bc, width: 1.5), minimumSize: const Size.fromHeight(56), foregroundColor: t1),
              onPressed: chosen == null ? () => _answer(i) : null,
              child: Text(o.text, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w500)),
            ),
          ),
        );
      }),
      TextButton(onPressed: chosen == null ? () => _answer(-1) : null, child: const Text("I don't know this one", style: TextStyle(color: accentText))),
    ]);
  }

  Widget _result() {
    final reeval = widget.startPhase == 'placement';
    return Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      const Text('🎯', style: TextStyle(fontSize: 48)),
      const SizedBox(height: 12),
      Text("You're ${reeval ? 'now at' : 'starting at'} $resultLevel", style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w700, color: t1)),
      const SizedBox(height: 8),
      Text("We'll suggest new words from $resultLevel and up — change it anytime in settings.", style: const TextStyle(color: t2), textAlign: TextAlign.center),
      const SizedBox(height: 24),
      SizedBox(width: double.infinity, child: FilledButton(style: FilledButton.styleFrom(backgroundColor: inkBlue, minimumSize: const Size.fromHeight(52)), onPressed: widget.onDone, child: Text(reeval ? 'Done' : 'Start learning ▸', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)))),
    ]);
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int tab = 0;

  Future<void> _startSession({bool force = false}) async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TrainingScreen(force: force)));
    setState(() {}); // refresh after session
  }

  @override
  Widget build(BuildContext context) {
    final body = tab == 0 ? TodayTab(onStart: _startSession, onChanged: () => setState(() {})) : const WordsTab();
    return Scaffold(
      body: SafeArea(child: body),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (i) => setState(() => tab = i),
        destinations: const [
          NavigationDestination(icon: Text('☀️', style: TextStyle(fontSize: 20)), label: 'Today'),
          NavigationDestination(icon: Text('🏆', style: TextStyle(fontSize: 20)), label: 'Words'),
        ],
      ),
    );
  }
}

// ---- Today ----
class TodayTab extends StatelessWidget {
  final Future<void> Function({bool force}) onStart;
  final VoidCallback onChanged;
  const TodayTab({super.key, required this.onStart, required this.onChanged});

  void _changeLevel(BuildContext context) {
    showModalBottomSheet(
      context: context,
      builder: (_) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Padding(padding: EdgeInsets.all(16), child: Text('Your level', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18))),
          ...levels.map((l) => ListTile(
                leading: CircleAvatar(backgroundColor: inkBlue, radius: 16, child: Text(l, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700))),
                title: Text(l),
                subtitle: Text(levelDesc[l]!, style: const TextStyle(fontSize: 12)),
                trailing: (Store.user.level ?? 'A1') == l ? const Icon(Icons.check, color: green) : null,
                onTap: () {
                  Store.user.level = l;
                  Store.save();
                  Navigator.pop(context);
                  onChanged();
                },
              )),
          const SizedBox(height: 8),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final today = todayStr();
    final due = dueCount(words, Store.cards, today);
    final shown = due < C.sessionSize ? due : C.sessionSize;
    final hasNew = words.any((w) => !Store.cards.containsKey(w.id));
    final learned = learnedCount(Store.cards);
    final h = DateTime.now().hour;
    final greet = h < 12 ? 'Goedemorgen' : (h < 18 ? 'Goedemiddag' : 'Goedenavond');

    String heroTitle, heroSub, btn;
    bool force;
    if (shown > 0) {
      heroTitle = '$shown';
      heroSub = 'word${shown == 1 ? '' : 's'} due today · ~5 min';
      btn = 'Start ▸';
      force = false;
    } else if (hasNew) {
      heroTitle = '0';
      heroSub = 'All caught up 🎉 Learn new words?';
      btn = 'Learn new words ▸';
      force = true;
    } else {
      heroTitle = '🎉';
      heroSub = "You're all caught up. Come back tomorrow!";
      btn = 'Practice anyway';
      force = true;
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text('$greet 👋', style: const TextStyle(color: t2, fontSize: 16)),
          Row(children: [
            GestureDetector(onTap: () => _changeLevel(context), child: _pill(Store.user.level ?? 'A1', inkBlue, Colors.white)),
            const SizedBox(width: 8),
            _pill('🔥 ${Store.user.currentStreak}', accentSoft, accentText),
            IconButton(
              onPressed: () async {
                await Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen()));
                onChanged();
              },
              icon: const Icon(Icons.settings, color: t3, size: 22),
            ),
          ]),
        ]),
        const SizedBox(height: 12),
        const Text('Today', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: t1)),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(22),
          decoration: BoxDecoration(
            gradient: const LinearGradient(colors: [inkBlue, inkDeep], begin: Alignment.topLeft, end: Alignment.bottomRight),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(heroTitle, style: const TextStyle(color: Colors.white, fontSize: 40, fontWeight: FontWeight.w700, height: 1)),
            const SizedBox(height: 4),
            Text(heroSub, style: const TextStyle(color: Colors.white70, fontSize: 15)),
            const SizedBox(height: 18),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                style: FilledButton.styleFrom(backgroundColor: Colors.white, foregroundColor: inkBlue, minimumSize: const Size.fromHeight(52)),
                onPressed: () => onStart(force: force),
                child: Text(btn, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 17)),
              ),
            ),
          ]),
        ),
        const SizedBox(height: 24),
        Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
          _stat('$learned', 'learned', inkBlue),
          _stat('${Store.cards.length - learned}', 'in progress', accentText),
          _stat('${words.length}', 'total', t3),
        ]),
      ],
    );
  }

  Widget _stat(String n, String label, Color c) => Column(children: [
        Text(n, style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: c)),
        Text(label, style: const TextStyle(color: t3, fontSize: 13)),
      ]);
}

Widget _pill(String text, Color bgc, Color fg) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(color: bgc, borderRadius: BorderRadius.circular(999)),
      child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w700, fontSize: 14)),
    );

const String buildVersion = 'native.1';

bool addToPriority(int id) {
  if (Store.cards.containsKey(id)) return false;
  if (Store.user.priorityQueue.contains(id)) return false;
  Store.user.priorityQueue.add(id);
  Store.save();
  return true;
}

void showLevelSheet(BuildContext context, VoidCallback onChanged) {
  showModalBottomSheet(
    context: context,
    builder: (_) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Padding(padding: EdgeInsets.all(16), child: Text('Your level', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18))),
        ...levels.map((l) => ListTile(
              leading: CircleAvatar(backgroundColor: inkBlue, radius: 16, child: Text(l, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700))),
              title: Text(l),
              subtitle: Text(levelDesc[l]!, style: const TextStyle(fontSize: 12)),
              trailing: (Store.user.level ?? 'A1') == l ? const Icon(Icons.check, color: green) : null,
              onTap: () {
                Store.user.level = l;
                Store.save();
                Navigator.pop(context);
                onChanged();
              },
            )),
        const SizedBox(height: 8),
      ]),
    ),
  );
}

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  @override
  Widget build(BuildContext context) {
    final u = Store.user;
    return Scaffold(
      appBar: AppBar(title: const Text('You'), backgroundColor: bg, foregroundColor: t1, elevation: 0),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Card(
          child: Column(children: [
            ListTile(
              title: const Text('Your level'),
              subtitle: const Text('New words come from here and up'),
              trailing: OutlinedButton(onPressed: () => showLevelSheet(context, () => setState(() {})), child: Text(u.level ?? 'A1')),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.assignment_outlined, color: inkBlue),
              title: const Text('Reevaluate my level'),
              subtitle: const Text('Retake the quick placement check'),
              trailing: const Icon(Icons.chevron_right, color: t3),
              onTap: () async {
                logEvent('reevaluate level: started');
                await Navigator.push(context, MaterialPageRoute(
                  builder: (_) => OnboardingFlow(startPhase: 'placement', onDone: () => Navigator.pop(context)),
                ));
                logEvent('reevaluate level: now ${Store.user.level}');
                if (mounted) setState(() {});
              },
            ),
            const Divider(height: 1),
            SwitchListTile(
              title: const Text('Hard mode (typing)'),
              subtitle: const Text('Type the Dutch word once you know it well'),
              value: u.hardModeEnabled,
              activeColor: inkBlue,
              onChanged: (v) {
                setState(() => u.hardModeEnabled = v);
                Store.save();
              },
            ),
            const Divider(height: 1),
            SwitchListTile(
              title: const Text('Daily reminder'),
              subtitle: const Text('One gentle nudge (delivered in the installed app)'),
              value: u.reminderOn,
              activeColor: inkBlue,
              onChanged: (v) async {
                if (v) {
                  final granted = await requestNotifPermission(); // in-context permission
                  if (granted) {
                    final p = u.reminderTime.split(':');
                    await scheduleDailyReminder(int.parse(p[0]), int.parse(p[1]));
                  }
                  setState(() => u.reminderOn = granted);
                } else {
                  await cancelReminders();
                  setState(() => u.reminderOn = false);
                }
                Store.save();
              },
            ),
            if (u.reminderOn)
              ListTile(
                title: const Text('Reminder time'),
                trailing: Text(u.reminderTime, style: const TextStyle(fontWeight: FontWeight.w600)),
                onTap: () async {
                  final parts = u.reminderTime.split(':');
                  final picked = await showTimePicker(context: context, initialTime: TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])));
                  if (picked != null) {
                    setState(() => u.reminderTime = '${picked.hour.toString().padLeft(2, '0')}:${picked.minute.toString().padLeft(2, '0')}');
                    await scheduleDailyReminder(picked.hour, picked.minute);
                    Store.save();
                  }
                },
              ),
          ]),
        ),
        const SizedBox(height: 18),
        const Padding(padding: EdgeInsets.only(left: 4, bottom: 6), child: Text('Help & feedback', style: TextStyle(color: t3, fontSize: 13, fontWeight: FontWeight.w600))),
        Card(
          child: Column(children: [
            ListTile(
              leading: const Icon(Icons.mail_outline, color: inkBlue),
              title: const Text('Contact the developer'),
              subtitle: const Text('Send feedback or report a problem'),
              onTap: _contactDeveloper,
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.description_outlined, color: inkBlue),
              title: const Text('Send logs to developer'),
              subtitle: const Text('Shares an on-device log to help diagnose issues'),
              onTap: () => shareLogs(),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.info_outline, color: inkBlue),
              title: const Text('About & word levels'),
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const InfoScreen())),
            ),
          ]),
        ),
        const SizedBox(height: 30),
        Center(child: TextButton(onPressed: _confirmReset, child: const Text('Reset all progress', style: TextStyle(color: t3, fontSize: 13)))),
        const SizedBox(height: 6),
        Text('Woordjes · build $buildVersion · ${words.length} words', style: const TextStyle(color: t3, fontSize: 12), textAlign: TextAlign.center),
      ]),
    );
  }

  Future<void> _contactDeveloper() async {
    final uri = Uri(scheme: 'mailto', path: 'nord_technologies@proton.me', queryParameters: {'subject': 'Woordjes feedback (build $buildVersion)'});
    try {
      await launchUrl(uri);
    } catch (_) {}
  }

  Future<void> _confirmReset() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Reset all progress?'),
        content: const Text('This permanently erases your streak, learned words and level. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(style: TextButton.styleFrom(foregroundColor: coral), onPressed: () => Navigator.pop(context, true), child: const Text('Reset')),
        ],
      ),
    );
    if (ok == true) {
      logEvent('progress reset by user');
      Store.cards.clear();
      Store.user = UserState();
      await Store.save();
      if (mounted) {
        Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => const Root()), (r) => false);
      }
    }
  }
}

// ---- Info / About (word-level methodology + sources) ----
class InfoScreen extends StatelessWidget {
  const InfoScreen({super.key});
  @override
  Widget build(BuildContext context) {
    Future<void> open(String url) async {
      try {
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      } catch (_) {}
    }
    return Scaffold(
      appBar: AppBar(title: const Text('About'), backgroundColor: bg, foregroundColor: t1, elevation: 0),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        const Text('How word levels are decided', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: t1)),
        const SizedBox(height: 10),
        const Text(
          'Every word in Woordjes is tagged with a CEFR level (A1–B2). These levels are '
          'data-driven, not guessed: each word is placed at the level where it first appears '
          'with real frequency in graded Dutch-as-a-second-language texts. That keeps the '
          'levels honest for the inburgering exam (which targets A2/B1) and means your '
          'placement test and lessons start you in the right place.',
          style: TextStyle(color: t2, height: 1.5),
        ),
        const SizedBox(height: 16),
        const Text('Source', style: TextStyle(fontWeight: FontWeight.w700, color: t1)),
        const SizedBox(height: 6),
        const Text(
          'Levels are derived from NT2Lex, a CEFR-graded frequency lexicon of Dutch as a '
          'foreign language, from the CEFRLex project (UCLouvain / CENTAL).',
          style: TextStyle(color: t2, height: 1.5),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: () => open('https://cental.uclouvain.be/cefrlex/nt2lex/'),
          icon: const Icon(Icons.link, color: inkBlue),
          label: const Text('cental.uclouvain.be/cefrlex/nt2lex', style: TextStyle(color: inkBlue)),
        ),
        const SizedBox(height: 16),
        const Text('Paper', style: TextStyle(fontWeight: FontWeight.w700, color: t1)),
        const SizedBox(height: 6),
        const Text(
          'Tack, A., François, T., Desmet, P., & Fairon, C. (2018). NT2Lex: A CEFR-Graded '
          'Lexical Resource for Dutch as a Foreign Language Linked to Open Dutch WordNet. '
          'In Proceedings of the 13th Workshop on Innovative Use of NLP for Building '
          'Educational Applications (BEA), ACL.',
          style: TextStyle(color: t2, height: 1.5),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: () => open('https://aclanthology.org/W18-0514/'),
          icon: const Icon(Icons.article_outlined, color: inkBlue),
          label: const Text('Read the paper (ACL Anthology)', style: TextStyle(color: inkBlue)),
        ),
        const SizedBox(height: 24),
        const Text(
          'Word translations and grammar (de/het, plurals, verb forms) are generated and '
          'auto-checked, with a native-speaker review before public release.',
          style: TextStyle(color: t3, fontSize: 13, height: 1.5),
        ),
      ]),
    );
  }
}

// ---- Words (learned + in progress, by topic, expandable) ----
class WordsTab extends StatefulWidget {
  const WordsTab({super.key});
  @override
  State<WordsTab> createState() => _WordsTabState();
}

class _WordsTabState extends State<WordsTab> {
  String query = '';

  List<Widget> _searchResults() {
    final q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    final hits = words.where((w) => w.nl.toLowerCase().contains(q) || w.en.toLowerCase().contains(q)).take(12).toList();
    if (hits.isEmpty) return [const Padding(padding: EdgeInsets.all(8), child: Text('No words found.', style: TextStyle(color: t3)))];
    return [
      Card(
        margin: const EdgeInsets.only(bottom: 16),
        child: Column(
          children: hits.map((w) {
            final c = Store.cards[w.id];
            final queued = Store.user.priorityQueue.contains(w.id);
            Widget action;
            if (c != null && c.learned) {
              action = const Text('🏆 learned', style: TextStyle(color: t3, fontSize: 12));
            } else if (c != null) {
              action = const Text('in progress', style: TextStyle(color: t3, fontSize: 12));
            } else if (queued) {
              action = const Text('added ✓', style: TextStyle(color: accentText, fontSize: 12, fontWeight: FontWeight.w700));
            } else {
              action = OutlinedButton(
                style: OutlinedButton.styleFrom(foregroundColor: inkBlue, side: const BorderSide(color: inkBlue), visualDensity: VisualDensity.compact),
                onPressed: () => setState(() => addToPriority(w.id)),
                child: const Text('+ Learn'),
              );
            }
            return ListTile(
              dense: true,
              title: Text(dispNL(w), style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text('${w.en} · ${w.level}', style: const TextStyle(color: t3, fontSize: 12)),
              trailing: action,
            );
          }).toList(),
        ),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final learned = Store.cards.values.where((c) => c.learned).length;
    final prog = Store.cards.length - learned;
    final sections = <Widget>[];
    for (final t in topics) {
      final tw = topicWords(t['id']!);
      final l = tw.where((w) => Store.cards[w.id]?.learned == true).toList();
      final p = tw.where((w) => Store.cards.containsKey(w.id) && Store.cards[w.id]!.learned == false).toList();
      if (l.isEmpty && p.isEmpty) continue;
      sections.add(Card(
        margin: const EdgeInsets.only(bottom: 10),
        child: ExpansionTile(
          shape: const Border(),
          title: Text('${t['emoji']} ${t['name']}', style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text('${l.length} 🏆 · ${p.length} learning', style: const TextStyle(color: t3, fontSize: 13)),
          children: [
            ...l.map((w) => _wl(w, '🏆')),
            ...p.map((w) => _wl(w, '•')),
          ],
        ),
      ));
    }
    return ListView(padding: const EdgeInsets.fromLTRB(20, 16, 20, 24), children: [
      const Text('Your words', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: t1)),
      const SizedBox(height: 16),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
            _s('$learned', 'learned', inkBlue),
            _s('$prog', 'in progress', accentText),
            _s('${words.length}', 'total', t3),
          ]),
        ),
      ),
      const SizedBox(height: 14),
      TextField(
        onChanged: (v) => setState(() => query = v),
        autocorrect: false,
        decoration: InputDecoration(
          hintText: 'Search a word to learn next…',
          prefixIcon: const Icon(Icons.search, color: t3),
          filled: true,
          fillColor: surface,
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: cBorder)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: inkBlue)),
        ),
      ),
      const SizedBox(height: 12),
      ..._searchResults(),
      if (sections.isEmpty)
        const Padding(padding: EdgeInsets.only(top: 16), child: Text('Start a session and your words will show up here. 🌱', style: TextStyle(color: t3)))
      else
        ...sections,
    ]);
  }

  Widget _s(String n, String l, Color c) => Column(children: [
        Text(n, style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: c)),
        Text(l, style: const TextStyle(color: t3, fontSize: 13)),
      ]);
  Widget _wl(Word w, String mark) => ListTile(
        dense: true,
        leading: Text(mark),
        title: Text(dispNL(w), style: const TextStyle(fontWeight: FontWeight.w600)),
        trailing: Text(w.en, style: const TextStyle(color: t2)),
      );
}

// ---- Training ----
class TrainingScreen extends StatefulWidget {
  final bool force;
  const TrainingScreen({super.key, required this.force});
  @override
  State<TrainingScreen> createState() => _TrainingScreenState();
}

class _TrainingScreenState extends State<TrainingScreen> {
  final today = todayStr();
  late List<SessionItem> queue;
  int idx = 0, answered = 0, correct = 0, newIntroduced = 0;
  final previewed = <int>{};
  final reviewed = <int>{};
  final newReps = <int, int>{};
  final newAttempts = <int, int>{};
  final learnedNames = <Word>[];
  bool done = false;

  McQuestion? mc;
  String exType = 'PREVIEW';
  bool dehet = false;
  int? chosen;
  bool? lastCorrect;
  bool deHetPhase = false;
  String? deHetChosen;
  final _typeCtrl = TextEditingController();
  bool typeAttempted = false;
  String? typedFeedback;

  @override
  void dispose() {
    _typeCtrl.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    queue = buildSession(words, Store.cards, Store.user, today, force: widget.force);
    if (queue.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => Navigator.of(context).pop());
    } else {
      _prepare();
    }
  }

  SessionItem get item => queue[idx];

  void _prepare() {
    final w = byId[item.wordId]!;
    final card = Store.ensure(item.wordId);
    final drill = card.box == 0;
    String ex;
    if (drill && !previewed.contains(item.wordId)) {
      ex = 'PREVIEW';
    } else if (drill) {
      final r = newReps[item.wordId] ?? 0;
      ex = r == 0 ? 'MC_NL_EN' : 'MC_EN_NL';
    } else {
      ex = exerciseFor(card, Store.user, true);
    }
    chosen = null;
    lastCorrect = null;
    deHetPhase = false;
    deHetChosen = null;
    typeAttempted = false;
    typedFeedback = null;
    _typeCtrl.clear();
    exType = ex;
    if (ex == 'PREVIEW' || ex == 'TYPING') {
      mc = null;
    } else {
      final dir = ex == 'MC_NL_EN' ? 'NL_EN' : 'EN_NL';
      dehet = dir == 'EN_NL' && w.type == 'noun' && w.article != null && card.box >= 2;
      mc = generateMC(w, words, dir, bare: dehet);
    }
  }

  void _advance() {
    if (answered >= C.maxSessionScreens || idx + 1 >= queue.length) {
      _finish();
      return;
    }
    setState(() {
      idx++;
      _prepare();
    });
  }

  void _requeueCurrent() {
    final card = Store.ensure(item.wordId);
    final pos = (idx + 1 + C.retryGapInSession).clamp(0, queue.length);
    queue.insert(pos, SessionItem(item.wordId, card.box == 0));
  }

  bool _scoreCorrect(Word w, Wcard card) {
    answered++;
    correct++;
    reviewed.add(w.id);
    if (card.box == 0) {
      newReps[w.id] = (newReps[w.id] ?? 0) + 1;
      newAttempts[w.id] = (newAttempts[w.id] ?? 0) + 1;
      if (newReps[w.id]! >= C.newRepsTarget) {
        if (onCorrect(card, today)) learnedNames.add(w);
        return false;
      }
      return true;
    }
    if (onCorrect(card, today)) learnedNames.add(w);
    return false;
  }

  bool _scoreWrong(Word w, Wcard card) {
    answered++;
    reviewed.add(w.id);
    if (card.box == 0) {
      newReps[w.id] = ((newReps[w.id] ?? 0) - 1).clamp(0, 99);
      newAttempts[w.id] = (newAttempts[w.id] ?? 0) + 1;
      if (newAttempts[w.id]! >= C.maxDrillAttempts) {
        card.box = 1;
        card.nextDue = addDays(today, 1);
        card.lastReviewed = today;
        return false;
      }
      return true;
    }
    onWrong(card, today);
    return true;
  }

  void _onPreviewGotIt() {
    previewed.add(item.wordId);
    if (!reviewed.contains(item.wordId)) newIntroduced++;
    if (Store.user.lastNewDay != today) {
      Store.user.lastNewDay = today;
      Store.user.newCountToday = 0;
    }
    Store.user.newCountToday++;
    Store.save();
    setState(_prepare);
  }

  void _onKnowIt() {
    final c = Store.ensure(item.wordId);
    c.box = C.maxBox;
    c.learned = true;
    c.distinctCorrectDays = C.learnedMinDays;
    c.lastCorrectDay = today;
    c.consecutiveCorrect = C.learnedMinDays;
    c.lastResult = 'CORRECT';
    c.lastReviewed = today;
    c.nextDue = addDays(today, C.intervalsDays[C.maxBox]);
    Store.save();
    _advance();
  }

  void _onPick(int i) {
    final w = byId[item.wordId]!;
    final card = Store.ensure(item.wordId);
    final opt = mc!.options[i];
    if (opt.correct) {
      if (dehet) {
        setState(() {
          chosen = i;
          deHetPhase = true;
        });
        return;
      }
      final again = _scoreCorrect(w, card);
      if (again) _requeueCurrent();
      Store.save();
      setState(() {
        chosen = i;
        lastCorrect = true;
      });
      Future.delayed(const Duration(milliseconds: 650), _advance);
    } else {
      final again = _scoreWrong(w, card);
      if (again) _requeueCurrent();
      Store.save();
      setState(() {
        chosen = i;
        lastCorrect = false;
      });
    }
  }

  void _onDeHet(String a) {
    final w = byId[item.wordId]!;
    final card = Store.ensure(item.wordId);
    final right = a == w.article;
    deHetChosen = a;
    if (right) {
      final again = _scoreCorrect(w, card);
      if (again) _requeueCurrent();
      Store.save();
      setState(() => lastCorrect = true);
      Future.delayed(const Duration(milliseconds: 650), _advance);
    } else {
      final again = _scoreWrong(w, card);
      if (again) _requeueCurrent();
      Store.save();
      setState(() => lastCorrect = false);
    }
  }

  Future<void> _finish() async {
    for (final id in previewed) {
      final c = Store.cards[id];
      if (c != null && c.box == 0 && !c.learned) {
        c.box = 1;
        c.nextDue = addDays(today, 1);
        c.lastReviewed = today;
      }
    }
    if (answered >= 1) {
      final before = Store.user.currentStreak;
      final lastDay = Store.user.lastCompletedDay;
      updateStreak(Store.user, today);
      logEvent('session done: answered=$answered correct=$correct new=$newIntroduced | streak $before->${Store.user.currentStreak} (today=$today lastDay=$lastDay)');
    } else {
      logEvent('session ended with 0 answers (streak unchanged)');
    }
    Store.user.onboarded = true;
    await Store.save();
    setState(() => done = true);
  }

  @override
  Widget build(BuildContext context) {
    if (done) return _complete();
    if (queue.isEmpty) return const Scaffold(body: SizedBox());
    final w = byId[item.wordId]!;
    final progress = (idx / queue.length).clamp(0.0, 1.0);
    Widget content;
    if (exType == 'PREVIEW') {
      content = _preview(w);
    } else if (exType == 'TYPING') {
      content = _typingView(w);
    } else {
      content = _mcView(w);
    }

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(children: [
            Row(children: [
              IconButton(onPressed: () => answered >= 1 ? _finish() : Navigator.pop(context), icon: const Icon(Icons.close, color: t3)),
              Expanded(child: LinearProgressIndicator(value: progress, backgroundColor: surfaceAlt, color: inkBlue, minHeight: 8, borderRadius: BorderRadius.circular(999))),
              const SizedBox(width: 12),
              Text('${idx + 1}/${queue.length}', style: const TextStyle(color: t3, fontWeight: FontWeight.w600, fontSize: 13)),
            ]),
            Expanded(child: SingleChildScrollView(child: content)),
          ]),
        ),
      ),
    );
  }

  Widget _preview(Word w) {
    return Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      const SizedBox(height: 24),
      Container(
        width: double.infinity,
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(color: surface, borderRadius: BorderRadius.circular(16), boxShadow: const [BoxShadow(color: Color(0x0D1A1F26), blurRadius: 12, offset: Offset(0, 4))]),
        child: Column(children: [
          const Text('New word', style: TextStyle(color: t3, fontSize: 14)),
          const SizedBox(height: 8),
          if (w.type == 'noun' && w.article != null) _badge(w.article!),
          Row(mainAxisAlignment: MainAxisAlignment.center, mainAxisSize: MainAxisSize.min, children: [
            Flexible(child: Text(w.nl, style: const TextStyle(fontSize: 38, fontWeight: FontWeight.w700, color: t1))),
            speakBtn(dispNL(w)),
          ]),
          if (w.type == 'noun' && w.plural != null && w.plural != '—') Text('pl. ${w.plural}', style: const TextStyle(color: t3)),
          if (w.type == 'verb') Padding(padding: const EdgeInsets.only(top: 6), child: Text('${w.pastSimple} · ${w.perfect}', style: const TextStyle(color: t2, fontSize: 16))),
          const SizedBox(height: 10),
          Text(w.en, style: const TextStyle(fontSize: 22, color: t2)),
        ]),
      ),
      const SizedBox(height: 20),
      SizedBox(width: double.infinity, child: FilledButton(style: FilledButton.styleFrom(backgroundColor: inkBlue, minimumSize: const Size.fromHeight(52)), onPressed: _onPreviewGotIt, child: const Text('Got it ✓', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)))),
      const SizedBox(height: 8),
      TextButton(onPressed: _onKnowIt, child: const Text('I already know this', style: TextStyle(color: accentText))),
    ]);
  }

  Widget _mcView(Word w) {
    final q = mc!;
    final ask = q.dir == 'NL_EN' ? 'What does this mean?' : 'How do you say this in Dutch?';
    final correctIdx = q.options.indexWhere((o) => o.correct);
    return Column(children: [
      const SizedBox(height: 28),
      Text(ask, style: const TextStyle(color: t3)),
      const SizedBox(height: 8),
      q.dir == 'NL_EN'
          ? Row(mainAxisAlignment: MainAxisAlignment.center, mainAxisSize: MainAxisSize.min, children: [
              Flexible(child: Text(q.prompt, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: t1), textAlign: TextAlign.center)),
              speakBtn(q.prompt),
            ])
          : Text(q.prompt, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: t1), textAlign: TextAlign.center),
      const SizedBox(height: 24),
      if (!deHetPhase)
        ...List.generate(q.options.length, (i) {
          final o = q.options[i];
          Color bgc = surface, bc = cBorder;
          if (chosen != null) {
            if (i == correctIdx) {
              bgc = greenSoft;
              bc = green;
            } else if (i == chosen) {
              bgc = coralSoft;
              bc = coral;
            }
          }
          return Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(backgroundColor: bgc, side: BorderSide(color: bc, width: 1.5), minimumSize: const Size.fromHeight(56), foregroundColor: t1),
                onPressed: chosen == null ? () => _onPick(i) : null,
                child: Text(o.text, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w500)),
              ),
            ),
          );
        }),
      if (deHetPhase) _deHetView(w),
      const SizedBox(height: 14),
      if (lastCorrect == false && !deHetPhase) ...[
        Text("Almost — it's “${q.options[correctIdx].text}”", style: const TextStyle(color: accentText, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        SizedBox(width: double.infinity, child: FilledButton(style: FilledButton.styleFrom(backgroundColor: inkBlue, minimumSize: const Size.fromHeight(52)), onPressed: _advance, child: const Text('Next ▸'))),
      ],
    ]);
  }

  Widget _deHetView(Word w) {
    return Column(children: [
      Text('Is it de or het ${w.nl}?', style: const TextStyle(color: t3)),
      const SizedBox(height: 10),
      Row(children: [
        for (final a in const ['de', 'het'])
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Builder(builder: (_) {
                Color bgc = surface, bc = inkBlue, fg = inkBlue;
                if (lastCorrect != null) {
                  if (a == w.article) {
                    bgc = greenSoft;
                    bc = green;
                    fg = t1;
                  } else if (a == deHetChosen) {
                    bgc = coralSoft;
                    bc = coral;
                    fg = t1;
                  } else {
                    bc = cBorder;
                  }
                }
                return OutlinedButton(
                  style: OutlinedButton.styleFrom(backgroundColor: bgc, minimumSize: const Size.fromHeight(60), side: BorderSide(color: bc, width: 1.5), foregroundColor: fg),
                  onPressed: lastCorrect == null ? () => _onDeHet(a) : null,
                  child: Text(a, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
                );
              }),
            ),
          ),
      ]),
      if (lastCorrect == false) ...[
        const SizedBox(height: 14),
        Text("Almost — it's “${w.article} ${w.nl}”", style: const TextStyle(color: accentText, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        SizedBox(width: double.infinity, child: FilledButton(style: FilledButton.styleFrom(backgroundColor: inkBlue, minimumSize: const Size.fromHeight(52)), onPressed: _advance, child: const Text('Next ▸'))),
      ],
    ]);
  }

  void _submitTyping(Word w, Wcard card) {
    final v = judgeTyped(_typeCtrl.text, w);
    if (v == 'CORRECT') {
      final again = _scoreCorrect(w, card);
      if (again) _requeueCurrent();
      Store.save();
      setState(() {
        lastCorrect = true;
        typedFeedback = 'Goed zo! ✓';
      });
      Future.delayed(const Duration(milliseconds: 700), _advance);
    } else if (v == 'ALMOST' && !typeAttempted) {
      setState(() {
        typeAttempted = true;
        typedFeedback = 'Almost! Check your spelling and try again.';
      });
    } else {
      final again = _scoreWrong(w, card);
      if (again) _requeueCurrent();
      Store.save();
      setState(() {
        lastCorrect = false;
        typedFeedback = "It's “${expectedTyped(w)}”";
      });
    }
  }

  Widget _typingView(Word w) {
    final card = Store.ensure(item.wordId);
    return Column(children: [
      const SizedBox(height: 28),
      const Text('Type the Dutch for', style: TextStyle(color: t3)),
      const SizedBox(height: 8),
      Text(w.en, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: t1), textAlign: TextAlign.center),
      const SizedBox(height: 24),
      TextField(
        controller: _typeCtrl,
        enabled: lastCorrect == null,
        autofocus: true,
        autocorrect: false,
        enableSuggestions: false,
        textCapitalization: TextCapitalization.none,
        onSubmitted: (_) => lastCorrect == null ? _submitTyping(w, card) : null,
        decoration: InputDecoration(
          hintText: 'type here…',
          filled: true,
          fillColor: surface,
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: cBorder, width: 1.5)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: inkBlue, width: 1.5)),
        ),
        style: const TextStyle(fontSize: 19),
      ),
      Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(w.type == 'noun' ? 'Tip: include the article (de / het).' : 'Tip: mind the spelling.', style: const TextStyle(color: t3, fontSize: 13)),
      ),
      if (typedFeedback != null) Padding(padding: const EdgeInsets.only(top: 14), child: Text(typedFeedback!, style: TextStyle(color: lastCorrect == true ? green : accentText, fontWeight: FontWeight.w600))),
      const SizedBox(height: 16),
      SizedBox(
        width: double.infinity,
        child: FilledButton(
          style: FilledButton.styleFrom(backgroundColor: inkBlue, minimumSize: const Size.fromHeight(52)),
          onPressed: lastCorrect == null ? () => _submitTyping(w, card) : _advance,
          child: Text(lastCorrect == null ? 'Check' : 'Next ▸', style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
        ),
      ),
      if (lastCorrect == null)
        TextButton(
          onPressed: () {
            final again = _scoreWrong(w, card);
            if (again) _requeueCurrent();
            Store.save();
            setState(() {
              lastCorrect = false;
              typedFeedback = "It's “${expectedTyped(w)}”";
            });
          },
          child: const Text('Show answer', style: TextStyle(color: t3)),
        ),
    ]);
  }

  Widget _badge(String art) {
    final isHet = art == 'het';
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(color: isHet ? accentSoft : const Color(0xFFE7EEF6), borderRadius: BorderRadius.circular(999)),
      child: Text(art.toUpperCase(), style: TextStyle(color: isHet ? accentText : inkBlue, fontWeight: FontWeight.w700, fontSize: 13, letterSpacing: 0.5)),
    );
  }

  Widget _complete() {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            const Text('🎉', style: TextStyle(fontSize: 48)),
            const SizedBox(height: 12),
            const Text('Nice work!', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: t1)),
            const SizedBox(height: 6),
            Text('Correct $correct/$answered · $newIntroduced new', style: const TextStyle(color: t2)),
            if (learnedNames.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: Text('🏆 Learned: ${learnedNames.map((w) => w.nl).join(', ')}', style: const TextStyle(color: t3, fontSize: 13))),
            const SizedBox(height: 16),
            _pill('🔥 ${Store.user.currentStreak}-day streak', accentSoft, accentText),
            const SizedBox(height: 24),
            SizedBox(width: double.infinity, child: FilledButton(style: FilledButton.styleFrom(backgroundColor: inkBlue, minimumSize: const Size.fromHeight(52)), onPressed: () => Navigator.pop(context), child: const Text('Done', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600)))),
          ]),
        ),
      ),
    );
  }
}
