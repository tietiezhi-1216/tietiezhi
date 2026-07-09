import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:hotkey_manager/hotkey_manager.dart';

import 'chat/chat_controller.dart';
import 'core/interconnect.dart';
import 'core/settings_store.dart';
import 'dictation/dictation_controller.dart';
import 'dictation/dictation_hotkey.dart';
import 'ui/shell.dart';
import 'ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (DictationHotkey.supported) {
    await hotKeyManager.unregisterAll();
  }
  final store = SettingsStore();
  await store.load();
  runApp(TietiezhiApp(store: store));
}

class TietiezhiApp extends StatelessWidget {
  const TietiezhiApp({super.key, required this.store});
  final SettingsStore store;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: store),
        ChangeNotifierProvider(create: (_) => ChatController(store)),
        ChangeNotifierProvider(create: (_) => InterconnectClient()),
        ChangeNotifierProvider(create: (_) => DictationController(store)),
      ],
      child: MaterialApp(
        title: 'Tietiezhi',
        debugShowCheckedModeBanner: false,
        theme: tietiezhiTheme(),
        home: const TietiezhiShell(),
      ),
    );
  }
}
