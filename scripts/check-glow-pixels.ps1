param([string]$Prefix = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
foreach ($surface in @('preview','overlay')) {
  $before = [System.Drawing.Bitmap]::new((Resolve-Path -LiteralPath ('qa/glow-layers/'+$Prefix+$surface+'-off.png')).Path)
  $after = [System.Drawing.Bitmap]::new((Resolve-Path -LiteralPath ('qa/glow-layers/'+$Prefix+$surface+'-on.png')).Path)
  try {
    if ($before.Size -ne $after.Size) { throw 'Glow changed glyph layout' }
    $opaqueSolidPixels = 0; $changedSolidPixels = 0
    for ($y = 0; $y -lt $before.Height; $y++) {
      for ($x = 0; $x -lt $before.Width; $x++) {
        $color = $before.GetPixel($x,$y)
        if ($color.A -eq 255 -and $color.R -eq 53 -and $color.G -eq 167 -and $color.B -eq 255) {
          $opaqueSolidPixels++
          if ($after.GetPixel($x,$y).ToArgb() -ne $color.ToArgb()) { $changedSolidPixels++ }
        }
      }
    }
    [pscustomobject]@{ surface=$Prefix+$surface; solidPixels=$opaqueSolidPixels; changedByGlow=$changedSolidPixels } | ConvertTo-Json
    if ($opaqueSolidPixels -lt 200 -or $changedSolidPixels -ne 0) { throw 'Rear glow modified opaque solid glyph pixels' }
  } finally { $before.Dispose(); $after.Dispose() }
}
