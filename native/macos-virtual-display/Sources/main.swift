// SPDX-FileCopyrightText: (C) 2026 OmniDesk contributors
// SPDX-License-Identifier: GPL-2.0-only
//
// omnidesk-virtual-display: creates one virtual monitor with the private
// CGVirtualDisplay API, prints one JSON line on stdout and keeps the monitor
// alive until stdin closes, SIGTERM/SIGINT/SIGHUP arrives, or the parent dies.
//
//   omnidesk-virtual-display --width 1920 --height 1080 --refresh 60 [--hidpi] [--name "OmniDesk Display"]
//
// stdout, success: {"ok":true,"displayId":<CGDirectDisplayID>,"width":..,"height":..,"refresh":..,"hidpi":false,"name":".."}
// stdout, failure: {"ok":false,"error":"<code>","message":".."} and exit code 2.
// After the display is removed: {"ok":true,"event":"removed"} (best effort).

import Foundation
import CoreGraphics

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    }
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "error": code, "message": message])
    exit(2)
}

// ---- arguments ----
var width = 1920, height = 1080, refresh = 60.0, hidpi = false
var name = "OmniDesk Display"
var serial: UInt32 = 0x4F44 // "OD"
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let a = args.removeFirst()
    func value() -> String { if args.isEmpty { fail("bad-args", "missing value for \(a)") }; return args.removeFirst() }
    switch a {
    case "--width": width = Int(value()) ?? -1
    case "--height": height = Int(value()) ?? -1
    case "--refresh": refresh = Double(value()) ?? -1
    case "--name": name = String(value().prefix(64))
    case "--serial": serial = UInt32(value()) ?? serial
    case "--hidpi": hidpi = true
    case "--version": print("omnidesk-virtual-display 1.0.0"); exit(0)
    default: fail("bad-args", "unknown argument \(a)")
    }
}
guard (640...7680).contains(width), (480...4320).contains(height), (24.0...240.0).contains(refresh) else {
    fail("bad-args", "width 640-7680, height 480-4320, refresh 24-240")
}
if hidpi && (width % 2 != 0 || height % 2 != 0) { fail("bad-args", "hidpi needs even width and height") }

func activeDisplays() -> [CGDirectDisplayID] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return Array(ids.prefix(Int(count)))
}

// The private classes must exist at runtime; check before touching them so a
// future macOS without them gives a clean error instead of a crash.
for cls in ["CGVirtualDisplay", "CGVirtualDisplayDescriptor", "CGVirtualDisplayMode", "CGVirtualDisplaySettings"] {
    if NSClassFromString(cls) == nil { fail("api-missing", "\(cls) is not available on this macOS") }
}

// ---- create ----
let queue = DispatchQueue(label: "omnidesk.virtual-display")
var display: CGVirtualDisplay?

let descriptor = CGVirtualDisplayDescriptor()
descriptor.queue = queue
descriptor.name = name
descriptor.maxPixelsWide = UInt32(width)
descriptor.maxPixelsHigh = UInt32(height)
// Physical size: pretend ~110 ppi so macOS picks sensible defaults.
descriptor.sizeInMillimeters = CGSize(width: Double(width) * 25.4 / 110.0, height: Double(height) * 25.4 / 110.0)
descriptor.vendorID = 0x4F44   // arbitrary, only needs to be stable
descriptor.productID = 0x0001
descriptor.serialNum = serial
descriptor.terminationHandler = { _, _ in
    emit(["ok": true, "event": "terminated"])
    exit(3)
}

guard let created = CGVirtualDisplay(descriptor: descriptor) else {
    fail("create-failed", "CGVirtualDisplay init returned nil")
}
display = created

let settings = CGVirtualDisplaySettings()
settings.hiDPI = hidpi ? 1 : 0
let modeW = hidpi ? width / 2 : width
let modeH = hidpi ? height / 2 : height
settings.modes = [CGVirtualDisplayMode(width: UInt(modeW), height: UInt(modeH), refreshRate: CGFloat(refresh))]
if !created.apply(settings) {
    display = nil
    fail("settings-failed", "applySettings returned false")
}

let id = created.displayID
// Wait until WindowServer lists it (usually < 1 s).
let deadline = Date().addingTimeInterval(5)
while !activeDisplays().contains(id) && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
}
if !activeDisplays().contains(id) {
    display = nil
    fail("not-active", "display \(id) was created but never became active")
}
emit(["ok": true, "displayId": Int(id), "width": width, "height": height, "refresh": refresh,
      "hidpi": hidpi, "name": name, "activeDisplays": activeDisplays().count])

// ---- keep alive until told to stop ----
func shutdown(_ why: String) -> Never {
    display = nil // releasing the object removes the monitor
    emit(["ok": true, "event": "removed", "reason": why])
    exit(0)
}

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { shutdown("signal \(sig)") }
    src.resume()
    signalSources.append(src)
}

// stdin EOF = parent closed the pipe or died.
Thread.detachNewThread {
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { DispatchQueue.main.async { shutdown("stdin closed") }; return }
    }
}

// Also watch the parent pid in case stdin was inherited from elsewhere.
let parent = getppid()
let parentTimer = DispatchSource.makeTimerSource(queue: .main)
parentTimer.schedule(deadline: .now() + 1, repeating: 1)
parentTimer.setEventHandler { if getppid() != parent { shutdown("parent exited") } }
parentTimer.resume()

dispatchMain()
