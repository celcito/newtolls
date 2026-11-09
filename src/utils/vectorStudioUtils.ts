import { Point2D, Path2D } from '../types';
import { distance, isLoopClosed, closeLoop, simplifyPointsRDP } from './drawingPrecision';

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/**
 * Calculates bounding box of a point set
 */
export function getPathBounds(points: Point2D[]): BoundingBox {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0, centerX: 0, centerY: 0 };
  }
  let minX = points[0][0];
  let maxX = points[0][0];
  let minY = points[0][1];
  let maxY = points[0][1];

  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const width = Math.max(0.001, maxX - minX);
  const height = Math.max(0.001, maxY - minY);
  return {
    minX,
    minY,
    maxX,
    maxY,
    width,
    height,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Rotates a 2D point around an origin point by angle in radians
 */
export function rotatePoint(p: Point2D, center: Point2D, angleRad: number): Point2D {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  return [
    center[0] + dx * cos - dy * sin,
    center[1] + dx * sin + dy * cos,
  ];
}

/**
 * Translates points by delta (dx, dy)
 */
export function translatePath(points: Point2D[], dx: number, dy: number): Point2D[] {
  return points.map(([x, y]) => [
    Math.max(0, Math.min(100, x + dx)),
    Math.max(0, Math.min(100, y + dy)),
  ]);
}

/**
 * Scales points relative to center
 */
export function scalePath(points: Point2D[], scaleX: number, scaleY: number, origin?: Point2D): Point2D[] {
  const center = origin || [
    points.reduce((acc, p) => acc + p[0], 0) / (points.length || 1),
    points.reduce((acc, p) => acc + p[1], 0) / (points.length || 1),
  ];

  return points.map(([x, y]) => [
    Math.max(0, Math.min(100, center[0] + (x - center[0]) * scaleX)),
    Math.max(0, Math.min(100, center[1] + (y - center[1]) * scaleY)),
  ]);
}

/**
 * Rotates points relative to center
 */
export function rotatePath(points: Point2D[], angleDeg: number, origin?: Point2D): Point2D[] {
  const angleRad = (angleDeg * Math.PI) / 180;
  const center = origin || [
    points.reduce((acc, p) => acc + p[0], 0) / (points.length || 1),
    points.reduce((acc, p) => acc + p[1], 0) / (points.length || 1),
  ];

  return points.map((p) => {
    const rotated = rotatePoint(p, center, angleRad);
    return [
      Math.max(0, Math.min(100, rotated[0])),
      Math.max(0, Math.min(100, rotated[1])),
    ];
  });
}

/**
 * Flips points horizontally or vertically around path center
 */
export function flipPath(points: Point2D[], flipH: boolean, flipV: boolean): Point2D[] {
  const bounds = getPathBounds(points);
  return points.map(([x, y]) => {
    const newX = flipH ? bounds.maxX - (x - bounds.minX) : x;
    const newY = flipV ? bounds.maxY - (y - bounds.minY) : y;
    return [newX, newY];
  });
}

/**
 * Centers a path inside the 100x100 canvas space
 */
export function centerPathInCanvas(points: Point2D[]): Point2D[] {
  const bounds = getPathBounds(points);
  const dx = 50 - bounds.centerX;
  const dy = 50 - bounds.centerY;
  return translatePath(points, dx, dy);
}

/**
 * Inserts a new node into the closest segment along the path
 */
export function insertNodeOnPath(points: Point2D[], clickPt: Point2D): { points: Point2D[]; index: number } | null {
  if (points.length < 2) return null;

  let bestSegmentIndex = -1;
  let minDistance = Infinity;
  let bestProjection: Point2D = [0, 0];

  const count = points.length;
  for (let i = 0; i < count; i++) {
    const nextIdx = (i + 1) % count;
    // If not closed and on last point, break
    if (nextIdx === 0 && distance(points[0], points[count - 1]) > 0.1) {
      break;
    }

    const p1 = points[i];
    const p2 = points[nextIdx];

    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 0.0001) continue;

    const t = Math.max(0, Math.min(1, ((clickPt[0] - p1[0]) * dx + (clickPt[1] - p1[1]) * dy) / lenSq));
    const proj: Point2D = [p1[0] + t * dx, p1[1] + t * dy];
    const d = distance(clickPt, proj);

    if (d < minDistance) {
      minDistance = d;
      bestSegmentIndex = i;
      bestProjection = proj;
    }
  }

  // Only insert if within 5% distance
  if (minDistance <= 5 && bestSegmentIndex !== -1) {
    const updated = [...points];
    updated.splice(bestSegmentIndex + 1, 0, bestProjection);
    return { points: updated, index: bestSegmentIndex + 1 };
  }

  return null;
}

/**
 * Offset Path (Illustrator / Inkscape Outset & Inset)
 * Expands or shrinks closed contour by delta percentage
 */
export function offsetPathVector(points: Point2D[], delta: number): Point2D[] {
  const n = points.length;
  if (n < 3) return points;

  // Calculate normals
  const normals: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([dy / len, -dx / len]);
  }

  const result: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const prevNorm = normals[(i - 1 + n) % n];
    const currNorm = normals[i];

    let nx = prevNorm[0] + currNorm[0];
    let ny = prevNorm[1] + currNorm[1];
    const nLen = Math.hypot(nx, ny) || 1;
    nx /= nLen;
    ny /= nLen;

    const dot = currNorm[0] * nx + currNorm[1] * ny;
    const miter = Math.min(2.5, Math.max(0.5, 1 / (dot || 1)));

    result.push([
      Math.max(1, Math.min(99, points[i][0] + nx * delta * miter)),
      Math.max(1, Math.min(99, points[i][1] + ny * delta * miter)),
    ]);
  }

  return result;
}

/**
 * Export paths as clean SVG vector file (Illustrator / Inkscape compatible)
 */
export function exportPathsToSVG(
  paths: { points: Point2D[]; isClosed: boolean; isOuter: boolean }[],
  name: string = 'cookie_cutter_vector'
): string {
  const pathElements = paths.map((p, idx) => {
    if (p.points.length === 0) return '';
    const d = p.points.reduce((acc, pt, i) => {
      const command = i === 0 ? 'M' : 'L';
      return `${acc} ${command} ${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`;
    }, '');

    const closedSuffix = p.isClosed ? ' Z' : '';
    const strokeColor = p.isOuter ? '#f59e0b' : '#38bdf8';
    const strokeWidth = p.isOuter ? '1.5' : '1.0';
    const roleClass = p.isOuter ? 'cutter-blade' : 'stamp-emboss';

    return `  <path id="path_${idx}_${roleClass}" class="${roleClass}" d="${d}${closedSuffix}" fill="none" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
  <!-- Generated by Cookie3D Studio Vector Engine (Illustrator & Inkscape Compatible) -->
  <title>${name}</title>
  <defs>
    <style>
      .cutter-blade { stroke: #f59e0b; stroke-width: 1.5; }
      .stamp-emboss { stroke: #38bdf8; stroke-width: 1.0; }
    </style>
  </defs>
  <rect width="100" height="100" fill="#0f172a" opacity="0.05" />
${pathElements.join('\n')}
</svg>`;
}

/**
 * Downloads string content as a file
 */
export function downloadSVGFile(svgContent: string, filename: string = 'desenho_vetorial.svg') {
  const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Quick SVG path string parser into Point2D array
 * Parses SVG commands (M, L, H, V, C, S, Q, Z)
 */
export function parseSvgStringToPaths(svgText: string): Point2D[][] {
  const paths: Point2D[][] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, 'image/svg+xml');

  // Find viewBox or width/height
  const svgElem = doc.querySelector('svg');
  let vbX = 0, vbY = 0, vbW = 100, vbH = 100;
  if (svgElem) {
    const vb = svgElem.getAttribute('viewBox');
    if (vb) {
      const parts = vb.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        [vbX, vbY, vbW, vbH] = parts;
      }
    } else {
      const w = parseFloat(svgElem.getAttribute('width') || '100');
      const h = parseFloat(svgElem.getAttribute('height') || '100');
      if (w > 0) vbW = w;
      if (h > 0) vbH = h;
    }
  }

  // Convert SVG coordinates to 0..100 percentage space
  const normalize = (x: number, y: number): Point2D => {
    const pctX = ((x - vbX) / vbW) * 100;
    const pctY = ((y - vbY) / vbH) * 100;
    return [Math.max(0, Math.min(100, pctX)), Math.max(0, Math.min(100, pctY))];
  };

  // Helper to parse path 'd' attribute
  const parsePathD = (d: string): Point2D[] => {
    const points: Point2D[] = [];
    const commands = d.match(/([a-df-zA-DF-Z])([^a-df-zA-DF-Z]*)/g);
    if (!commands) return [];

    let currX = 0;
    let currY = 0;

    for (const cmdChunk of commands) {
      const cmd = cmdChunk[0];
      const numbers = cmdChunk.slice(1).trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));

      switch (cmd) {
        case 'M':
          if (numbers.length >= 2) {
            currX = numbers[0];
            currY = numbers[1];
            points.push(normalize(currX, currY));
          }
          break;
        case 'm':
          if (numbers.length >= 2) {
            currX += numbers[0];
            currY += numbers[1];
            points.push(normalize(currX, currY));
          }
          break;
        case 'L':
          for (let i = 0; i < numbers.length; i += 2) {
            currX = numbers[i];
            currY = numbers[i + 1];
            points.push(normalize(currX, currY));
          }
          break;
        case 'l':
          for (let i = 0; i < numbers.length; i += 2) {
            currX += numbers[i];
            currY += numbers[i + 1];
            points.push(normalize(currX, currY));
          }
          break;
        case 'H':
          if (numbers.length >= 1) {
            currX = numbers[0];
            points.push(normalize(currX, currY));
          }
          break;
        case 'h':
          if (numbers.length >= 1) {
            currX += numbers[0];
            points.push(normalize(currX, currY));
          }
          break;
        case 'V':
          if (numbers.length >= 1) {
            currY = numbers[0];
            points.push(normalize(currX, currY));
          }
          break;
        case 'v':
          if (numbers.length >= 1) {
            currY += numbers[0];
            points.push(normalize(currX, currY));
          }
          break;
        case 'C':
        case 'c':
        case 'S':
        case 's':
        case 'Q':
        case 'q': {
          // Approximate curve endpoints
          for (let i = 0; i < numbers.length; i += 6) {
            if (i + 5 < numbers.length) {
              if (cmd === 'c') {
                currX += numbers[i + 4];
                currY += numbers[i + 5];
              } else {
                currX = numbers[i + 4];
                currY = numbers[i + 5];
              }
              points.push(normalize(currX, currY));
            }
          }
          break;
        }
        case 'Z':
        case 'z':
          if (points.length > 0) {
            points.push([points[0][0], points[0][1]]);
          }
          break;
      }
    }
    return points;
  };

  // Find all <path> elements
  const pathTags = doc.querySelectorAll('path');
  pathTags.forEach((p) => {
    const d = p.getAttribute('d');
    if (d) {
      const pts = parsePathD(d);
      if (pts.length >= 2) paths.push(pts);
    }
  });

  // Find all <polygon> and <polyline>
  const polyTags = doc.querySelectorAll('polygon, polyline');
  polyTags.forEach((p) => {
    const ptsAttr = p.getAttribute('points');
    if (ptsAttr) {
      const nums = ptsAttr.trim().split(/[\s,]+/).map(Number).filter((n) => !isNaN(n));
      const pts: Point2D[] = [];
      for (let i = 0; i < nums.length; i += 2) {
        pts.push(normalize(nums[i], nums[i + 1]));
      }
      if (p.tagName.toLowerCase() === 'polygon' && pts.length >= 2) {
        pts.push([pts[0][0], pts[0][1]]);
      }
      if (pts.length >= 2) paths.push(pts);
    }
  });

  // Find all <circle>
  const circleTags = doc.querySelectorAll('circle');
  circleTags.forEach((c) => {
    const cx = parseFloat(c.getAttribute('cx') || '0');
    const cy = parseFloat(c.getAttribute('cy') || '0');
    const r = parseFloat(c.getAttribute('r') || '0');
    if (r > 0) {
      const pts: Point2D[] = [];
      for (let i = 0; i <= 32; i++) {
        const ang = (i * 2 * Math.PI) / 32;
        pts.push(normalize(cx + r * Math.cos(ang), cy + r * Math.sin(ang)));
      }
      paths.push(pts);
    }
  });

  // Find all <rect>
  const rectTags = doc.querySelectorAll('rect');
  rectTags.forEach((r) => {
    const rx = parseFloat(r.getAttribute('x') || '0');
    const ry = parseFloat(r.getAttribute('y') || '0');
    const rw = parseFloat(r.getAttribute('width') || '0');
    const rh = parseFloat(r.getAttribute('height') || '0');
    if (rw > 0 && rh > 0) {
      paths.push([
        normalize(rx, ry),
        normalize(rx + rw, ry),
        normalize(rx + rw, ry + rh),
        normalize(rx, ry + rh),
        normalize(rx, ry),
      ]);
    }
  });

  return paths;
}
