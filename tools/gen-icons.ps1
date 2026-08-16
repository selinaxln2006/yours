# Generates PWA icons (compass mark on rounded cream square) using System.Drawing.
# Usage: powershell -ExecutionPolicy Bypass -File tools/gen-icons.ps1

Add-Type -AssemblyName System.Drawing

function New-Icon {
    param([int]$size, [string]$path)
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded-square background (cream)
    $bg = [System.Drawing.ColorTranslator]::FromHtml('#F5F1EB')
    $brush = New-Object System.Drawing.SolidBrush($bg)
    $rad = $size * 0.22
    $d = $rad * 2
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc(0, 0, $d, $d, 180, 90)
    $gp.AddArc($size - $d, 0, $d, $d, 270, 90)
    $gp.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $gp.AddArc(0, $size - $d, $d, $d, 90, 90)
    $gp.CloseFigure()
    $g.FillPath($brush, $gp)

    # Outer ring (accent green)
    $accent = [System.Drawing.ColorTranslator]::FromHtml('#7C8B5E')
    $pen = New-Object System.Drawing.Pen($accent, [Math]::Max(2, $size * 0.035))
    $c = $size * 0.5
    $r = $size * 0.30
    $g.DrawEllipse($pen, $c - $r, $c - $r, $r * 2, $r * 2)

    # Diamond pointer (N tip up)
    $fill = New-Object System.Drawing.SolidBrush($accent)
    $rr = $r * 0.78
    $pts = @(
        [System.Drawing.PointF]::new($c, $c - $rr),
        [System.Drawing.PointF]::new($c - $rr, $c),
        [System.Drawing.PointF]::new($c, $c + $rr),
        [System.Drawing.PointF]::new($c + $rr, $c)
    )
    $g.FillPolygon($fill, [System.Drawing.PointF[]]$pts)

    # Center dot (white)
    $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $dr = $size * 0.045
    $g.FillEllipse($dotBrush, $c - $dr, $c - $dr, $dr * 2, $dr * 2)

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output "generated $path"
}

if (-not (Test-Path "icons")) { New-Item -ItemType Directory -Path "icons" | Out-Null }
New-Icon 192 "icons/icon-192.png"
New-Icon 512 "icons/icon-512.png"
Write-Output "done"
