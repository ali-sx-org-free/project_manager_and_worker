import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Task } from '@agent-pm/core';
import type { Vec3 } from '../layout.ts';
import { STATE_META } from '../theme.ts';
import { Label } from './Label.tsx';

interface Props {
  task: Task;
  position: Vec3;
  selected: boolean;
  onSelect: (id: string) => void;
}

const short = (s: string, n = 9) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** 一個任務節點：六角形底座，顏色和動效表達狀態。 */
export function TaskNode({ task, position, selected, onSelect }: Props) {
  const [hover, setHover] = useState(false);
  const pad = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const ring = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const meta = STATE_META[task.state];
  const color = useMemo(() => new THREE.Color(meta.color), [meta.color]);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    let glow = 0.35;
    let lift = 0;
    switch (task.state) {
      case 'pending':
        glow = 0.12;
        break;
      case 'ready': // 呼吸光
        glow = 0.45 + 0.35 * Math.sin(t * 2.2);
        lift = 0.04 * Math.sin(t * 2.2);
        break;
      case 'claimed':
        glow = 0.7;
        break;
      case 'in_review':
        glow = 0.75 + 0.2 * Math.sin(t * 5);
        break;
      case 'changes_requested':
        glow = 0.5 + 0.4 * Math.sin(t * 3.2);
        break;
      case 'blocked': // 閃爍
        glow = Math.sin(t * 7) > 0 ? 1.3 : 0.15;
        break;
      case 'done':
        glow = 0.3;
        break;
    }
    if (mat.current) {
      mat.current.emissiveIntensity = THREE.MathUtils.lerp(mat.current.emissiveIntensity, glow, 0.25);
      mat.current.color.lerp(color, 0.12);
      mat.current.emissive.lerp(color, 0.12);
    }
    if (pad.current) {
      const s = THREE.MathUtils.lerp(pad.current.scale.x, hover || selected ? 1.12 : 1, 0.2);
      pad.current.scale.set(s, 1, s);
      pad.current.position.y = 0.14 + lift;
    }
    if (ring.current) {
      ring.current.visible = task.state === 'claimed' || task.state === 'in_review';
      ring.current.rotation.z = t * (task.state === 'claimed' ? 1.8 : -0.6);
    }
    if (halo.current) {
      const m = halo.current.material as THREE.MeshBasicMaterial;
      m.opacity = task.state === 'pending' ? 0.05 : 0.1 + 0.08 * Math.sin(t * 2);
    }
  });

  const tag = task.labels.length ? ` · ${task.labels.join(' ')}` : '';
  // 做到一半的任務（執行中，或中斷後等人接手）顯示進度環：換人之後環不會歸零
  const partial =
    task.progress > 0 && task.progress < 100 && task.state !== 'done' && task.state !== 'in_review' && task.state !== 'pending';
  const waiting = partial && (task.state === 'ready' || task.state === 'changes_requested');
  const status = partial ? `${waiting ? '待接手' : meta.label} ${task.progress}%` : meta.label;
  return (
    <group
      position={position}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(task.id);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHover(false);
        document.body.style.cursor = '';
      }}
    >
      {/* 地面光暈 */}
      <mesh ref={halo} rotation-x={-Math.PI / 2} position-y={0.02}>
        <circleGeometry args={[1.05, 40]} />
        <meshBasicMaterial color={meta.color} transparent opacity={0.1} depthWrite={false} />
      </mesh>

      <mesh ref={pad} position-y={0.14} castShadow>
        <cylinderGeometry args={[0.62, 0.7, 0.24, 6]} />
        <meshStandardMaterial
          ref={mat}
          color={meta.color}
          emissive={meta.color}
          emissiveIntensity={0.4}
          roughness={0.55}
          metalness={0.1}
          transparent={task.state === 'pending'}
          opacity={task.state === 'pending' ? 0.8 : 1}
        />
      </mesh>

      {/* 執行中 / review 中的旋轉環（帶缺口才看得出在轉） */}
      <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={0.3} visible={false}>
        <torusGeometry args={[0.86, 0.035, 8, 48, Math.PI * 1.55]} />
        <meshBasicMaterial color={meta.color} toneMapped={false} />
      </mesh>

      {partial && (
        <group rotation-x={-Math.PI / 2} position-y={0.06}>
          <mesh>
            <ringGeometry args={[0.9, 1.05, 64]} />
            <meshBasicMaterial color="#26324f" transparent opacity={0.9} depthWrite={false} />
          </mesh>
          {/* 從正前方順時針填滿 */}
          <mesh position-z={0.01} rotation-z={-Math.PI / 2} scale={[1, -1, 1]}>
            <ringGeometry key={task.progress} args={[0.9, 1.05, 64, 1, 0, (task.progress / 100) * Math.PI * 2]} />
            <meshBasicMaterial color={waiting ? '#ffffff' : meta.color} side={2} toneMapped={false} />
          </mesh>
        </group>
      )}

      {selected && (
        <mesh rotation-x={-Math.PI / 2} position-y={0.05}>
          <ringGeometry args={[1.14, 1.21, 48]} />
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </mesh>
      )}

      <Label
        position={[0, 0.25, 1.05]}
        dot={meta.color}
        border={selected ? '#ffffff' : hover ? meta.color : 'rgba(120,140,190,0.28)'}
        lines={[
          { text: short(task.title), size: 16, weight: 600 },
          { text: `${status}${tag}`, size: 12, color: task.state === 'pending' ? '#8090b0' : meta.color },
        ]}
        opacity={task.state === 'pending' ? 0.75 : 1}
      />
    </group>
  );
}
