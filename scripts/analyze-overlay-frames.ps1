param([Parameter(Mandatory = $true)][string]$Directory, [switch]$FailOnContamination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$drawingReferences = [System.Collections.Generic.HashSet[string]]::new()
[void]$drawingReferences.Add([System.Drawing.Bitmap].Assembly.Location)
[void]$drawingReferences.Add([System.Drawing.Color].Assembly.Location)
$drawingQueue = [System.Collections.Generic.Queue[System.Reflection.Assembly]]::new()
$drawingQueue.Enqueue([System.Drawing.Bitmap].Assembly)
while ($drawingQueue.Count -gt 0) {
  $assembly = $drawingQueue.Dequeue()
  foreach ($reference in $assembly.GetReferencedAssemblies()) {
    if ($reference.Name -match '^System\.(Drawing|Private\.Windows)') {
      $dependency = [System.Reflection.Assembly]::Load($reference)
      if ($drawingReferences.Add($dependency.Location)) { $drawingQueue.Enqueue($dependency) }
    }
  }
}
Add-Type -ReferencedAssemblies @($drawingReferences) @'
using System.Drawing;
public static class OverlayGuardPixels {
  public static int Count(string path) {
    using(var bitmap = new Bitmap(path)) {
      int count = 0;
      // Fixture text is centered. Strong violet pixels in this reserved corner
      // indicate a misplaced glyph layer, unlike the dim decorative star halos.
      for(int y=0;y<64 && y<bitmap.Height;y++) for(int x=0;x<260 && x<bitmap.Width;x++) {
        var p=bitmap.GetPixel(x,y);
        if(p.R>=100 && p.B>=150 && p.B>p.R+10) count++;
      }
      return count;
    }
  }
  public static int Scene(string path) {
    using(var bitmap = new Bitmap(path)) {
      int count = 0;
      // Sparse samples outside the reserved corner prove that the fixture was
      // actually painted; a blank transparent window must not count as a pass.
      for(int y=64;y<bitmap.Height;y+=6) for(int x=0;x<bitmap.Width;x+=6) {
        var p=bitmap.GetPixel(x,y);
        if(p.R>=100 && p.B>=150 && p.B>p.R+10) count++;
      }
      return count;
    }
  }
}
'@
$frames = @(Get-ChildItem -LiteralPath $Directory -Filter 'frame-*.png' | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{ frame = $_.Name; misplacedVioletPixels = [OverlayGuardPixels]::Count($_.FullName); sceneVioletSamples = [OverlayGuardPixels]::Scene($_.FullName) }
})
if ($frames.Count -eq 0) { throw 'No captured frames; cannot verify overlay pixels' }
$result = [pscustomobject]@{
  directory = $Directory; frames = $frames.Count;
  contaminatedFrames = @($frames | Where-Object misplacedVioletPixels -gt 10).Count;
  maxMisplacedVioletPixels = ($frames | Measure-Object misplacedVioletPixels -Maximum).Maximum;
  maxSceneVioletSamples = ($frames | Measure-Object sceneVioletSamples -Maximum).Maximum;
  measurements = $frames
}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Directory 'pixel-analysis.json')
$result | Select-Object directory,frames,contaminatedFrames,maxMisplacedVioletPixels,maxSceneVioletSamples | ConvertTo-Json
if ($FailOnContamination -and $result.contaminatedFrames -gt 0) { throw 'Misplaced glyph pixels detected in OS overlay capture' }
if ($FailOnContamination -and $result.maxSceneVioletSamples -lt 50) { throw 'Fixture scene was not visibly painted; cannot verify overlay pixels' }
