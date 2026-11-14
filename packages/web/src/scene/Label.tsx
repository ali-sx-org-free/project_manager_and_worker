import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { CANVAS_FONT } from '../theme.ts';

export interface LabelLine {
  text: string;
  /** 字高（CSS px），預設 15 */
  size?: number;
  color?: string;
  weight?: number;
}

interface Props {
  lines: LabelLine[];
  position?: [number, number, number];
  /** 第一行前面的色點 */
  dot?: string;
  border?: string;
  bg?: string;
  scale?: number;
  opacity?: number;
}

const RATIO = 2; // 畫布按 2x 繪製，放大也不糊
const PX_PER_UNIT = 48; // 多少 CSS px 對應 1 個世界單位

/** 用 canvas 畫文字再貼成 sprite。這樣不需要下載字型檔，中文直接用系統字型。 */
function draw(lines: LabelLine[], dot?: string, border?: string, bg = 'rgba(9,14,26,0.82)') {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = (l: LabelLine) => `${l.weight ?? 500} ${(l.size ?? 15) * RATIO}px ${CANVAS_FONT}`;
  const padX = 11 * RATIO;
  const padY = 7 * RATIO;
  const gap = 4 * RATIO;
  const dotW = dot ? 16 * RATIO : 0;

  const widths = lines.map((l, i) => {
    ctx.font = font(l);
    return ctx.measureText(l.text).width + (i === 0 ? dotW : 0);
  });
  const heights = lines.map((l) => (l.size ?? 15) * RATIO * 1.25);
  canvas.width = Math.ceil(Math.max(...widths) + padX * 2);
  canvas.height = Math.ceil(heights.reduce((a, b) => a + b, 0) + gap * (lines.length - 1) + padY * 2);

  ctx.beginPath();
  ctx.roundRect(1, 1, canvas.width - 2, canvas.height - 2, 9 * RATIO);
  ctx.fillStyle = bg;
  ctx.fill();
  if (border) {
    ctx.lineWidth = 1.5 * RATIO;
    ctx.strokeStyle = border;
    ctx.stroke();
  }

  let y = padY;
  lines.forEach((l, i) => {
    ctx.font = font(l);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = l.color ?? '#e8eefb';
    const cy = y + heights[i] / 2;
    let x = (canvas.width - widths[i]) / 2;
    if (i === 0 && dot) {
      ctx.save();
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(x + 5 * RATIO, cy, 4.5 * RATIO, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      x += dotW;
    }
    ctx.fillText(l.text, x, cy + RATIO);
    y += heights[i] + gap;
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return {
    texture,
    w: canvas.width / RATIO / PX_PER_UNIT,
    h: canvas.height / RATIO / PX_PER_UNIT,
  };
}

export function Label({ lines, position, dot, border, bg, scale = 1, opacity = 1 }: Props) {
  const key = JSON.stringify([lines, dot, border, bg]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { texture, w, h } = useMemo(() => draw(lines, dot, border, bg), [key]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[w * scale, h * scale, 1]} renderOrder={5}>
      <spriteMaterial map={texture} transparent opacity={opacity} depthWrite={false} toneMapped={false} />
    </sprite>
  );
}
