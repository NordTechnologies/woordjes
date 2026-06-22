// On-device rolling log (kept on the user's phone, shareable with the developer).
import 'dart:io';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

final List<String> _buf = [];
File? _file;
bool _ready = false;
const int _maxLines = 1000;

Future<void> initLog() async {
  try {
    final dir = await getApplicationDocumentsDirectory();
    _file = File('${dir.path}/woordjes_log.txt');
    if (await _file!.exists()) {
      _buf.addAll((await _file!.readAsString()).split('\n').where((l) => l.isNotEmpty));
      _trim();
    }
    _ready = true;
    logEvent('--- app start ---');
  } catch (_) {}
}

void _trim() {
  while (_buf.length > _maxLines) {
    _buf.removeAt(0);
  }
}

void logEvent(String msg) {
  _buf.add('${DateTime.now().toIso8601String()}  $msg');
  _trim();
  if (_ready && _file != null) {
    _file!.writeAsString(_buf.join('\n')).catchError((_) => _file!);
  }
}

Future<void> shareLogs() async {
  try {
    if (_file == null) return;
    await _file!.writeAsString(_buf.join('\n'));
    await SharePlus.instance.share(ShareParams(
      files: [XFile(_file!.path)],
      subject: 'Woordjes log file',
      text: 'My Woordjes log (for the developer).',
    ));
  } catch (_) {}
}

String recentLogs() => _buf.length > 50 ? _buf.sublist(_buf.length - 50).join('\n') : _buf.join('\n');
