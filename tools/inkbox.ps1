Add-Type -AssemblyName System.Drawing
$jobs = @(
  @{ f = 'C:\Users\vlads\Pictures\Screenshots\Screenshot 2026-11-13 231219.png'; x0 = 280; x1 = 1460; y0 = 45; y1 = 985 },
  @{ f = 'E:\OtherProjects\ChatMap\tests\betterwright\shape\leafaspect-overview.png'; x0 = 300; x1 = 1380; y0 = 10; y1 = 740 },
  @{ f = 'E:\OtherProjects\ChatMap\tests\betterwright\shape\leafaspect18-overview.png'; x0 = 300; x1 = 1380; y0 = 10; y1 = 740 }
)
foreach ($j in $jobs) {
  $b = [System.Drawing.Bitmap]::FromFile($j.f)
  $minX = $b.Width; $maxX = 0; $minY = $b.Height; $maxY = 0
  for ($y = $j.y0; $y -lt $j.y1; $y += 2) {
    for ($x = $j.x0; $x -lt $j.x1; $x += 2) {
      $p = $b.GetPixel($x, $y)
      $lum = 0.2126 * $p.R + 0.7152 * $p.G + 0.0722 * $p.B
      if ($lum -gt 48) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $b.Dispose()
  $bw = $maxX - $minX + 1
  $bh = $maxY - $minY + 1
  $a = [math]::Round($bw / [math]::Max(1, $bh), 2)
  Write-Output "$($j.f) => inkbox=${bw}x${bh} aspect=$a"
}
