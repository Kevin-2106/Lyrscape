param([Parameter(Mandatory = $true)][int]$AppProcessId, [ValidateSet('Minimize', 'Restore')][string]$Mode)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $AppProcessId
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')) + [IO.Path]::DirectorySeparatorChar
if (!$process.Path.StartsWith($workspace, [StringComparison]::OrdinalIgnoreCase)) { throw 'Process is outside this workspace' }
if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Application main window missing' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MemoryWindowState {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
}
'@
$command = if ($Mode -eq 'Minimize') { 6 } else { 9 }
[void][MemoryWindowState]::ShowWindowAsync($process.MainWindowHandle, $command)
