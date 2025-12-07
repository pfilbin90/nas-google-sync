import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shimmer/shimmer.dart';
import '../../../../../../shared/constants/common_ingredients.dart';
import '../../../../../../shared/models/ingredient.dart';
import '../../../../logic/smart_quickadd_provider.dart';
import '../quick_add_chips.dart';

/// The ingredients step of the recipe wizard.
///
/// Allows users to add ingredients to their recipe, with quick-add chips
/// for commonly used ingredients based on personalization.
class IngredientsStep extends ConsumerStatefulWidget {
  /// Callback when an ingredient is added.
  final void Function(Ingredient ingredient)? onIngredientAdded;

  /// The currently added ingredients.
  final List<Ingredient> ingredients;

  const IngredientsStep({
    super.key,
    this.onIngredientAdded,
    this.ingredients = const [],
  });

  @override
  ConsumerState<IngredientsStep> createState() => _IngredientsStepState();
}

class _IngredientsStepState extends ConsumerState<IngredientsStep> {
  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Add Ingredients',
            style: TextStyle(
              fontSize: 24.0,
              fontWeight: FontWeight.bold,
              color: Color(0xFF1A1A1A),
            ),
          ),
          const SizedBox(height: 8.0),
          const Text(
            'Add the ingredients for your recipe. Use quick-add for common items.',
            style: TextStyle(
              fontSize: 14.0,
              color: Color(0xFF666666),
            ),
          ),
          const SizedBox(height: 24.0),
          _QuickAddSection(
            onIngredientSelected: widget.onIngredientAdded,
          ),
          const SizedBox(height: 24.0),
          _IngredientsList(
            ingredients: widget.ingredients,
          ),
        ],
      ),
    );
  }
}

/// Section displaying quick-add chips with smart personalization.
class _QuickAddSection extends ConsumerWidget {
  final void Function(Ingredient ingredient)? onIngredientSelected;

  const _QuickAddSection({
    this.onIngredientSelected,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final quickAddAsync = ref.watch(smartQuickAddProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Quick Add',
          style: TextStyle(
            fontSize: 16.0,
            fontWeight: FontWeight.w600,
            color: Color(0xFF333333),
          ),
        ),
        const SizedBox(height: 12.0),
        quickAddAsync.when(
          data: (ingredients) => QuickAddChips(
            ingredients: ingredients,
            onIngredientSelected: onIngredientSelected,
          ),
          loading: () => const _QuickAddChipsLoading(),
          error: (_, __) => QuickAddChips(
            ingredients: CommonIngredients.bases,
            onIngredientSelected: onIngredientSelected,
          ),
        ),
      ],
    );
  }
}

/// Loading shimmer state for quick-add chips.
class _QuickAddChipsLoading extends StatelessWidget {
  const _QuickAddChipsLoading();

  @override
  Widget build(BuildContext context) {
    return Shimmer.fromColors(
      baseColor: const Color(0xFFE0E0E0),
      highlightColor: const Color(0xFFF5F5F5),
      child: Wrap(
        spacing: 8.0,
        runSpacing: 8.0,
        children: List.generate(6, (index) {
          // Vary the width slightly for a more natural look
          final widths = [72.0, 88.0, 64.0, 96.0, 80.0, 76.0];
          return Container(
            width: widths[index],
            height: 36.0,
            decoration: BoxDecoration(
              color: const Color(0xFFFFFFFF),
              borderRadius: BorderRadius.circular(16.0),
            ),
          );
        }),
      ),
    );
  }
}

/// List displaying the currently added ingredients.
class _IngredientsList extends StatelessWidget {
  final List<Ingredient> ingredients;

  const _IngredientsList({
    required this.ingredients,
  });

  @override
  Widget build(BuildContext context) {
    if (ingredients.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(24.0),
        decoration: BoxDecoration(
          color: const Color(0xFFF5F5F5),
          borderRadius: BorderRadius.circular(8.0),
          border: Border.all(
            color: const Color(0xFFE0E0E0),
            width: 1.0,
          ),
        ),
        child: const Center(
          child: Text(
            'No ingredients added yet.\nTap the quick-add chips above or add manually.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 14.0,
              color: Color(0xFF999999),
            ),
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Ingredients (${ingredients.length})',
          style: const TextStyle(
            fontSize: 16.0,
            fontWeight: FontWeight.w600,
            color: Color(0xFF333333),
          ),
        ),
        const SizedBox(height: 12.0),
        ...ingredients.map((ingredient) => _IngredientRow(ingredient: ingredient)),
      ],
    );
  }
}

/// A single row displaying an ingredient.
class _IngredientRow extends StatelessWidget {
  final Ingredient ingredient;

  const _IngredientRow({
    required this.ingredient,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8.0),
      padding: const EdgeInsets.symmetric(horizontal: 12.0, vertical: 10.0),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFFFF),
        borderRadius: BorderRadius.circular(8.0),
        border: Border.all(
          color: const Color(0xFFE0E0E0),
          width: 1.0,
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              ingredient.name,
              style: const TextStyle(
                fontSize: 14.0,
                fontWeight: FontWeight.w500,
                color: Color(0xFF333333),
              ),
            ),
          ),
          Text(
            '${ingredient.defaultAmount} ${ingredient.defaultUnit}',
            style: const TextStyle(
              fontSize: 14.0,
              color: Color(0xFF666666),
            ),
          ),
        ],
      ),
    );
  }
}
