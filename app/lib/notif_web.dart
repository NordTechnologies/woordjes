// Web no-op stubs (notifications are delivered only in the installed app).
Future<void> initNotifications() async {}
Future<bool> requestNotifPermission() async => false;
Future<void> scheduleDailyReminder(int hour, int minute) async {}
Future<void> cancelReminders() async {}
