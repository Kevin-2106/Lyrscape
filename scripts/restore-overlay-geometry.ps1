param([Parameter(Mandatory = $true)][int]$AppProcessId, [string]$Snapshot = 'qa/app-session-before-update.json')
$ErrorActionPreference = 'Stop'
$session = Get-Content -LiteralPath $Snapshot | ConvertFrom-Json
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OverlayGeometry {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
[void][OverlayGeometry]::SetProcessDpiAwarenessContext([IntPtr](-4))
$script:overlayHandle = [IntPtr]::Zero
$enumerate = [OverlayGeometry+EnumProc]{ param($handle, $unused)
  [uint32]$owner = 0; [void][OverlayGeometry]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($owner -eq $AppProcessId) {
    $title = [System.Text.StringBuilder]::new(256); [void][OverlayGeometry]::GetWindowText($handle, $title, 256)
    if ($title.ToString() -eq 'Lyrscape Desktop Lyrics') { $script:overlayHandle = $handle }
  }
  return $true
}
[void][OverlayGeometry]::EnumWindows($enumerate, [IntPtr]::Zero)
if ($script:overlayHandle -eq [IntPtr]::Zero) { throw 'Target overlay missing' }
# Keep native z-order, visibility and focus. Height will subsequently follow layout.
if (![OverlayGeometry]::SetWindowPos($script:overlayHandle, [IntPtr]::Zero, $session.position.x, $session.position.y, $session.size.width, $session.size.height, 0x14)) { throw 'Failed to restore overlay geometry' }
Write-Output 'Restored overlay physical position and width.'
