import Foundation
import Security

struct KeychainError: Error, Equatable, Sendable, CustomStringConvertible {
    let status: OSStatus

    var description: String {
        "KeychainError(status: \(status))"
    }
}

protocol KeychainBackend: Sendable {
    func update(_ query: [CFString: Any], attributes: [CFString: Any]) -> OSStatus
    func add(_ attributes: [CFString: Any]) -> OSStatus
    func copyMatching(_ query: [CFString: Any]) -> (OSStatus, Data?)
}

struct SystemKeychainBackend: KeychainBackend, Sendable {
    func update(_ query: [CFString: Any], attributes: [CFString: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func add(_ attributes: [CFString: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func copyMatching(_ query: [CFString: Any]) -> (OSStatus, Data?) {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        return (status, result as? Data)
    }
}

struct KeychainStore: SecretStoring, Sendable {
    static let requiredService = "com.yym8224961.slate-quota-collector"

    private let service: String
    private let backend: any KeychainBackend

    init(
        service: String = Self.requiredService,
        backend: any KeychainBackend = SystemKeychainBackend()
    ) {
        self.service = service
        self.backend = backend
    }

    func read(account: String) throws -> String {
        var query = baseQuery(account: account)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne

        let (status, data) = backend.copyMatching(query)
        guard status == errSecSuccess else {
            throw KeychainError(status: status)
        }
        guard let data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainError(status: errSecDecode)
        }
        return value
    }

    func write(_ value: String, account: String) throws {
        let query = baseQuery(account: account)
        let attributes: [CFString: Any] = [
            kSecValueData: Data(value.utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let updateStatus = backend.update(query, attributes: attributes)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var item = query
            for (key, value) in attributes {
                item[key] = value
            }
            let addStatus = backend.add(item)
            guard addStatus == errSecSuccess else {
                throw KeychainError(status: addStatus)
            }
        default:
            throw KeychainError(status: updateStatus)
        }
    }

    private func baseQuery(account: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
    }
}
