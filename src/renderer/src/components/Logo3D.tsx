import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Logo } from './ui'

// R-Code's mark in 3D: the </> from the app icon, outlined and extruded into soft glass.
// It turns to face the mouse, and a light rides along with the cursor so the highlights
// and reflections move across the glass as it turns.

const v = (x: number, y: number): THREE.Vector2 => new THREE.Vector2(x, y)
const angle = (n: THREE.Vector2): number => Math.atan2(n.y, n.x)
const cross = (a: THREE.Vector2, b: THREE.Vector2): number => a.x * b.y - a.y * b.x
const right = (d: THREE.Vector2): THREE.Vector2 => v(d.y, -d.x)
const left = (d: THREE.Vector2): THREE.Vector2 => v(-d.y, d.x)
const at = (p: THREE.Vector2, n: THREE.Vector2, r: number): THREE.Vector2 => p.clone().addScaledVector(n, r)

/** Outline of a round-capped stroke through 2 points (a pill) or 3 points (a chevron). */
function strokeOutline(points: THREE.Vector2[], r: number): THREE.Shape {
  const s = new THREE.Shape()
  if (points.length === 2) {
    const [a, b] = points
    const d = b.clone().sub(a).normalize()
    const p = at(a, right(d), r)
    s.moveTo(p.x, p.y)
    s.absarc(b.x, b.y, r, angle(right(d)), angle(right(d)) + Math.PI, false)
    s.absarc(a.x, a.y, r, angle(left(d)), angle(left(d)) + Math.PI, false)
    return s
  }
  // Walk the chevron so it turns left; the outer side is then always on the right.
  let [a, b, c] = points
  if (cross(b.clone().sub(a), c.clone().sub(b)) < 0) [a, c] = [c, a]
  const d1 = b.clone().sub(a).normalize()
  const d2 = c.clone().sub(b).normalize()
  const start = at(a, right(d1), r)
  s.moveTo(start.x, start.y)
  s.absarc(b.x, b.y, r, angle(right(d1)), angle(right(d2)), false) // outer corner
  s.absarc(c.x, c.y, r, angle(right(d2)), angle(right(d2)) + Math.PI, false) // end cap
  // Inner corner: where the two inner edges meet, softened with a small fillet.
  const p1 = at(a, left(d1), r)
  const p2 = at(b, left(d2), r)
  const corner = p1.clone().addScaledVector(d1, cross(p2.clone().sub(p1), d2) / cross(d1, d2))
  const f = r * 0.8
  const into = corner.clone().addScaledVector(d2, f)
  const out = corner.clone().addScaledVector(d1, -f)
  s.lineTo(into.x, into.y)
  s.quadraticCurveTo(corner.x, corner.y, out.x, out.y)
  s.absarc(a.x, a.y, r, angle(left(d1)), angle(left(d1)) + Math.PI, false) // start cap
  return s
}

function glyphGeometry(): THREE.BufferGeometry[] {
  const r = 0.085 // core half-width; the bevel rounds it out to ~0.18
  const shapes = [
    strokeOutline([v(-0.78, 0.6), v(-1.5, 0), v(-0.78, -0.6)], r), // <
    strokeOutline([v(-0.26, -0.92), v(0.26, 0.92)], r), // /
    strokeOutline([v(0.78, 0.6), v(1.5, 0), v(0.78, -0.6)], r), // >
  ]
  return shapes.map((shape) => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: 0.16,
      bevelEnabled: true,
      bevelThickness: 0.13,
      bevelSize: 0.095,
      bevelSegments: 12,
      curveSegments: 40,
    })
    g.translate(0, 0, -0.08)
    // Weld the caps to the walls so the glass shades as one smooth, pillowy surface.
    g.deleteAttribute('normal')
    g.deleteAttribute('uv')
    const smooth = mergeVertices(g, 1e-4)
    g.dispose()
    smooth.computeVertexNormals()
    return smooth
  })
}

export function Logo3D({ size = 150, className }: { size?: number; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const width = Math.round(size * 1.5)

  useEffect(() => {
    const host = ref.current
    if (!host) return
    // A fresh canvas per mount: a canvas whose context was released can't be reused.
    const canvas = document.createElement('canvas')
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    } catch {
      setFailed(true)
      return
    }
    host.appendChild(canvas)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, size, false)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2

    const scene = new THREE.Scene()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const room = new RoomEnvironment()
    const env = pmrem.fromScene(room, 0.03).texture
    room.dispose()
    pmrem.dispose()
    scene.environment = env

    // Fit the camera so the mark fills most of the canvas, with room to turn.
    const camera = new THREE.PerspectiveCamera(28, width / size, 0.1, 50)
    const viewHeight = 3.75 / (width / size) / 0.82
    camera.position.set(0, 0, viewHeight / 2 / Math.tan(THREE.MathUtils.degToRad(14)))

    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.07,
      transmission: 1,
      thickness: 0.4,
      ior: 1.5,
      attenuationColor: new THREE.Color(0x7fb0ff),
      attenuationDistance: 1.4,
      // A faint inner glow keeps the glass luminous on the dark background.
      emissive: new THREE.Color(0x2f6bff),
      emissiveIntensity: 0.12,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      iridescence: 0.7,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [180, 620],
      specularIntensity: 1,
      envMapIntensity: 2,
    })
    const geometries = glyphGeometry()
    const mark = new THREE.Group()
    for (const g of geometries) mark.add(new THREE.Mesh(g, glass))
    mark.rotation.order = 'YXZ'
    scene.add(mark)

    // A key light that follows the cursor, plus a cool rim from behind for the glass edges.
    const key = new THREE.PointLight(0xffffff, 40, 0, 2)
    key.position.set(1.5, 1.5, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0x8fbcff, 3.2)
    rim.position.set(-3, 2.5, -3)
    scene.add(rim)
    const fill = new THREE.DirectionalLight(0xc9a8ff, 0.8)
    fill.position.set(3, -2.5, 2)
    scene.add(fill)

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    // Start as if the cursor were just below-right, so the first frame already has life.
    const mouse = { x: window.innerWidth * 0.62, y: window.innerHeight * 0.75 }
    const onMove = (e: PointerEvent): void => {
      mouse.x = e.clientX
      mouse.y = e.clientY
    }
    window.addEventListener('pointermove', onMove, { passive: true })

    const maxTurn = 0.49 // ~28°
    const look = { yaw: 0, pitch: 0, lx: 1.5, ly: 1.5 }
    let raf = 0
    let last = performance.now()
    let visible = true
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      if (visible && !raf) raf = requestAnimationFrame(frame)
    })
    io.observe(canvas)

    function frame(now: number): void {
      raf = 0
      if (!visible) return
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      const box = canvas.getBoundingClientRect()
      const dx = mouse.x - (box.left + box.width / 2)
      const dy = mouse.y - (box.top + box.height / 2)
      // Point the mark's face at the cursor, as if it sat ~700px in front of the screen.
      const depth = 700
      const yaw = THREE.MathUtils.clamp(Math.atan2(dx, depth), -maxTurn, maxTurn)
      const pitch = THREE.MathUtils.clamp(Math.atan2(dy, depth), -maxTurn, maxTurn)
      const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 5)
      look.yaw += (yaw - look.yaw) * k
      look.pitch += (pitch - look.pitch) * k
      const kl = reduceMotion ? 1 : 1 - Math.exp(-dt * 3.5)
      look.lx += (THREE.MathUtils.clamp(dx / 180, -4.5, 4.5) - look.lx) * kl
      look.ly += (THREE.MathUtils.clamp(-dy / 180, -3.5, 3.5) - look.ly) * kl

      const t = now / 1000
      mark.rotation.y = look.yaw + (reduceMotion ? 0 : Math.sin(t * 0.7) * 0.03)
      mark.rotation.x = look.pitch + (reduceMotion ? 0 : Math.sin(t * 0.9) * 0.02)
      mark.position.y = reduceMotion ? 0 : Math.sin(t * 1.1) * 0.035
      key.position.set(look.lx, look.ly, 3.6)
      // Swing the reflections the opposite way so the glass catches new light as it turns.
      scene.environmentRotation.set(-look.pitch * 0.8, -look.yaw * 1.4, 0)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      window.removeEventListener('pointermove', onMove)
      for (const g of geometries) g.dispose()
      glass.dispose()
      env.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    }
  }, [size, width])

  if (failed) return <Logo size={size} className={className} />
  return <div ref={ref} style={{ width, height: size }} className={className} aria-label="R-Code" role="img" />
}
