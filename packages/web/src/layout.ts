import dagre from '@dagrejs/dagre';
import type { Project, Task } from '@agent-pm/core';

export type Vec3 = [number, number, number];

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Lane {
  project: Project;
  bounds: Bounds;
}

export interface Layout {
  pos: Record<string, Vec3>;
  lanes: Lane[];
  bounds: Bounds;
}

const NODE_W = 2.6; // 沿依賴方向（世界 x）
const NODE_H = 1.5; // 同一層內（世界 z）
const LANE_PAD = 1.3;
const LANE_GAP = 1.9;
/** dagre 內部按像素取整，直接用小數的世界單位會算歪，所以放大 100 倍計算再縮回來 */
const K = 100;

/** 每個項目用 dagre 算一張從左到右的分層圖，鋪在地面（xz 平面）上；項目之間沿 z 軸排成泳道。 */
export function computeLayout(projects: Project[], tasks: Task[]): Layout {
  const pos: Record<string, Vec3> = {};
  const lanes: Lane[] = [];
  let z = 0;

  // 第一個項目放在最靠近鏡頭的泳道，所以倒著往後排
  for (const project of [...projects].reverse()) {
    const mine = tasks.filter((t) => t.project_id === project.id);
    if (!mine.length) continue;
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', ranksep: 2.0 * K, nodesep: 1.1 * K, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const t of mine) g.setNode(t.id, { width: NODE_W * K, height: NODE_H * K });
    for (const t of mine) for (const d of t.deps) g.setEdge(d, t.id);
    dagre.layout(g);

    const width = (g.graph().width ?? 0) / K;
    const height = (g.graph().height ?? 0) / K;
    z += LANE_PAD;
    for (const t of mine) {
      const n = g.node(t.id);
      pos[t.id] = [n.x / K, 0, z + n.y / K];
    }
    lanes.push({
      project,
      bounds: { minX: -LANE_PAD, maxX: width + LANE_PAD, minZ: z - LANE_PAD, maxZ: z + height + LANE_PAD },
    });
    z += height + LANE_PAD + LANE_GAP;
  }

  // 整體置中到原點
  const maxX = Math.max(1, ...lanes.map((l) => l.bounds.maxX));
  const totalZ = Math.max(1, z - LANE_GAP);
  const dx = -(maxX - LANE_PAD) / 2;
  const dz = -totalZ / 2;
  for (const id of Object.keys(pos)) pos[id] = [pos[id][0] + dx, 0, pos[id][2] + dz];
  for (const l of lanes) {
    l.bounds = {
      minX: l.bounds.minX + dx,
      maxX: maxX + dx, // 泳道右緣對齊，看起來是一塊整齊的檯面
      minZ: l.bounds.minZ + dz,
      maxZ: l.bounds.maxZ + dz,
    };
  }
  const bounds: Bounds = lanes.length
    ? {
        minX: Math.min(...lanes.map((l) => l.bounds.minX)),
        maxX: Math.max(...lanes.map((l) => l.bounds.maxX)),
        minZ: Math.min(...lanes.map((l) => l.bounds.minZ)),
        maxZ: Math.max(...lanes.map((l) => l.bounds.maxZ)),
      }
    : { minX: -6, maxX: 6, minZ: -4, maxZ: 4 };
  return { pos, lanes, bounds };
}

/** PM 懸在場景後上方，worker 閒置時停靠在場景前緣 */
export const pmPosition = (b: Bounds): Vec3 => [(b.minX + b.maxX) / 2, 3.6, b.minZ - 1.8];
export const dockZ = (b: Bounds) => b.maxZ + 1.6;
