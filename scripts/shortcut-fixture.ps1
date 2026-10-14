param([ValidateSet('Press','Hold','Minimize','Restore')][string]$Mode = 'Press', [ValidateRange(20,24)][int]$FunctionKey = 20, [string]$ReadyFile = '', [string]$StopFile = '', [int]$WindowProcessId = 0)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LyrscapeHotkeyFixture {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr h, int id, uint modifiers, uint key);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
}
'@
$virtualKey = [byte](0x70 + $FunctionKey - 1)
if ($Mode -in @('Minimize','Restore')) {
  $testProcess = Get-Process -Id $WindowProcessId
  $expected = [IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) 'builds/Lyrscape-audio-shortcuts-qa.exe'))
  if ($testProcess.Path -ne $expected) { throw 'Window fixture may control only the isolated QA executable' }
  [void][LyrscapeHotkeyFixture]::ShowWindow($testProcess.MainWindowHandle, $(if ($Mode -eq 'Minimize') { 6 } else { 9 }))
} elseif ($Mode -eq 'Hold') {
  if (![LyrscapeHotkeyFixture]::RegisterHotKey([IntPtr]::Zero, 31206, 0x4007, $virtualKey)) { throw 'Fixture hotkey is already occupied' }
  try {
    Set-Content -LiteralPath $ReadyFile -Value 'registered'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (!(Test-Path -LiteralPath $StopFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  } finally { [void][LyrscapeHotkeyFixture]::UnregisterHotKey([IntPtr]::Zero, 31206) }
} else {
  $pressed = [byte[]]@(0x11, 0x12, 0x10, $virtualKey)
  try {
    foreach ($key in $pressed) { [LyrscapeHotkeyFixture]::keybd_event($key, 0, 0, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 80
  } finally {
    for ($index = $pressed.Length - 1; $index -ge 0; $index--) { [LyrscapeHotkeyFixture]::keybd_event($pressed[$index], 0, 2, [UIntPtr]::Zero) }
  }
}
