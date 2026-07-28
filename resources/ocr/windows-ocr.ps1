param(
  [string] $ImagePath,
  [string] $LanguageTag,
  [switch] $ListLanguages
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

if ($ListLanguages) {
  $languages = @(
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]::AvailableRecognizerLanguages |
      ForEach-Object {
        @{
          code = $_.LanguageTag
          label = $_.DisplayName
        }
      }
  )
  ConvertTo-Json -InputObject $languages -Depth 3 -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ImagePath)) {
  throw 'An image path is required.'
}

function Wait-WinRtOperation {
  param(
    [Parameter(Mandatory = $true)]
    [object] $Operation,
    [Parameter(Mandatory = $true)]
    [Type] $ResultType
  )

  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethod -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

$engine = if ([string]::IsNullOrWhiteSpace($LanguageTag)) {
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]::TryCreateFromUserProfileLanguages()
}
else {
  $language = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]::new($LanguageTag)
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]::TryCreateFromLanguage($language)
}
if ($null -eq $engine) {
  throw 'Windows OCR has no recognition language available for the current user.'
}

$file = Wait-WinRtOperation `
  ([Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]::GetFileFromPathAsync($ImagePath)) `
  ([Windows.Storage.StorageFile])
$stream = Wait-WinRtOperation `
  ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) `
  ([Windows.Storage.Streams.IRandomAccessStream])

try {
  $decoder = Wait-WinRtOperation `
    ([Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]::CreateAsync($stream)) `
    ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Wait-WinRtOperation `
    ($decoder.GetSoftwareBitmapAsync()) `
    ([Windows.Graphics.Imaging.SoftwareBitmap])

  try {
    $result = Wait-WinRtOperation `
      ($engine.RecognizeAsync($bitmap)) `
      ([Windows.Media.Ocr.OcrResult])
    $lines = @(
      foreach ($line in $result.Lines) {
        $words = @($line.Words)
        if ($words.Count -eq 0) {
          continue
        }
        $left = ($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
        $top = ($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
        $right = ($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
        $bottom = ($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
        @{
          text = $line.Text
          x = [double] $left
          y = [double] $top
          width = [double] ($right - $left)
          height = [double] ($bottom - $top)
          words = @(
            foreach ($word in $words) {
              @{
                text = $word.Text
                x = [double] $word.BoundingRect.X
                y = [double] $word.BoundingRect.Y
                width = [double] $word.BoundingRect.Width
                height = [double] $word.BoundingRect.Height
              }
            }
          )
        }
      }
    )

    @{
      language = @{
        code = $engine.RecognizerLanguage.LanguageTag
        label = $engine.RecognizerLanguage.DisplayName
      }
      lines = $lines
      textAngle = $result.TextAngle
    } | ConvertTo-Json -Depth 5 -Compress
  }
  finally {
    if ($null -ne $bitmap) {
      $bitmap.Dispose()
    }
  }
}
finally {
  $stream.Dispose()
}
