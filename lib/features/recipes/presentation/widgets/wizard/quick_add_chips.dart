import 'package:flutter/widgets.dart';
import '../../../../../shared/models/ingredient.dart';

/// A widget that displays a row of quick-add ingredient chips.
///
/// Each chip represents an ingredient that can be quickly added to a recipe.
/// When a chip is tapped, the [onIngredientSelected] callback is invoked.
class QuickAddChips extends StatelessWidget {
  /// The list of ingredients to display as chips.
  final List<Ingredient> ingredients;

  /// Callback when an ingredient chip is tapped.
  final void Function(Ingredient ingredient)? onIngredientSelected;

  const QuickAddChips({
    super.key,
    required this.ingredients,
    this.onIngredientSelected,
  });

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8.0,
      runSpacing: 8.0,
      children: ingredients.map((ingredient) {
        return _QuickAddChip(
          ingredient: ingredient,
          onTap: () => onIngredientSelected?.call(ingredient),
        );
      }).toList(),
    );
  }
}

/// Individual chip for a single ingredient.
class _QuickAddChip extends StatelessWidget {
  final Ingredient ingredient;
  final VoidCallback? onTap;

  const _QuickAddChip({
    required this.ingredient,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 8.0),
        decoration: BoxDecoration(
          color: const Color(0xFFE8F5E9),
          borderRadius: BorderRadius.circular(16.0),
          border: Border.all(
            color: const Color(0xFF4CAF50),
            width: 1.0,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              '+',
              style: TextStyle(
                fontSize: 14.0,
                fontWeight: FontWeight.w600,
                color: Color(0xFF388E3C),
              ),
            ),
            const SizedBox(width: 4.0),
            Text(
              ingredient.name,
              style: const TextStyle(
                fontSize: 14.0,
                fontWeight: FontWeight.w500,
                color: Color(0xFF2E7D32),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
