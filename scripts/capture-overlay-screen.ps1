param(
  [Parameter(Mandatory = $true)][int]$AppProcessId,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [int]$FrameCount = 24,
  [int]$IntervalMs = 100
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OverlayScreenCapture {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  public struct Rect { public int Left, Top, Right, Bottom; }
  public struct Point { public int X, Y; }
}
'@
[void][OverlayScreenCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
$windows = [System.Collections.Generic.Dictionary[string,IntPtr]]::new()
$enumerate = [OverlayScreenCapture+EnumProc]{ param($handle, $unused)
  [uint32]$owner = 0
  [void][OverlayScreenCapture]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($owner -eq $AppProcessId) {
    $title = [System.Text.StringBuilder]::new(256)
    [void][OverlayScreenCapture]::GetWindowText($handle, $title, 256)
    if ($title.Length -gt 0) { $windows[$title.ToString()] = $handle }
  }
  return $true
}
[void][OverlayScreenCapture]::EnumWindows($enumerate, [IntPtr]::Zero)
if (!$windows.ContainsKey('Lyrscape') -or !$windows.ContainsKey('Lyrscape Desktop Lyrics')) { throw 'Expected both isolated test windows' }
$main = $windows['Lyrscape']; $overlay = $windows['Lyrscape Desktop Lyrics']
# The caller first paints the isolated control WebView a uniform #112233 backdrop.
# Only pixels within that backdrop are saved, so unrelated desktop content is excluded.
[void][OverlayScreenCapture]::SetWindowPos($main, [IntPtr](-1), 150, 180, 1600, 800, 0x50)
[void][OverlayScreenCapture]::SetWindowPos($overlay, [IntPtr](-1), 200, 300, 0, 0, 0x51)
Start-Sleep -Milliseconds 200
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
[void][System.IO.Directory]::CreateDirectory($destination)
$backdrop = [OverlayScreenCapture+Rect]::new(); $origin = [OverlayScreenCapture+Point]::new()
[void][OverlayScreenCapture]::GetClientRect($main, [ref]$backdrop)
[void][OverlayScreenCapture]::ClientToScreen($main, [ref]$origin)
for ($index = 0; $index -lt $FrameCount; $index++) {
  $bounds = [OverlayScreenCapture+Rect]::new()
  [void][OverlayScreenCapture]::GetWindowRect($overlay, [ref]$bounds)
  $width = $bounds.Right - $bounds.Left; $height = $bounds.Bottom - $bounds.Top
  if ($width -le 0 -or $height -le 0 -or $bounds.Left -lt $origin.X -or $bounds.Top -lt $origin.Y -or $bounds.Right -gt ($origin.X + $backdrop.Right) -or $bounds.Bottom -gt ($origin.Y + $backdrop.Bottom)) { throw 'Overlay capture must stay within the controlled backdrop' }
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
    # Geometry alone cannot detect a minimized/temporarily obscured backdrop.
    # Reject the capture before saving if unrelated desktop pixels are visible.
    foreach ($corner in @(@(0,0), @(($width-1),0), @(0,($height-1)), @(($width-1),($height-1)))) {
      $backgroundPixel = $bitmap.GetPixel($corner[0],$corner[1])
      if ($backgroundPixel.R -ne 17 -or $backgroundPixel.G -ne 34 -or $backgroundPixel.B -ne 51) { throw 'Controlled backdrop is not visible; refusing to save screen pixels' }
    }
    $bitmap.Save((Join-Path $destination ('frame-{0:D3}.png' -f $index)), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  Start-Sleep -Milliseconds $IntervalMs
}
Write-Output ('Saved {0} OS-composited overlay frames to {1}' -f $FrameCount, $destination)
