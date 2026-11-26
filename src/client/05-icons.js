/**
 * The panel's icons.
 *
 * Original 14px line drawings on `currentColor`, so they inherit the row colour
 * and need no theme-specific asset.
 */
function DwIcon({ name, size = 14, className }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.35,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    className,
    style: { display: 'block', flex: '0 0 auto' },
  }
  switch (name) {
    case 'env':
      return h('svg', common, [
        h('circle', { key: 'a', cx: 8, cy: 8, r: 5.6 }),
        h('path', { key: 'b', d: 'M2.6 8h10.8M8 2.4c1.7 1.5 2.6 3.4 2.6 5.6S9.7 12.1 8 13.6C6.3 12.1 5.4 10.2 5.4 8S6.3 3.9 8 2.4z' }),
      ])
    case 'instance':
      return h('svg', common, [
        h('rect', { key: 'a', x: 2.2, y: 3, width: 11.6, height: 4 }),
        h('rect', { key: 'b', x: 2.2, y: 9, width: 11.6, height: 4 }),
        h('circle', { key: 'c', cx: 4.8, cy: 5, r: .7, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'd', cx: 4.8, cy: 11, r: .7, fill: 'currentColor', stroke: 'none' }),
      ])
    case 'database':
      return h('svg', common, [
        h('ellipse', { key: 'a', cx: 8, cy: 4.1, rx: 5.4, ry: 2.1 }),
        h('path', { key: 'b', d: 'M2.6 4.1v7.8c0 1.16 2.42 2.1 5.4 2.1s5.4-.94 5.4-2.1V4.1' }),
        h('path', { key: 'c', d: 'M2.6 8c0 1.16 2.42 2.1 5.4 2.1s5.4-.94 5.4-2.1' }),
      ])
    case 'table':
      return h('svg', common, [
        h('rect', { key: 'a', x: 2.3, y: 2.8, width: 11.4, height: 10.4, rx: 1.2 }),
        h('path', { key: 'b', d: 'M2.3 6.2h11.4M6.4 6.2v7M10.3 6.2v7' }),
      ])
    case 'view':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M1.6 8S4.1 3.6 8 3.6 14.4 8 14.4 8 11.9 12.4 8 12.4 1.6 8 1.6 8z' }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.9 }),
      ])
    case 'column':
      return h('svg', common, [h('path', { d: 'M4.4 3.2v4.4a1.6 1.6 0 0 0 1.6 1.6h5.6M9.6 7.2l2 2-2 2' })])
    case 'key':
      return h('svg', common, [
        h('circle', { key: 'a', cx: 5.4, cy: 5.4, r: 2.6 }),
        h('path', { key: 'b', d: 'M7.3 7.3l5.1 5.1M10.6 10.6l1.4-1.4M12 12l1.2-1.2' }),
      ])
    case 'chevron':
      return h('svg', common, [h('path', { d: 'M6 3.6L10.4 8 6 12.4' })])
    case 'refresh':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
        h('path', { key: 'b', d: 'M13.4 2.6v3.2h-3.2' }),
      ])
    case 'play':
      return h('svg', { ...common, fill: 'currentColor', stroke: 'none' }, [h('path', { d: 'M4.6 2.9l8 5.1-8 5.1z' })])
    case 'stop':
      return h('svg', { ...common, fill: 'currentColor', stroke: 'none' }, [h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.4 })])
    case 'layers':
      return h('svg', common, [
        h('rect', { key: 'a', x: 2.4, y: 2.4, width: 7, height: 7, rx: 1.4 }),
        h('rect', { key: 'b', x: 6.6, y: 6.6, width: 7, height: 7, rx: 1.4 }),
      ])
    case 'stack':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M2 6 8 3.2 14 6 8 8.8Z' }),
        h('path', { key: 'b', d: 'M2 10.4 8 13.2 14 10.4' }),
      ])
    case 'arrow-left':
      return h('svg', common, [h('path', { key: 'a', d: 'M12.5 8H3.5M7 4.5 3.5 8 7 11.5' })])
    case 'arrow-right':
      return h('svg', common, [h('path', { key: 'a', d: 'M3.5 8h9M9 4.5 12.5 8 9 11.5' })])
    case 'at':
      return h('svg', common, [
        h('circle', { key: 'a', cx: 8, cy: 8, r: 2.4 }),
        h('path', { key: 'b', d: 'M10.4 8v1.4a2.1 2.1 0 0 0 4.2 0V8A6.4 6.4 0 1 0 8 14.4c1.2 0 2.2-.2 3-.7' }),
      ])
    case 'star':
      return h('svg', common, [h('path', { d: 'M8 2.1l1.82 3.69 4.07.59-2.94 2.87.69 4.06L8 11.4l-3.64 1.91.69-4.06L2.11 6.38l4.07-.59z' })])
    case 'close':
      return h('svg', common, [h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' })])
    case 'download':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M8 2.4v7.2' }),
        h('path', { key: 'b', d: 'M5 6.9 8 9.9l3-3' }),
        h('path', { key: 'c', d: 'M2.6 10.6v2.2h10.8v-2.2' }),
      ])
    case 'copy':
      return h('svg', common, [
        h('rect', { key: 'a', x: 5.4, y: 5.4, width: 8, height: 8, rx: 1.4 }),
        h('path', { key: 'b', d: 'M10.6 5.4V3.6a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4v5.6a1.4 1.4 0 0 0 1.4 1.4h1.8' }),
      ])
    case 'ddl':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M5.4 3.2H3.6v9.6h1.8M10.6 3.2h1.8v9.6h-1.8' }),
        h('path', { key: 'b', d: 'M6.6 6.4h2.8M6.6 9.2h2.8' }),
      ])
    case 'database-play':
      return h('svg', common, [
        h('ellipse', { key: 'a', cx: 8, cy: 3.8, rx: 5, ry: 1.9 }),
        h('path', { key: 'b', d: 'M3 3.8v7.6c0 1.05 2.24 1.9 5 1.9' }),
        h('path', { key: 'c', d: 'M3 7.6c0 1.05 2.24 1.9 5 1.9' }),
        h('path', { key: 'd', d: 'M10.6 9.4l3.1 2-3.1 2z', fill: 'currentColor', stroke: 'none' }),
      ])
    case 'grid':
      return h('svg', common, [
        h('rect', { key: 'a', x: 2.4, y: 2.4, width: 11.2, height: 11.2, rx: 1.4 }),
        h('path', { key: 'b', d: 'M2.4 6.2h11.2M2.4 9.8h11.2M6.2 2.4v11.2M9.8 2.4v11.2' }),
      ])
    case 'log':
      return h('svg', common, [
        h('rect', { key: 'a', x: 2.2, y: 3, width: 11.6, height: 10, rx: 1.4 }),
        h('path', { key: 'b', d: 'M4.6 6.2h6.8M4.6 9h4.4' }),
      ])
    case 'search':
      return h('svg', common, [
        h('circle', { key: 'a', cx: 7, cy: 7, r: 4.2 }),
        h('path', { key: 'b', d: 'M10.2 10.2l3.2 3.2' }),
      ])
    case 'spinner':
      return h('svg', { ...common, className: `dw-spin ${className ?? ''}` }, [
        h('path', { d: 'M8 2.2a5.8 5.8 0 1 0 5.8 5.8', opacity: .9 }),
      ])
    case 'format':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M2.5 4h11M2.5 8h7.5M2.5 12h4.5' }),
        h('path', { key: 'b', d: 'M11.5 10.5v3M10 12h3' }),
      ])
    case 'plus':
      return h('svg', common, [h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' })])
    case 'link':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-1 1' }),
        h('path', { key: 'b', d: 'M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l1-1' }),
      ])
    case 'ai':
      return h('svg', common, [
        h('path', { key: 'a', d: 'M8 1.9l1.4 3.7 3.7 1.4-3.7 1.4L8 12.1 6.6 8.4 2.9 7l3.7-1.4z' }),
        h('path', { key: 'b', d: 'M12.4 10.9l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z' }),
      ])
    case 'panel':
      return h('svg', common, [
        h('rect', { key: 'a', x: 1.8, y: 3, width: 12.4, height: 10, rx: 1.4 }),
        h('path', { key: 'b', d: 'M6 3v10' }),
      ])
    default:
      return h('svg', common, [h('circle', { cx: 8, cy: 8, r: 5.2 })])
  }
}
