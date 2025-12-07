import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/providers/auth_provider.dart';
import '../../../core/services/worker_client.dart';
import '../../../shared/constants/common_ingredients.dart';
import '../../../shared/models/ingredient.dart';
import 'smart_quickadd_service.dart';

/// Provider for the WorkerClient instance.
final workerClientProvider = Provider<WorkerClient>((ref) {
  final client = WorkerClient();
  ref.onDispose(client.dispose);
  return client;
});

/// Provider for the SmartQuickAddService instance.
final smartQuickAddServiceProvider = Provider<SmartQuickAddService>((ref) {
  final supabase = ref.watch(supabaseClientProvider);
  final workerClient = ref.watch(workerClientProvider);
  return DefaultSmartQuickAddService(
    supabase: supabase,
    workerClient: workerClient,
  );
});

/// Provider for fetching smart quick-add ingredients.
///
/// This provider implements tiered personalization:
/// - Users with 5+ published recipes -> personal top 6 ingredients
/// - Users with 0-4 recipes or logged out -> global popular ingredients
/// - Error/timeout -> fall back to static CommonIngredients.bases
final smartQuickAddProvider =
    FutureProvider.autoDispose<List<Ingredient>>((ref) async {
  final userId = ref.watch(currentUserIdProvider);
  final service = ref.watch(smartQuickAddServiceProvider);

  try {
    return await service.fetchQuickAddIngredients(userId);
  } catch (e) {
    // On any error, return the static fallback
    return CommonIngredients.bases;
  }
});
