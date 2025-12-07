import 'dart:async';
import 'package:supabase_flutter/supabase_flutter.dart';
import '../../../core/services/worker_client.dart';
import '../../../shared/models/ingredient.dart';

/// Minimum number of published recipes required to show personalized ingredients.
const int minRecipesForPersonalization = 5;

/// Number of quick-add ingredients to display.
const int quickAddIngredientCount = 6;

/// Service for fetching smart quick-add ingredients.
///
/// This service implements tiered personalization:
/// - Users with 5+ published recipes -> personal top 6 ingredients
/// - Users with 0-4 recipes or logged out -> global popular ingredients
abstract class SmartQuickAddService {
  /// Fetches quick-add ingredients for the given user.
  /// Pass null for [userId] if the user is not logged in.
  Future<List<Ingredient>> fetchQuickAddIngredients(String? userId);

  /// Fetches the count of published recipes for a user.
  Future<int> getUserPublishedRecipeCount(String userId);

  /// Fetches the user's most-used ingredients from their recipes.
  Future<List<Ingredient>> fetchUserTopIngredients(String userId);

  /// Fetches global popular ingredients from the worker API.
  Future<List<Ingredient>> fetchGlobalPopularIngredients();
}

/// Default implementation of [SmartQuickAddService] using Supabase and Worker API.
class DefaultSmartQuickAddService implements SmartQuickAddService {
  final SupabaseClient _supabase;
  final WorkerClient _workerClient;

  DefaultSmartQuickAddService({
    required SupabaseClient supabase,
    required WorkerClient workerClient,
  })  : _supabase = supabase,
        _workerClient = workerClient;

  @override
  Future<List<Ingredient>> fetchQuickAddIngredients(String? userId) async {
    // If user is not logged in, fetch global popular ingredients
    if (userId == null) {
      return await fetchGlobalPopularIngredients();
    }

    // Check how many published recipes the user has
    final recipeCount = await getUserPublishedRecipeCount(userId);

    if (recipeCount >= minRecipesForPersonalization) {
      // User has enough recipes - get personalized ingredients
      return await fetchUserTopIngredients(userId);
    } else {
      // Not enough recipes - use global popular
      return await fetchGlobalPopularIngredients();
    }
  }

  @override
  Future<int> getUserPublishedRecipeCount(String userId) async {
    final response = await _supabase
        .from('recipes')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'published')
        .count(CountOption.exact);

    return response.count;
  }

  @override
  Future<List<Ingredient>> fetchUserTopIngredients(String userId) async {
    // Query recipe_items to get the most frequently used ingredients
    // Join with ingredients table to get ingredient details
    final response = await _supabase
        .from('recipe_items')
        .select('''
          ingredient_id,
          ingredients!inner(
            id,
            name,
            default_unit,
            default_amount
          ),
          recipes!inner(
            user_id,
            status
          )
        ''')
        .eq('recipes.user_id', userId)
        .eq('recipes.status', 'published');

    // Count ingredient occurrences and get top ingredients
    final ingredientCounts = <String, Map<String, dynamic>>{};

    for (final item in response) {
      final ingredientData = item['ingredients'] as Map<String, dynamic>;
      final ingredientId = ingredientData['id'] as String;

      if (ingredientCounts.containsKey(ingredientId)) {
        ingredientCounts[ingredientId]!['count'] =
            (ingredientCounts[ingredientId]!['count'] as int) + 1;
      } else {
        ingredientCounts[ingredientId] = {
          'data': ingredientData,
          'count': 1,
        };
      }
    }

    // Sort by count and take top ingredients
    final sortedIngredients = ingredientCounts.entries.toList()
      ..sort(
          (a, b) => (b.value['count'] as int).compareTo(a.value['count'] as int));

    return sortedIngredients.take(quickAddIngredientCount).map((entry) {
      final data = entry.value['data'] as Map<String, dynamic>;
      return Ingredient.fromJson(data);
    }).toList();
  }

  @override
  Future<List<Ingredient>> fetchGlobalPopularIngredients() async {
    final ingredients = await _workerClient.fetchPopularIngredients();
    return ingredients.take(quickAddIngredientCount).toList();
  }
}
