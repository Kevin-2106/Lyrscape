param([Parameter(Mandatory = $true)][int]$AppProcessId, [ValidateSet('CloseMain', 'TrayOpen', 'TrayOverlay', 'TrayQuit')][string]$Action)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $AppProcessId
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')) + [IO.Path]::DirectorySeparatorChar
if (!$process.Path.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) { throw 'Process is outside this workspace' }
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
public static class LyrscapeTrayFixture {
  delegate bool EnumProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr menu, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint index, StringBuilder text, int size, uint flags);
  static IntPtr Find(uint pid, string kind) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, data) => {
      uint owner; GetWindowThreadProcessId(hwnd, out owner);
      if (owner != pid) return true;
      var cls = new StringBuilder(256); GetClassName(hwnd, cls, 256);
      var title = new StringBuilder(512); GetWindowText(hwnd, title, 512);
      bool match = kind == "tray" ? cls.ToString() == "tray_icon_app" : kind == "menu" ? cls.ToString() == "#32768" : title.ToString() == "Lyrscape";
      if (match) { found = hwnd; return false; } return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Run(uint pid, string action) {
    IntPtr hwnd = Find(pid, action == "CloseMain" ? "main" : "tray");
    if (hwnd == IntPtr.Zero) throw new Exception("Owned native window missing: " + action);
    if (action == "CloseMain") { PostMessage(hwnd, 0x10, UIntPtr.Zero, IntPtr.Zero); return; }
    // tray-icon 0.25's Shell callback; exercises the native handler without global input.
    PostMessage(hwnd, 6002, UIntPtr.Zero, new IntPtr(action == "TrayOpen" ? 0x202 : 0x205));
    if (action == "TrayOpen") return;
    IntPtr popup = IntPtr.Zero;
    for (int i = 0; i < 60 && popup == IntPtr.Zero; i++) { Thread.Sleep(50); popup = Find(pid, "menu"); }
    if (popup == IntPtr.Zero) throw new Exception("Native tray menu did not open");
    IntPtr menu = SendMessage(popup, 0x1E1, UIntPtr.Zero, IntPtr.Zero);
    for (int i = 0; i < GetMenuItemCount(menu); i++) {
      var text = new StringBuilder(256); GetMenuString(menu, (uint)i, text, 256, 0x400);
      string wanted = action == "TrayQuit" ? "\u9000\u51fa Lyrscape" : "\u663e\u793a / \u9690\u85cf";
      if (text.ToString().Contains(wanted)) {
        uint id = GetMenuItemID(menu, i);
        PostMessage(hwnd, 0x1F, UIntPtr.Zero, IntPtr.Zero); // WM_CANCELMODE closes its popup.
        PostMessage(hwnd, 0x111, new UIntPtr(id), IntPtr.Zero);
        return;
      }
    }
    throw new Exception("Quit item missing from native tray menu");
  }
}
'@
[LyrscapeTrayFixture]::Run($AppProcessId, $Action)
Write-Output "PASS: $Action on owned PID $AppProcessId"
