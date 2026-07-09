import 'package:flutter/material.dart';

/// Orbit brand palette (dark, matches the macOS app's overlay chrome).
class OrbitColors {
  static const accent = Color(0xFF6E7BF2);
  static const accent2 = Color(0xFFB266F2);
  static const bg = Color(0xFF141418);
  static const panel = Color(0xFF1E1E24);
  static const panelAlt = Color(0xFF26262E);
  static const border = Color(0xFF33333C);
  static const text = Color(0xFFECECF1);
  static const textDim = Color(0xFF9A9AA6);
}

ThemeData orbitTheme() {
  final base = ThemeData(
    brightness: Brightness.dark,
    useMaterial3: true,
    scaffoldBackgroundColor: OrbitColors.bg,
    colorScheme: const ColorScheme.dark(
      primary: OrbitColors.accent,
      secondary: OrbitColors.accent2,
      surface: OrbitColors.panel,
      onSurface: OrbitColors.text,
    ),
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(
      bodyColor: OrbitColors.text,
      displayColor: OrbitColors.text,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: OrbitColors.panel,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: OrbitColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: OrbitColors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: OrbitColors.accent, width: 1.5),
      ),
    ),
  );
}
