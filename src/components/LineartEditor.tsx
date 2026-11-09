import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ModelLineart, Path2D, Point2D } from '../types';
import { traceImageToLineart } from '../utils/imageTracer';
import {
  distance,
  snapToGrid,
  isLoopClosed,
  closeLoop,
  simplifyPointsRDP,
  chaikinSmooth,
  catmullRomSpline,
  StrokeStabilizer,
  generateRegularPolygon,
  generateEllipse,
  generateRectangle,
  calculatePolygonArea,
} from '../utils/drawingPrecision';
import {
  getPathBounds,
  rotatePath,
  scalePath,
  translatePath,
  flipPath,
  centerPathInCanvas,
  insertNodeOnPath,
  offsetPathVector,
  exportPathsToSVG,
  downloadSVGFile,
  parseSvgStringToPaths,
  BoundingBox,
} from '../utils/vectorStudioUtils';
import {
  X,
  Upload,
  Pen,
  RotateCcw,
  Sparkles,
  Check,
  Sliders,
  SplitSquareVertical,
  Grid,
  Magnet,
  Undo2,
  Redo2,
  Circle,
  Square,
  Minus,
  Star,
  Heart,
  ShieldCheck,
  Eraser,
  Layers,
  Crosshair,
  Info,
  MousePointer,
  Waypoints,
  Maximize2,
  Minimize2,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  FileCode,
  Copy,
  PlusCircle,
  Trash2,
  Download as DownloadIcon,
} from 'lucide-react';

interface LineartEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onApplyCustomModel: (model: ModelLineart) => void;
}

type MainTool =
  | 'select' // Illustrator Selection Tool (V) - move, scale, rotate
  | 'node' // Illustrator Direct Selection / Inkscape Node Tool (A / N) - edit vertices
  | 'pen' // Freehand pen with stabilizer
  | 'line' // Straight polyline
  | 'circle' // Ellipse / circle
  | 'rect' // Rectangle / box
  | 'star' // Star
  | 'heart' // Heart
  | 'eraser'; // Eraser

type SmoothingLevel = 'none' | 'medium' | 'high';

interface StrokeItem {
  id: string;
  points: Point2D[];
  isClosed: boolean;
  isOuter: boolean;
}

export const LineartEditor: React.FC<LineartEditorProps> = ({
  isOpen,
  onClose,
  onApplyCustomModel,
}) => {
  const [tab, setTab] = useState<'draw' | 'upload'>('draw');

  // Model Metadata
  const [modelName, setModelName] = useState<string>('Meu Cortador Vetorial');

  // Vector Tools State
  const [activeTool, setActiveTool] = useState<MainTool>('pen');
  const [selectedStrokeId, setSelectedStrokeId] = useState<string | null>(null);
  const [selectedNodeIndex, setSelectedNodeIndex] = useState<number | null>(null);

  // Drawing & Precision Parameters
  const [brushSize, setBrushSize] = useState<number>(4);
  const [smoothingLevel, setSmoothingLevel] = useState<SmoothingLevel>('medium');
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [enableSnapGrid, setEnableSnapGrid] = useState<boolean>(false);
  const [showCenterGuides, setShowCenterGuides] = useState<boolean>(true);
  const [mirrorMode, setMirrorMode] = useState<boolean>(false);
  const [autoCloseLoop, setAutoCloseLoop] = useState<boolean>(true);

  // Stroke stack & history
  const [strokes, setStrokes] = useState<StrokeItem[]>([]);
  const [undoStack, setUndoStack] = useState<StrokeItem[][]>([]);
  const [redoStack, setRedoStack] = useState<StrokeItem[][]>([]);

  // Dragging / Transforming State
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const isPointerDownRef = useRef<boolean>(false);
  const dragModeRef = useRef<'none' | 'draw' | 'move-shape' | 'move-node' | 'scale-handle' | 'rotate-handle'>('none');
  const activeHandleRef = useRef<string | null>(null);
  const startDragPtRef = useRef<Point2D | null>(null);
  const originalPointsRef = useRef<Point2D[]>([]);
  const currentRawPointsRef = useRef<Point2D[]>([]);
  const stabilizerRef = useRef<StrokeStabilizer>(new StrokeStabilizer(0.35));

  // Visual state
  const [cursorPos, setCursorPos] = useState<Point2D | null>(null);
  const [isNearStart, setIsNearStart] = useState<boolean>(false);
  const [svgModalOpen, setSvgModalOpen] = useState<boolean>(false);
  const [svgTextInput, setSvgTextInput] = useState<string>('');

  // Upload Tab State
  const [uploadedImageSrc, setUploadedImageSrc] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<number>(128);
  const [invert, setInvert] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const svgFileInputRef = useRef<HTMLInputElement>(null);

  // Synchronize stabilizer with smoothing level
  useEffect(() => {
    if (smoothingLevel === 'none') {
      stabilizerRef.current.setWeight(0);
    } else if (smoothingLevel === 'medium') {
      stabilizerRef.current.setWeight(0.35);
    } else {
      stabilizerRef.current.setWeight(0.65);
    }
  }, [smoothingLevel]);

  // History management
  const recordHistory = useCallback((newStrokes: StrokeItem[]) => {
    setUndoStack((prev) => [...prev, strokes]);
    setRedoStack([]);
    setStrokes(newStrokes);
  }, [strokes]);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, prev.length - 1));
    setRedoStack((prev) => [...prev, strokes]);
    setStrokes(previous);
  }, [undoStack, strokes]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, prev.length - 1));
    setUndoStack((prev) => [...prev, strokes]);
    setStrokes(next);
  }, [redoStack, strokes]);

  // Keyboard shortcuts (V, A, P, Ctrl+Z, Delete, etc.)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.shiftKey) handleRedo();
        else handleUndo();
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        handleRedo();
        e.preventDefault();
      } else if (e.key === 'v' || e.key === 'V') {
        setActiveTool('select');
      } else if (e.key === 'a' || e.key === 'A') {
        setActiveTool('node');
      } else if (e.key === 'p' || e.key === 'P') {
        setActiveTool('pen');
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (activeTool === 'node' && selectedStrokeId && selectedNodeIndex !== null) {
          handleDeleteSelectedNode();
          e.preventDefault();
        } else if (selectedStrokeId) {
          handleDeleteSelectedStroke();
          e.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleUndo, handleRedo, activeTool, selectedStrokeId, selectedNodeIndex]);

  // Recalculate outer vs inner contours automatically
  const reclassifyStrokes = useCallback((strokeList: StrokeItem[]): StrokeItem[] => {
    if (strokeList.length === 0) return [];
    if (strokeList.length === 1) {
      return [{ ...strokeList[0], isOuter: true }];
    }

    // Keep existing outer if valid
    const existingOuter = strokeList.find((s) => s.isOuter);
    if (existingOuter) {
      return strokeList;
    }

    let bestIndex = 0;
    let maxScore = -1;

    strokeList.forEach((st, idx) => {
      const area = calculatePolygonArea(st.points);
      const score = st.isClosed ? area * 1.5 : area;
      if (score > maxScore) {
        maxScore = score;
        bestIndex = idx;
      }
    });

    return strokeList.map((st, idx) => ({
      ...st,
      isOuter: idx === bestIndex,
    }));
  }, []);

  // Coordinate conversion
  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point2D => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return [0, 0];
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let x = (e.clientX - rect.left) * scaleX;
    let y = (e.clientY - rect.top) * scaleY;

    let pctX = (x / canvas.width) * 100;
    let pctY = (y / canvas.height) * 100;

    if (enableSnapGrid) {
      [pctX, pctY] = snapToGrid([pctX, pctY], 5);
    }

    return [
      Math.max(0, Math.min(100, pctX)),
      Math.max(0, Math.min(100, pctY)),
    ];
  };

  // Redraw canvas
  const redrawCanvas = useCallback(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // 1. Background
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, w, h);

    // 2. Millimeter grid
    if (showGrid) {
      ctx.lineWidth = 1;
      const step = w / 20;
      ctx.strokeStyle = '#1e293b40';
      ctx.beginPath();
      for (let x = 0; x <= w; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y <= h; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Major lines (10% step)
      ctx.strokeStyle = '#33415560';
      ctx.beginPath();
      for (let x = 0; x <= w; x += step * 2) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y <= h; y += step * 2) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }

    // 3. Center axes
    if (showCenterGuides) {
      ctx.strokeStyle = '#47556980';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Safe margin
      ctx.strokeStyle = '#33415540';
      ctx.setLineDash([2, 4]);
      ctx.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
      ctx.setLineDash([]);
    }

    // 4. Mirror Axis
    if (mirrorMode) {
      ctx.strokeStyle = '#06b6d490';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 5. Render committed strokes
    strokes.forEach((stroke) => {
      if (stroke.points.length < 2) return;

      const isSelected = stroke.id === selectedStrokeId;
      const isOuterBlade = stroke.isOuter;

      ctx.lineWidth = isOuterBlade ? Math.max(3.5, brushSize * 1.1) : Math.max(2, brushSize * 0.75);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.strokeStyle = isOuterBlade ? '#f59e0b' : '#38bdf8';

      if (isOuterBlade) {
        ctx.shadowColor = 'rgba(245, 158, 11, 0.45)';
        ctx.shadowBlur = 8;
      } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }

      ctx.beginPath();
      const first = stroke.points[0];
      ctx.moveTo((first[0] / 100) * w, (first[1] / 100) * h);

      for (let i = 1; i < stroke.points.length; i++) {
        const pt = stroke.points[i];
        ctx.lineTo((pt[0] / 100) * w, (pt[1] / 100) * h);
      }

      if (stroke.isClosed) {
        ctx.closePath();
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Selection halo if active
      if (isSelected) {
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 6. If in Node Edit Mode ('node') and this shape is selected, draw interactive vertex nodes (Inkscape / Illustrator style)
      if (activeTool === 'node' && isSelected) {
        stroke.points.forEach((pt, nIdx) => {
          const isNodeSelected = nIdx === selectedNodeIndex;
          const nx = (pt[0] / 100) * w;
          const ny = (pt[1] / 100) * h;

          // Draw vertex square node
          const nodeSize = isNodeSelected ? 9 : 7;
          ctx.fillStyle = isNodeSelected ? '#3b82f6' : '#ffffff';
          ctx.strokeStyle = '#1e293b';
          ctx.lineWidth = 1.5;
          ctx.fillRect(nx - nodeSize / 2, ny - nodeSize / 2, nodeSize, nodeSize);
          ctx.strokeRect(nx - nodeSize / 2, ny - nodeSize / 2, nodeSize, nodeSize);
        });
      }
    });

    // 7. If in Selection / Transform Mode ('select') and a stroke is selected, draw Illustrator Bounding Box with transform handles
    const activeStroke = strokes.find((s) => s.id === selectedStrokeId);
    if (activeTool === 'select' && activeStroke && activeStroke.points.length > 0) {
      const b = getPathBounds(activeStroke.points);
      const bx = (b.minX / 100) * w;
      const by = (b.minY / 100) * h;
      const bw = (b.width / 100) * w;
      const bh = (b.height / 100) * h;

      // Draw bounding rectangle
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);

      // Draw 8 resize handles
      const handleSize = 7;
      const handles = [
        { id: 'tl', x: bx, y: by },
        { id: 'tm', x: bx + bw / 2, y: by },
        { id: 'tr', x: bx + bw, y: by },
        { id: 'ml', x: bx, y: by + bh / 2 },
        { id: 'mr', x: bx + bw, y: by + bh / 2 },
        { id: 'bl', x: bx, y: by + bh },
        { id: 'bm', x: bx + bw / 2, y: by + bh },
        { id: 'br', x: bx + bw, y: by + bh },
      ];

      handles.forEach((hnd) => {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.5;
        ctx.fillRect(hnd.x - handleSize / 2, hnd.y - handleSize / 2, handleSize, handleSize);
        ctx.strokeRect(hnd.x - handleSize / 2, hnd.y - handleSize / 2, handleSize, handleSize);
      });

      // Rotation lever above top center
      const rotY = by - 20;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + bw / 2, by);
      ctx.lineTo(bx + bw / 2, rotY);
      ctx.stroke();

      ctx.fillStyle = '#60a5fa';
      ctx.beginPath();
      ctx.arc(bx + bw / 2, rotY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    // 8. Active drawing in progress
    if (currentRawPointsRef.current.length > 0) {
      const pts = currentRawPointsRef.current;
      ctx.lineWidth = brushSize;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#38bdf8';
      ctx.shadowColor = 'rgba(56, 189, 248, 0.5)';
      ctx.shadowBlur = 6;

      ctx.beginPath();
      const p0 = pts[0];
      ctx.moveTo((p0[0] / 100) * w, (p0[1] / 100) * h);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo((pts[i][0] / 100) * w, (pts[i][1] / 100) * h);
      }
      ctx.stroke();

      if (mirrorMode) {
        ctx.strokeStyle = '#06b6d4';
        ctx.beginPath();
        ctx.moveTo(((100 - p0[0]) / 100) * w, (p0[1] / 100) * h);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(((100 - pts[i][0]) / 100) * w, (pts[i][1] / 100) * h);
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // Magnetic snap indicator
      const startPt = pts[0];
      const startX = (startPt[0] / 100) * w;
      const startY = (startPt[1] / 100) * h;

      if (isNearStart) {
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(startX, startY, 12, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = '#22c55e';
        ctx.beginPath();
        ctx.arc(startX, startY, 5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.arc(startX, startY, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [
    showGrid,
    showCenterGuides,
    mirrorMode,
    brushSize,
    strokes,
    selectedStrokeId,
    selectedNodeIndex,
    activeTool,
    isNearStart,
  ]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Pointer interactions for drawing, node editing, selection and transforms
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);

    const pt = getCanvasPoint(e);
    isPointerDownRef.current = true;
    startDragPtRef.current = pt;
    setIsNearStart(false);

    // MODE 1: Node Tool (Direct Selection / Vértices)
    if (activeTool === 'node') {
      const activeStroke = strokes.find((s) => s.id === selectedStrokeId);
      if (activeStroke) {
        // Check if clicked an existing node
        const nodeIdx = activeStroke.points.findIndex((p) => distance(p, pt) <= 3);
        if (nodeIdx !== -1) {
          setSelectedNodeIndex(nodeIdx);
          dragModeRef.current = 'move-node';
          originalPointsRef.current = [...activeStroke.points];
          redrawCanvas();
          return;
        }

        // Check if clicked along path to insert a new node!
        const insertResult = insertNodeOnPath(activeStroke.points, pt);
        if (insertResult) {
          const updated = strokes.map((s) => (s.id === activeStroke.id ? { ...s, points: insertResult.points } : s));
          recordHistory(updated);
          setSelectedNodeIndex(insertResult.index);
          dragModeRef.current = 'move-node';
          originalPointsRef.current = [...insertResult.points];
          redrawCanvas();
          return;
        }
      }

      // Otherwise, see if clicked another stroke to select it
      const clickedStroke = strokes.find((s) => s.points.some((p) => distance(p, pt) <= 4));
      if (clickedStroke) {
        setSelectedStrokeId(clickedStroke.id);
        setSelectedNodeIndex(null);
      } else {
        setSelectedStrokeId(null);
        setSelectedNodeIndex(null);
      }
      redrawCanvas();
      return;
    }

    // MODE 2: Selection / Transform Tool (V)
    if (activeTool === 'select') {
      const activeStroke = strokes.find((s) => s.id === selectedStrokeId);
      if (activeStroke) {
        const b = getPathBounds(activeStroke.points);
        // Check rotate handle (above top center)
        const rotPt: Point2D = [b.centerX, b.minY - 3];
        if (distance(pt, rotPt) <= 4) {
          dragModeRef.current = 'rotate-handle';
          originalPointsRef.current = [...activeStroke.points];
          redrawCanvas();
          return;
        }

        // Check scale handles
        const handles: { id: string; p: Point2D }[] = [
          { id: 'tl', p: [b.minX, b.minY] },
          { id: 'tr', p: [b.maxX, b.minY] },
          { id: 'bl', p: [b.minX, b.maxY] },
          { id: 'br', p: [b.maxX, b.maxY] },
        ];
        const hMatch = handles.find((h) => distance(pt, h.p) <= 3.5);
        if (hMatch) {
          dragModeRef.current = 'scale-handle';
          activeHandleRef.current = hMatch.id;
          originalPointsRef.current = [...activeStroke.points];
          redrawCanvas();
          return;
        }

        // Check if clicking inside bounding box to move
        if (pt[0] >= b.minX && pt[0] <= b.maxX && pt[1] >= b.minY && pt[1] <= b.maxY) {
          dragModeRef.current = 'move-shape';
          originalPointsRef.current = [...activeStroke.points];
          redrawCanvas();
          return;
        }
      }

      // Check if clicking another stroke
      const clickedStroke = strokes.find((s) => s.points.some((p) => distance(p, pt) <= 4));
      if (clickedStroke) {
        setSelectedStrokeId(clickedStroke.id);
        dragModeRef.current = 'move-shape';
        originalPointsRef.current = [...clickedStroke.points];
      } else {
        setSelectedStrokeId(null);
        dragModeRef.current = 'none';
      }
      redrawCanvas();
      return;
    }

    // MODE 3: Eraser
    if (activeTool === 'eraser') {
      const clickedIdx = strokes.findIndex((st) => st.points.some((p) => distance(p, pt) <= 4));
      if (clickedIdx !== -1) {
        const next = strokes.filter((_, i) => i !== clickedIdx);
        recordHistory(reclassifyStrokes(next));
        if (selectedStrokeId === strokes[clickedIdx].id) {
          setSelectedStrokeId(null);
        }
      }
      return;
    }

    // MODE 4: Drawing tools (Pen, Line, Shapes)
    dragModeRef.current = 'draw';
    stabilizerRef.current.reset(pt[0], pt[1]);
    currentRawPointsRef.current = [pt];
    redrawCanvas();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = getCanvasPoint(e);
    setCursorPos(pt);

    if (!isPointerDownRef.current) return;

    // Moving a single node in Node Mode
    if (dragModeRef.current === 'move-node' && selectedStrokeId && selectedNodeIndex !== null) {
      setStrokes((prev) =>
        prev.map((s) => {
          if (s.id !== selectedStrokeId) return s;
          const nextPts = [...s.points];
          nextPts[selectedNodeIndex] = pt;
          return { ...s, points: nextPts };
        })
      );
      redrawCanvas();
      return;
    }

    // Moving entire shape in Select Mode
    if (dragModeRef.current === 'move-shape' && selectedStrokeId && startDragPtRef.current) {
      const dx = pt[0] - startDragPtRef.current[0];
      const dy = pt[1] - startDragPtRef.current[1];
      const moved = translatePath(originalPointsRef.current, dx, dy);
      setStrokes((prev) => prev.map((s) => (s.id === selectedStrokeId ? { ...s, points: moved } : s)));
      redrawCanvas();
      return;
    }

    // Scaling shape via handle
    if (dragModeRef.current === 'scale-handle' && selectedStrokeId && startDragPtRef.current) {
      const origBounds = getPathBounds(originalPointsRef.current);
      const startW = origBounds.width || 1;
      const startH = origBounds.height || 1;
      const dx = pt[0] - startDragPtRef.current[0];
      const dy = pt[1] - startDragPtRef.current[1];

      let scaleFactorX = 1;
      let scaleFactorY = 1;

      if (activeHandleRef.current === 'br') {
        scaleFactorX = Math.max(0.2, (startW + dx) / startW);
        scaleFactorY = Math.max(0.2, (startH + dy) / startH);
      } else if (activeHandleRef.current === 'tl') {
        scaleFactorX = Math.max(0.2, (startW - dx) / startW);
        scaleFactorY = Math.max(0.2, (startH - dy) / startH);
      } else if (activeHandleRef.current === 'tr') {
        scaleFactorX = Math.max(0.2, (startW + dx) / startW);
        scaleFactorY = Math.max(0.2, (startH - dy) / startH);
      } else if (activeHandleRef.current === 'bl') {
        scaleFactorX = Math.max(0.2, (startW - dx) / startW);
        scaleFactorY = Math.max(0.2, (startH + dy) / startH);
      }

      const scaled = scalePath(originalPointsRef.current, scaleFactorX, scaleFactorY, [origBounds.centerX, origBounds.centerY]);
      setStrokes((prev) => prev.map((s) => (s.id === selectedStrokeId ? { ...s, points: scaled } : s)));
      redrawCanvas();
      return;
    }

    // Rotating shape via lever
    if (dragModeRef.current === 'rotate-handle' && selectedStrokeId) {
      const origBounds = getPathBounds(originalPointsRef.current);
      const angle = (Math.atan2(pt[1] - origBounds.centerY, pt[0] - origBounds.centerX) * 180) / Math.PI + 90;
      const rotated = rotatePath(originalPointsRef.current, angle, [origBounds.centerX, origBounds.centerY]);
      setStrokes((prev) => prev.map((s) => (s.id === selectedStrokeId ? { ...s, points: rotated } : s)));
      redrawCanvas();
      return;
    }

    // Active stroke drawing
    if (dragModeRef.current === 'draw') {
      if (activeTool === 'pen') {
        const [filteredX, filteredY] = stabilizerRef.current.filter(pt[0], pt[1]);
        const currentFiltered: Point2D = [filteredX, filteredY];
        const lastPt = currentRawPointsRef.current[currentRawPointsRef.current.length - 1];

        if (!lastPt || distance(lastPt, currentFiltered) >= 0.4) {
          currentRawPointsRef.current.push(currentFiltered);
        }

        if (autoCloseLoop && currentRawPointsRef.current.length > 10) {
          const start = currentRawPointsRef.current[0];
          setIsNearStart(distance(currentFiltered, start) <= 6);
        }
      } else if (activeTool === 'line') {
        if (startDragPtRef.current) {
          currentRawPointsRef.current = [startDragPtRef.current, pt];
        }
      } else if (activeTool === 'circle') {
        if (startDragPtRef.current) {
          const center = startDragPtRef.current;
          currentRawPointsRef.current = generateEllipse(center, Math.abs(pt[0] - center[0]), Math.abs(pt[1] - center[1]), 48);
        }
      } else if (activeTool === 'rect') {
        if (startDragPtRef.current) {
          currentRawPointsRef.current = generateRectangle(startDragPtRef.current, pt, 2);
        }
      } else if (activeTool === 'star') {
        if (startDragPtRef.current) {
          const center = startDragPtRef.current;
          const radius = distance(center, pt);
          const starPts: Point2D[] = [];
          for (let i = 0; i < 10; i++) {
            const r = i % 2 === 0 ? radius : radius * 0.45;
            const angle = (i * Math.PI) / 5 - Math.PI / 2;
            starPts.push([center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle)]);
          }
          starPts.push([starPts[0][0], starPts[0][1]]);
          currentRawPointsRef.current = starPts;
        }
      } else if (activeTool === 'heart') {
        if (startDragPtRef.current) {
          const center = startDragPtRef.current;
          const radius = distance(center, pt);
          const heartPts: Point2D[] = [];
          for (let t = 0; t <= Math.PI * 2; t += 0.15) {
            const x = 16 * Math.pow(Math.sin(t), 3);
            const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
            heartPts.push([center[0] + (x / 18) * radius, center[1] + (y / 18) * radius]);
          }
          heartPts.push([heartPts[0][0], heartPts[0][1]]);
          currentRawPointsRef.current = heartPts;
        }
      }
      redrawCanvas();
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = drawCanvasRef.current;
    if (canvas && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    isPointerDownRef.current = false;
    setIsNearStart(false);

    if (dragModeRef.current === 'move-shape' || dragModeRef.current === 'scale-handle' || dragModeRef.current === 'rotate-handle' || dragModeRef.current === 'move-node') {
      recordHistory([...strokes]);
      dragModeRef.current = 'none';
      return;
    }

    if (dragModeRef.current === 'draw') {
      let finalPoints = [...currentRawPointsRef.current];
      if (finalPoints.length < 2) {
        currentRawPointsRef.current = [];
        dragModeRef.current = 'none';
        redrawCanvas();
        return;
      }

      let closed = false;
      if (activeTool === 'circle' || activeTool === 'rect' || activeTool === 'star' || activeTool === 'heart') {
        closed = true;
      } else if (activeTool === 'pen') {
        if (autoCloseLoop && isLoopClosed(finalPoints, 7)) {
          finalPoints = closeLoop(finalPoints);
          closed = true;
        }
      }

      if (activeTool === 'pen') {
        const eps = smoothingLevel === 'high' ? 0.9 : smoothingLevel === 'medium' ? 0.5 : 0.2;
        let clean = simplifyPointsRDP(finalPoints, eps);
        if (smoothingLevel === 'medium') {
          clean = chaikinSmooth(clean, 2, closed);
        } else if (smoothingLevel === 'high') {
          clean = catmullRomSpline(clean, 3, closed);
        }
        finalPoints = clean;
      }

      const newId = `stroke_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const newStroke: StrokeItem = {
        id: newId,
        points: finalPoints,
        isClosed: closed,
        isOuter: false,
      };

      const newStrokes = [...strokes, newStroke];

      if (mirrorMode) {
        const mirroredPts: Point2D[] = finalPoints.map(([x, y]) => [
          Math.max(0, Math.min(100, 100 - x)),
          y,
        ]);
        newStrokes.push({
          id: `stroke_mirror_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          points: mirroredPts,
          isClosed: closed,
          isOuter: false,
        });
      }

      const classified = reclassifyStrokes(newStrokes);
      recordHistory(classified);
      setSelectedStrokeId(newId);
      currentRawPointsRef.current = [];
      dragModeRef.current = 'none';
      redrawCanvas();
    }
  };

  // Vector Transformation Operations (Illustrator / Inkscape feature set)
  const handleFlipHorizontal = () => {
    if (!selectedStrokeId) return;
    const updated = strokes.map((s) => {
      if (s.id === selectedStrokeId) {
        return { ...s, points: flipPath(s.points, true, false) };
      }
      return s;
    });
    recordHistory(updated);
  };

  const handleFlipVertical = () => {
    if (!selectedStrokeId) return;
    const updated = strokes.map((s) => {
      if (s.id === selectedStrokeId) {
        return { ...s, points: flipPath(s.points, false, true) };
      }
      return s;
    });
    recordHistory(updated);
  };

  const handleRotate90 = () => {
    if (!selectedStrokeId) return;
    const updated = strokes.map((s) => {
      if (s.id === selectedStrokeId) {
        return { ...s, points: rotatePath(s.points, 90) };
      }
      return s;
    });
    recordHistory(updated);
  };

  const handleCenterInCanvas = () => {
    if (!selectedStrokeId) return;
    const updated = strokes.map((s) => {
      if (s.id === selectedStrokeId) {
        return { ...s, points: centerPathInCanvas(s.points) };
      }
      return s;
    });
    recordHistory(updated);
  };

  const handleDuplicateSelected = () => {
    if (!selectedStrokeId) return;
    const original = strokes.find((s) => s.id === selectedStrokeId);
    if (!original) return;
    const newId = `stroke_${Date.now()}_dup`;
    const offsetPts = translatePath(original.points, 4, 4);
    const dup: StrokeItem = {
      ...original,
      id: newId,
      points: offsetPts,
      isOuter: false,
    };
    recordHistory([...strokes, dup]);
    setSelectedStrokeId(newId);
  };

  const handleDeleteSelectedStroke = () => {
    if (!selectedStrokeId) return;
    const updated = strokes.filter((s) => s.id !== selectedStrokeId);
    recordHistory(reclassifyStrokes(updated));
    setSelectedStrokeId(null);
  };

  const handleDeleteSelectedNode = () => {
    if (!selectedStrokeId || selectedNodeIndex === null) return;
    const active = strokes.find((s) => s.id === selectedStrokeId);
    if (!active || active.points.length <= 2) return;

    const nextPoints = active.points.filter((_, idx) => idx !== selectedNodeIndex);
    const updated = strokes.map((s) => (s.id === selectedStrokeId ? { ...s, points: nextPoints } : s));
    recordHistory(updated);
    setSelectedNodeIndex(null);
  };

  // Node Smoothing / Conversion (Node Tool)
  const handleSmoothSelectedStroke = () => {
    if (!selectedStrokeId) return;
    const updated = strokes.map((s) => {
      if (s.id === selectedStrokeId) {
        return { ...s, points: catmullRomSpline(s.points, 3, s.isClosed) };
      }
      return s;
    });
    recordHistory(updated);
  };

  // Offset Path (Outset / Inset - Illustrator Object > Path > Offset Path)
  const handleOffsetPath = (delta: number) => {
    if (!selectedStrokeId) return;
    const target = strokes.find((s) => s.id === selectedStrokeId);
    if (!target) return;

    const offsetPoints = offsetPathVector(target.points, delta);
    const newStroke: StrokeItem = {
      id: `stroke_offset_${Date.now()}`,
      points: offsetPoints,
      isClosed: target.isClosed,
      isOuter: false,
    };
    recordHistory([...strokes, newStroke]);
    setSelectedStrokeId(newStroke.id);
  };

  // SVG Export
  const handleExportSVG = () => {
    if (strokes.length === 0) return;
    const svgCode = exportPathsToSVG(strokes, modelName || 'cortador_vetorial');
    downloadSVGFile(svgCode, `${modelName.replace(/\s+/g, '_').toLowerCase() || 'cortador'}.svg`);
  };

  // SVG Import from string / file
  const handleImportSVGCode = (svgCode: string) => {
    try {
      const parsedPaths = parseSvgStringToPaths(svgCode);
      if (parsedPaths.length === 0) {
        alert('Nenhum caminho vetorial válido encontrado no SVG.');
        return;
      }

      const importedStrokes: StrokeItem[] = parsedPaths.map((pts, idx) => ({
        id: `svg_path_${Date.now()}_${idx}`,
        points: pts,
        isClosed: distance(pts[0], pts[pts.length - 1]) <= 2,
        isOuter: idx === 0,
      }));

      recordHistory(reclassifyStrokes([...strokes, ...importedStrokes]));
      setSvgModalOpen(false);
      setSvgTextInput('');
    } catch (err) {
      console.error('Erro ao importar SVG:', err);
      alert('Falha ao processar arquivo SVG.');
    }
  };

  const handleSVGFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) handleImportSVGCode(content);
    };
    reader.readAsText(file);
  };

  // Image Upload Tracing
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => setUploadedImageSrc(event.target?.result as string);
    reader.readAsDataURL(file);
  };

  const handleProcessUploadedImage = async () => {
    if (!uploadedImageSrc) return;
    setIsProcessing(true);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = uploadedImageSrc;
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
      });

      const { outerPerimeter, innerDetails } = await traceImageToLineart(img, threshold, invert, 0.55);

      const customModel: ModelLineart = {
        id: `custom_upload_${Date.now()}`,
        name: modelName || 'Desenho Personalizado',
        category: 'frames',
        categoryLabel: 'Desenho Próprio',
        description: 'Modelo gerado a partir de imagem lineart vetorizada.',
        iconName: 'Image',
        outerPerimeter,
        innerDetails,
      };

      onApplyCustomModel(customModel);
      onClose();
    } catch (err) {
      console.error('Failed to vectorize image:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  // Convert drawn lines to 3D Model
  const handleProcessDrawnLines = () => {
    if (strokes.length === 0) return;

    let outerStroke = strokes.find((s) => s.isOuter) || strokes[0];
    let outerPerimeter = outerStroke.points;
    if (!outerStroke.isClosed && outerPerimeter.length >= 3) {
      outerPerimeter = closeLoop(outerPerimeter);
    }

    const innerDetails: Path2D[] = strokes
      .filter((s) => s.id !== outerStroke?.id)
      .map((s) => s.points);

    const customModel: ModelLineart = {
      id: `custom_draw_${Date.now()}`,
      name: modelName || 'Meu Cortador Vetorial',
      category: 'frames',
      categoryLabel: 'Desenho Próprio',
      description: 'Cortador e carimbo gerados no estúdio vetorial profissional.',
      iconName: 'PenTool',
      outerPerimeter,
      innerDetails,
    };

    onApplyCustomModel(customModel);
    onClose();
  };

  if (!isOpen) return null;

  const activeStroke = strokes.find((s) => s.id === selectedStrokeId);
  const outerStroke = strokes.find((s) => s.isOuter);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 lg:p-5 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-6xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col max-h-[95vh] overflow-hidden">
        {/* Header */}
        <div className="p-3.5 px-6 border-b border-slate-800 flex items-center justify-between bg-slate-950/80">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-slate-100 flex items-center gap-2">
                <span>Estúdio Vetorial (Estilo Illustrator & Inkscape)</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 uppercase">
                  Nós & Curvas
                </span>
              </h2>
              <p className="text-[11px] text-slate-400">
                Edição direta de nós e curvas, transformações geométricas, deslocamento de contorno (offset) e importação/exportação SVG.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-100 rounded-xl hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab switch */}
        <div className="flex border-b border-slate-800 bg-slate-950/40 p-2 gap-2 px-6">
          <button
            onClick={() => setTab('draw')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
              tab === 'draw'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Pen className="w-4 h-4" />
            <span>Editor Vetorial & Desenho</span>
          </button>
          <button
            onClick={() => setTab('upload')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
              tab === 'upload'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Upload className="w-4 h-4" />
            <span>Vetorizar Imagem (PNG/JPG)</span>
          </button>
        </div>

        {/* Workspace */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-5 space-y-3">
          {/* Top Info / Name / SVG Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-950/60 p-2.5 px-4 rounded-xl border border-slate-800/80">
            <div className="flex items-center gap-2 flex-1 min-w-[240px]">
              <span className="text-xs font-medium text-slate-400 whitespace-nowrap">Nome:</span>
              <input
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                className="flex-1 px-3 py-1 text-xs bg-slate-900 border border-slate-700/80 rounded-lg text-slate-200 focus:outline-none focus:border-amber-500"
                placeholder="Ex: Cortador Flor Geométrica"
              />
            </div>

            {/* SVG Import & Export Buttons */}
            <div className="flex items-center gap-2">
              <input
                ref={svgFileInputRef}
                type="file"
                accept=".svg,image/svg+xml"
                onChange={handleSVGFileUpload}
                className="hidden"
              />
              <button
                onClick={() => svgFileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-lg border border-slate-700 transition-colors cursor-pointer"
                title="Abrir arquivo vetorial .SVG do Illustrator, Inkscape ou Corel"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Importar SVG</span>
              </button>

              <button
                onClick={() => setSvgModalOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 transition-colors cursor-pointer"
                title="Colar código SVG XML diretamente"
              >
                <FileCode className="w-3.5 h-3.5" />
                <span>Colar SVG</span>
              </button>

              <button
                onClick={handleExportSVG}
                disabled={strokes.length === 0}
                className="flex items-center gap-1.5 px-3 py-1 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-amber-400 rounded-lg border border-slate-700 transition-colors cursor-pointer"
                title="Baixar arquivo .SVG compatível com Illustrator e Inkscape"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                <span>Exportar SVG</span>
              </button>
            </div>
          </div>

          {tab === 'draw' ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              {/* Left Column: Canvas & Primary Vector Toolbar (8 cols) */}
              <div className="lg:col-span-8 flex flex-col gap-2.5">
                {/* Illustrator/Inkscape Main Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2 p-2 bg-slate-950/80 rounded-xl border border-slate-800 text-xs">
                  {/* Vector Tools Group */}
                  <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                    {/* Selection Tool (V) */}
                    <button
                      onClick={() => setActiveTool('select')}
                      className={`p-1.5 px-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'select'
                          ? 'bg-blue-600 text-white font-bold shadow'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Seleção & Transformação (V) - Mover, redimensionar e girar objeto"
                    >
                      <MousePointer className="w-3.5 h-3.5" />
                      <span className="text-[11px]">Seleção (V)</span>
                    </button>

                    {/* Direct Selection / Node Tool (A / N) */}
                    <button
                      onClick={() => setActiveTool('node')}
                      className={`p-1.5 px-2.5 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'node'
                          ? 'bg-cyan-600 text-white font-bold shadow'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Editar Nós / Vértices (A / N) - Ajuste pontos individuais com precisão"
                    >
                      <Waypoints className="w-3.5 h-3.5" />
                      <span className="text-[11px]">Nós (A)</span>
                    </button>

                    <div className="w-[1px] h-5 bg-slate-800 mx-1" />

                    {/* Pen Tool (P) */}
                    <button
                      onClick={() => setActiveTool('pen')}
                      className={`p-1.5 px-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'pen'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Caneta Bézier / Traçado Livre (P)"
                    >
                      <Pen className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline text-[11px]">Caneta</span>
                    </button>

                    {/* Line / Polyline */}
                    <button
                      onClick={() => setActiveTool('line')}
                      className={`p-1.5 px-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'line'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Linha Reta / Segmentos"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>

                    {/* Circle */}
                    <button
                      onClick={() => setActiveTool('circle')}
                      className={`p-1.5 px-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'circle'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Círculo ou Elipse Perfeita"
                    >
                      <Circle className="w-3.5 h-3.5" />
                    </button>

                    {/* Rect */}
                    <button
                      onClick={() => setActiveTool('rect')}
                      className={`p-1.5 px-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'rect'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Retângulo / Moldura"
                    >
                      <Square className="w-3.5 h-3.5" />
                    </button>

                    {/* Star */}
                    <button
                      onClick={() => setActiveTool('star')}
                      className={`p-1.5 px-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'star'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Estrela Geométrica"
                    >
                      <Star className="w-3.5 h-3.5" />
                    </button>

                    {/* Heart */}
                    <button
                      onClick={() => setActiveTool('heart')}
                      className={`p-1.5 px-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'heart'
                          ? 'bg-amber-500 text-slate-950 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title="Coração Orgânico"
                    >
                      <Heart className="w-3.5 h-3.5" />
                    </button>

                    {/* Eraser */}
                    <button
                      onClick={() => setActiveTool('eraser')}
                      className={`p-1.5 px-2 rounded flex items-center gap-1.5 transition-colors cursor-pointer ${
                        activeTool === 'eraser'
                          ? 'bg-rose-500 text-white font-bold'
                          : 'text-slate-400 hover:text-rose-400'
                      }`}
                      title="Borracha de Vetores"
                    >
                      <Eraser className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Undo / Redo & Clear */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={handleUndo}
                      disabled={undoStack.length === 0}
                      className="p-1.5 px-2 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30 transition-colors"
                      title="Desfazer (Ctrl+Z)"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={handleRedo}
                      disabled={redoStack.length === 0}
                      className="p-1.5 px-2 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 disabled:opacity-30 transition-colors"
                      title="Refazer (Ctrl+Y)"
                    >
                      <Redo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        recordHistory([]);
                        setSelectedStrokeId(null);
                        setSelectedNodeIndex(null);
                      }}
                      className="p-1.5 px-2 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 transition-colors"
                      title="Limpar tudo"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Precision Canvas Area */}
                <div className="relative aspect-square w-full max-h-[460px] bg-slate-950 rounded-2xl border-2 border-slate-800 shadow-inner flex items-center justify-center overflow-hidden touch-none select-none">
                  <canvas
                    ref={drawCanvasRef}
                    width={800}
                    height={800}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    className="cursor-crosshair w-full h-full block touch-none"
                    style={{ touchAction: 'none' }}
                  />

                  {/* HUD Info Tag */}
                  <div className="absolute top-3 left-3 bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-lg border border-slate-700/80 text-[11px] font-mono text-slate-300 flex items-center gap-3 pointer-events-none">
                    <span className="flex items-center gap-1 text-amber-400">
                      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                      {cursorPos ? `X: ${cursorPos[0].toFixed(1)}% | Y: ${cursorPos[1].toFixed(1)}%` : '0, 0'}
                    </span>
                    <span className="text-slate-500">|</span>
                    <span className="text-cyan-400">
                      Modo: {activeTool === 'select' ? 'Seleção (V)' : activeTool === 'node' ? 'Nós (A)' : 'Traçado'}
                    </span>
                    {activeStroke && (
                      <>
                        <span className="text-slate-500">|</span>
                        <span className="text-slate-300">{activeStroke.points.length} nós</span>
                      </>
                    )}
                  </div>

                  {/* Magnetic snap helper */}
                  {isNearStart && (
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-slate-950 font-bold text-xs px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 animate-bounce pointer-events-none">
                      <Magnet className="w-4 h-4" />
                      <span>Solte para Fechar o Contorno!</span>
                    </div>
                  )}

                  {/* Instructions on empty */}
                  {strokes.length === 0 && !isPointerDownRef.current && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none p-6 text-center">
                      <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-3">
                        <Waypoints className="w-6 h-6" />
                      </div>
                      <p className="text-sm font-semibold text-slate-200">
                        Prancheta Vetorial Estilo Illustrator / Inkscape
                      </p>
                      <p className="text-xs text-slate-400 max-w-sm mt-1">
                        Use a Caneta para desenhar formas ou importar SVGs. Alterne para a ferramenta de <strong>Nós (A)</strong> para editar pontos ou <strong>Seleção (V)</strong> para transformar objetos.
                      </p>
                    </div>
                  )}
                </div>

                {/* Sub-toolbar: Grid, Snap, Guides, Mirror */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <button
                    onClick={() => setShowGrid(!showGrid)}
                    className={`p-2 rounded-xl border flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                      showGrid ? 'bg-slate-800 text-amber-400 border-amber-500/40' : 'bg-slate-950/60 text-slate-400 border-slate-800'
                    }`}
                  >
                    <Grid className="w-3.5 h-3.5" />
                    <span>Grade Milimétrica</span>
                  </button>

                  <button
                    onClick={() => setEnableSnapGrid(!enableSnapGrid)}
                    className={`p-2 rounded-xl border flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                      enableSnapGrid ? 'bg-slate-800 text-amber-400 border-amber-500/40' : 'bg-slate-950/60 text-slate-400 border-slate-800'
                    }`}
                  >
                    <Magnet className="w-3.5 h-3.5" />
                    <span>Atrair à Grade</span>
                  </button>

                  <button
                    onClick={() => setShowCenterGuides(!showCenterGuides)}
                    className={`p-2 rounded-xl border flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                      showCenterGuides ? 'bg-slate-800 text-amber-400 border-amber-500/40' : 'bg-slate-950/60 text-slate-400 border-slate-800'
                    }`}
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                    <span>Eixos Centrais</span>
                  </button>

                  <button
                    onClick={() => setMirrorMode(!mirrorMode)}
                    className={`p-2 rounded-xl border flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                      mirrorMode ? 'bg-cyan-950/60 text-cyan-400 border-cyan-500/60' : 'bg-slate-950/60 text-slate-400 border-slate-800'
                    }`}
                  >
                    <SplitSquareVertical className="w-3.5 h-3.5" />
                    <span>Modo Espelho</span>
                  </button>
                </div>
              </div>

              {/* Right Column: Illustrator Inspector / Node Tools / Layers (4 cols) */}
              <div className="lg:col-span-4 flex flex-col gap-3">
                {/* Contextual Transform Box (When Shape is Selected) */}
                {activeStroke ? (
                  <div className="p-3.5 bg-slate-950/80 rounded-2xl border border-blue-500/40 shadow-lg flex flex-col gap-2.5 animate-in fade-in">
                    <div className="flex items-center justify-between text-xs font-semibold text-blue-400">
                      <span className="flex items-center gap-1.5">
                        <MousePointer className="w-4 h-4" />
                        <span>Transformar Objeto Selecionado</span>
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {activeStroke.points.length} nós
                      </span>
                    </div>

                    {/* Transform Buttons Grid */}
                    <div className="grid grid-cols-4 gap-1.5">
                      <button
                        onClick={handleFlipHorizontal}
                        className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg flex flex-col items-center justify-center gap-1 text-[10px] text-slate-300 transition-colors"
                        title="Inverter Horizontalmente"
                      >
                        <FlipHorizontal className="w-3.5 h-3.5 text-blue-400" />
                        <span>Espelhar H</span>
                      </button>

                      <button
                        onClick={handleFlipVertical}
                        className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg flex flex-col items-center justify-center gap-1 text-[10px] text-slate-300 transition-colors"
                        title="Inverter Verticalmente"
                      >
                        <FlipVertical className="w-3.5 h-3.5 text-blue-400" />
                        <span>Espelhar V</span>
                      </button>

                      <button
                        onClick={handleRotate90}
                        className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg flex flex-col items-center justify-center gap-1 text-[10px] text-slate-300 transition-colors"
                        title="Girar 90 graus"
                      >
                        <RotateCw className="w-3.5 h-3.5 text-blue-400" />
                        <span>Girar 90°</span>
                      </button>

                      <button
                        onClick={handleCenterInCanvas}
                        className="p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg flex flex-col items-center justify-center gap-1 text-[10px] text-slate-300 transition-colors"
                        title="Centralizar no centro do quadro"
                      >
                        <Maximize2 className="w-3.5 h-3.5 text-blue-400" />
                        <span>Centralizar</span>
                      </button>
                    </div>

                    {/* Offset Path (Inkscape / Illustrator Inset/Outset) */}
                    <div className="pt-2 border-t border-slate-800">
                      <span className="text-[11px] text-slate-400 block mb-1">
                        Deslocamento de Contorno (Offset Path):
                      </span>
                      <div className="grid grid-cols-4 gap-1.5">
                        <button
                          onClick={() => handleOffsetPath(2)}
                          className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded text-[10px] text-amber-300 transition-colors"
                          title="Expandir contorno para fora (+2%)"
                        >
                          +2% Outset
                        </button>
                        <button
                          onClick={() => handleOffsetPath(4)}
                          className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded text-[10px] text-amber-300 transition-colors"
                          title="Expandir contorno para fora (+4%)"
                        >
                          +4% Outset
                        </button>
                        <button
                          onClick={() => handleOffsetPath(-2)}
                          className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded text-[10px] text-cyan-300 transition-colors"
                          title="Contrair contorno para dentro (-2%)"
                        >
                          -2% Inset
                        </button>
                        <button
                          onClick={() => handleOffsetPath(-4)}
                          className="px-2 py-1 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded text-[10px] text-cyan-300 transition-colors"
                          title="Contrair contorno para dentro (-4%)"
                        >
                          -4% Inset
                        </button>
                      </div>
                    </div>

                    {/* Path Smoothing & Duplication */}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={handleSmoothSelectedStroke}
                        className="flex-1 py-1 px-2 bg-slate-900 hover:bg-cyan-950/60 border border-cyan-500/40 rounded text-[10px] text-cyan-300 transition-colors flex items-center justify-center gap-1"
                        title="Suavizar curvas com curvas spline Bézier"
                      >
                        <Sparkles className="w-3 h-3" />
                        <span>Suavizar Curvas</span>
                      </button>

                      <button
                        onClick={handleDuplicateSelected}
                        className="py-1 px-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded text-[10px] text-slate-300 transition-colors flex items-center gap-1"
                        title="Duplicar Objeto"
                      >
                        <Copy className="w-3 h-3" />
                        <span>Duplicar</span>
                      </button>

                      <button
                        onClick={handleDeleteSelectedStroke}
                        className="p-1 px-2 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/40 rounded text-rose-300 transition-colors"
                        title="Excluir este objeto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Node editing guidance */
                  <div className="p-3 bg-slate-950/70 rounded-2xl border border-slate-800 text-xs text-slate-400 flex items-start gap-2.5">
                    <Waypoints className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                    <span>
                      Clique em qualquer objeto com a <strong>Ferramenta Seleção (V)</strong> para mover, girar e redimensionar, ou com a <strong>Ferramenta Nós (A)</strong> para manipular vértices individuais.
                    </span>
                  </div>
                )}

                {/* Precision & Smoothing Engine */}
                <div className="p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800 flex flex-col gap-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <Sliders className="w-4 h-4 text-amber-400" />
                    <span>Precisão & Suavizador de Caneta</span>
                  </div>

                  <div>
                    <label className="text-[11px] text-slate-400 flex items-center justify-between mb-1">
                      <span>Suavizador Anti-Trepidação:</span>
                      <span className="font-mono text-amber-400 uppercase text-[10px]">
                        {smoothingLevel === 'none' ? 'Bruto' : smoothingLevel === 'medium' ? 'Equilibrado' : 'Ultra'}
                      </span>
                    </label>
                    <div className="grid grid-cols-3 gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800 text-[11px]">
                      <button
                        onClick={() => setSmoothingLevel('none')}
                        className={`py-1 rounded-lg font-medium transition-colors ${
                          smoothingLevel === 'none' ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Bruto
                      </button>
                      <button
                        onClick={() => setSmoothingLevel('medium')}
                        className={`py-1 rounded-lg font-medium transition-colors ${
                          smoothingLevel === 'medium' ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Suave
                      </button>
                      <button
                        onClick={() => setSmoothingLevel('high')}
                        className={`py-1 rounded-lg font-medium transition-colors ${
                          smoothingLevel === 'high' ? 'bg-amber-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Ultra
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                      <span>Espessura Visual:</span>
                      <span className="font-mono text-amber-400">{brushSize}px</span>
                    </div>
                    <input
                      type="range"
                      min="2"
                      max="12"
                      value={brushSize}
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>
                </div>

                {/* Layer Hierarchy / Contours List */}
                <div className="p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                    <span className="flex items-center gap-1.5">
                      <Layers className="w-4 h-4 text-cyan-400" />
                      <span>Camadas de Objetos ({strokes.length})</span>
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {outerStroke ? '1 Lâmina Cortador' : '0 Cortador'}
                    </span>
                  </div>

                  <div className="max-h-[180px] overflow-y-auto space-y-1.5 pr-1">
                    {strokes.length === 0 ? (
                      <div className="p-3 text-center text-[11px] text-slate-500 border border-dashed border-slate-800 rounded-xl">
                        Nenhum objeto na prancheta.
                      </div>
                    ) : (
                      strokes.map((st, idx) => {
                        const isSelected = st.id === selectedStrokeId;
                        return (
                          <div
                            key={st.id}
                            onClick={() => {
                              setSelectedStrokeId(st.id);
                              setSelectedNodeIndex(null);
                            }}
                            className={`p-2 rounded-xl border text-xs flex items-center justify-between gap-2 cursor-pointer transition-all ${
                              isSelected
                                ? 'bg-blue-950/40 border-blue-500 text-blue-200'
                                : st.isOuter
                                ? 'bg-amber-950/20 border-amber-500/40 text-amber-200'
                                : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-center gap-2 overflow-hidden">
                              <span
                                className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: st.isOuter ? '#f59e0b' : '#38bdf8' }}
                              />
                              <div className="truncate">
                                <p className="text-[11px] font-medium leading-tight truncate">
                                  {st.isOuter ? 'Lâmina de Corte (Contorno)' : `Carimbo #${idx + 1}`}
                                </p>
                                <p className="text-[9px] text-slate-400">
                                  {st.points.length} nós • {st.isClosed ? 'Fechado ✓' : 'Aberto'}
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              {!st.isOuter && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const updated = strokes.map((s) => ({ ...s, isOuter: s.id === st.id }));
                                    recordHistory(updated);
                                  }}
                                  className="px-1.5 py-0.5 text-[9px] bg-slate-800 hover:bg-amber-500 hover:text-slate-950 rounded text-slate-300 transition-colors"
                                  title="Tornar este contorno a Lâmina do Cortador"
                                >
                                  Lâmina
                                </button>
                              )}

                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const updated = strokes.filter((s) => s.id !== st.id);
                                  recordHistory(reclassifyStrokes(updated));
                                  if (selectedStrokeId === st.id) setSelectedStrokeId(null);
                                }}
                                className="p-1 rounded text-slate-500 hover:text-rose-400 transition-colors"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Upload Image Tab */
            <div className="flex flex-col gap-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                onChange={handleFileChange}
                className="hidden"
              />

              {!uploadedImageSrc ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-slate-700 hover:border-amber-500/80 rounded-2xl p-12 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-slate-950/40"
                >
                  <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-3">
                    <Upload className="w-7 h-7" />
                  </div>
                  <p className="text-sm font-semibold text-slate-200">
                    Clique aqui ou arraste uma imagem lineart
                  </p>
                  <p className="text-xs text-slate-400 mt-1 max-w-md">
                    PNG, JPG ou SVG com traços pretos nítidos sobre fundo branco ou transparente
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="relative aspect-video max-h-[280px] bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-center overflow-hidden p-3">
                    <img
                      src={uploadedImageSrc}
                      alt="Prévia lineart"
                      className="max-h-full max-w-full object-contain filter"
                      style={{
                        filter: `contrast(150%) ${invert ? 'invert(1)' : ''}`,
                      }}
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute top-3 right-3 text-xs bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-lg text-slate-200 hover:text-white border border-slate-700 shadow"
                    >
                      Trocar Imagem
                    </button>
                  </div>

                  <div className="p-4 bg-slate-950/70 rounded-xl border border-slate-800 flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-300 flex items-center gap-1.5">
                        <Sliders className="w-4 h-4 text-amber-400" />
                        <span>Sensibilidade do Traço (Limiar P&B)</span>
                      </span>
                      <span className="text-xs font-mono text-amber-400">{threshold}</span>
                    </div>
                    <input
                      type="range"
                      min="30"
                      max="225"
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />

                    <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                      <span className="text-xs text-slate-300">Inverter cores (se fundo for escuro)</span>
                      <button
                        onClick={() => setInvert(!invert)}
                        className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                          invert ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {invert ? 'Invertido' : 'Normal'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 px-6 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            Cancelar
          </button>

          {tab === 'upload' ? (
            <button
              disabled={!uploadedImageSrc || isProcessing}
              onClick={handleProcessUploadedImage}
              className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>{isProcessing ? 'Vetorizando...' : 'Gerar Cortador e Carimbo 3D'}</span>
            </button>
          ) : (
            <button
              disabled={strokes.length === 0}
              onClick={handleProcessDrawnLines}
              className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-xl shadow-lg shadow-amber-500/20 transition-all cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>Transformar em Modelo 3D ({strokes.length} objetos)</span>
            </button>
          )}
        </div>
      </div>

      {/* SVG Paste Modal */}
      {svgModalOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-5 shadow-2xl flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <FileCode className="w-4 h-4 text-cyan-400" />
                <span>Colar Código SVG (Illustrator / Inkscape)</span>
              </h3>
              <button
                onClick={() => setSvgModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Copie o código SVG do Illustrator ou Inkscape (ou abra o arquivo .svg em um editor de texto) e cole abaixo:
            </p>
            <textarea
              rows={8}
              value={svgTextInput}
              onChange={(e) => setSvgTextInput(e.target.value)}
              placeholder="<svg ...><path d='M10,20 L50,80 ...' /></svg>"
              className="w-full p-3 text-xs font-mono bg-slate-950 border border-slate-700 rounded-xl text-slate-200 focus:outline-none focus:border-cyan-500"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setSvgModalOpen(false)}
                className="px-4 py-2 text-xs text-slate-400 hover:text-white"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleImportSVGCode(svgTextInput)}
                disabled={!svgTextInput.trim()}
                className="px-5 py-2 text-xs font-bold bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-slate-950 rounded-xl"
              >
                Importar Vetor
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
