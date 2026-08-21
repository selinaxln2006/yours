$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
foreach ($d in $disks) {
    $sizeGB = [math]::Round($d.Size / 1GB, 1)
    $freeGB = [math]::Round($d.FreeSpace / 1GB, 1)
    $name = $d.VolumeName
    if (-not $name) { $name = "(no label)" }
    Write-Output "$($d.DeviceID) $name  Total=$sizeGB GB  Free=$freeGB GB"
}
