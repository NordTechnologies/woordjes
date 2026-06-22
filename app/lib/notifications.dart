// Cross-platform notification API. Web gets no-op stubs (the plugin isn't web-safe);
// iOS/Android get the real flutter_local_notifications implementation.
export 'notif_native.dart' if (dart.library.html) 'notif_web.dart';
