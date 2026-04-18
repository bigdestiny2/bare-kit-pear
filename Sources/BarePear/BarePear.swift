//  BarePear — public namespace.
//
//  Types are nested under this enum so call sites read `BarePear.Host`
//  and `BarePear.RPC`, matching the documentation.

import Foundation

/// Root namespace for the BarePear SDK.
///
/// Use `BarePear.Host` to spawn and own a Bare worklet, and `BarePear.RPC`
/// for length-prefixed JSON RPC against the running worklet. See BUILD.md
/// in the package root for the full recipe.
public enum BarePear {
    /// SDK version string.
    public static let version = "0.1.0"
}
