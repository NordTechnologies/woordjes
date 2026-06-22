// On-device logging API. Native writes a log file the user can share with the
// developer; web gets no-op stubs (no filesystem).
export 'logger_native.dart' if (dart.library.html) 'logger_web.dart';
