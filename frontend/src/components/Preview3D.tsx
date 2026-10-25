import { useMemo } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import type { Wall } from '../types';
// Bundled so labels render offline (drei's <Text> otherwise fetches a font from a CDN). troika needs woff/ttf, not woff2.
import labelFont from '@fontsource/inter/files/inter-latin-500-normal.woff?url';

interface Preview3DProps {
  walls: Wall[];
  getLightColor: (lightId: number) => string;
  getDefectiveSimulation: (lightId: number, channels: string) => string | null;
  showDefective: boolean;
  showIds?: boolean;
  // 'inside' puts the camera in the center of the layout, looking out at the walls
  view?: 'outside' | 'inside';
}

const LIGHT_SPACING = 0.8; // LIGHT_SIZE + gap
const LIGHT_SIZE = 0.7;
const LIGHT_DEPTH = 0.1;
const PANEL_PADDING = 0.3;

// Shared by every light box. Created once at module level so re-renders
// (one per WebSocket frame) never allocate new GPU buffers.
const LIGHT_BOX_GEOMETRY = new THREE.BoxGeometry(LIGHT_SIZE, LIGHT_SIZE, LIGHT_DEPTH);
const LIGHT_EDGES_GEOMETRY = new THREE.EdgesGeometry(LIGHT_BOX_GEOMETRY);

// Rotation for each wall so it faces outward
const WALL_ROTATION: Record<string, number> = {
  West:  -Math.PI / 2,
  North: Math.PI,
  East:  Math.PI / 2,
  South: 0,
};

function panelWidth(wallWidth: number) {
  return wallWidth * LIGHT_SPACING + PANEL_PADDING;
}

// Compute wall positions dynamically so edges meet at corners.
// Top-down (Y up): West/East run along Z, North/South run along X.
function computeWallPositions(walls: Wall[]): Record<string, [number, number, number]> {
  const byName: Record<string, Wall> = {};
  for (const w of walls) byName[w.name] = w;

  // Half-lengths of the long side (West/East) and short side (North/South)
  const longHalf = panelWidth(byName['West']?.width ?? byName['East']?.width ?? 13) / 2;
  const shortHalf = panelWidth(byName['North']?.width ?? byName['South']?.width ?? 3) / 2;

  return {
    West:  [-shortHalf, 0, 0],
    East:  [shortHalf, 0, 0],
    North: [0, 0, -longHalf],
    South: [0, 0, longHalf],
  };
}

function parseColor(colorStr: string): [number, number, number] {
  // Handle rgb(r, g, b)
  const rgbMatch = colorStr.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) {
    return [
      parseInt(rgbMatch[1]) / 255,
      parseInt(rgbMatch[2]) / 255,
      parseInt(rgbMatch[3]) / 255,
    ];
  }
  // Handle hex #rrggbb
  const hexMatch = colorStr.match(/^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (hexMatch) {
    return [
      parseInt(hexMatch[1], 16) / 255,
      parseInt(hexMatch[2], 16) / 255,
      parseInt(hexMatch[3], 16) / 255,
    ];
  }
  return [0.13, 0.13, 0.13]; // dark fallback
}

function WallGroup({ wall, position, getLightColor, getDefectiveSimulation, showDefective, showIds, inside }: {
  wall: Wall;
  position: [number, number, number];
  getLightColor: (lightId: number) => string;
  getDefectiveSimulation: (lightId: number, channels: string) => string | null;
  showDefective: boolean;
  showIds?: boolean;
  inside?: boolean;
}) {
  const rotationY = WALL_ROTATION[wall.name];

  // Collect all lights from the matrix
  const lights = useMemo(() => {
    const result: { lightId: number; localX: number; localY: number; defective: string }[] = [];
    if (!wall.matrix) return result;
    for (let y = 0; y < wall.height; y++) {
      for (let x = 0; x < wall.width; x++) {
        const light = wall.matrix[y]?.[x];
        if (light) {
          const localX = (x - (wall.width - 1) / 2) * LIGHT_SPACING;
          const localY = (y - (wall.height - 1) / 2) * LIGHT_SPACING;
          result.push({
            lightId: light.light_id,
            localX,
            localY,
            defective: light.defective_channels || '',
          });
        }
      }
    }
    return result;
  }, [wall]);

  if (rotationY === undefined) return null;

  const pw = panelWidth(wall.width);
  const panelHeight = wall.height * LIGHT_SPACING + PANEL_PADDING;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {/* Back panel */}
      <mesh position={[0, 0, -LIGHT_DEPTH / 2 - 0.01]}>
        <planeGeometry args={[pw, panelHeight]} />
        <meshStandardMaterial color="#1a1a2e" />
      </mesh>

      {/* Light boxes */}
      {lights.map(({ lightId, localX, localY, defective }) => {
        if (showIds) {
          return (
            <group key={lightId} position={[localX, localY, 0]}>
              <mesh geometry={LIGHT_BOX_GEOMETRY}>
                <meshStandardMaterial color="#475569" emissive="#334155" emissiveIntensity={0.8} />
              </mesh>
              <Text
                position={[0, 0, inside ? -LIGHT_DEPTH / 2 - 0.01 : LIGHT_DEPTH / 2 + 0.01]}
                rotation={[0, inside ? Math.PI : 0, 0]}
                font={labelFont}
                fontSize={0.3}
                color="#f8fafc"
                anchorX="center"
                anchorY="middle"
              >
                {String(lightId)}
              </Text>
            </group>
          );
        }

        const isDefective = showDefective && !!defective;
        const simColor = isDefective ? getDefectiveSimulation(lightId, defective) : null;
        const colorStr = simColor || getLightColor(lightId);
        const [r, g, b] = parseColor(colorStr);
        const isDark = r < 0.15 && g < 0.15 && b < 0.15;

        return (
          <group key={lightId} position={[localX, localY, 0]}>
            <mesh geometry={LIGHT_BOX_GEOMETRY}>
              <meshStandardMaterial
                color={isDark ? '#333' : colorStr}
                emissive={colorStr}
                emissiveIntensity={isDark ? 0.1 : 0.8}
              />
            </mesh>
            {isDefective && (
              <lineSegments geometry={LIGHT_EDGES_GEOMETRY}>
                <lineBasicMaterial color="#ff4444" linewidth={2} />
              </lineSegments>
            )}
          </group>
        );
      })}

      {/* Wall label */}
      <Text
        position={[0, -panelHeight / 2 - 0.4, 0]}
        rotation={[0, inside ? Math.PI : 0, 0]}
        font={labelFont}
        fontSize={0.4}
        color="#94a3b8"
        anchorX="center"
        anchorY="top"
      >
        {wall.name}
      </Text>
    </group>
  );
}

export default function Preview3D({ walls, getLightColor, getDefectiveSimulation, showDefective, showIds, view = 'outside' }: Preview3DProps) {
  const positions = useMemo(() => computeWallPositions(walls), [walls]);
  const inside = view === 'inside';

  return (
    <div className="preview-3d-container">
      {/* key remounts the canvas so the camera resets when switching views */}
      <Canvas key={view} camera={inside ? { position: [0, 0, 0.01], fov: 75 } : { position: [0, 8, 18], fov: 45 }}>
        <ambientLight intensity={0.3} />
        <directionalLight position={[5, 10, 5]} intensity={0.5} />
        {inside ? (
          // Camera sits a hair off the center and orbits it, so dragging just turns your head
          <OrbitControls
            target={[0, 0, 0]}
            enablePan={false}
            enableZoom={false}
            rotateSpeed={-0.4}
          />
        ) : (
          <OrbitControls
            enablePan={true}
            enableZoom={true}
            enableRotate={true}
            minDistance={5}
            maxDistance={40}
          />
        )}
        {walls.map((wall) => (
          <WallGroup
            key={wall.id}
            wall={wall}
            position={positions[wall.name] || [0, 0, 0]}
            getLightColor={getLightColor}
            getDefectiveSimulation={getDefectiveSimulation}
            showDefective={showDefective}
            showIds={showIds}
            inside={inside}
          />
        ))}
      </Canvas>
    </div>
  );
}
