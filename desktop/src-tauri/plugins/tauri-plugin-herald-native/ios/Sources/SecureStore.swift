import Foundation
import Security

/// Secrets (paired-device tokens) at rest on iOS: the Keychain, one generic
/// password per entry, readable after the first unlock and never synced or
/// restored to another device (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly).
enum SecureStore {
  static let service = "com.hexidecibel.companion.secure"

  enum Failure: Error, CustomStringConvertible {
    case badKey
    case status(OSStatus)
    var description: String {
      switch self {
      case .badKey: return "bad key name"
      case .status(let s): return "keychain error \(s)"
      }
    }
  }

  static func validKey(_ key: String) -> Bool {
    guard !key.isEmpty, key.count <= 128 else { return false }
    return key.unicodeScalars.allSatisfy { c in
      CharacterSet.alphanumerics.contains(c) || ".:_-".unicodeScalars.contains(c)
    }
  }

  private static func base(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  static func get(_ key: String) throws -> String? {
    guard validKey(key) else { throw Failure.badKey }
    var q = base(key)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    let st = SecItemCopyMatching(q as CFDictionary, &out)
    if st == errSecItemNotFound { return nil }
    guard st == errSecSuccess else { throw Failure.status(st) }
    guard let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func set(_ key: String, _ value: String) throws {
    guard validKey(key) else { throw Failure.badKey }
    let data = Data(value.utf8)
    let del = SecItemDelete(base(key) as CFDictionary)
    guard del == errSecSuccess || del == errSecItemNotFound else { throw Failure.status(del) }
    var add = base(key)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let st = SecItemAdd(add as CFDictionary, nil)
    guard st == errSecSuccess else { throw Failure.status(st) }
  }

  static func delete(_ key: String) throws {
    guard validKey(key) else { throw Failure.badKey }
    let st = SecItemDelete(base(key) as CFDictionary)
    guard st == errSecSuccess || st == errSecItemNotFound else { throw Failure.status(st) }
  }
}
