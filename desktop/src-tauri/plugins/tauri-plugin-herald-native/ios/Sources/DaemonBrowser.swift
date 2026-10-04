import Foundation
import Network

/// One `_companion._tcp` service: the same shape Android and desktop return.
struct FoundDaemon: Encodable {
  let name: String
  let host: String
  let addresses: [String]
  let port: Int
  let txt: [String: String]
}

struct DiscoverResult: Encodable {
  let daemons: [FoundDaemon]
}

/// "192.168.1.5%en0" -> "192.168.1.5".
func stripScope(_ host: String) -> String {
  if let i = host.firstIndex(of: "%") { return String(host[..<i]) }
  return host
}

/// Pairing "Nearby": browse Bonjour for a fixed time; resolve each service to
/// an IPv4 host:port by opening (and immediately closing) a TCP connection to
/// it. Needs NSLocalNetworkUsageDescription + NSBonjourServices (setup-ios.sh);
/// the first browse shows iOS's local-network permission prompt.
@available(iOS 13.0, macOS 10.15, *)
final class DaemonBrowser {
  private let queue = DispatchQueue(label: "companion.daemon-browser")
  private var browser: NWBrowser?
  private var connections: [NWConnection] = []
  private var resolving = Set<String>()
  private var results: [String: FoundDaemon] = [:]
  private var finished = false

  func browse(timeoutMs: Int, done: @escaping ([FoundDaemon]) -> Void) {
    let params = NWParameters()
    params.includePeerToPeer = false
    let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_companion._tcp", domain: nil), using: params)
    browser = b
    b.browseResultsChangedHandler = { [weak self] found, _ in
      guard let self = self else { return }
      for r in found { self.resolve(r) }
    }
    b.start(queue: queue)
    let ms = max(500, min(timeoutMs, 10_000))
    queue.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in
      guard let self = self else { return }
      self.finished = true
      self.browser?.cancel()
      self.connections.forEach { $0.cancel() }
      self.connections.removeAll()
      done(self.results.values.sorted { $0.name < $1.name })
    }
  }

  private func resolve(_ r: NWBrowser.Result) {
    guard case let .service(name, _, _, _) = r.endpoint else { return }
    if finished || resolving.contains(name) { return }
    resolving.insert(name)
    let txt: [String: String]
    if case let .bonjour(record) = r.metadata {
      txt = record.dictionary
    } else {
      txt = [:]
    }
    let params = NWParameters.tcp
    if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ip.version = .v4
    }
    let conn = NWConnection(to: r.endpoint, using: params)
    connections.append(conn)
    conn.stateUpdateHandler = { [weak self, weak conn] state in
      guard let self = self, let conn = conn else { return }
      switch state {
      case .ready:
        if case let .hostPort(host, port)? = conn.currentPath?.remoteEndpoint {
          let addr = stripScope("\(host)")
          self.results[name] = FoundDaemon(
            name: name, host: addr, addresses: [addr], port: Int(port.rawValue), txt: txt)
        }
        conn.cancel()
      case .failed:
        conn.cancel()
      default:
        break
      }
    }
    conn.start(queue: queue)
  }
}
