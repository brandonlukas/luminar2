import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

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

const LINE_VERT = /* glsl */ `
  attribute float speed;
  varying float vSpeed;
  void main() {
    vSpeed = speed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LINE_FRAG = /* glsl */ `
  precision highp float;
  varying float vSpeed;
  uniform vec3 uColorSlow;
  uniform vec3 uColorFast;
  uniform float uIntensity;
  void main() {
    vec3 col = mix(uColorSlow, uColorFast, clamp(vSpeed, 0.0, 1.0));
    gl_FragColor = vec4(col * uIntensity, 1.0);
  }
`;

const SPRITE_VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute float aSpeed;
  varying vec2 vCoord;
  varying float vSpeed;
  uniform float uLen;   // half-length in world units at speed 1
  uniform float uWidth; // half-width in world units

  void main() {
    vCoord = position.xy;
    vSpeed = aSpeed;
    vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
    vec3 vdir = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
    float vlen = length(vdir);
    vec3 dir = vlen > 1e-6 ? vdir / vlen : vec3(1.0, 0.0, 0.0);
    vec3 perp = normalize(vec3(-dir.y, dir.x, 1e-4));
    float len = uLen * (0.3 + clamp(aSpeed, 0.0, 1.6));
    mv.xyz += dir * position.x * len + perp * position.y * uWidth;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPRITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vCoord;
  varying float vSpeed;
  uniform vec3 uColorSlow;
  uniform vec3 uColorFast;
  uniform float uIntensity;

  void main() {
    // x: -1 tail .. +1 head. Teardrop: wide bright head, tapering tail.
    float t = vCoord.x * 0.5 + 0.5;
    float env = mix(0.18, 1.0, t);
    float lat = vCoord.y / env;
    float body = max(0.0, 1.0 - lat * lat);
    float shape = smoothstep(0.0, 0.3, t) * (1.0 - smoothstep(0.88, 1.0, t));
    float alpha = body * body * shape * (0.3 + 0.7 * t) * uIntensity;
    vec3 col = mix(uColorSlow, uColorFast, clamp(vSpeed, 0.0, 1.0));
    gl_FragColor = vec4(col * alpha, 1.0);
  }
`;

// Metaball threshold: fat gaussian sprites accumulate; a sharp smoothstep on
// their summed luminance fuses neighbours into one gooey surface.
const GooShader = {
  uniforms: {
    tDiffuse: { value: null },
    uLow: { value: 0.16 },
    uHigh: { value: 0.3 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uLow;
    uniform float uHigh;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = max(c.r, max(c.g, c.b));
      float m = smoothstep(uLow, uHigh, l);
      vec3 base = c.rgb / max(l, 1e-4);
      float body = 0.42 + 0.4 * smoothstep(uHigh, 1.4, l);
      gl_FragColor = vec4(base * m * body, 1.0);
    }
  `,
};

// Ink: runs last, after tone mapping — luminance becomes pigment on paper.
const InkShader = {
  uniforms: {
    tDiffuse: { value: null },
    uPaper: { value: null },
    uInk: { value: null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uPaper;
    uniform vec3 uInk;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
      gl_FragColor = vec4(mix(uPaper, uInk, l), 1.0);
    }
  `,
};

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
    // Line material shares the point material's uniform objects.
    this.lineMaterial = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uColorSlow: this.material.uniforms.uColorSlow,
        uColorFast: this.material.uniforms.uColorFast,
        uIntensity: this.material.uniforms.uIntensity,
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.spriteMaterial = new THREE.ShaderMaterial({
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      uniforms: {
        uColorSlow: this.material.uniforms.uColorSlow,
        uColorFast: this.material.uniforms.uColorFast,
        uIntensity: this.material.uniforms.uIntensity,
        uLen: { value: 1 },
        uWidth: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.points = null;
    this.lines = null;
    this.sprites = null;
    this.mode = 'points';
    this.materialSize = 1;
    this.materialSpeed = 1;
    this.jitter = 0;
    this.lifeScale = 1;
    this.clustered = false;
    this._clusters = [];
    this._intensityScale = 1;

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, new THREE.PerspectiveCamera());
    this.afterimagePass = new AfterimagePass(opts.trails ?? 0.9);
    this.trailDamp = opts.trails ?? 0.9;
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(2, 2), opts.bloom ?? 0.9, 0.65, 0.0);
    this.gooPass = new ShaderPass(GooShader);
    this.gooPass.enabled = false;
    this.inkPass = new ShaderPass(InkShader);
    this.inkPass.uniforms.uPaper.value = new THREE.Color('#faf3e7');
    this.inkPass.uniforms.uInk.value = new THREE.Color('#1a1512');
    this.inkPass.enabled = false;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.afterimagePass);
    this.composer.addPass(this.gooPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.inkPass);

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
    this._applyIntensity();
    this.positions = new Float32Array(n * 3);
    this.speeds = new Float32Array(n);
    this.ages = new Float32Array(n);
    this.lives = new Float32Array(n);
    // Segment buffers for line mode: (prev, curr) pair per particle.
    this.segPositions = new Float32Array(n * 6);
    this.segSpeeds = new Float32Array(n * 2);

    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    if (this.lines) {
      this.scene.remove(this.lines);
      this.lines.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('speed', new THREE.BufferAttribute(this.speeds, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.segPositions, 3).setUsage(THREE.DynamicDrawUsage));
    lineGeo.setAttribute('speed', new THREE.BufferAttribute(this.segSpeeds, 1).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lineGeo, this.lineMaterial);
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);

    // Comet sprites: one quad per particle, stretched along velocity.
    if (this.sprites) {
      this.scene.remove(this.sprites);
      this.sprites.geometry.dispose();
    }
    this.vels = new Float32Array(n * 3);
    const spriteGeo = new THREE.InstancedBufferGeometry();
    spriteGeo.instanceCount = n;
    spriteGeo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    spriteGeo.setIndex([0, 1, 2, 2, 1, 3]);
    spriteGeo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    spriteGeo.setAttribute('aVel', new THREE.InstancedBufferAttribute(this.vels, 3).setUsage(THREE.DynamicDrawUsage));
    spriteGeo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(this.speeds, 1).setUsage(THREE.DynamicDrawUsage));
    this.sprites = new THREE.Mesh(spriteGeo, this.spriteMaterial);
    this.sprites.frustumCulled = false;
    this.scene.add(this.sprites);

    this._applyMode();
    if (this.field) this.reseedAll();
  }

  setMaterial(def) {
    this.mode = def.mode;
    this.materialSize = def.size;
    this.materialSpeed = def.speed;
    this.jitter = def.jitter ?? 0;
    this.lifeScale = def.lifeScale ?? 1;
    this.clustered = !!def.clustered;
    this.clusterSigma = def.clusterSigma;
    this.clusterCount = def.clusterCount;
    this._clusters = [];
    this._intensityScale = def.intensity;
    this._applyIntensity();
    const u = this.material.uniforms;
    u.uColorSlow.value.setRGB(...def.colors[0]);
    u.uColorFast.value.setRGB(...def.colors[1]);
    this.gooPass.enabled = !!def.threshold;
    this.inkPass.enabled = !!def.invert;
    this.setTrails(def.trails);
    this.setBloom(def.bloom);
    this._applyMode();
  }

  _applyMode() {
    if (this.points) this.points.visible = this.mode === 'points';
    if (this.lines) this.lines.visible = this.mode === 'lines';
    if (this.sprites) this.sprites.visible = this.mode === 'sprites';
  }

  _applyIntensity() {
    if (!this.count) return;
    this.material.uniforms.uIntensity.value =
      Math.min(0.9, (0.18 * 18000) / this.count) * this._intensityScale;
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

  // Clustered substances respawn in bursts around drifting seed points, so
  // the flow shears each clump into a flock before it disperses.
  _clusterSpawn(out) {
    if (this._clusters.length === 0) {
      const K = this.clusterCount ?? 7;
      for (let k = 0; k < K; k++) {
        const p = [0, 0, 0];
        this.field.spawn(p);
        this._clusters.push({ p, age: Math.random() * 2, life: 1.5 + Math.random() * 3 });
      }
    }
    const c = this._clusters[(Math.random() * this._clusters.length) | 0];
    const sigma = this.diag * (this.clusterSigma ?? 0.022);
    const g = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.4 * sigma;
    out[0] = c.p[0] + g();
    out[1] = c.p[1] + g();
    out[2] = this.field.is3D ? c.p[2] + g() : 0;
  }

  _respawn(i) {
    if (this.clustered) this._clusterSpawn(this._spawn);
    else this.field.spawn(this._spawn);
    this.positions[i * 3] = this._spawn[0];
    this.positions[i * 3 + 1] = this._spawn[1];
    this.positions[i * 3 + 2] = this._spawn[2];
    this.ages[i] = 0;
    this.lives[i] = (3 + Math.random() * 6) * this.lifeScale;
    this.speeds[i] = 0;
    // Collapse the particle's line segment so no streak spans the jump.
    const s = this.segPositions;
    if (s) {
      s[i * 6] = s[i * 6 + 3] = this._spawn[0];
      s[i * 6 + 1] = s[i * 6 + 4] = this._spawn[1];
      s[i * 6 + 2] = s[i * 6 + 5] = this._spawn[2];
      this.segSpeeds[i * 2] = this.segSpeeds[i * 2 + 1] = 0;
    }
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
    const seg = this.segPositions;
    const segS = this.segSpeeds;
    const lineMode = this.mode === 'lines';
    const v1 = this._v1;
    const v2 = this._v2;
    const b = f.bounds;
    const scale = (this.speed * this.materialSpeed * 0.14 * this.diag) / f.charSpeed;
    const charSpeed = f.charSpeed;
    const jitter = this.jitter * charSpeed;
    const pad = this.diag * 0.03;
    const spriteMode = this.mode === 'sprites';
    const vels = this.vels;

    // Drift cluster seeds through their own lifecycle.
    if (this.clustered) {
      for (const c of this._clusters) {
        c.age += dt;
        if (c.age > c.life) {
          f.spawn(c.p);
          c.age = 0;
          c.life = 1.5 + Math.random() * 3;
        }
      }
    }

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
      let vx = midOk ? v2[0] : v1[0];
      let vy = midOk ? v2[1] : v1[1];
      let vz = midOk ? v2[2] : v1[2];
      if (jitter > 0) {
        vx += (Math.random() - 0.5) * jitter;
        vy += (Math.random() - 0.5) * jitter;
        if (f.is3D) vz += (Math.random() - 0.5) * jitter;
      }
      const ox = x;
      const oy = y;
      const oz = z;
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
      const sp = Math.hypot(vx, vy, vz) / charSpeed;
      this.speeds[i] = sp;

      if (spriteMode) {
        vels[ix] = vx;
        vels[ix + 1] = vy;
        vels[ix + 2] = vz;
      }

      if (lineMode) {
        const si = i * 6;
        // A wrap teleports the particle — collapse that segment.
        const jumped =
          Math.abs(x - ox) > this.diag * 0.25 ||
          Math.abs(y - oy) > this.diag * 0.25 ||
          Math.abs(z - oz) > this.diag * 0.25;
        seg[si] = jumped ? x : ox;
        seg[si + 1] = jumped ? y : oy;
        seg[si + 2] = jumped ? z : oz;
        seg[si + 3] = x;
        seg[si + 4] = y;
        seg[si + 5] = z;
        segS[i * 2] = sp;
        segS[i * 2 + 1] = sp;
      }
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.speed.needsUpdate = true;
    if (lineMode) {
      this.lines.geometry.attributes.position.needsUpdate = true;
      this.lines.geometry.attributes.speed.needsUpdate = true;
    }
    if (spriteMode) {
      const a = this.sprites.geometry.attributes;
      a.aPos.needsUpdate = true;
      a.aVel.needsUpdate = true;
      a.aSpeed.needsUpdate = true;
    }
  }

  _updateUniforms() {
    const u = this.material.uniforms;
    const h = this.container.clientHeight || 2;
    u.uWorldSize.value = this.sizeParam * this.materialSize * this.diag * 0.0038;
    const su = this.spriteMaterial.uniforms;
    su.uLen.value = this.sizeParam * this.materialSize * this.diag * 0.011;
    su.uWidth.value = this.sizeParam * this.materialSize * this.diag * 0.0021;
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
