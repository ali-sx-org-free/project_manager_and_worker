import { Line, OrbitControls, Stars } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { PRIORITY_LABEL } from '@agent-pm/core';
import { computeLayout, dockZ, pmPosition, type Bounds, type Lane, type Vec3 } from '../layout.ts';
import { sortedProjects, useStore, useWorld } from '../store.ts';
import { PM_COLOR, WORKER_COLORS } from '../theme.ts';
import { PmAvatar, WorkerAvatar } from './Avatars.tsx';
import { Edges } from './Edges.tsx';
import { Label } from './Label.tsx';
import { TaskNode } from './TaskNode.tsx';

const FOV = 32;

const VIEW_DIR = new THREE.Vector3(0, 0.78, 0.62).normalize();

/** 讓鏡頭剛好框住指定範圍（含後上方的 PM 和前緣停靠的 worker），避開頂欄和底欄。
 *  切換項目或版面變化時平滑飛過去，之後交還給使用者拖拽。 */
function CameraRig({ bounds }: { bounds: Bounds }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; t: number } | null>(null);
  const first = useRef(true);
  const key = `${bounds.minX.toFixed(1)},${bounds.maxX.toFixed(1)},${bounds.minZ.toFixed(1)},${bounds.maxZ.toFixed(1)},${Math.round(size.width / 20)},${Math.round(size.height / 20)}`;

  useEffect(() => {
    const pm = pmPosition(bounds);
    const front = dockZ(bounds) + 0.6;
    const points = [
      new THREE.Vector3(bounds.minX, 0, bounds.minZ),
      new THREE.Vector3(bounds.maxX, 0, bounds.minZ),
      new THREE.Vector3(bounds.minX - 0.6, 0, front),
      new THREE.Vector3(bounds.maxX + 0.6, 0, front),
      new THREE.Vector3(pm[0], pm[1] + 2.2, pm[2]),
    ];
    const target = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0.4, (bounds.minZ + front) / 2);
    // 以 NDC 計的留白：頂欄、底欄、左右
    const narrow = size.width < 760;
    const top = (2 * (narrow ? 104 : 66)) / size.height;
    const bottom = (2 * (narrow ? 70 : 52)) / size.height;
    const side = (2 * 20) / size.width;
    const probe = new THREE.PerspectiveCamera(FOV, size.width / size.height, 0.1, 1000);
    const project = (dist: number) => {
      probe.position.copy(target).addScaledVector(VIEW_DIR, dist);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      return points.map((p) => p.clone().project(probe));
    };
    const fits = (dist: number) =>
      project(dist).every((v) => v.x > -1 + side && v.x < 1 - side && v.y > -1 + bottom && v.y < 1 - top);
    const solve = () => {
      let lo = 4;
      let hi = 400;
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    // PM 在後上方、worker 在前下方，內容在畫面上不對稱：前後挪動注視點，讓上下留白均衡後再求最近距離
    let hi = solve();
    for (let i = 0; i < 6; i++) {
      const ys = project(hi).map((v) => v.y);
      const off = (Math.max(...ys) + Math.min(...ys)) / 2 - (bottom - top) / 2;
      target.z -= off * hi * Math.tan(THREE.MathUtils.degToRad(FOV) / 2) * 1.1;
      hi = solve();
    }
    const pos = target.clone().addScaledVector(VIEW_DIR, hi);
    if (first.current) {
      camera.position.copy(pos);
      camera.lookAt(target);
      if (controls) {
        controls.target.copy(target);
        controls.update();
        first.current = false;
      }
    } else goal.current = { pos, target, t: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, controls]);

  useFrame((_, dt) => {
    const g = goal.current;
    if (!g || !controls) return;
    const k = 1 - Math.exp(-dt * 3.5);
    camera.position.lerp(g.pos, k);
    controls.target.lerp(g.target, k);
    controls.update();
    g.t += dt;
    if (g.t > 1.8) goal.current = null;
  });
  return null;
}

/** 泳道：每個項目一塊半透明檯面，左前角標出項目名。 */
function LanePlate({ lane, dim, running }: { lane: Lane; dim: boolean; running: number }) {
  const { minX, maxX, minZ, maxZ } = lane.bounds;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const tint = lane.project.kind === 'dev' ? '#3b9dff' : '#3ddc97';
  const outline: Vec3[] = [
    [minX, 0.01, minZ],
    [maxX, 0.01, minZ],
    [maxX, 0.01, maxZ],
    [minX, 0.01, maxZ],
    [minX, 0.01, minZ],
  ];
  const delivered = lane.project.status === 'delivered';
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[minX + w / 2, -0.01, minZ + d / 2]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#0e1626" transparent opacity={dim ? 0.35 : 0.8} roughness={0.9} />
      </mesh>
      <Line points={outline} color={delivered ? PM_COLOR : tint} lineWidth={1.2} transparent opacity={dim ? 0.15 : 0.5} />
      <Label
        position={[maxX - 2.6, 0.4, minZ - 0.5]}
        dot={tint}
        border={delivered ? 'rgba(255,217,138,0.6)' : undefined}
        opacity={dim ? 0.4 : 1}
        lines={[
          { text: lane.project.title, size: 16, weight: 700 },
          {
            // 優先級和並行配額：這個項目排第幾、現在佔了幾個 worker、最多能佔幾個
            text: delivered
              ? 'PM 已交付'
              : `${lane.project.key} · 優先 ${PRIORITY_LABEL[lane.project.priority] ?? lane.project.priority} · ${
                  lane.project.max_parallel === 0
                    ? '已暫停'
                    : `並行 ${running}${lane.project.max_parallel === null ? '' : `/${lane.project.max_parallel}`}`
                }`,
            size: 12,
            color: delivered
              ? PM_COLOR
              : lane.project.max_parallel !== null && running >= lane.project.max_parallel
                ? '#f7c948'
                : '#8fa0c4',
          },
        ]}
      />
    </group>
  );
}

function World() {
  const world = useWorld();
  const selected = useStore((s) => s.selected);
  const focus = useStore((s) => s.focus);
  const set = useStore((s) => s.set);

  const projects = sortedProjects(world);
  // 版面只跟圖的結構有關，狀態變化不需要重算
  const structure = Object.values(world.tasks)
    .map((t) => `${t.id}:${t.deps.join(',')}`)
    .join('|');
  const layout = useMemo(
    () => computeLayout(projects, Object.values(world.tasks)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structure, projects.map((p) => p.id).join(',')],
  );

  const focusLane = layout.lanes.find((l) => l.project.id === focus);
  const bounds = focusLane?.bounds ?? layout.bounds;
  const cx = (layout.bounds.minX + layout.bounds.maxX) / 2;

  const workers = Object.values(world.workers).sort((a, b) => a.registered_at - b.registered_at || a.id.localeCompare(b.id));
  const dz = dockZ(bounds);
  const dockCx = (bounds.minX + bounds.maxX) / 2;
  const span = Math.min(4.2, (bounds.maxX - bounds.minX) / Math.max(1, workers.length));

  const pmPos = pmPosition(bounds);
  const reviewing = Object.values(world.tasks)
    .filter((t) => t.state === 'in_review' && layout.pos[t.id])
    .map((task) => ({ task, pos: layout.pos[task.id] }));

  return (
    <>
      <CameraRig bounds={bounds} />
      {layout.lanes.map((lane) => (
        <LanePlate
          key={lane.project.id}
          lane={lane}
          dim={focus !== 'all' && focus !== lane.project.id}
          running={Object.values(world.tasks).filter((t) => t.project_id === lane.project.id && t.state === 'claimed').length}
        />
      ))}
      <Edges tasks={world.tasks} pos={layout.pos} />
      {Object.values(world.tasks).map(
        (t) =>
          layout.pos[t.id] && (
            <TaskNode
              key={t.id}
              task={t}
              position={layout.pos[t.id]}
              selected={selected === t.id}
              onSelect={(id) => set({ selected: id })}
            />
          ),
      )}
      {workers.map((w, i) => {
        const task = w.current_task ? world.tasks[w.current_task] : undefined;
        return (
          <WorkerAvatar
            key={w.id}
            worker={w}
            color={WORKER_COLORS[i % WORKER_COLORS.length]}
            dock={[dockCx + (i - (workers.length - 1) / 2) * span, 0, dz]}
            target={task && task.state === 'claimed' && layout.pos[task.id] ? layout.pos[task.id] : null}
          />
        );
      })}
      {layout.lanes.length > 0 && <PmAvatar position={pmPos} reviewing={reviewing} />}
      <gridHelper args={[80, 80, '#1b2740', '#121b2e']} position={[cx, -0.03, 0]} />
    </>
  );
}

export function Scene() {
  const set = useStore((s) => s.set);
  return (
    <Canvas
      camera={{ fov: FOV, near: 0.1, far: 300, position: [0, 16, 15] }}
      dpr={[1, 2]}
      flat
      shadows={false}
      onPointerMissed={() => set({ selected: null })}
    >
      <color attach="background" args={['#070b14']} />
      <fog attach="fog" args={['#070b14', 70, 160]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[6, 14, 8]} intensity={1.1} />
      <directionalLight position={[-10, 6, -6]} intensity={0.5} color="#7aa2ff" />
      <Stars radius={90} depth={40} count={1800} factor={3} saturation={0} fade speed={0.6} />
      <World />
      <OrbitControls
        makeDefault
        enableDamping
        maxPolarAngle={Math.PI / 2.15}
        minDistance={5}
        maxDistance={140}
      />
    </Canvas>
  );
}
