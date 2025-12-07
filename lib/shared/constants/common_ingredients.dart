import '../models/ingredient.dart';

/// Common ingredients used as fallback when personalized
/// or global popular ingredients cannot be loaded.
class CommonIngredients {
  CommonIngredients._();

  /// Base ingredients used as default quick-add chips.
  /// These are the most commonly used ingredients across all recipes.
  static const List<Ingredient> bases = [
    Ingredient(
      id: 'salt',
      name: 'Salt',
      defaultUnit: 'tsp',
      defaultAmount: 1.0,
    ),
    Ingredient(
      id: 'pepper',
      name: 'Black Pepper',
      defaultUnit: 'tsp',
      defaultAmount: 0.5,
    ),
    Ingredient(
      id: 'olive-oil',
      name: 'Olive Oil',
      defaultUnit: 'tbsp',
      defaultAmount: 2.0,
    ),
    Ingredient(
      id: 'garlic',
      name: 'Garlic',
      defaultUnit: 'cloves',
      defaultAmount: 2.0,
    ),
    Ingredient(
      id: 'onion',
      name: 'Onion',
      defaultUnit: 'medium',
      defaultAmount: 1.0,
    ),
    Ingredient(
      id: 'butter',
      name: 'Butter',
      defaultUnit: 'tbsp',
      defaultAmount: 2.0,
    ),
  ];
}
