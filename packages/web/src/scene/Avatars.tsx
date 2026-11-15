import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Task, Worker } from '@agent-pm/core';
import type { Vec3 } from '../layout.ts';
import { fx } from '../store.ts';
import { PM_COLOR, STATE_META } from '../theme.ts';
import { Label } from './Label.tsx';

interface WorkerProps {
  worker: Worker;
  color: string;
  /** 閒置時停靠的位置 */
  dock: Vec3;
  /** 正在執行的任務位置 */
  target: Vec3 | null;
}

/** Worker 化身：一個小機器人。領到任務就飛過去繞著節點轉，心跳斷了會變暗落地。 */
export function WorkerAvatar({ worker, color, dock, target }: WorkerProps) {
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.MeshStandardMaterial>(null);
  const antenna = useRef<THREE.MeshBasicMaterial>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  const offline = worker.status === 'offline';
  const goal = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }, dt) => {
    const g = group.current;
    if (!g) return;
    const t = clock.elapsedTime + phase;
    if (target && !offline) {
      const a = t * 1.5;
      goal.set(target[0] + Math.cos(a) * 1.0, 0.85 + Math.sin(a * 2) * 0.08, target[2] + Math.sin(a) * 1.0);
    } else if (offline) {
      goal.set(dock[0], 0.3, dock[2]);
    } else {
      goal.set(dock[0], 0.75 + Math.sin(t * 1.3) * 0.1, dock[2]);
    }
    const k = 1 - Math.exp(-dt * (target ? 3.2 : 2.4));
    const before = g.position.clone();
    g.position.lerp(goal, k);
    // 面朝飛行方向；停下來時面向鏡頭
    const v = g.position.clone().sub(before);
    const yaw = v.lengthSq() > 1e-6 && target && !offline ? Math.atan2(v.x, v.z) : 0;
    g.rotation.y = THREE.MathUtils.lerp(g.rotation.y, yaw, 0.12);
    g.rotation.z = THREE.MathUtils.lerp(g.rotation.z, offline ? 0.5 : 0, 0.08);

    if (body.current) {
      body.current.emissiveIntensity = THREE.MathUtils.lerp(body.current.emissiveIntensity, offline ? 0 : 0.55, 0.1);
    }
    if (antenna.current) {
      // 每次心跳天線閃一下
      const since = performance.now() - (fx.heartbeats.get(worker.id) ?? -1e9);
      const flash = Math.max(0, 1 - since / 500);
      antenna.current.color.set(offline ? '#3a4257' : color).lerp(new THREE.Color('#ffffff'), flash);
    }
  });

  const status = offline ? '離線' : target ? null : worker.busy_elsewhere ? '忙於其他項目' : '閒置';
  return (
    <group ref={group} position={[dock[0], 0.75, dock[2]]} scale={1.25}>
      {/* 身體 */}
      <mesh castShadow>
        <sphereGeometry args={[0.3, 28, 20]} />
        <meshStandardMaterial
          ref={body}
          color={offline ? '#4a536b' : '#dfe7f7'}
          emissive={color}
          emissiveIntensity={0.55}
          roughness={0.3}
          metalness={0.4}
        />
      </mesh>
      {/* 面罩和眼睛 */}
      <mesh position={[0, 0.03, 0.2]} scale={[1, 0.55, 0.6]}>
        <sphereGeometry args={[0.22, 20, 14]} />
        <meshStandardMaterial color="#0b1020" roughness={0.2} metalness={0.6} />
      </mesh>
      {[-0.075, 0.075].map((x) => (
        <mesh key={x} position={[x, 0.04, 0.325]}>
          <sphereGeometry args={[0.032, 10, 10]} />
          <meshBasicMaterial color={offline ? '#39425a' : color} toneMapped={false} />
        </mesh>
      ))}
      {/* 天線 */}
      <mesh position={[0, 0.38, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 0.2, 6]} />
        <meshStandardMaterial color="#9aa7c7" />
      </mesh>
      <mesh position={[0, 0.5, 0]}>
        <sphereGeometry args={[0.045, 10, 10]} />
        <meshBasicMaterial ref={antenna} color={color} toneMapped={false} />
      </mesh>
      {/* 推進環 */}
      <mesh rotation-x={Math.PI / 2} position-y={-0.3}>
        <torusGeometry args={[0.2, 0.025, 8, 24]} />
        <meshBasicMaterial color={offline ? '#39425a' : color} transparent opacity={0.8} toneMapped={false} />
      </mesh>

      <Label
        position={[0, status ? 1.42 : 1.1, 0]}
        dot={offline ? '#5d6a86' : color}
        opacity={offline ? 0.6 : 1}
        lines={[
          { text: `${worker.name} · ${worker.machine}`, size: 12, weight: 600 },
          ...(status ? [{ text: status, size: 10, color: offline ? '#ff8b98' : '#9fb0d4' }] : []),
        ]}
      />
    </group>
  );
}

/** PM 化身：懸在場景上方的晶體。對每個 in_review 的節點照一道光束。 */
export function PmAvatar({ position, reviewing }: { position: Vec3; reviewing: { task: Task; pos: Vec3 }[] }) {
  const core = useRef<THREE.Mesh>(null);
  const shell = useRef<THREE.Mesh>(null);
  const beams = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (core.current) {
      core.current.rotation.y = t * 0.5;
      core.current.position.y = Math.sin(t * 0.9) * 0.12;
    }
    if (shell.current) {
      shell.current.rotation.y = -t * 0.25;
      shell.current.rotation.x = t * 0.15;
    }
    if (beams.current) {
      const flicker = 0.75 + 0.25 * Math.sin(t * 9);
      beams.current.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m && 'opacity' in m && o.userData.base) m.opacity = o.userData.base * flicker;
      });
    }
  });

  const purple = STATE_META.in_review.color;
  return (
    <>
      <group position={position}>
        <mesh ref={core}>
          <octahedronGeometry args={[0.62, 0]} />
          <meshStandardMaterial
            color="#fff6dd"
            emissive={PM_COLOR}
            emissiveIntensity={reviewing.length ? 1.1 : 0.7}
            roughness={0.15}
            metalness={0.5}
            flatShading
          />
        </mesh>
        <mesh ref={shell}>
          <icosahedronGeometry args={[1.0, 1]} />
          <meshBasicMaterial color={PM_COLOR} wireframe transparent opacity={0.28} />
        </mesh>
        <pointLight color={PM_COLOR} intensity={30} distance={14} />
        <Label
          position={[0, 1.6, 0]}
          dot={PM_COLOR}
          border="rgba(255,217,138,0.5)"
          lines={[
            { text: 'PM · 項目管理員', size: 16, weight: 700 },
            {
              text: reviewing.length ? `正在 review ${reviewing.length} 個交付` : '拆解 · review · 交付',
              size: 12,
              color: reviewing.length ? purple : '#c9b98a',
            },
          ]}
        />
      </group>

      <group ref={beams}>
        {reviewing.map(({ task, pos }) => {
          const from: Vec3 = [position[0], position[1] - 0.6, position[2]];
          const to: Vec3 = [pos[0], 0.3, pos[2]];
          return (
            <group key={task.id}>
              <Line points={[from, to]} color={purple} lineWidth={9} transparent opacity={0.2} userData={{ base: 0.2 }} />
              <Line points={[from, to]} color="#f1e4ff" lineWidth={2} transparent opacity={0.9} userData={{ base: 0.9 }} />
            </group>
          );
        })}
      </group>
    </>
  );
}
