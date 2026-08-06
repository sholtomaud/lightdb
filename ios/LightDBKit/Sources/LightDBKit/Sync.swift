import Foundation

extension SyncMessage {
    /// Build a message for `peerVector`, the last vector seen from that peer.
    /// Pass nil on a first sync to send the whole log.
    public static func build(from db: LWWMap, peerVector: VersionVector?) -> SyncMessage {
        SyncMessage(
            peer: db.actor,
            vv: db.versionVector(),
            ops: db.changesSince(peerVector ?? [:])
        )
    }

    /// JSON bytes for the wire.
    ///
    /// Deliberately uncompressed. The receiver reads the gzip flag from the
    /// frame header and handles either, and a device-provisioning payload is a
    /// couple of frames at most -- not worth carrying a deflate implementation
    /// to save a fraction of one.
    public func encode() throws -> [UInt8] {
        let encoder = JSONEncoder()
        // Stable output makes a frame stream reproducible between runs, which
        // matters when debugging a transfer that only half worked.
        encoder.outputFormatting = [.sortedKeys]
        return [UInt8](try encoder.encode(self))
    }
}
