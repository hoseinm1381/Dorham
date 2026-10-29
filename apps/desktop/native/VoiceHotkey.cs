using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

// Poll only the explicitly selected key and modifiers. No text, key history,
// or general keyboard hook is collected. A lost parent/stdin stops this helper.
class VoiceHotkey {
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static volatile bool running = true;
  static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
  static int Main(string[] args) {
    int key, mods, parent;
    if (args.Length != 3 || !int.TryParse(args[0], out key) || !int.TryParse(args[1], out mods) || !int.TryParse(args[2], out parent) || key < 20 || key > 222 || mods < 0 || mods > 7 || parent < 1) return 2;
    Task.Run(() => { while (Console.ReadLine() != null) {} running = false; });
    bool previous = false, armed = false; int ticks = 0;
    try {
      while (running) {
        bool raw = Down(key);
        if (!raw) armed = true; // A key held during startup never unmutes a call.
        bool down = armed && raw && Down(17) == ((mods & 1) != 0) && Down(18) == ((mods & 2) != 0) && Down(16) == ((mods & 4) != 0) && !Down(91) && !Down(92);
        if (down != previous) { Console.WriteLine(down ? "D" : "U"); previous = down; }
        if (++ticks % 50 == 0) { using (Process p = Process.GetProcessById(parent)) { if (p.HasExited) break; } Console.WriteLine("H"); }
        Thread.Sleep(20);
      }
    } catch { return 1; }
    return 0;
  }
}
