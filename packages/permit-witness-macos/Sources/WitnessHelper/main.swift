import Darwin
import Foundation
import WitnessTransport

// No stdin, argv, environment, configuration, Keychain or listener access.
// Packaging/signing alone must not accidentally enable this candidate.
do {
    try CandidateStartup.run()
} catch {
    FileHandle.standardError.write(Data("ERR_WITNESS_TRUSTED_BOOTSTRAP_UNAVAILABLE\n".utf8))
    exit(78)
}
