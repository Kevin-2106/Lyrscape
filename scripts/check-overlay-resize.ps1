param([Parameter(Mandatory = $true)][int]$AppProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OverlayResizeMouse {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public struct Rect { public int Left, Top, Right, Bottom; }
  public struct Point { public int X, Y; }
}
'@
[void][OverlayResizeMouse]::SetProcessDpiAwarenessContext([IntPtr](-4))
$script:resizeWindow = [IntPtr]::Zero
$enumerate = [OverlayResizeMouse+EnumProc]{ param($handle, $unused)
  [uint32]$owner = 0
  [void][OverlayResizeMouse]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($owner -eq $AppProcessId) {
    $title = [System.Text.StringBuilder]::new(256)
    [void][OverlayResizeMouse]::GetWindowText($handle, $title, 256)
    if ($title.ToString() -eq 'Lyrscape Desktop Lyrics') { $script:resizeWindow = $handle }
  }
  return $true
}
[void][OverlayResizeMouse]::EnumWindows($enumerate, [IntPtr]::Zero)
if ($script:resizeWindow -eq [IntPtr]::Zero) { throw 'Isolated overlay window not found' }
$originalCursor = [OverlayResizeMouse+Point]::new()
[void][OverlayResizeMouse]::GetCursorPos([ref]$originalCursor)
$results = @()
try {
  foreach ($edge in @('East', 'West')) {
    $before = [OverlayResizeMouse+Rect]::new()
    [void][OverlayResizeMouse]::GetWindowRect($script:resizeWindow, [ref]$before)
    $x = if ($edge -eq 'East') { $before.Right - 7 } else { $before.Left + 7 }
    $y = [int](($before.Top + $before.Bottom) / 2)
    [void][OverlayResizeMouse]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 120
    [OverlayResizeMouse]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    for ($step = 1; $step -le 8; $step++) {
      $destinationX = if ($edge -eq 'East') { $x - $step * 12 } else { $x + $step * 12 }
      [void][OverlayResizeMouse]::SetCursorPos($destinationX, $y)
      Start-Sleep -Milliseconds 35
    }
    [OverlayResizeMouse]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 500
    $after = [OverlayResizeMouse+Rect]::new()
    [void][OverlayResizeMouse]::GetWindowRect($script:resizeWindow, [ref]$after)
    $oldWidth = $before.Right - $before.Left; $newWidth = $after.Right - $after.Left
    $results += [pscustomobject]@{ edge=$edge; beforeWidth=$oldWidth; afterWidth=$newWidth; passed=($oldWidth-$newWidth -ge 48) }
  }
} finally {
  [OverlayResizeMouse]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
  [void][OverlayResizeMouse]::SetCursorPos($originalCursor.X, $originalCursor.Y)
}
$results | ConvertTo-Json
if (@($results | Where-Object { !$_.passed }).Count) { throw 'Native edge resize did not change width as expected' }
