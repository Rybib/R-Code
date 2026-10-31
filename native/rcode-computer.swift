// rcode-computer: the small native helper behind R-Code's `computer` tool. It posts mouse and
// keyboard events, reports the macOS permissions computer control needs, and refuses input aimed
// at R-Code itself (pass --deny-pid with R-Code's pid), so an agent can never click its own
// approval buttons. Every call prints one JSON object: the result, or {"error": "..."}.
//
//   rcode-computer status | request
//   rcode-computer click X Y [--button left|right|middle] [--count 1-3]
//   rcode-computer move X Y | drag X1 Y1 X2 Y2 | scroll X Y DX DY
//   rcode-computer type TEXT | key "cmd+shift+t return"
//
// Coordinates are global display points (top-left of the main display is 0,0).

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(obj["error"] == nil ? 0 : 1)
}

func fail(_ message: String, needs: String? = nil) -> Never {
  var obj: [String: Any] = ["error": message]
  if let needs { obj["needs"] = needs }
  emit(obj)
}

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
  guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
  let value = args[i + 1]
  args.removeSubrange(i...(i + 1))
  return value
}
let denyPid = option("--deny-pid").flatMap { pid_t($0) }
let buttonName = option("--button") ?? "left"
let clickCount = max(1, min(3, Int(option("--count") ?? "1") ?? 1))
guard let command = args.first else { fail("usage: rcode-computer <command> [args]") }
let rest = Array(args.dropFirst())

func number(_ i: Int) -> Double {
  guard i < rest.count, let v = Double(rest[i]), v.isFinite else { fail("\(command): argument \(i + 1) must be a number") }
  return v
}

// ───────────── state ─────────────

func frontmost() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
  return ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier)]
}

func status() -> [String: Any] {
  let bounds = CGDisplayBounds(CGMainDisplayID())
  return [
    "accessibility": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "display": ["width": bounds.width, "height": bounds.height, "scale": NSScreen.main?.backingScaleFactor ?? 2],
    "frontmost": frontmost()
  ]
}

/// The app that would receive a click at a point. Accessibility hit-testing is exact; the window
/// list is the fallback. It skips full-screen overlays above normal windows (the Dock keeps an
/// invisible one over the whole display), which never take the click.
func appUnder(_ p: CGPoint) -> pid_t? {
  var element: AXUIElement?
  var pid: pid_t = 0
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &element) == .success,
     let element, AXUIElementGetPid(element, &pid) == .success {
    return pid
  }
  let display = CGDisplayBounds(CGMainDisplayID())
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in list { // front to back
    guard let dict = w[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: dict), rect.contains(p),
          (w[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { continue }
    if (w[kCGWindowLayer as String] as? Int ?? 0) != 0 && rect.contains(display) { continue }
    return w[kCGWindowOwnerPID as String] as? pid_t
  }
  return nil
}

func rcodeIsFrontmost() -> Bool {
  guard let deny = denyPid else { return false }
  return NSWorkspace.shared.frontmostApplication?.processIdentifier == deny
}

func requireAccessibility() {
  if !AXIsProcessTrusted() {
    fail("R-Code doesn't have Accessibility permission, which it needs to use the mouse and keyboard.", needs: "accessibility")
  }
}

/// Refuse pointer input that would land on R-Code (its windows, or its menu bar while it's in front).
func guardPoint(_ p: CGPoint) {
  guard let deny = denyPid else { return }
  if appUnder(p) == deny {
    fail("(\(Int(p.x)), \(Int(p.y))) is on R-Code's own window, which agents can't control. Click inside the app you're working in, or bring it forward with open_app.")
  }
  if rcodeIsFrontmost(), let screen = NSScreen.main {
    let menuBar = max(screen.frame.maxY - screen.visibleFrame.maxY, NSStatusBar.system.thickness)
    if p.y < menuBar {
      fail("R-Code is the frontmost app, so the menu bar belongs to R-Code. Bring the target app forward first with open_app.")
    }
  }
}

/// Refuse keystrokes while R-Code has keyboard focus.
func guardKeyboard() {
  if rcodeIsFrontmost() {
    fail("R-Code is the frontmost app, so keystrokes would go into R-Code. Bring the target app forward first (open_app, or click its window).")
  }
}

// ───────────── mouse ─────────────

let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
  event?.post(tap: .cghidEventTap)
}

func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clickState: Int = 1) {
  let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
  event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
  event?.flags = []
  post(event)
}

func point(_ xi: Int, _ yi: Int) -> CGPoint {
  CGPoint(x: number(xi), y: number(yi))
}

func click(_ p: CGPoint) {
  let (down, up, button): (CGEventType, CGEventType, CGMouseButton) =
    switch buttonName {
    case "right": (.rightMouseDown, .rightMouseUp, .right)
    case "middle": (.otherMouseDown, .otherMouseUp, .center)
    default: (.leftMouseDown, .leftMouseUp, .left)
    }
  mouse(.mouseMoved, p)
  usleep(40_000)
  for n in 1...clickCount {
    mouse(down, p, button, clickState: n)
    usleep(20_000)
    mouse(up, p, button, clickState: n)
    if n < clickCount { usleep(60_000) }
  }
}

func drag(from a: CGPoint, to b: CGPoint) {
  mouse(.mouseMoved, a)
  usleep(40_000)
  mouse(.leftMouseDown, a)
  usleep(60_000)
  let steps = 24
  for i in 1...steps {
    let t = CGFloat(i) / CGFloat(steps)
    mouse(.leftMouseDragged, CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
    usleep(12_000)
  }
  usleep(40_000)
  mouse(.leftMouseUp, b)
}

/// Scroll by whole lines, one at a time so apps that clamp large deltas still move the full amount.
func scroll(at p: CGPoint, dx: Int, dy: Int) {
  mouse(.mouseMoved, p)
  usleep(40_000)
  for i in 0..<max(abs(dx), abs(dy)) {
    let wy = i < abs(dy) ? Int32(dy.signum()) : 0
    let wx = i < abs(dx) ? Int32(dx.signum()) : 0
    post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: wy, wheel2: wx, wheel3: 0))
    usleep(12_000)
  }
}

// ───────────── keyboard ─────────────

// Virtual key codes (US ANSI positions; on other layouts letters follow the physical key).
let keyCodes: [String: CGKeyCode] = [
  "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
  "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
  "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
  "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
  "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
  "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31, "delete": 0x33, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
  "forwarddelete": 0x75, "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
  "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
  "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65,
  "f10": 0x6D, "f11": 0x67, "f12": 0x6F
]

let modifierFlags: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift,
  "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
  "ctrl": .maskControl, "control": .maskControl, "fn": .maskSecondaryFn
]

func press(_ code: CGKeyCode, _ flags: CGEventFlags) {
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    event?.flags = flags
    post(event)
    usleep(15_000)
  }
}

/// Parse "cmd+shift+t" into a key code and modifiers.
func combo(_ text: String) -> (CGKeyCode, CGEventFlags) {
  var parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
  if text.hasSuffix("++") { parts = Array(parts.dropLast(2)) + ["="]; } // "cmd++" means cmd+= on a US keyboard
  guard let keyName = parts.popLast(), !keyName.isEmpty else { fail("key: \"\(text)\" has no key after its modifiers") }
  var flags: CGEventFlags = []
  for m in parts {
    guard let f = modifierFlags[m] else { fail("key: unknown modifier \"\(m)\" in \"\(text)\" (use cmd, shift, option, ctrl, fn)") }
    flags.insert(f)
  }
  guard let code = keyCodes[keyName] else { fail("key: unknown key \"\(keyName)\" in \"\(text)\". Use letters, digits, return, tab, space, delete, escape, arrows, home/end, pageup/pagedown or f1–f12; type text with the type action.") }
  return (code, flags)
}

func typeText(_ text: String) {
  for (i, line) in text.components(separatedBy: "\n").enumerated() {
    if i > 0 { press(0x24, []) }
    var units = Array(line.utf16)
    while !units.isEmpty {
      var n = min(16, units.count)
      if n < units.count, UTF16.isLeadSurrogate(units[n - 1]) { n -= 1 } // don't split an emoji
      let chunk = Array(units.prefix(n))
      units.removeFirst(n)
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        event?.flags = []
        event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        post(event)
      }
      usleep(10_000)
    }
  }
}

// ───────────── commands ─────────────

switch command {
case "status":
  emit(status())
case "request":
  // Shows the system prompts (or adds R-Code to the lists in System Settings).
  _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
  _ = CGRequestScreenCaptureAccess()
  emit(status())
case "click", "move":
  requireAccessibility()
  let p = point(0, 1)
  if command == "click" {
    guardPoint(p)
    click(p)
  } else {
    mouse(.mouseMoved, p)
  }
case "drag":
  requireAccessibility()
  let a = point(0, 1), b = point(2, 3)
  guardPoint(a)
  guardPoint(b)
  drag(from: a, to: b)
case "scroll":
  requireAccessibility()
  let p = point(0, 1)
  guardPoint(p)
  scroll(at: p, dx: Int(number(2)), dy: Int(number(3)))
case "type":
  requireAccessibility()
  guardKeyboard()
  guard let text = rest.first else { fail("type: missing text") }
  typeText(text)
case "key":
  requireAccessibility()
  guardKeyboard()
  guard let spec = rest.first else { fail("key: missing keys") }
  let combos = spec.split(whereSeparator: { $0 == " " }).map { combo(String($0)) } // validate all before pressing any
  for (code, flags) in combos {
    press(code, flags)
    usleep(40_000)
  }
default:
  fail("unknown command \"\(command)\"")
}
usleep(50_000)
emit(["ok": true, "frontmost": frontmost()])
