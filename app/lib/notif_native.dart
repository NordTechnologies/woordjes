// Native (iOS/Android) daily reminder via flutter_local_notifications.
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;
import 'package:flutter_timezone/flutter_timezone.dart';

final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
bool _inited = false;
const int _reminderId = 1;

Future<void> initNotifications() async {
  if (_inited) return;
  tzdata.initializeTimeZones();
  try {
    final info = await FlutterTimezone.getLocalTimezone();
    tz.setLocalLocation(tz.getLocation(info.identifier));
  } catch (_) {}
  const ios = DarwinInitializationSettings(
    requestAlertPermission: false,
    requestBadgePermission: false,
    requestSoundPermission: false,
  );
  const android = AndroidInitializationSettings('@mipmap/ic_launcher');
  await _plugin.initialize(const InitializationSettings(iOS: ios, android: android));
  _inited = true;
}

Future<bool> requestNotifPermission() async {
  await initNotifications();
  final ios = _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>();
  if (ios != null) {
    final g = await ios.requestPermissions(alert: true, badge: true, sound: true);
    return g ?? false;
  }
  final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  if (android != null) {
    final g = await android.requestNotificationsPermission();
    return g ?? true;
  }
  return true;
}

Future<void> scheduleDailyReminder(int hour, int minute) async {
  await initNotifications();
  await _plugin.cancel(_reminderId);
  final now = tz.TZDateTime.now(tz.local);
  var when = tz.TZDateTime(tz.local, now.year, now.month, now.day, hour, minute);
  if (!when.isAfter(now)) when = when.add(const Duration(days: 1));
  const details = NotificationDetails(
    iOS: DarwinNotificationDetails(),
    android: AndroidNotificationDetails('daily_reminder', 'Daily reminder',
        channelDescription: 'A gentle daily nudge to study', importance: Importance.defaultImportance),
  );
  await _plugin.zonedSchedule(
    _reminderId,
    'Tijd om te leren! 🇳🇱',
    'A few Dutch words are waiting for you.',
    when,
    details,
    androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
    uiLocalNotificationDateInterpretation: UILocalNotificationDateInterpretation.absoluteTime,
    matchDateTimeComponents: DateTimeComponents.time, // repeat daily at this time
  );
}

Future<void> cancelReminders() async {
  await initNotifications();
  await _plugin.cancel(_reminderId);
}
