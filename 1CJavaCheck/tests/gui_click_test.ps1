# GUI-тест: открыть JavaCheck.epf в клиенте 1С, нажать "Проверить",
# прочитать все тексты окон через UI Automation, сохранить скриншот.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing

$V8     = 'C:\Program Files\1cv8\8.5.4.1683\bin\1cv8.exe'
$EPF    = 'c:\Tools\1CJavaCheck\JavaCheck.epf'
$OUTTXT = 'c:\Tools\1CJavaCheck\artifacts\gui_messages.txt'
$SHOT   = 'c:\Tools\1CJavaCheck\artifacts\gui_result.png'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function Get-Wins($procId) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $procId)
    return @($AE::RootElement.FindAll($TS::Children, $c))
}
function Get-Texts($win) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)
    $r = @()
    foreach ($t in $win.FindAll($TS::Descendants, $c)) {
        $s = $t.Current.Name
        if ($s -and $s.Trim().Length -gt 0) { $r += $s.Trim() }
    }
    return $r
}

$a = @('ENTERPRISE','/S"localhost/dev_erpapk_demo"','/N"Администратор (ОрловАВ)"','/P""',
       "/Execute`"$EPF`"",'/DisableStartupDialogs')
Write-Output ('launch: 1cv8.exe ' + ($a -join ' '))
$p = Start-Process -FilePath $V8 -ArgumentList $a -PassThru
Write-Output ('pid=' + $p.Id)

# --- ждать кнопку "Проверить" (клиент стартует ~40 c) ---
$btn = $null
$deadline = (Get-Date).AddSeconds(180)
$wins = @()
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 1000
    $p.Refresh()
    if ($p.HasExited) { Write-Output 'CLIENT EXITED'; break }
    $wins = Get-Wins $p.Id
    foreach ($w in $wins) {
        $bk = $w.FindAll($TS::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)))
        foreach ($b in $bk) { if ($b.Current.Name -eq 'Проверить') { $btn = $b; break } }
        if ($btn) { break }
    }
    if ($btn) { break }
}

$dump = @()
if (-not $btn) {
    $dump += 'BUTTON NOT FOUND'
    foreach ($w in (Get-Wins $p.Id)) {
        $dump += ('WINDOW: [' + $w.Current.Name + '] class=' + $w.Current.ClassName)
        $dump += (Get-Texts $w | ForEach-Object { '   TEXT: ' + $_ })
    }
    $dump | Set-Content $OUTTXT -Encoding UTF8
    $dump | ForEach-Object { Write-Output $_ }
    exit 4
}
Write-Output 'button found -> invoke'

$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Seconds 10

# --- собрать тексты всех окон процесса ---
$res = @()
foreach ($w in (Get-Wins $p.Id)) {
    $res += ('WINDOW: [' + $w.Current.Name + '] class=' + $w.Current.ClassName)
    $res += (Get-Texts $w | ForEach-Object { '   TEXT: ' + $_ })
}
$res | Set-Content $OUTTXT -Encoding UTF8

# --- скриншот главного окна ---
$main = $null
foreach ($w in (Get-Wins $p.Id)) {
    if ($w.Current.ClassName -eq 'V8Window0.0' -and $w.Current.Name) { $main = $w; break }
}
if (-not $main) { $main = (Get-Wins $p.Id) | Where-Object { $_.Current.Name } | Select-Object -First 1 }
if ($main) {
    $r = $main.Current.BoundingRectangle
    if ($r.Width -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap([int]$r.Width, [int]$r.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
        $bmp.Save($SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Output ('screenshot: ' + $SHOT)
    }
}

$res | ForEach-Object { Write-Output $_ }
Write-Output '=== SEARCH ==='
foreach ($kw in @('Джава доступна','Джава недоступна','Детали')) {
    $hit = $res | Where-Object { $_ -like ('*' + $kw + '*') }
    if ($hit) { Write-Output ('FOUND: ' + $kw); $hit | Select-Object -First 3 | ForEach-Object { Write-Output ('   ' + $_) } }
}
Write-Output 'DONE'
