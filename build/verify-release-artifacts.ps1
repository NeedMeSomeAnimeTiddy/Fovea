Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedPublisher = $env:FOVEA_WINDOWS_PUBLISHER
$packageMetadata = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
$packageVersion = [string]$packageMetadata.version
if ([string]::IsNullOrWhiteSpace($expectedPublisher)) {
  throw 'FOVEA_WINDOWS_PUBLISHER is required.'
}
if ([string]::IsNullOrWhiteSpace($packageVersion)) { throw 'package.json does not contain a version.' }

$distPath = Join-Path $PSScriptRoot '..\dist'
$installerName = "Fovea-$packageVersion-x64-Setup.exe"
$installerPath = Join-Path $distPath $installerName
$blockmapPath = "$installerPath.blockmap"
$metadataPath = Join-Path $distPath 'latest.yml'
$applicationPath = Join-Path $distPath 'win-unpacked\Fovea.exe'

foreach ($requiredPath in @($installerPath, $blockmapPath, $metadataPath, $applicationPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required release artifact is missing: $requiredPath"
  }
}

function Assert-FoveaSignature {
  param([Parameter(Mandatory = $true)][string]$Path)

  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode signature is not valid for $Path. Status: $($signature.Status)"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "No signer certificate was returned for $Path."
  }
  $actualPublisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if (-not [string]::Equals($actualPublisher, $expectedPublisher, [System.StringComparison]::Ordinal)) {
    throw "Publisher mismatch for $Path. Expected '$expectedPublisher', received '$actualPublisher'."
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "The signature for $Path does not contain a trusted timestamp."
  }
}

Assert-FoveaSignature -Path $applicationPath
Assert-FoveaSignature -Path $installerPath

$metadata = Get-Content -LiteralPath $metadataPath -Raw
$versionMatch = [regex]::Match($metadata, '(?m)^version:\s*([^\s]+)\s*$')
if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value -ne $packageVersion) {
  throw 'latest.yml does not contain the package version.'
}
$urlPattern = '(?m)^\s*-?\s*url:\s*' + [regex]::Escape($installerName) + '\s*$'
if (-not [regex]::IsMatch($metadata, $urlPattern)) {
  throw 'latest.yml does not point to the signed x64 installer.'
}
$hashMatch = [regex]::Match($metadata, '(?m)^\s*sha512:\s*([^\s]+)\s*$')
if (-not $hashMatch.Success) {
  throw 'latest.yml does not contain a SHA-512 digest.'
}

$sha512 = [System.Security.Cryptography.SHA512]::Create()
try {
  $installerBytes = [System.IO.File]::ReadAllBytes($installerPath)
  $actualDigest = [Convert]::ToBase64String($sha512.ComputeHash($installerBytes))
} finally {
  $sha512.Dispose()
}
if (-not [string]::Equals($actualDigest, $hashMatch.Groups[1].Value, [System.StringComparison]::Ordinal)) {
  throw 'The installer SHA-512 digest does not match latest.yml.'
}

Write-Host "Verified signed Fovea $packageVersion release artifacts for publisher '$expectedPublisher'."
