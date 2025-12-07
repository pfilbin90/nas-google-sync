import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Provider that returns the current user's ID, or null if not logged in.
final currentUserIdProvider = Provider<String?>((ref) {
  final supabase = Supabase.instance.client;
  return supabase.auth.currentUser?.id;
});

/// Provider that returns the Supabase client instance.
final supabaseClientProvider = Provider<SupabaseClient>((ref) {
  return Supabase.instance.client;
});
