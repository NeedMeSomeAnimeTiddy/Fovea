import { describe, expect, it } from 'vitest'
import {
  mapUiAutomationFeatures,
  parseUiAutomationPayload
} from '../src/main/capture/windows-ui-automation-service'

describe('Windows UI Automation screen analysis', () => {
  it('sanitises the native payload and ignores unusable rectangles', () => {
    const elements = parseUiAutomationPayload(JSON.stringify({
      elements: [
        {
          name: '  Save\u0000   changes ',
          controlType: 'Button',
          localizedControlType: 'button',
          automationId: 'save',
          helpText: ' Saves the current file ',
          enabled: false,
          focusable: true,
          visibleRatio: 0.8,
          centerVisible: true,
          windowVisibilityVerified: true,
          x: 20,
          y: 30,
          width: 100,
          height: 32
        },
        { name: 'No size', x: 0, y: 0, width: 1, height: 1 },
        { name: 'Invalid', x: 'left', y: 0, width: 10, height: 10 }
      ]
    }))

    expect(elements).toEqual([expect.objectContaining({
      name: 'Save changes',
      controlType: 'Button',
      helpText: 'Saves the current file',
      enabled: false,
      focusable: true,
      visibleRatio: 0.8,
      centerVisible: true,
      windowVisibilityVerified: true,
      bounds: { x: 20, y: 30, width: 100, height: 32 }
    })])
  })

  it('converts physical bounds to display-relative DIP boxes and keeps semantics', () => {
    const elements = parseUiAutomationPayload(JSON.stringify({
      elements: [{
        name: 'Open help',
        controlType: 'Hyperlink',
        localizedControlType: 'link',
        automationId: 'help',
        helpText: 'Read the documentation',
        enabled: true,
        focusable: true,
        visibleRatio: 1,
        centerVisible: true,
        x: -160,
        y: 80,
        width: 400,
        height: 80
      }]
    }))
    const features = mapUiAutomationFeatures(
      elements,
      { x: -100, y: 20, width: 500, height: 250 },
      ({ x, y, width, height }) => ({ x: x / 2, y: y / 2, width: width / 2, height: height / 2 })
    )

    expect(features).toEqual([expect.objectContaining({
      kind: 'link',
      label: 'Open help',
      source: 'uia',
      role: 'link',
      description: 'Read the documentation',
      enabled: true,
      visibility: 1,
      bounds: { x: 0.04, y: 0.08, width: 0.4, height: 0.16 }
    })])
  })

  it('clips controls that cross a display edge', () => {
    const features = mapUiAutomationFeatures([{
      name: 'Next',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'next',
      helpText: '',
      enabled: true,
      focusable: true,
      visibleRatio: 0.6,
      centerVisible: true,
      bounds: { x: 90, y: 90, width: 30, height: 30 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features[0]?.bounds).toEqual({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 })
    expect(features[0]?.visibilityVerified).toBe(false)
  })

  it('does not map elements that failed topmost point visibility checks', () => {
    const features = mapUiAutomationFeatures([{
      name: 'Hidden save',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'hidden-save',
      helpText: 'This belongs to a covered application',
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: false,
      bounds: { x: 10, y: 10, width: 80, height: 30 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features).toEqual([])
  })

  it('promotes an icon tooltip to the clickable feature label', () => {
    const features = mapUiAutomationFeatures([{
      name: '',
      legacyName: '',
      labeledBy: '',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'openNotificationsButton',
      helpText: '',
      legacyDescription: '',
      fullDescription: 'Show recent alerts',
      itemStatus: '',
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: true,
      bounds: { x: 40, y: 20, width: 24, height: 24 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features).toEqual([
      expect.objectContaining({
        label: 'Show recent alerts',
        role: 'button'
      })
    ])
  })

  it('replaces a one-character icon name with its meaningful tooltip', () => {
    const features = mapUiAutomationFeatures([{
      name: 'B',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'boldButton',
      helpText: 'Bold',
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: true,
      bounds: { x: 40, y: 20, width: 24, height: 24 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features).toEqual([
      expect.objectContaining({
        label: 'Bold',
        role: 'button',
        kind: 'control'
      })
    ])
  })

  it('rejects undefined accessibility names and uses the real tooltip', () => {
    const features = mapUiAutomationFeatures(parseUiAutomationPayload(JSON.stringify({
      elements: [{
        name: 'undefined',
        legacyName: 'null',
        labeledBy: 'unknown',
        controlType: 'Button',
        localizedControlType: 'button',
        automationId: 'x9Q2mL7',
        helpText: 'Open notifications',
        enabled: true,
        focusable: true,
        visibleRatio: 1,
        centerVisible: true,
        x: 40,
        y: 20,
        width: 32,
        height: 32
      }]
    })), { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features).toEqual([
      expect.objectContaining({
        label: 'Open notifications',
        role: 'button'
      })
    ])
  })

  it('replaces an opaque generated button name with its tooltip', () => {
    const features = mapUiAutomationFeatures([{
      name: 'xQmL7',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'notifications',
      helpText: 'Open notifications',
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: true,
      bounds: { x: 40, y: 20, width: 32, height: 32 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features[0]).toMatchObject({
      label: 'Open notifications',
      role: 'button'
    })
  })

  it('uses a stable generic label when an icon exposes only broken metadata', () => {
    const features = mapUiAutomationFeatures(parseUiAutomationPayload(JSON.stringify({
      elements: [{
        name: 'undefined',
        controlType: 'Button',
        localizedControlType: 'button',
        automationId: '5f764c4e9a12',
        helpText: 'null',
        enabled: true,
        focusable: true,
        visibleRatio: 1,
        centerVisible: true,
        x: 40,
        y: 20,
        width: 32,
        height: 32
      }]
    })), { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features[0]).toMatchObject({ label: 'Unlabelled button', role: 'button' })
  })

  it('does not reuse an opaque accessible name when no tooltip is available', () => {
    const features = mapUiAutomationFeatures([{
      name: 'Radix R ajalpakoac97l35',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'ajalpakoac97l35',
      helpText: '',
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: true,
      bounds: { x: 40, y: 20, width: 32, height: 32 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features[0]).toMatchObject({ label: 'Unlabelled button', role: 'button' })
  })

  it('treats invokable custom web elements as buttons', () => {
    const features = mapUiAutomationFeatures([{
      name: 'More actions',
      controlType: 'Custom',
      localizedControlType: 'custom',
      automationId: 'more-actions',
      helpText: 'Open more actions',
      invokable: true,
      enabled: true,
      focusable: true,
      visibleRatio: 1,
      centerVisible: true,
      bounds: { x: 20, y: 20, width: 32, height: 32 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features).toEqual([
      expect.objectContaining({
        label: 'More actions',
        role: 'button',
        kind: 'control',
        description: 'Open more actions'
      })
    ])
  })

  it('keeps a compact icon control when its centre is the topmost accessibility element', () => {
    const features = mapUiAutomationFeatures([{
      name: 'Notifications',
      controlType: 'Button',
      localizedControlType: 'button',
      automationId: 'notifications',
      helpText: 'Open notifications',
      enabled: true,
      focusable: true,
      visibleRatio: 0.2,
      centerVisible: true,
      topmostVerified: true,
      bounds: { x: 40, y: 20, width: 24, height: 24 }
    }], { x: 0, y: 0, width: 100, height: 100 }, (bounds) => bounds)

    expect(features).toEqual([
      expect.objectContaining({
        label: 'Notifications',
        description: 'Open notifications',
        visibility: 0.2,
        visibilityVerified: true
      })
    ])
  })
})
