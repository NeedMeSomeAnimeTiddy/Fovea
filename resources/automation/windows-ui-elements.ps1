param(
  [string] $WindowHandles = '',
  [switch] $ForegroundOnly,
  [switch] $FrozenSnapshot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class FoveaVisibleWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct Point {
    public int X;
    public int Y;
  }

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(Point point);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr window, uint flags);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
'@

$capturedForegroundHandle = [IntPtr]::Zero
if ($ForegroundOnly) {
  # Pin the source window before loading and walking its accessibility tree.
  # The frozen overlay may become focused while this script is still running.
  $capturedForegroundHandle = [FoveaVisibleWindow]::GetForegroundWindow()
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$maximumElements = 1200
$analysisBudgetMs = 2800
$includedTypes = [System.Collections.Generic.HashSet[string]]::new(
  [string[]] @(
    'Button',
    'Calendar',
    'CheckBox',
    'ComboBox',
    'Edit',
    'HeaderItem',
    'Hyperlink',
    'ListItem',
    'MenuItem',
    'ProgressBar',
    'RadioButton',
    'Slider',
    'Spinner',
    'TabItem',
    'Thumb',
    'TreeItem'
  ),
  [System.StringComparer]::OrdinalIgnoreCase
)
$priorityTypes = [System.Collections.Generic.HashSet[string]]::new(
  [string[]] @(
    'Button',
    'CheckBox',
    'ComboBox',
    'MenuItem',
    'RadioButton',
    'TabItem',
    'Thumb'
  ),
  [System.StringComparer]::OrdinalIgnoreCase
)
$includedConditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
foreach ($automationType in @(
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::Calendar,
  [System.Windows.Automation.ControlType]::CheckBox,
  [System.Windows.Automation.ControlType]::ComboBox,
  [System.Windows.Automation.ControlType]::Edit,
  [System.Windows.Automation.ControlType]::HeaderItem,
  [System.Windows.Automation.ControlType]::Hyperlink,
  [System.Windows.Automation.ControlType]::ListItem,
  [System.Windows.Automation.ControlType]::MenuItem,
  [System.Windows.Automation.ControlType]::ProgressBar,
  [System.Windows.Automation.ControlType]::RadioButton,
  [System.Windows.Automation.ControlType]::Slider,
  [System.Windows.Automation.ControlType]::Spinner,
  [System.Windows.Automation.ControlType]::TabItem,
  [System.Windows.Automation.ControlType]::Thumb,
  [System.Windows.Automation.ControlType]::TreeItem
)) {
  $includedConditions.Add(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      $automationType
    )
  )
}
$includedConditions.Add(
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty,
    $true
  )
)
$includedConditions.Add(
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty,
    $true
  )
)
$includedConditions.Add(
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty,
    $true
  )
)
$includedConditions.Add(
  [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty,
    $true
  )
)
$includedCondition = [System.Windows.Automation.OrCondition]::new($includedConditions.ToArray())

$cache = [System.Windows.Automation.CacheRequest]::new()
$cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::Full
$cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::LocalizedControlTypeProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::HelpTextProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::ItemStatusProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::AcceleratorKeyProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::AccessKeyProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::LabeledByProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty)

$fullDescriptionProperty = [System.Windows.Automation.AutomationProperty]::LookupById(30159)
$ariaPropertiesProperty = [System.Windows.Automation.AutomationProperty]::LookupById(30102)

function Get-RuntimeIdKey {
  param([System.Windows.Automation.AutomationElement] $Element)
  if ($null -eq $Element) {
    return ''
  }
  try {
    return [string]::Join('.', $Element.GetRuntimeId())
  }
  catch {
    return ''
  }
}

function Test-ElementAtPoint {
  param(
    [System.Windows.Automation.AutomationElement] $Target,
    [System.Windows.Point] $Point
  )
  $targetId = Get-RuntimeIdKey $Target
  if (-not $targetId) {
    return $false
  }
  try {
    $hit = [System.Windows.Automation.AutomationElement]::FromPoint($Point)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -lt 32 -and $null -ne $hit; $depth += 1) {
      if ((Get-RuntimeIdKey $hit) -eq $targetId) {
        return $true
      }
      $hit = $walker.GetParent($hit)
    }
  }
  catch {
    # Windows can disappear or change their accessibility tree during a hit test.
  }
  return $false
}

function Test-WindowAtPoint {
  param(
    [IntPtr] $RootHandle,
    [System.Windows.Point] $Point
  )
  if ($RootHandle -eq [IntPtr]::Zero) {
    return $false
  }
  try {
    $nativePoint = [FoveaVisibleWindow+Point]::new()
    $nativePoint.X = [int] [Math]::Round($Point.X)
    $nativePoint.Y = [int] [Math]::Round($Point.Y)
    $hitWindow = [FoveaVisibleWindow]::WindowFromPoint($nativePoint)
    $hitRoot = [FoveaVisibleWindow]::GetAncestor($hitWindow, 2)
    return $hitRoot -eq $RootHandle
  }
  catch {
    return $false
  }
}

function Get-VisibleRatio {
  param(
    [System.Windows.Automation.AutomationElement] $Element,
    [System.Windows.Rect] $Bounds,
    [IntPtr] $RootHandle
  )
  if ($Bounds.Width -lt 2 -or $Bounds.Height -lt 2) {
    return @{ ratio = 0.0; centerVisible = $false }
  }
  if ($FrozenSnapshot) {
    return @{ ratio = 1.0; centerVisible = $true }
  }
  $centerX = $Bounds.X + $Bounds.Width / 2
  $centerY = $Bounds.Y + $Bounds.Height / 2
  $center = [System.Windows.Point]::new($centerX, $centerY)
  $centerVisible = (
    (Test-WindowAtPoint $RootHandle $center) -and
    (Test-ElementAtPoint $Element $center)
  )
  return @{
    ratio = if ($centerVisible) { 1.0 } else { 0.0 }
    centerVisible = [bool] $centerVisible
  }
}

$output = [System.Collections.Generic.List[object]]::new()
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$activation = $cache.Activate()
try {
  $windows = @()
  $requestedHandles = @($WindowHandles -split ',' | Where-Object { $_ })
  if ($ForegroundOnly) {
    if ($capturedForegroundHandle -ne [IntPtr]::Zero) {
      $requestedHandles = @('{0:x}' -f $capturedForegroundHandle.ToInt64())
    }
  }
  foreach ($handle in $requestedHandles) {
    if ($handle -notmatch '^[0-9a-fA-F]+$') {
      continue
    }
    try {
      $nativeHandle = [IntPtr] ([Convert]::ToInt64($handle, 16))
      $targetWindow = [System.Windows.Automation.AutomationElement]::FromHandle($nativeHandle)
      if ($null -ne $targetWindow) {
        $windows += @{
          element = $targetWindow
          handle = $nativeHandle
        }
      }
    }
    catch {
      # Desktop-capture sources can disappear before the accessibility snapshot starts.
    }
  }

  :windowLoop foreach ($windowEntry in $windows) {
    if ($stopwatch.ElapsedMilliseconds -ge $analysisBudgetMs) {
      break windowLoop
    }
    try {
      $window = $windowEntry.element
      $rootHandle = $windowEntry.handle
      $windowBounds = $window.Current.BoundingRectangle
      $windowVisibility = Get-VisibleRatio $window $windowBounds $rootHandle
      if ($window.Current.IsOffscreen -or $windowVisibility.ratio -le 0) {
        continue
      }
      $elements = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $includedCondition
      )
    }
    catch {
      # Elevated, protected, and closing windows may deny automation access.
      continue
    }
    $compactPriorityElements = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
    $priorityElements = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
    $remainingElements = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()
    foreach ($element in $elements) {
      try {
        $candidateType = $element.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        $candidateInvokable = [bool] $element.Cached.IsInvokePatternAvailable
        $candidateActionable = (
          $candidateInvokable -or
          [bool] $element.Cached.IsTogglePatternAvailable -or
          [bool] $element.Cached.IsExpandCollapsePatternAvailable -or
          [bool] $element.Cached.IsSelectionItemPatternAvailable
        )
        if (-not $includedTypes.Contains($candidateType) -and -not $candidateActionable) {
          continue
        }
        $isCustomAction = $candidateActionable -and -not $includedTypes.Contains($candidateType)
        if ($priorityTypes.Contains($candidateType) -or $isCustomAction) {
          $candidateBounds = $element.Cached.BoundingRectangle
          if ($candidateBounds.Width -le 180 -and $candidateBounds.Height -le 100) {
            $compactPriorityElements.Add($element)
          }
          else {
            $priorityElements.Add($element)
          }
        }
        else {
          $remainingElements.Add($element)
        }
      }
      catch {
        # Ignore elements invalidated while arranging the priority scan.
      }
    }
    $orderedElements = @($compactPriorityElements) + @($priorityElements) + @($remainingElements)
    foreach ($element in $orderedElements) {
      if ($stopwatch.ElapsedMilliseconds -ge $analysisBudgetMs) {
        break windowLoop
      }
      if ($output.Count -ge $maximumElements) {
        break windowLoop
      }
      try {
        if ($element.Cached.IsOffscreen) {
          continue
        }
        $controlType = $element.Cached.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        $invokable = [bool] $element.Cached.IsInvokePatternAvailable
        $actionable = (
          $invokable -or
          [bool] $element.Cached.IsTogglePatternAvailable -or
          [bool] $element.Cached.IsExpandCollapsePatternAvailable -or
          [bool] $element.Cached.IsSelectionItemPatternAvailable
        )
        if (-not $includedTypes.Contains($controlType) -and -not $actionable) {
          continue
        }
        $bounds = $element.Cached.BoundingRectangle
        if (
          [double]::IsNaN($bounds.X) -or
          [double]::IsNaN($bounds.Y) -or
          [double]::IsNaN($bounds.Width) -or
          [double]::IsNaN($bounds.Height) -or
          $bounds.Width -lt 2 -or
          $bounds.Height -lt 2
        ) {
          continue
        }
        $visibility = Get-VisibleRatio $element $bounds $rootHandle
        if (-not $visibility.centerVisible) {
          continue
        }
        $legacyName = ''
        $legacyDescription = ''
        try {
          $legacy = $element.GetCurrentPattern(
            [System.Windows.Automation.LegacyIAccessiblePattern]::Pattern
          )
          if ($null -ne $legacy) {
            $legacyName = [string] $legacy.Current.Name
            $legacyDescription = [string] $legacy.Current.Description
          }
        }
        catch {
          # Modern controls often do not expose the legacy accessibility pattern.
        }
        $labeledBy = ''
        try {
          if ($null -ne $element.Cached.LabeledBy) {
            $labeledBy = [string] $element.Cached.LabeledBy.Current.Name
          }
        }
        catch {
          # A label can disappear independently while the control remains valid.
        }
        $fullDescription = ''
        $ariaProperties = ''
        try {
          if ($null -ne $fullDescriptionProperty) {
            $fullDescription = [string] $element.GetCurrentPropertyValue($fullDescriptionProperty, $true)
          }
          if ($null -ne $ariaPropertiesProperty) {
            $ariaProperties = [string] $element.GetCurrentPropertyValue($ariaPropertiesProperty, $true)
          }
        }
        catch {
          # Optional modern accessibility metadata is not supported by every provider.
        }
        $output.Add(@{
          name = [string] $element.Cached.Name
          legacyName = [string] $legacyName
          labeledBy = [string] $labeledBy
          controlType = [string] $controlType
          localizedControlType = [string] $element.Cached.LocalizedControlType
          automationId = [string] $element.Cached.AutomationId
          helpText = [string] $element.Cached.HelpText
          legacyDescription = [string] $legacyDescription
          itemStatus = [string] $element.Cached.ItemStatus
          acceleratorKey = [string] $element.Cached.AcceleratorKey
          accessKey = [string] $element.Cached.AccessKey
          invokable = [bool] $invokable
          actionable = [bool] $actionable
          fullDescription = [string] $fullDescription
          ariaProperties = [string] $ariaProperties
          enabled = [bool] $element.Cached.IsEnabled
          focusable = [bool] $element.Cached.IsKeyboardFocusable
          visibleRatio = [double] $visibility.ratio
          centerVisible = [bool] $visibility.centerVisible
          topmostVerified = [bool] (-not $FrozenSnapshot)
          x = [double] $bounds.X
          y = [double] $bounds.Y
          width = [double] $bounds.Width
          height = [double] $bounds.Height
        })
      }
      catch {
        # Elements can disappear while their owning application updates.
      }
    }
  }
}
finally {
  $activation.Dispose()
}

@{
  elements = @($output)
} | ConvertTo-Json -Depth 4 -Compress
