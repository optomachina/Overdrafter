import Foundation

enum AppDestination: String, CaseIterable, Hashable, Identifiable {
    case parts
    case quotes
    case search

    var id: Self { self }

    var title: String {
        switch self {
        case .parts:
            return "Parts"
        case .quotes:
            return "Quotes"
        case .search:
            return "Search"
        }
    }

    var systemImage: String {
        switch self {
        case .parts:
            return "cube"
        case .quotes:
            return "list.clipboard"
        case .search:
            return "magnifyingglass"
        }
    }

    var routePath: String {
        "/\(rawValue)"
    }

    init?(routeComponent: String) {
        self.init(rawValue: routeComponent.lowercased())
    }
}
