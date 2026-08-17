Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Write-Host '=== Electron Processes with MainWindowTitle ==='
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object {
    Write-Host ("Id=" + $_.Id + " Name=" + $_.ProcessName + " Title=" + $_.MainWindowTitle)
}
Write-Host '=== Any process with BB/BBPlayer in WindowTitle or Name ==='
Get-Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.MainWindowTitle -match 'BB|BBPlayer|BB Player|无边框|沉浸式|影音') -or
    ($_.ProcessName -match 'BBPlayer|bbplayer|BB\.Player')
} | ForEach-Object {
    Write-Host ("Id=" + $_.Id + " Name=" + $_.ProcessName + " Title=" + $_.MainWindowTitle)
}
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$out = 'D:/AI/Github/BBPlayer/BBPlayer/_desktop_screenshot.png'
$bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Host ('Saved screenshot: ' + $out + ' Size=' + $bounds.Width + 'x' + $bounds.Height)
