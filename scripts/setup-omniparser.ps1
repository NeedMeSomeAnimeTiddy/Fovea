param(
  [string]$Python = 'python',
  [string]$TorchIndexUrl = '',
  [string]$Revision = '354021201345a96178360b28733573e27269f2de'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $repositoryRoot '.venv-omniparser'
$environmentPython = Join-Path $environmentPath 'Scripts\python.exe'
$huggingFaceCli = Join-Path $environmentPath 'Scripts\hf.exe'
$runtimePath = Join-Path $repositoryRoot '.omniparser-runtime'
$sourcePath = Join-Path $runtimePath 'source'
$modelPath = Join-Path $sourcePath 'weights\icon_detect_v3\model.pt'
$faceModelDirectory = Join-Path $sourcePath 'weights\face_detection_yunet'
$faceModelPath = Join-Path $faceModelDirectory 'face_detection_yunet_2023mar.onnx'
$bridgePath = Join-Path $repositoryRoot 'resources\analysis\omniparser-detector.py'
$requirementsPath = Join-Path $repositoryRoot 'resources\analysis\omniparser-requirements.txt'

if (-not (Test-Path -LiteralPath $environmentPython)) {
  & $Python -m venv $environmentPath
}

if (-not $TorchIndexUrl) {
  $TorchIndexUrl = if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    'https://download.pytorch.org/whl/cu128'
  } else {
    'https://download.pytorch.org/whl/cpu'
  }
}

& $environmentPython -m pip install --upgrade pip
& $environmentPython -m pip install torch torchvision --index-url $TorchIndexUrl
& $environmentPython -m pip install --requirement $requirementsPath

if (-not (Test-Path -LiteralPath (Join-Path $sourcePath '.git'))) {
  New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
  & git clone --filter=blob:none --no-checkout https://github.com/microsoft/OmniParser.git $sourcePath
}

& git -C $sourcePath fetch --depth 1 origin $Revision
& git -C $sourcePath checkout --detach FETCH_HEAD
& $huggingFaceCli download `
  microsoft/OmniParser-v2.0 `
  icon_detect_v3/model.pt `
  --revision refs/pr/37 `
  --local-dir (Join-Path $sourcePath 'weights')

if (-not (Test-Path -LiteralPath $modelPath)) {
  throw "OmniParser model download did not create $modelPath"
}

if (-not (Test-Path -LiteralPath $faceModelPath)) {
  New-Item -ItemType Directory -Force -Path $faceModelDirectory | Out-Null
  Invoke-WebRequest `
    -Uri 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx' `
    -OutFile $faceModelPath
}
if ((Get-Item -LiteralPath $faceModelPath).Length -lt 100000) {
  throw "YuNet face model download did not create a valid model at $faceModelPath"
}

& $environmentPython $bridgePath --check --root $sourcePath --model $modelPath --face-model $faceModelPath
Write-Host 'OmniParser icon_detect_v3 and YuNet face detection are ready. Fovea will load them in the background on the next development run.'
