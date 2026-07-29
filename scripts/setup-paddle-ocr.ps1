param(
  [ValidateSet('small', 'medium', 'large', 'all')]
  [string]$Profile = 'all',
  [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $repositoryRoot '.venv-paddleocr'
$environmentPython = Join-Path $environmentPath 'Scripts\python.exe'
$bridgePath = Join-Path $repositoryRoot 'resources\ocr\paddle-ocr.py'
$requirementsPath = Join-Path $repositoryRoot 'resources\ocr\paddle-requirements.txt'
$cachePath = Join-Path $repositoryRoot '.paddle-ocr-cache'

if (-not (Test-Path -LiteralPath $environmentPython)) {
  & $Python -m venv $environmentPath
}

& $environmentPython -m pip install --upgrade pip
& $environmentPython -m pip install paddlepaddle==3.2.2 --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
& $environmentPython -m pip install --requirement $requirementsPath
& $environmentPython $bridgePath --check

$profiles = if ($Profile -eq 'all') { @('small', 'medium', 'large') } else { @($Profile) }
foreach ($candidate in $profiles) {
  Write-Host "Preparing PaddleOCR $candidate models..."
  & $environmentPython $bridgePath --warmup --profile $candidate --cache-dir $cachePath
}
