import Foundation
import Network

final class ConnectivityMonitor: ObservableObject {
    @Published private(set) var isOnline = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.optomachina.overdrafter.connectivity")

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.isOnline = path.status == .satisfied
            }
        }
        monitor.start(queue: queue)
    }

    deinit {
        monitor.cancel()
    }
}
