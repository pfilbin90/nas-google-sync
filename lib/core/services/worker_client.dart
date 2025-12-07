import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../../shared/models/ingredient.dart';

/// Client for interacting with the worker API.
class WorkerClient {
  final http.Client _httpClient;
  final String _baseUrl;

  /// Timeout for API requests.
  static const Duration requestTimeout = Duration(seconds: 10);

  WorkerClient({
    http.Client? httpClient,
    String? baseUrl,
  })  : _httpClient = httpClient ?? http.Client(),
        _baseUrl = baseUrl ?? const String.fromEnvironment(
          'WORKER_API_URL',
          defaultValue: 'https://api.example.com',
        );

  /// Fetches popular ingredients from the worker API.
  ///
  /// Returns a list of the most popular ingredients globally.
  /// Throws [TimeoutException] if the request takes longer than [requestTimeout].
  /// Throws [WorkerApiException] on API errors.
  Future<List<Ingredient>> fetchPopularIngredients() async {
    try {
      final response = await _httpClient
          .get(Uri.parse('$_baseUrl/api/ingredients/popular'))
          .timeout(requestTimeout);

      if (response.statusCode != 200) {
        throw WorkerApiException(
          'Failed to fetch popular ingredients',
          statusCode: response.statusCode,
        );
      }

      final data = json.decode(response.body) as Map<String, dynamic>;
      final ingredientsList = data['ingredients'] as List<dynamic>;

      return ingredientsList
          .map((json) => Ingredient.fromJson(json as Map<String, dynamic>))
          .toList();
    } on TimeoutException {
      rethrow;
    } on FormatException catch (e) {
      throw WorkerApiException('Invalid response format: ${e.message}');
    } on http.ClientException catch (e) {
      throw WorkerApiException('Network error: ${e.message}');
    }
  }

  void dispose() {
    _httpClient.close();
  }
}

/// Exception thrown when the worker API returns an error.
class WorkerApiException implements Exception {
  final String message;
  final int? statusCode;

  WorkerApiException(this.message, {this.statusCode});

  @override
  String toString() => 'WorkerApiException: $message${statusCode != null ? ' (status: $statusCode)' : ''}';
}
