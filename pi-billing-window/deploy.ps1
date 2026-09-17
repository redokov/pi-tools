# deploy.ps1 — копирование исходников из проекта разработки в рабочую копию,
# из которой расширение загружается pi.
#
# Использование:
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1
#
# Или с перезагрузкой pi через /reload (если есть CLI):
#   powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Reload

param(
    [switch]$Reload
)

$ErrorActionPreference = "Stop"

$srcDir = $PSScriptRoot
$dstDir = Join-Path $env:USERPROFILE ".pi\agent\extensions\pi-billing-window"

Write-Host "[deploy] src: $srcDir" -ForegroundColor Cyan
Write-Host "[deploy] dst: $dstDir" -ForegroundColor Cyan

if (-not (Test-Path $dstDir)) {
    Write-Host "[deploy] creating dst dir..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
}

# Список файлов для копирования. Тесты и docs НЕ копируем — они живут
# только в проекте разработки.
$files = @(
    "index.ts",
    "state.ts",
    "ticker.ts",
    "ui.ts",
    "parser.ts",
    "notifier.ts",
    "history.ts",
    "arms.ts",
    "package.json"
)

foreach ($name in $files) {
    $src = Join-Path $srcDir "src\$name"
    if ($name -eq "package.json") {
        $src = Join-Path $srcDir "package.json"
    }

    if (-not (Test-Path $src)) {
        Write-Host "[deploy] WARN: $src not found, skipping" -ForegroundColor Yellow
        continue
    }

    $dst = Join-Path $dstDir $name
    Copy-Item -Force $src $dst
    Write-Host "[deploy] copied $name" -ForegroundColor Green
}

# README копируем в рабочую копию тоже — чтобы описание было под рукой.
Copy-Item -Force (Join-Path $srcDir "README.md") (Join-Path $dstDir "README.md")
Write-Host "[deploy] copied README.md" -ForegroundColor Green

# (опционально) tsconfig — для tsc-валидации в рабочей копии.
Copy-Item -Force (Join-Path $srcDir "tsconfig.json") (Join-Path $dstDir "tsconfig.json")
Write-Host "[deploy] copied tsconfig.json" -ForegroundColor Green

if ($Reload) {
    Write-Host "[deploy] --Reload requested, но pi-CLI /reload не вызывается автоматически" -ForegroundColor Yellow
    Write-Host "[deploy] откройте pi и выполните /reload вручную." -ForegroundColor Yellow
}

Write-Host "[deploy] done." -ForegroundColor Cyan
