import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import * as THREE from 'three';
import type { PartSceneHandle } from './PartScene';

/** The CAD view cube (proposition 0): 26 pick regions — 6 faces, 12 edges, 8 corners — each
 *  turning the view to look from that direction; a drag orbits; it always shows where the
 *  camera is. The printer's axes start at the bed's origin corner (front-left-bottom): X red
 *  to the right, Y green to the back, Z blue up, drawn on top so the cube never hides them.
 *  Its own small WebGL canvas; it reads the main camera through the scene handle each frame. */
const SIZE = 150;
const FACE = 0.78;
const EDGE = 0.22;
const AXES: Array<{ name: string; dir: [number, number, number]; color: string }> = [
  { name: 'X', dir: [1, 0, 0], color: '#ef5350' },
  { name: 'Y', dir: [0, 0, -1], color: '#4cd964' },
  { name: 'Z', dir: [0, 1, 0], color: '#4a9cff' },
];

function faceTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#243041';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#eef3f8';
    g.font = '700 54px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 132);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function letterSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = color;
    g.font = '800 46px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 32, 34);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  sprite.renderOrder = 10;
  sprite.scale.set(0.3, 0.3, 1);
  return sprite;
}

function solidArrow(dir: THREE.Vector3, from: THREE.Vector3, length: number, color: string): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, length - 0.14, 10), m);
  shaft.position.y = (length - 0.14) / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.14, 12), m);
  head.position.y = length - 0.07;
  g.add(shaft, head);
  g.renderOrder = 9;
  g.position.copy(from);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return g;
}

export function ViewCube({ scene }: { scene: React.RefObject<PartSceneHandle | null> }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(SIZE, SIZE, false);
    const cubeScene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.25, 1.25, 1.25, -1.25, 0.1, 10);
    cubeScene.add(new THREE.AmbientLight('#ffffff', 1.6));
    const light = new THREE.DirectionalLight('#ffffff', 0.8);
    light.position.set(2, 3, 4);
    cubeScene.add(light);
    const root = new THREE.Group();
    cubeScene.add(root);
    const regions: THREE.Mesh[] = [];
    const regionMaterial = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    const addRegion = (mesh: THREE.Mesh, dir: [number, number, number]) => {
      mesh.userData.dir = new THREE.Vector3(...dir);
      root.add(mesh);
      regions.push(mesh);
    };
    const faces: Array<[[number, number, number], string, [number, number, number]]> = [
      [[0, 0, 1], t('partViewer.cube.front'), [0, 0, 0]],
      [[0, 0, -1], t('partViewer.cube.back'), [0, Math.PI, 0]],
      [[1, 0, 0], t('partViewer.cube.right'), [0, Math.PI / 2, 0]],
      [[-1, 0, 0], t('partViewer.cube.left'), [0, -Math.PI / 2, 0]],
      [[0, 1, 0], t('partViewer.cube.top'), [-Math.PI / 2, 0, 0]],
      [[0, -1, 0], t('partViewer.cube.bottom'), [Math.PI / 2, 0, 0]],
    ];
    for (const [n, label, rot] of faces) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(FACE, FACE), new THREE.MeshStandardMaterial({ map: faceTexture(label), roughness: 0.9 }));
      m.position.set(n[0] * 0.5, n[1] * 0.5, n[2] * 0.5);
      m.rotation.set(rot[0], rot[1], rot[2]);
      addRegion(m, n);
    }
    for (let a = 0; a < 3; a++) {
      for (const s1 of [-1, 1]) {
        for (const s2 of [-1, 1]) {
          const b = (a + 1) % 3;
          const c = (a + 2) % 3;
          const size: [number, number, number] = [EDGE, EDGE, EDGE];
          size[a] = FACE;
          const pos: [number, number, number] = [0, 0, 0];
          pos[b] = s1 * 0.5;
          pos[c] = s2 * 0.5;
          const dir: [number, number, number] = [0, 0, 0];
          dir[b] = s1;
          dir[c] = s2;
          const m = new THREE.Mesh(new THREE.BoxGeometry(...size), regionMaterial('#1d2733'));
          m.position.set(...pos);
          addRegion(m, dir);
        }
      }
    }
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(EDGE, EDGE, EDGE), regionMaterial('#1a2330'));
      m.position.set(x * 0.5, y * 0.5, z * 0.5);
      addRegion(m, [x, y, z]);
    }
    root.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)), new THREE.LineBasicMaterial({ color: '#4a5866' })));
    const origin = new THREE.Vector3(-0.5, -0.5, 0.5);
    for (const ax of AXES) {
      const dir = new THREE.Vector3(...ax.dir);
      cubeScene.add(solidArrow(dir, origin, 0.78, ax.color));
      const label = letterSprite(ax.name, ax.color);
      label.position.copy(origin.clone().add(dir.clone().multiplyScalar(0.98)));
      cubeScene.add(label);
    }
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 12), new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false }));
    dot.renderOrder = 11;
    dot.position.copy(origin);
    cubeScene.add(dot);

    const ray = new THREE.Raycaster();
    let hovered: THREE.Mesh | null = null;
    let drag: { x: number; y: number; moved: boolean; hit: THREE.Mesh | null } | null = null;
    const pick = (e: PointerEvent): THREE.Mesh | null => {
      const r = canvas.getBoundingClientRect();
      const m = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(m, camera);
      return (ray.intersectObjects(regions)[0]?.object as THREE.Mesh | undefined) ?? null;
    };
    const setEmissive = (mesh: THREE.Mesh | null, on: boolean) => {
      if (!mesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive = new THREE.Color(on ? '#14b8a6' : '#000000');
      mat.emissiveIntensity = 0.5;
    };
    const onMove = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag.moved ||= Math.hypot(dx, dy) > 4;
        drag.x = e.clientX;
        drag.y = e.clientY;
        scene.current?.orbit(dx * 0.012, dy * 0.012);
        return;
      }
      const hit = pick(e);
      if (hit !== hovered) {
        setEmissive(hovered, false);
        hovered = hit;
        setEmissive(hovered, true);
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      }
    };
    const onLeave = () => {
      setEmissive(hovered, false);
      hovered = null;
    };
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false, hit: pick(e) };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    };
    const onUp = () => {
      const d = drag;
      drag = null;
      canvas.style.cursor = 'grab';
      if (d && !d.moved && d.hit) {
        const dir = d.hit.userData.dir as THREE.Vector3;
        scene.current?.goTo([dir.x, dir.y, dir.z]);
      }
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);

    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const view = scene.current?.getView();
      if (!view) return;
      camera.position.set(view.dir[0] * 4, view.dir[1] * 4, view.dir[2] * 4);
      camera.up.set(view.up[0], view.up[1], view.up[2]);
      camera.lookAt(0, 0, 0);
      renderer.render(cubeScene, camera);
    };
    loop();
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      cubeScene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      renderer.dispose();
    };
  }, [scene, t]);

  return (
    <canvas ref={canvasRef} data-testid="view-cube" width={SIZE} height={SIZE} style={{ width: SIZE, height: SIZE, cursor: 'grab' }}
      aria-label={t('partViewer.cube.label')} title={t('partViewer.cube.label')} className="select-none" />
  );
}
