# Проверка окружения, которое видит учётная запись службы сервера 1С (LocalSystem).
# LocalSystem наследует МАШИННЫЕ переменные среды (HKLM\...\Environment),
# а не переменные пользователя r.edokov.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$envKeys = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
Write-Output '=== machine-level (LocalSystem) ==='
$machinePath = (Get-ItemProperty $envKeys -Name Path).Path
$machineJavaHome = (Get-ItemProperty $envKeys -Name JAVA_HOME -ErrorAction SilentlyContinue).JAVA_HOME
Write-Output ("JAVA_HOME (machine) : " + $(if ($machineJavaHome) { $machineJavaHome } else { '<не задана>' }))

$found = @()
foreach ($dir in ($machinePath -split ';')) {
    $d = $dir.Trim().Trim('"')
    if (-not $d) { continue }
    $candidate = Join-Path $d 'java.exe'
    if (Test-Path -LiteralPath $candidate) { $found += $candidate }
}
Write-Output ("java.exe найден в machine PATH: " + $(if ($found.Count) { $found -join '; ' } else { '<НЕ найден>' }))
Write-Output ("каталогов в machine PATH: " + (($machinePath -split ';' | Where-Object { $_.Trim() }).Count))

if ($machineJavaHome) {
    $jhExe = Join-Path $machineJavaHome 'bin\java.exe'
    Write-Output ("java.exe в machine JAVA_HOME: " + $(if (Test-Path -LiteralPath $jhExe) { $jhExe } else { '<НЕ найден>' }))
}

Write-Output ''
Write-Output '=== user-level (r.edokov, для сравнения) ==='
$userJavaHome = [Environment]::GetEnvironmentVariable('JAVA_HOME', 'User')
Write-Output ("JAVA_HOME (user)    : " + $(if ($userJavaHome) { $userJavaHome } else { '<не задана>' }))
Write-Output ("JAVA_HOME (process) : " + $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { '<не задана>' }))

Write-Output ''
Write-Output '=== процессы сервера 1С и их владельцы ==='
Get-CimInstance Win32_Process -Filter "Name='rphost.exe' OR Name='rmngr.exe' OR Name='ragent.exe'" |
    ForEach-Object {
        $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
        Write-Output ("{0} (pid {1}) -> {2}\{3}" -f $_.Name, $_.ProcessId, $owner.Domain, $owner.User)
    }
