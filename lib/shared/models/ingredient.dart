/// Model representing an ingredient used in recipes.
class Ingredient {
  final String id;
  final String name;
  final String defaultUnit;
  final double defaultAmount;

  const Ingredient({
    required this.id,
    required this.name,
    required this.defaultUnit,
    required this.defaultAmount,
  });

  factory Ingredient.fromJson(Map<String, dynamic> json) {
    return Ingredient(
      id: json['id'] as String,
      name: json['name'] as String,
      defaultUnit: json['defaultUnit'] as String? ?? json['default_unit'] as String? ?? '',
      defaultAmount: (json['defaultAmount'] ?? json['default_amount'] ?? 1.0).toDouble(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'defaultUnit': defaultUnit,
      'defaultAmount': defaultAmount,
    };
  }

  @override
  bool operator ==(Object other) {
    if (identical(this, other)) return true;
    return other is Ingredient &&
        other.id == id &&
        other.name == name &&
        other.defaultUnit == defaultUnit &&
        other.defaultAmount == defaultAmount;
  }

  @override
  int get hashCode => Object.hash(id, name, defaultUnit, defaultAmount);

  @override
  String toString() => 'Ingredient(id: $id, name: $name, defaultUnit: $defaultUnit, defaultAmount: $defaultAmount)';
}
