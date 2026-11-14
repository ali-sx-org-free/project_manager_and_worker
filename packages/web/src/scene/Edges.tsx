import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Task } from '@agent-pm/core';
import type { Vec3 } from '../layout.ts';
import { fx } from '../store.ts';
import { STATE_META } from '../theme.ts';

const PULSE_MS = 1300;

function Edge({ from, to, a, b }: { from: Task; to: Task; a: Vec3; b: Vec3 }) {
  const pulse = useRef<THREE.Mesh>(null);
  const done = from.state === 'done';

  const { curve, points, headPos, headQuat } = useMemo(() => {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const dir = B.clone().sub(A).normalize();
    // 兩端讓出節點半徑，中間微微拱起
    const start = A.clone().addScaledVector(dir, 0.78).setY(0.1);
    const end = B.clone().addScaledVector(dir, -0.92).setY(0.1);
    const mid = start.clone().lerp(end, 0.5).setY(0.42);
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const tangent = curve.getTangent(1).normalize();
    const headQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    return { curve, points: curve.getPoints(20), headPos: end, headQuat };
  }, [a, b]);

  useFrame(() => {
    const m = pulse.current;
    if (!m) return;
    const started = fx.pulses.get(`${from.id}->${to.id}`);
    const k = started === undefined ? 2 : (performance.now() - started) / PULSE_MS;
    if (k < 0 || k > 1) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.copy(curve.getPoint(k));
    m.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.8);
  });

  const color = done ? STATE_META.done.color : '#44516f';
  return (
    <group>
      <Line points={points} color={color} lineWidth={done ? 2.2 : 1.4} transparent opacity={done ? 0.85 : 0.6} />
      <mesh position={headPos} quaternion={headQuat}>
        <coneGeometry args={[0.09, 0.24, 10]} />
        <meshBasicMaterial color={color} transparent opacity={done ? 0.95 : 0.7} />
      </mesh>
      <mesh ref={pulse} visible={false}>
        <sphereGeometry args={[0.11, 14, 14]} />
        <meshBasicMaterial color="#eafff4" toneMapped={false} />
      </mesh>
    </group>
  );
}

export function Edges({ tasks, pos }: { tasks: Record<string, Task>; pos: Record<string, Vec3> }) {
  return (
    <>
      {Object.values(tasks).flatMap((to) =>
        to.deps.map((d) => {
          const from = tasks[d];
          if (!from || !pos[d] || !pos[to.id]) return null;
          return <Edge key={`${d}->${to.id}`} from={from} to={to} a={pos[d]} b={pos[to.id]} />;
        }),
      )}
    </>
  );
}
