import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'chat/chat_controller.dart';
import 'core/settings_store.dart';
import 'ui/shell.dart';
import 'ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = SettingsStore();
  await store.load();
  runApp(OrbitApp(store: store));
}

class OrbitApp extends StatelessWidget {
  const OrbitApp({super.key, required this.store});
  final SettingsStore store;

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: store),
        ChangeNotifierProvider(create: (_) => ChatController(store)),
      ],
      child: MaterialApp(
        title: 'Orbit',
        debugShowCheckedModeBanner: false,
        theme: orbitTheme(),
        home: const OrbitShell(),
      ),
    );
  }
}
