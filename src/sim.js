import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const VERT = /* glsl */ `
  attribute float speed;
  varying float vSpeed;
  uniform float uWorldSize;   // point diameter in world units
  uniform float uPixPerUnit;  // orthographic pixels per world unit
  uniform float uPerspFactor; // h_px / (2 tan(fov/2))
  uniform float uPersp;       // 1 = perspective camera

  void main() {
    vSpeed = speed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = uPersp > 0.5
      ? uWorldSize * uPerspFactor / max(0.1, -mv.z)
      : uWorldSize * uPixPerUnit;
    gl_PointSize = clamp(px, 1.0, 64.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying float vSpeed;
  uniform vec3 uColorSlow;
  uniform vec3 uColorFast;
  uniform float uIntensity;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.0, d);
    alpha *= alpha * uIntensity;
    vec3 col = mix(uColorSlow, uColorFast, clamp(vSpeed, 0.0, 1.0));
    // Blending is ONE,ONE: color carries all the energy.
    gl_FragColor = vec4(col * alpha, 1.0);
  }
`;

export class FlowSim {
  // opts.controls: 'full' (orbit/zoom/pan), 'rotate' (drag only — the page
  // keeps its scroll wheel), or 'none'. opts.pixelRatio caps DPR per plate.
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.paused = false;
    this.running = true;
    this.speed = opts.speed ?? 1;
    this.sizeParam = opts.size ?? 1;
    this.onStats = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.pixelRatio ?? 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = null;
    this.controls = null;
    this.boundsBox = null;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uWorldSize: { value: 1 },
        uPixPerUnit: { value: 1 },
        uPerspFactor: { value: 1 },
        uPersp: { value: 0 },
        uColorSlow: { value: new THREE.Color(0.07, 0.22, 0.95) },
        uColorFast: { value: new THREE.Color(1.0, 0.82, 0.55) },
        uIntensity: { value: 0.18 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.points = null;

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, new THREE.PerspectiveCamera());
    this.afterimagePass = new AfterimagePass(opts.trails ?? 0.9);
    this.trailDamp = opts.trails ?? 0.9;
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(2, 2), opts.bloom ?? 0.9, 0.65, 0.0);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.afterimagePass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // Simulation state
    this.field = null;
    this.count = 0;
    this.positions = null;
    this.speeds = null;
    this.ages = null;
    this.lives = null;
    this.velScale = 1;
    this.diag = 1;
    this._v1 = [0, 0, 0];
    this._v2 = [0, 0, 0];
    this._spawn = [0, 0, 0];

    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._lastT = performance.now();

    this._resize = this._resize.bind(this);
    this._observer = new ResizeObserver(this._resize);
    this._observer.observe(container);
    this._resize();

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ————— public API —————

  setField(field) {
    this.field = field;
    const b = field.bounds;
    this.diag = Math.hypot(
      b.max[0] - b.min[0],
      b.max[1] - b.min[1],
      b.max[2] - b.min[2]
    ) || 1;
    this._setupCamera();
    this._setupBoundsBox();
    this.reseedAll();
    this.afterimagePass.uniforms.damp.value = 0; // clear stale trails one frame
    this._clearTrailsNext = true;
  }

  setParticleCount(n) {
    this.count = n;
    // Keep accumulated brightness roughly constant as density changes.
    this.material.uniforms.uIntensity.value = Math.min(0.9, (0.18 * 18000) / n);
    this.positions = new Float32Array(n * 3);
    this.speeds = new Float32Array(n);
    this.ages = new Float32Array(n);
    this.lives = new Float32Array(n);

    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('speed', new THREE.BufferAttribute(this.speeds, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    if (this.field) this.reseedAll();
  }

  reseedAll() {
    if (!this.field || !this.positions) return;
    for (let i = 0; i < this.count; i++) this._respawn(i);
    // Stagger ages so lifetimes don't expire in lockstep.
    for (let i = 0; i < this.count; i++) this.ages[i] = Math.random() * this.lives[i];
  }

  setTrails(damp) {
    this.trailDamp = damp;
    this.afterimagePass.uniforms.damp.value = damp;
  }

  setBloom(strength) {
    this.bloomPass.strength = strength;
  }

  // ————— internals —————

  _respawn(i) {
    this.field.spawn(this._spawn);
    this.positions[i * 3] = this._spawn[0];
    this.positions[i * 3 + 1] = this._spawn[1];
    this.positions[i * 3 + 2] = this._spawn[2];
    this.ages[i] = 0;
    this.lives[i] = 3 + Math.random() * 6;
    this.speeds[i] = 0;
  }

  _setupCamera() {
    const b = this.field.bounds;
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;

    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }
    const mode = this.opts.controls ?? 'full';

    if (this.field.is3D) {
      const cam = new THREE.PerspectiveCamera(45, 1, 0.01, this.diag * 20);
      const r = this.diag / 2;
      cam.position.set(cx + r * 1.6, cy - r * 1.9, cz + r * 1.1);
      cam.up.set(0, 0, 1);
      this.camera = cam;
      if (mode !== 'none') {
        this.controls = new OrbitControls(cam, this.renderer.domElement);
        this.controls.target.set(cx, cy, cz);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = 0.4;
        if (mode === 'rotate') {
          this.controls.enableZoom = false;
          this.controls.enablePan = false;
        }
        this.controls.addEventListener('start', () => {
          this.controls.autoRotate = false;
        });
      }
    } else {
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
      cam.position.set(cx, cy, 10);
      cam.lookAt(cx, cy, 0);
      this.camera = cam;
      // 2D plates with 'rotate' get no controls at all — nothing to rotate,
      // and the page keeps its wheel.
      if (mode === 'full') {
        this.controls = new OrbitControls(cam, this.renderer.domElement);
        this.controls.target.set(cx, cy, 0);
        this.controls.enableRotate = false;
        this.controls.screenSpacePanning = true;
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.12;
      }
    }
    this.renderPass.camera = this.camera;
    this._resize();
  }

  _setupBoundsBox() {
    if (this.boundsBox) {
      this.scene.remove(this.boundsBox);
      this.boundsBox.geometry.dispose();
      this.boundsBox.material.dispose();
      this.boundsBox = null;
    }
    if (!this.field.is3D) return;
    const b = this.field.bounds;
    const geo = new THREE.BoxGeometry(
      b.max[0] - b.min[0],
      b.max[1] - b.min[1],
      b.max[2] - b.min[2]
    );
    const edges = new THREE.EdgesGeometry(geo);
    geo.dispose();
    const mat = new THREE.LineBasicMaterial({ color: 0x16161e });
    this.boundsBox = new THREE.LineSegments(edges, mat);
    this.boundsBox.position.set(
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2
    );
    this.scene.add(this.boundsBox);
  }

  _resize() {
    const w = this.container.clientWidth || 2;
    const h = this.container.clientHeight || 2;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);

    if (!this.camera) return;
    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    } else {
      const b = this.field.bounds;
      const margin = 1.12;
      const bw = (b.max[0] - b.min[0]) * margin || 1;
      const bh = (b.max[1] - b.min[1]) * margin || 1;
      const aspect = w / h;
      let vw = bw;
      let vh = bh;
      if (vw / vh < aspect) vw = vh * aspect;
      else vh = vw / aspect;
      this.camera.left = -vw / 2;
      this.camera.right = vw / 2;
      this.camera.top = vh / 2;
      this.camera.bottom = -vh / 2;
      this.camera.updateProjectionMatrix();
    }
  }

  _updateParticles(dt) {
    const f = this.field;
    const p = this.positions;
    const v1 = this._v1;
    const v2 = this._v2;
    const b = f.bounds;
    const scale = (this.speed * 0.14 * this.diag) / f.charSpeed;
    const charSpeed = f.charSpeed;
    const pad = this.diag * 0.03;

    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      let x = p[ix];
      let y = p[ix + 1];
      let z = p[ix + 2];

      if (!f.sample(x, y, z, v1)) {
        this._respawn(i);
        continue;
      }
      // RK2 midpoint step
      const h = dt * scale;
      const mx = x + v1[0] * h * 0.5;
      const my = y + v1[1] * h * 0.5;
      const mz = z + v1[2] * h * 0.5;
      const midOk = f.sample(mx, my, mz, v2);
      const vx = midOk ? v2[0] : v1[0];
      const vy = midOk ? v2[1] : v1[1];
      const vz = midOk ? v2[2] : v1[2];
      x += vx * h;
      y += vy * h;
      z += vz * h;

      if (f.wrap) {
        for (let a = 0; a < 3; a++) {
          const lo = b.min[a];
          const span = b.max[a] - lo;
          if (span > 0) {
            let c = a === 0 ? x : a === 1 ? y : z;
            c = ((((c - lo) % span) + span) % span) + lo;
            if (a === 0) x = c;
            else if (a === 1) y = c;
            else z = c;
          }
        }
      }

      this.ages[i] += dt;
      const out =
        x < b.min[0] - pad || x > b.max[0] + pad ||
        y < b.min[1] - pad || y > b.max[1] + pad ||
        (f.is3D && (z < b.min[2] - pad || z > b.max[2] + pad));

      if (this.ages[i] > this.lives[i] || out) {
        this._respawn(i);
        continue;
      }

      p[ix] = x;
      p[ix + 1] = y;
      p[ix + 2] = z;
      this.speeds[i] = Math.hypot(vx, vy, vz) / charSpeed;
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.speed.needsUpdate = true;
  }

  _updateUniforms() {
    const u = this.material.uniforms;
    const h = this.container.clientHeight || 2;
    u.uWorldSize.value = this.sizeParam * this.diag * 0.0038;
    if (this.camera.isPerspectiveCamera) {
      u.uPersp.value = 1;
      u.uPerspFactor.value =
        (h * this.renderer.getPixelRatio()) /
        (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    } else {
      u.uPersp.value = 0;
      const viewH = (this.camera.top - this.camera.bottom) / this.camera.zoom;
      u.uPixPerUnit.value = (h * this.renderer.getPixelRatio()) / viewH;
    }
  }

  _loop(now) {
    requestAnimationFrame(this._loop);
    const dt = Math.min((now - this._lastT) / 1000, 0.05);
    this._lastT = now;
    if (!this.running) return; // offscreen — keep the clock, skip the work

    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      if (this.onStats) this.onStats(Math.round(this._fpsFrames / this._fpsAcc));
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }

    if (!this.field || !this.points) return;

    if (this.controls) this.controls.update();
    if (!this.paused && dt > 0) this._updateParticles(dt);
    this._updateUniforms();
    this.composer.render();

    if (this._clearTrailsNext) {
      this._clearTrailsNext = false;
      this.afterimagePass.uniforms.damp.value = this.trailDamp ?? 0.9;
    }
  }
}
