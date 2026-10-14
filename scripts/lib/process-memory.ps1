param([Parameter(Mandatory = $true)][int]$RootProcessId)
$ErrorActionPreference = 'Stop'
$all = Get-CimInstance Win32_Process
$ids = @($RootProcessId)
do {
  $count = $ids.Count
  $ids = @($ids + @($all | Where-Object { $_.ParentProcessId -in $ids }).ProcessId | Sort-Object -Unique)
} while ($ids.Count -gt $count)
$rows = @($all | Where-Object { $_.ProcessId -in $ids } | ForEach-Object {
  $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($process) {
    [pscustomobject]@{ id = $_.ProcessId; name = $_.Name; privateBytes = $process.PrivateMemorySize64; workingBytes = $process.WorkingSet64 }
  }
})
ConvertTo-Json -InputObject $rows -Compress
