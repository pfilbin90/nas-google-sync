import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:nas_google_sync/core/providers/auth_provider.dart';
import 'package:nas_google_sync/core/services/worker_client.dart';
import 'package:nas_google_sync/features/recipes/logic/smart_quickadd_provider.dart';
import 'package:nas_google_sync/features/recipes/logic/smart_quickadd_service.dart';
import 'package:nas_google_sync/shared/constants/common_ingredients.dart';
import 'package:nas_google_sync/shared/models/ingredient.dart';

// Mock classes
class MockSmartQuickAddService extends Mock implements SmartQuickAddService {}

class MockWorkerClient extends Mock implements WorkerClient {}

// Test data
final testPersonalIngredients = [
  const Ingredient(
      id: 'tomato', name: 'Tomato', defaultUnit: 'medium', defaultAmount: 2.0),
  const Ingredient(
      id: 'basil', name: 'Basil', defaultUnit: 'leaves', defaultAmount: 10.0),
  const Ingredient(
      id: 'mozzarella',
      name: 'Mozzarella',
      defaultUnit: 'oz',
      defaultAmount: 8.0),
  const Ingredient(
      id: 'oregano', name: 'Oregano', defaultUnit: 'tsp', defaultAmount: 1.0),
  const Ingredient(
      id: 'parmesan',
      name: 'Parmesan',
      defaultUnit: 'tbsp',
      defaultAmount: 2.0),
  const Ingredient(
      id: 'pasta', name: 'Pasta', defaultUnit: 'oz', defaultAmount: 16.0),
];

final testGlobalPopularIngredients = [
  const Ingredient(
      id: 'chicken', name: 'Chicken', defaultUnit: 'lb', defaultAmount: 1.0),
  const Ingredient(
      id: 'rice', name: 'Rice', defaultUnit: 'cup', defaultAmount: 1.0),
  const Ingredient(
      id: 'egg', name: 'Eggs', defaultUnit: 'large', defaultAmount: 2.0),
  const Ingredient(
      id: 'milk', name: 'Milk', defaultUnit: 'cup', defaultAmount: 1.0),
  const Ingredient(
      id: 'flour', name: 'Flour', defaultUnit: 'cup', defaultAmount: 2.0),
  const Ingredient(
      id: 'sugar', name: 'Sugar', defaultUnit: 'cup', defaultAmount: 0.5),
];

void main() {
  late MockSmartQuickAddService mockService;

  setUp(() {
    mockService = MockSmartQuickAddService();
  });

  tearDown(() {
    reset(mockService);
  });

  ProviderContainer createContainer({
    String? userId,
    required MockSmartQuickAddService service,
  }) {
    return ProviderContainer(
      overrides: [
        currentUserIdProvider.overrideWithValue(userId),
        smartQuickAddServiceProvider.overrideWithValue(service),
      ],
    );
  }

  group('SmartQuickAddProvider', () {
    test('returns personal ingredients when user has 5+ recipes', () async {
      // Arrange
      when(() => mockService.fetchQuickAddIngredients('test-user-id'))
          .thenAnswer((_) async => testPersonalIngredients);

      final container = createContainer(
        userId: 'test-user-id',
        service: mockService,
      );

      // Act
      final result = await container.read(smartQuickAddProvider.future);

      // Assert
      expect(result, equals(testPersonalIngredients));
      verify(() => mockService.fetchQuickAddIngredients('test-user-id'))
          .called(1);
    });

    test('returns global popular when user has 0-4 recipes', () async {
      // Arrange
      when(() => mockService.fetchQuickAddIngredients('test-user-id'))
          .thenAnswer((_) async => testGlobalPopularIngredients);

      final container = createContainer(
        userId: 'test-user-id',
        service: mockService,
      );

      // Act
      final result = await container.read(smartQuickAddProvider.future);

      // Assert
      expect(result, equals(testGlobalPopularIngredients));
      verify(() => mockService.fetchQuickAddIngredients('test-user-id'))
          .called(1);
    });

    test('returns global popular when not logged in', () async {
      // Arrange
      when(() => mockService.fetchQuickAddIngredients(null))
          .thenAnswer((_) async => testGlobalPopularIngredients);

      final container = createContainer(
        userId: null,
        service: mockService,
      );

      // Act
      final result = await container.read(smartQuickAddProvider.future);

      // Assert
      expect(result, equals(testGlobalPopularIngredients));
      verify(() => mockService.fetchQuickAddIngredients(null)).called(1);
    });

    test('falls back to static list on network error', () async {
      // Arrange
      when(() => mockService.fetchQuickAddIngredients(null))
          .thenThrow(WorkerApiException('Network error'));

      final container = createContainer(
        userId: null,
        service: mockService,
      );

      // Act
      final result = await container.read(smartQuickAddProvider.future);

      // Assert
      expect(result, equals(CommonIngredients.bases));
    });

    test('falls back to static list on timeout', () async {
      // Arrange
      when(() => mockService.fetchQuickAddIngredients(null))
          .thenThrow(TimeoutException('Request timed out'));

      final container = createContainer(
        userId: null,
        service: mockService,
      );

      // Act
      final result = await container.read(smartQuickAddProvider.future);

      // Assert
      expect(result, equals(CommonIngredients.bases));
    });

    test('falls back to static list on any exception', () async {
      // Arrange
      when(() => mockService.fetchQuickAddIngredients('test-user-id'))
          .thenThrow(Exception('Database error'));

      final container = createContainer(
        userId: 'test-user-id',
        service: mockService,
      );

      // Act
      final result = await container.read(smartQuickAddProvider.future);

      // Assert
      expect(result, equals(CommonIngredients.bases));
    });
  });

  group('SmartQuickAddService', () {
    late MockSmartQuickAddService mockServiceForUnit;

    setUp(() {
      mockServiceForUnit = MockSmartQuickAddService();
    });

    test('fetchQuickAddIngredients returns personal for 5+ recipes', () async {
      // Arrange - Simulating service behavior
      when(() => mockServiceForUnit.getUserPublishedRecipeCount('user-id'))
          .thenAnswer((_) async => 7);
      when(() => mockServiceForUnit.fetchUserTopIngredients('user-id'))
          .thenAnswer((_) async => testPersonalIngredients);
      when(() => mockServiceForUnit.fetchQuickAddIngredients('user-id'))
          .thenAnswer((_) async => testPersonalIngredients);

      // Act
      final result =
          await mockServiceForUnit.fetchQuickAddIngredients('user-id');

      // Assert
      expect(result, equals(testPersonalIngredients));
    });

    test('fetchQuickAddIngredients returns global for < 5 recipes', () async {
      // Arrange
      when(() => mockServiceForUnit.getUserPublishedRecipeCount('user-id'))
          .thenAnswer((_) async => 3);
      when(() => mockServiceForUnit.fetchGlobalPopularIngredients())
          .thenAnswer((_) async => testGlobalPopularIngredients);
      when(() => mockServiceForUnit.fetchQuickAddIngredients('user-id'))
          .thenAnswer((_) async => testGlobalPopularIngredients);

      // Act
      final result =
          await mockServiceForUnit.fetchQuickAddIngredients('user-id');

      // Assert
      expect(result, equals(testGlobalPopularIngredients));
    });

    test('fetchQuickAddIngredients returns global when not logged in',
        () async {
      // Arrange
      when(() => mockServiceForUnit.fetchGlobalPopularIngredients())
          .thenAnswer((_) async => testGlobalPopularIngredients);
      when(() => mockServiceForUnit.fetchQuickAddIngredients(null))
          .thenAnswer((_) async => testGlobalPopularIngredients);

      // Act
      final result = await mockServiceForUnit.fetchQuickAddIngredients(null);

      // Assert
      expect(result, equals(testGlobalPopularIngredients));
    });
  });

  group('Ingredient model', () {
    test('fromJson parses correctly', () {
      final json = {
        'id': 'test-id',
        'name': 'Test Ingredient',
        'defaultUnit': 'cup',
        'defaultAmount': 2.5,
      };

      final ingredient = Ingredient.fromJson(json);

      expect(ingredient.id, 'test-id');
      expect(ingredient.name, 'Test Ingredient');
      expect(ingredient.defaultUnit, 'cup');
      expect(ingredient.defaultAmount, 2.5);
    });

    test('fromJson handles snake_case keys', () {
      final json = {
        'id': 'test-id',
        'name': 'Test Ingredient',
        'default_unit': 'cup',
        'default_amount': 2.5,
      };

      final ingredient = Ingredient.fromJson(json);

      expect(ingredient.defaultUnit, 'cup');
      expect(ingredient.defaultAmount, 2.5);
    });

    test('equality works correctly', () {
      const ingredient1 = Ingredient(
        id: 'test',
        name: 'Test',
        defaultUnit: 'cup',
        defaultAmount: 1.0,
      );
      const ingredient2 = Ingredient(
        id: 'test',
        name: 'Test',
        defaultUnit: 'cup',
        defaultAmount: 1.0,
      );
      const ingredient3 = Ingredient(
        id: 'other',
        name: 'Test',
        defaultUnit: 'cup',
        defaultAmount: 1.0,
      );

      expect(ingredient1, equals(ingredient2));
      expect(ingredient1, isNot(equals(ingredient3)));
    });

    test('toJson returns correct map', () {
      const ingredient = Ingredient(
        id: 'test-id',
        name: 'Test',
        defaultUnit: 'cup',
        defaultAmount: 1.5,
      );

      final json = ingredient.toJson();

      expect(json['id'], 'test-id');
      expect(json['name'], 'Test');
      expect(json['defaultUnit'], 'cup');
      expect(json['defaultAmount'], 1.5);
    });
  });

  group('CommonIngredients', () {
    test('bases contains expected count of ingredients', () {
      expect(CommonIngredients.bases.length, 6);
    });

    test('bases ingredients are valid', () {
      for (final ingredient in CommonIngredients.bases) {
        expect(ingredient.id, isNotEmpty);
        expect(ingredient.name, isNotEmpty);
        expect(ingredient.defaultUnit, isNotEmpty);
        expect(ingredient.defaultAmount, greaterThan(0));
      }
    });

    test('bases includes common cooking ingredients', () {
      final names = CommonIngredients.bases.map((i) => i.name).toList();
      expect(names, contains('Salt'));
      expect(names, contains('Olive Oil'));
      expect(names, contains('Garlic'));
    });
  });

  group('WorkerClient', () {
    late MockWorkerClient mockWorkerClient;

    setUp(() {
      mockWorkerClient = MockWorkerClient();
    });

    test('fetchPopularIngredients returns list of ingredients', () async {
      // Arrange
      when(() => mockWorkerClient.fetchPopularIngredients())
          .thenAnswer((_) async => testGlobalPopularIngredients);

      // Act
      final result = await mockWorkerClient.fetchPopularIngredients();

      // Assert
      expect(result, equals(testGlobalPopularIngredients));
      expect(result.length, 6);
    });

    test('fetchPopularIngredients throws on network error', () async {
      // Arrange
      when(() => mockWorkerClient.fetchPopularIngredients())
          .thenThrow(WorkerApiException('Network error'));

      // Act & Assert
      expect(
        () => mockWorkerClient.fetchPopularIngredients(),
        throwsA(isA<WorkerApiException>()),
      );
    });

    test('fetchPopularIngredients throws on timeout', () async {
      // Arrange
      when(() => mockWorkerClient.fetchPopularIngredients())
          .thenThrow(TimeoutException('Timeout'));

      // Act & Assert
      expect(
        () => mockWorkerClient.fetchPopularIngredients(),
        throwsA(isA<TimeoutException>()),
      );
    });
  });
}
