import type Sigma from 'sigma'

export type CustomNodeState = { isActive: boolean }
export type CustomEdgeState = { isActive: boolean }
export type CustomGraphState = { hasActiveSubgraph: boolean }

type MapSigma = Sigma<any, any, any, CustomNodeState, CustomEdgeState, CustomGraphState>

export const MAP_SIGMA_SETTINGS: Partial<ReturnType<MapSigma['getSettings']>> = {
  allowInvalidContainer: true,
  itemSizesReference: 'screen',
  autoRescaleContent: 'nodes',
  stagePadding: 60,
  labelRenderedSizeThreshold: 0,
  labelDensity: 1.2,
  labelPixelSnapping: true,
  enableCameraRotation: false,
  enableCameraMouseRotation: false,
}

export const MAP_SIGMA_STYLES: ReturnType<MapSigma['getStyles']> = {
  nodes: [
    {
      color: { attribute: 'color' },
      size: { attribute: 'size' },
      label: { attribute: 'label' },
      labelPosition: (attrs: any) => ((attrs.size ?? 0) >= 18 ? 'over' : 'right'),
      labelColor: (attrs: any, state: any) =>
        (state as any)?.isActive || (state as any)?.isHighlighted
          ? '#ffffff'
          : ((attrs.size ?? 0) >= 18 ? '#0e1015' : '#f0f3ff'),
      labelFont: '600 11.5px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      labelSize: 11.5,
      labelVisibility: (attrs: any) => ((attrs.size ?? 0) >= 18 ? 'visible' : 'auto'),
      labelBackgroundColor: (attrs: any) => ((attrs.size ?? 0) < 18 ? '#15171fe6' : undefined),
      labelBackgroundPadding: 3,
    },
    {
      // SAFETY: sigma passes untyped state/graph here; keys match CustomNodeState/CustomGraphState above.
      when: (_a, s, g) =>
        Boolean((g as unknown as { hasActiveSubgraph?: boolean }).hasActiveSubgraph &&
          !(s as unknown as { isActive?: boolean }).isActive),
      then: { color: '#1a1b22', labelColor: '#44485c', labelBackgroundColor: 'transparent' },
    },
    {
      whenState: 'isHighlighted',
      then: {
        depth: 'topNodes',
        labelVisibility: 'visible',
        labelColor: '#ffffff',
        backdropVisibility: 'visible',
        backdropBorderColor: '#ffffff',
        backdropBorderWidth: 2.5,
        backdropArea: 'node',
      },
    },
    {
      whenState: 'isActive',
      then: {
        depth: 'topNodes',
        labelVisibility: 'visible',
        labelColor: '#ffffff',
        backdropVisibility: 'visible',
        backdropBorderColor: '#68a4ff',
        backdropBorderWidth: 2,
        backdropArea: 'node',
      },
    },
    {
      whenState: 'isHovered',
      then: {
        depth: 'topNodes',
        labelVisibility: 'visible',
        labelColor: '#ffffff',
        backdropVisibility: 'visible',
        backdropBorderColor: '#68a4ff',
        backdropBorderWidth: 2,
        backdropArea: 'node',
      },
    },
  ],
  edges: [
    { color: { attribute: 'color' }, size: { attribute: 'size' } },
    {
      // SAFETY: sigma passes untyped state/graph here; keys match CustomEdgeState/CustomGraphState above.
      when: (_a, s, g) =>
        Boolean((g as unknown as { hasActiveSubgraph?: boolean }).hasActiveSubgraph &&
          !(s as unknown as { isActive?: boolean }).isActive),
      then: { color: '#13141b20' },
    },
    { whenState: 'isActive', then: { depth: 'topEdges', color: '#68a4ff', size: 2.2 } },
  ],
}
