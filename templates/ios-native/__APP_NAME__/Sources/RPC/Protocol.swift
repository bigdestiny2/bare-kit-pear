//  {{APP_NAME}} — Protocol.swift
//
//  Command and event IDs shared with the backend. MUST stay in sync with
//  whatever constants your backend/index.js defines for rpc dispatch.
//
//  The default set below is a starter template — replace Cmd / Evt cases
//  with your own backend's protocol. BarePear.RPC is fully generic and
//  doesn't care about these IDs; they're just ints on the wire.

import Foundation

enum Cmd: Int {
    case getStatus = 1
    // Add more: e.g. case loadData = 10, case saveRecord = 11, …
}

enum Evt: Int {
    case ready = 100
    case peerCount = 101
    case error = 102
    // Add more: e.g. case syncProgress = 110, case newMessage = 111, …
}
