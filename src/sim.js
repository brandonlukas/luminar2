import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// uStyle: 0 plain · 1 fireflies (blink) · 2 embers (cooling ramp)
const VERT = /* glsl */ `
  attribute float speed;
  attribute float aAgeN;
  attribute float aPhase;
  varying float vSpeed;
  varying float vAgeN;
  varying float vPhase;
  uniform float uWorldSize;   // point diameter in world units
  uniform float uPixPerUnit;  // orthographic pixels per world unit
  uniform float uPerspFactor; // h_px / (2 tan(fov/2))
  uniform float uPersp;       // 1 = perspective camera
  uniform float uStyle;

  void main() {
    vSpeed = speed;
    vAgeN = aAgeN;
    vPhase = aPhase;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = uPersp > 0.5
      ? uWorldSize * uPerspFactor / max(0.1, -mv.z)
      : uWorldSize * uPixPerUnit;
    gl_PointSize = clamp(px, 1.0, 96.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  varying float vSpeed;
  varying float vAgeN;
  varying float vPhase;
  uniform vec3 uColorSlow;
  uniform vec3 uColorFast;
  uniform float uIntensity;
  uniform float uStyle;
  uniform float uTime;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.0, d);
    alpha *= alpha;
    vec3 col = mix(uColorSlow, uColorFast, clamp(vSpeed, 0.0, 1.0));
    if (uStyle > 0.5 && uStyle < 1.5) {
      // fireflies: slow out-of-phase blinks over a faint body
      float pulse = pow(max(sin(uTime * 1.6 + vPhase * 6.2832), 0.0), 6.0);
      alpha *= 0.05 + 0.95 * pulse;
    } else if (uStyle > 1.5) {
      // embers: age is a cooling clock — white to amber to dull red to dark
      float t = clamp(vAgeN, 0.0, 1.0);
      col = vec3(1.0, 0.95 * pow(1.0 - t, 1.6), 0.85 * pow(1.0 - t, 3.5));
      alpha *= 1.0 - t * t;
    }
    alpha *= uIntensity;
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

// uSpriteStyle: 0 comet teardrop · 1 fish (procedural koi, tail wiggle) · 2 glyph atlas
const SPRITE_VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute float aSpeed;
  attribute float aSPhase;
  attribute float aAgeN;
  varying vec2 vCoord;
  varying float vSpeed;
  varying float vPhase;
  varying float vAgeN;
  varying vec3 vView;
  uniform float uLen;   // half-length in world units at speed 1
  uniform float uWidth; // half-width in world units
  uniform float uSpriteStyle;
  uniform float uSpriteFade; // 0 for frozen substances (filings)

  void main() {
    vCoord = position.xy;
    vSpeed = aSpeed;
    vPhase = aSPhase;
    vAgeN = aAgeN;
    vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
    vec3 vdir = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
    float vlen = length(vdir);
    vec3 dir = vlen > 1e-6 ? vdir / vlen : vec3(1.0, 0.0, 0.0);
    vec3 perp = normalize(vec3(-dir.y, dir.x, 1e-4));
    float lf = mix(1.0, smoothstep(0.0, 0.1, aAgeN) * (1.0 - smoothstep(0.8, 1.0, aAgeN)), uSpriteFade);
    float len;
    float wid;
    if (uSpriteStyle > 2.5) {          // wisp: grows and stretches with age
      len = uLen * (0.8 + 0.9 * clamp(aAgeN, 0.0, 1.0));
      wid = uLen * (0.45 + 0.5 * clamp(aAgeN, 0.0, 1.0));
    } else if (uSpriteStyle > 1.5) {   // glyphs: square, unstretched
      len = uLen;
      wid = uLen;
    } else if (uSpriteStyle > 0.5) {   // fish: mild stretch, plump body,
      // per-fish scale for a near/far depth illusion; fading fish shrink
      float sc = mix(0.55, 1.6, fract(aSPhase * 3.77)) * (0.4 + 0.6 * lf);
      len = uLen * sc * (0.75 + 0.45 * clamp(aSpeed, 0.0, 1.0));
      wid = uWidth * 3.4 * sc;
    } else {                            // comet: speed-stretched streak
      len = uLen * (0.3 + clamp(aSpeed, 0.0, 1.6));
      wid = uWidth;
    }
    mv.xyz += dir * position.x * len + perp * position.y * wid;
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPRITE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vCoord;
  varying float vSpeed;
  varying float vPhase;
  varying float vAgeN;
  varying vec3 vView;
  uniform vec3 uColorSlow;
  uniform vec3 uColorFast;
  uniform float uIntensity;
  uniform float uSpriteStyle;
  uniform float uSpriteFade;
  uniform float uTime;
  uniform float uWispFreq;
  uniform sampler2D uAtlas;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5;
    float s = 0.0;
    for (int k = 0; k < 3; k++) {
      s += a * vnoise(p);
      p *= 2.13;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    vec3 col = mix(uColorSlow, uColorFast, clamp(vSpeed, 0.0, 1.0));
    // gentle fade in/out over each particle's life (frozen substances skip it)
    float lifeFade = mix(1.0, smoothstep(0.0, 0.1, vAgeN) * (1.0 - smoothstep(0.8, 1.0, vAgeN)), uSpriteFade);

    if (uSpriteStyle > 2.5) {
      // wisp: sprites are soft windows onto ONE world-anchored fog. The
      // noise lives in world space, so interiors flow as sprites move and
      // neighbours align seamlessly; domain warping makes the fog curl.
      vec2 wp = vView.xy * uWispFreq;
      float tt = uTime * 0.18;
      float warp = fbm(wp * 0.7 + vec2(tt * 0.6, -tt * 0.4));
      float n = fbm(wp + warp * 1.6 + vec2(-tt, tt * 0.5));
      // elliptical falloff that reaches exactly zero well inside the quad
      float d2 = vCoord.x * vCoord.x + vCoord.y * vCoord.y * 1.8;
      float e = exp(-d2 * 2.2);
      float env = max(0.0, (e - 0.11) / 0.89);
      float dens = smoothstep(0.42, 0.72, n) * env;
      float fadeA = pow(max(0.0, sin(3.1416 * min(vAgeN, 1.0))), 1.3);
      gl_FragColor = vec4(col * (dens * fadeA * uIntensity), 1.0);
      return;
    }

    if (uSpriteStyle > 1.5) {
      // glyph from the atlas; the quad's velocity alignment rotates it
      float cell = floor(fract(vPhase * 7.31) * 8.0);
      vec2 uv = vec2((cell + vCoord.x * 0.5 + 0.5) / 8.0, vCoord.y * 0.5 + 0.5);
      float a = texture2D(uAtlas, uv).a;
      gl_FragColor = vec4(col * a * uIntensity * lifeFade, 1.0);
      return;
    }

    if (uSpriteStyle > 0.5) {
      // procedural koi: head at +x, swimming wiggle grows toward the tail
      float xx = vCoord.x;
      float tailw = 1.0 - (xx * 0.5 + 0.5);
      float yy = vCoord.y + sin(uTime * 6.0 + vPhase * 6.2832 + xx * 2.4) * 0.3 * tailw;
      float bodyw = 0.6 * sqrt(max(0.0, (1.0 - xx) * (xx + 0.45) / 0.75));
      float body = xx > -0.45 ? smoothstep(0.05, -0.03, abs(yy) - bodyw) : 0.0;
      float finw = 0.6 * (-xx - 0.3);
      float fin = xx < -0.3 ? smoothstep(0.05, -0.05, abs(yy) - finw) : 0.0;
      float m = max(body, fin * 0.9);
      // shoal palette: orange, gold, magenta, teal — picked per fish
      float hp = fract(vPhase * 5.17);
      vec3 base =
        hp < 0.50 ? mix(vec3(1.0, 0.18, 0.02), vec3(1.0, 0.48, 0.05), hp / 0.50) :
        hp < 0.75 ? mix(vec3(1.0, 0.62, 0.08), vec3(1.0, 0.85, 0.28), (hp - 0.50) / 0.25) :
        hp < 0.88 ? mix(vec3(0.92, 0.10, 0.38), vec3(0.72, 0.18, 0.72), (hp - 0.75) / 0.13) :
                    mix(vec3(0.08, 0.62, 0.75), vec3(0.32, 0.85, 0.88), (hp - 0.88) / 0.12);
      // calico patches on roughly half the fish
      float mottle = smoothstep(0.25, 0.6, sin(vPhase * 61.7 + xx * 5.3) * sin(vPhase * 23.3 + yy * 7.1));
      base = mix(base, vec3(1.0, 0.97, 0.9), mottle * step(0.5, fract(vPhase * 2.71)) * 0.6);
      // cylindrical shading: dark back, pale belly, rounded flanks
      float lat = bodyw > 1e-4 ? clamp(yy / bodyw, -1.0, 1.0) : 0.0;
      base *= 0.72 + 0.28 * sqrt(max(0.0, 1.0 - lat * lat));
      base = mix(base, base * 0.5, smoothstep(0.1, 0.95, lat));
      base = mix(base, vec3(1.0, 0.98, 0.92), smoothstep(-0.2, -0.95, lat) * 0.35);
      // crisp dark rim so the silhouette reads as a cut-out
      float rim = 1.0 - smoothstep(0.0, 0.10, bodyw - abs(yy));
      base *= 1.0 - 0.45 * rim * body;
      base *= 0.75 + 0.4 * clamp(vSpeed, 0.0, 1.0);
      gl_FragColor = vec4(base * m * uIntensity * lifeFade, 1.0);
      return;
    }

    // comet teardrop: wide bright head, tapering tail
    float t = vCoord.x * 0.5 + 0.5;
    float env = mix(0.18, 1.0, t);
    float lat = vCoord.y / env;
    float body = max(0.0, 1.0 - lat * lat);
    float shape = smoothstep(0.0, 0.3, t) * (1.0 - smoothstep(0.88, 1.0, t));
    float alpha = body * body * shape * (0.3 + 0.7 * t) * uIntensity * lifeFade;
    gl_FragColor = vec4(col * alpha, 1.0);
  }
`;

const BUBBLE_VERT = /* glsl */ `
  attribute float aBAge;
  attribute float aBSize;
  varying float vAge;
  uniform float uPixPerUnit;
  uniform float uPerspFactor;
  uniform float uPersp;

  void main() {
    vAge = aBAge;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float ws = aBSize * (0.7 + 0.6 * clamp(aBAge, 0.0, 1.0));
    float px = uPersp > 0.5
      ? ws * uPerspFactor / max(0.1, -mv.z)
      : ws * uPixPerUnit;
    gl_PointSize = clamp(px, 1.0, 40.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const BUBBLE_FRAG = /* glsl */ `
  precision highp float;
  varying float vAge;

  void main() {
    vec2 pc = gl_PointCoord;
    float d = length(pc - 0.5);
    float ring = smoothstep(0.10, 0.03, abs(d - 0.33));
    float glint = smoothstep(0.09, 0.0, length(pc - vec2(0.62, 0.35)));
    float fade = pow(max(0.0, sin(3.1416 * min(vAge, 1.0))), 0.75);
    vec3 col = vec3(0.75, 0.88, 1.0);
    gl_FragColor = vec4(col * (ring * 0.45 + glint * 0.7) * fade * 0.55, 1.0);
  }
`;

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
        uStyle: { value: 0 },
        uTime: { value: 0 },
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
    // Glyph atlas: 8 symbols drawn once into a canvas texture. The sprite
    // quad's velocity alignment rotates them — arrows point downstream free.
    const atlas = document.createElement('canvas');
    atlas.width = 512;
    atlas.height = 64;
    const actx = atlas.getContext('2d');
    actx.fillStyle = '#fff';
    actx.font = '46px ui-monospace, Menlo, monospace';
    actx.textAlign = 'center';
    actx.textBaseline = 'middle';
    ['→', '▸', '△', '＋', '≈', '✳', '◦', '·'].forEach((ch, i) => {
      actx.fillText(ch, i * 64 + 32, 34);
    });
    this.atlasTex = new THREE.CanvasTexture(atlas);

    this.spriteMaterial = new THREE.ShaderMaterial({
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      uniforms: {
        uColorSlow: this.material.uniforms.uColorSlow,
        uColorFast: this.material.uniforms.uColorFast,
        uIntensity: this.material.uniforms.uIntensity,
        uLen: { value: 1 },
        uWidth: { value: 1 },
        uSpriteStyle: { value: 0 },
        uSpriteFade: { value: 1 },
        uTime: this.material.uniforms.uTime,
        uWispFreq: { value: 1 },
        uAtlas: { value: this.atlasTex },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    // Constellation links get their own (dimmer) intensity.
    this.linkMaterial = new THREE.ShaderMaterial({
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      uniforms: {
        uColorSlow: this.material.uniforms.uColorSlow,
        uColorFast: this.material.uniforms.uColorFast,
        uIntensity: { value: 0.3 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.bubbleMaterial = new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VERT,
      fragmentShader: BUBBLE_FRAG,
      uniforms: {
        uPixPerUnit: this.material.uniforms.uPixPerUnit,
        uPerspFactor: this.material.uniforms.uPerspFactor,
        uPersp: this.material.uniforms.uPersp,
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.points = null;
    this.lines = null;
    this.sprites = null;
    this.bubblesObj = null;
    this.showBubbles = false;
    this.links = null;
    this.mode = 'points';
    this.materialSize = 1;
    this.materialSpeed = 1;
    this.jitter = 0;
    this.lifeScale = 1;
    this.clustered = false;
    this.frozen = false;
    this.showLinks = false;
    this._clusters = [];
    this._intensityScale = 1;
    this._time = 0;
    this._stirPrev = null;

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, new THREE.PerspectiveCamera());
    this.afterimagePass = new AfterimagePass(opts.trails ?? 0.9);
    this.trailDamp = opts.trails ?? 0.9;
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(2, 2), opts.bloom ?? 0.9, 0.65, 0.0);
    this.inkPass = new ShaderPass(InkShader);
    this.inkPass.uniforms.uPaper.value = new THREE.Color('#faf3e7');
    this.inkPass.uniforms.uInk.value = new THREE.Color('#1a1512');
    this.inkPass.enabled = false;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.afterimagePass);
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

    // Stirrable fields (field.stir) take the pointer.
    const el = this.renderer.domElement;
    const onStir = (e) => {
      const f = this.field;
      if (!f || !f.stir || !this.camera || this.camera.isPerspectiveCamera) return;
      const r = el.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const w = new THREE.Vector3(nx, ny, 0).unproject(this.camera);
      if (this._stirPrev) {
        f.stir(w.x, w.y, w.x - this._stirPrev.x, w.y - this._stirPrev.y);
      }
      this._stirPrev = { x: w.x, y: w.y };
    };
    el.addEventListener('pointermove', onStir);
    el.addEventListener('pointerdown', onStir);
    el.addEventListener('pointerleave', () => { this._stirPrev = null; });

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
    this.agesN = new Float32Array(n);
    this.phases = new Float32Array(n);
    for (let i = 0; i < n; i++) this.phases[i] = Math.random();
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
    geo.setAttribute('aAgeN', new THREE.BufferAttribute(this.agesN, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(this.phases, 1));
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
    spriteGeo.setAttribute('aSPhase', new THREE.InstancedBufferAttribute(this.phases, 1));
    spriteGeo.setAttribute('aAgeN', new THREE.InstancedBufferAttribute(this.agesN, 1).setUsage(THREE.DynamicDrawUsage));
    this.sprites = new THREE.Mesh(spriteGeo, this.spriteMaterial);
    this.sprites.frustumCulled = false;
    this.scene.add(this.sprites);

    // Constellation links: preallocated segment pool, drawRange per frame.
    if (this.links) {
      this.scene.remove(this.links);
      this.links.geometry.dispose();
    }
    this.maxLinks = 6000;
    this.linkPositions = new Float32Array(this.maxLinks * 6);
    this.linkSpeeds = new Float32Array(this.maxLinks * 2);
    const linkGeo = new THREE.BufferGeometry();
    linkGeo.setAttribute('position', new THREE.BufferAttribute(this.linkPositions, 3).setUsage(THREE.DynamicDrawUsage));
    linkGeo.setAttribute('speed', new THREE.BufferAttribute(this.linkSpeeds, 1).setUsage(THREE.DynamicDrawUsage));
    this.links = new THREE.LineSegments(linkGeo, this.linkMaterial);
    this.links.frustumCulled = false;
    this.scene.add(this.links);

    // Bubbles: a small fixed overlay pool (shoal only).
    if (this.bubblesObj) {
      this.scene.remove(this.bubblesObj);
      this.bubblesObj.geometry.dispose();
    }
    const NB = (this.bubbleCount = 300);
    this.bPos = new Float32Array(NB * 3);
    this.bAgeN = new Float32Array(NB);
    this.bAge = new Float32Array(NB);
    this.bLife = new Float32Array(NB);
    this.bPhase = new Float32Array(NB);
    this.bSize = new Float32Array(NB);
    for (let i = 0; i < NB; i++) {
      this.bPhase[i] = Math.random();
      this.bAge[i] = Math.random() * 2;
      this.bLife[i] = 1.5 + Math.random() * 2.5;
    }
    const bubGeo = new THREE.BufferGeometry();
    bubGeo.setAttribute('position', new THREE.BufferAttribute(this.bPos, 3).setUsage(THREE.DynamicDrawUsage));
    bubGeo.setAttribute('aBAge', new THREE.BufferAttribute(this.bAgeN, 1).setUsage(THREE.DynamicDrawUsage));
    bubGeo.setAttribute('aBSize', new THREE.BufferAttribute(this.bSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.bubblesObj = new THREE.Points(bubGeo, this.bubbleMaterial);
    this.bubblesObj.frustumCulled = false;
    this.scene.add(this.bubblesObj);

    this._applyMode();
    if (this.field) this.reseedAll();
  }

  setMaterial(def) {
    this.mode = def.mode;
    this.materialSize = def.size;
    this.materialSpeed = def.speed;
    this.jitter = def.jitter ?? 0;
    this.lifeScale = def.lifeScale ?? 1;
    this.frozen = !!def.frozen;
    this.showLinks = !!def.links;
    this.showBubbles = !!def.bubbles;
    this._intensityScale = def.intensity;
    this._applyIntensity();
    const u = this.material.uniforms;
    u.uColorSlow.value.setRGB(...def.colors[0]);
    u.uColorFast.value.setRGB(...def.colors[1]);
    u.uStyle.value = def.style ?? 0;
    this.spriteMaterial.uniforms.uSpriteStyle.value = def.spriteStyle ?? 0;
    this.spriteMaterial.uniforms.uSpriteFade.value = def.frozen ? 0 : 1;
    this.inkPass.enabled = !!def.invert;
    this.setTrails(def.trails);
    this.setBloom(def.bloom);
    this._applyMode();
    if (this.field && this.positions) this.reseedAll();
  }

  setGusts(on) {
    this.clustered = on;
    this._clusters = [];
  }

  clearTrails() {
    this.afterimagePass.uniforms.damp.value = 0;
    this._clearTrailsNext = true;
  }

  _applyMode() {
    if (this.points) this.points.visible = this.mode === 'points';
    if (this.lines) this.lines.visible = this.mode === 'lines';
    if (this.sprites) this.sprites.visible = this.mode === 'sprites' || this.frozen;
    if (this.links) this.links.visible = this.showLinks;
    if (this.bubblesObj) this.bubblesObj.visible = this.showBubbles;
  }

  _applyIntensity() {
    if (!this.count) return;
    this.material.uniforms.uIntensity.value =
      Math.min(0.9, (0.18 * 18000) / this.count) * this._intensityScale;
  }

  reseedAll() {
    if (!this.field || !this.positions) return;
    if (this.frozen) {
      this._layoutGrid();
      return;
    }
    for (let i = 0; i < this.count; i++) this._respawn(i);
    // Stagger ages so lifetimes don't expire in lockstep.
    for (let i = 0; i < this.count; i++) this.ages[i] = Math.random() * this.lives[i];
  }

  // Filings: park particles on a regular grid over the field bounds.
  _layoutGrid() {
    const b = this.field.bounds;
    const n = this.count;
    const bw = b.max[0] - b.min[0] || 1;
    const bh = b.max[1] - b.min[1] || 1;
    const far = b.min[0] - this.diag * 20; // parking lot for leftovers
    if (this.field.is3D) {
      const side = Math.floor(Math.cbrt(n));
      const bd = b.max[2] - b.min[2] || 1;
      for (let i = 0; i < n; i++) {
        const gx = i % side;
        const gy = ((i / side) | 0) % side;
        const gz = (i / (side * side)) | 0;
        const used = gz < side;
        this.positions[i * 3] = used ? b.min[0] + ((gx + 0.5) / side) * bw : far;
        this.positions[i * 3 + 1] = used ? b.min[1] + ((gy + 0.5) / side) * bh : far;
        this.positions[i * 3 + 2] = used ? b.min[2] + ((gz + 0.5) / side) * bd : 0;
      }
    } else {
      const cols = Math.max(2, Math.round(Math.sqrt((n * bw) / bh)));
      const rows = Math.max(2, Math.floor(n / cols));
      for (let i = 0; i < n; i++) {
        const gx = i % cols;
        const gy = (i / cols) | 0;
        const used = gy < rows;
        this.positions[i * 3] = used ? b.min[0] + ((gx + 0.5) / cols) * bw : far;
        this.positions[i * 3 + 1] = used ? b.min[1] + ((gy + 0.5) / rows) * bh : far;
        this.positions[i * 3 + 2] = 0;
      }
    }
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
      const K = 8;
      for (let k = 0; k < K; k++) {
        const p = [0, 0, 0];
        this.field.spawn(p);
        this._clusters.push({ p, age: Math.random() * 2, life: 1.5 + Math.random() * 3 });
      }
    }
    const c = this._clusters[(Math.random() * this._clusters.length) | 0];
    const sigma = this.diag * 0.038;
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
    // A stirrable field owns the pointer: no pan/zoom, no page-scroll theft.
    if (this.field.stir) {
      if (this.controls) this.controls.enabled = false;
      this.renderer.domElement.style.touchAction = 'none';
    } else {
      this.renderer.domElement.style.touchAction = '';
    }
    this._stirPrev = null;
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

    // Filings: no motion — just re-ask the field so dashes track live fields.
    if (this.frozen) {
      for (let i = 0; i < this.count; i++) {
        const ok = f.sample(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], v1);
        vels[i * 3] = ok ? v1[0] : 0;
        vels[i * 3 + 1] = ok ? v1[1] : 0;
        vels[i * 3 + 2] = ok ? v1[2] : 0;
        this.speeds[i] = ok ? Math.hypot(v1[0], v1[1], v1[2]) / charSpeed : 0;
      }
      const a = this.sprites.geometry.attributes;
      a.aPos.needsUpdate = true;
      a.aVel.needsUpdate = true;
      a.aSpeed.needsUpdate = true;
      return;
    }

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
      this.agesN[i] = this.ages[i] / this.lives[i];

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
    this.points.geometry.attributes.aAgeN.needsUpdate = true;
    if (lineMode) {
      this.lines.geometry.attributes.position.needsUpdate = true;
      this.lines.geometry.attributes.speed.needsUpdate = true;
    }
    if (spriteMode) {
      const a = this.sprites.geometry.attributes;
      a.aPos.needsUpdate = true;
      a.aVel.needsUpdate = true;
      a.aSpeed.needsUpdate = true;
      a.aAgeN.needsUpdate = true;
    }
    if (this.showLinks) this._updateLinks();
    if (this.showBubbles) this._updateBubbles(dt, scale, charSpeed);
  }

  // Bubbles ride a damped copy of the flow, rise, wobble, and respawn
  // wherever a fish currently is.
  _updateBubbles(dt, scale, charSpeed) {
    const f = this.field;
    const b = f.bounds;
    const v1 = this._v1;
    const pad = this.diag * 0.05;
    const h = dt * scale;
    const rise = 0.25 * charSpeed;
    const NB = this.bubbleCount;
    for (let i = 0; i < NB; i++) {
      this.bAge[i] += dt;
      let x = this.bPos[i * 3];
      let y = this.bPos[i * 3 + 1];
      let z = this.bPos[i * 3 + 2];
      const out =
        x < b.min[0] - pad || x > b.max[0] + pad ||
        y < b.min[1] - pad || y > b.max[1] + pad ||
        (f.is3D && (z < b.min[2] - pad || z > b.max[2] + pad));
      if (this.bAge[i] > this.bLife[i] || out) {
        const j = (Math.random() * this.count) | 0;
        const jr = this.diag * 0.015;
        x = this.positions[j * 3] + (Math.random() - 0.5) * jr;
        y = this.positions[j * 3 + 1] + (Math.random() - 0.5) * jr;
        z = f.is3D ? this.positions[j * 3 + 2] + (Math.random() - 0.5) * jr : 0;
        this.bAge[i] = 0;
        this.bLife[i] = 1.5 + Math.random() * 2.5;
        this.bSize[i] = this.diag * (0.0025 + Math.random() * 0.005);
      }
      const ok = f.sample(x, y, z, v1);
      const wob = Math.sin(this._time * 3 + this.bPhase[i] * 6.2832) * 0.15 * charSpeed;
      x += ((ok ? v1[0] : 0) * 0.35 + wob) * h;
      y += ((ok ? v1[1] : 0) * 0.35 + (f.is3D ? 0 : rise)) * h;
      if (f.is3D) z += ((ok ? v1[2] : 0) * 0.35 + rise) * h;
      this.bPos[i * 3] = x;
      this.bPos[i * 3 + 1] = y;
      this.bPos[i * 3 + 2] = z;
      this.bAgeN[i] = this.bAge[i] / this.bLife[i];
    }
    const a = this.bubblesObj.geometry.attributes;
    a.position.needsUpdate = true;
    a.aBAge.needsUpdate = true;
    a.aBSize.needsUpdate = true;
  }

  // Constellation: connect close pairs via a per-frame spatial hash.
  _updateLinks() {
    const n = this.count;
    const linkR = this.diag * 0.055;
    const r2 = linkR * linkR;
    const cell = linkR;
    const grid = new Map();
    const p = this.positions;
    const is3D = this.field.is3D;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(p[i * 3] / cell);
      const cy = Math.floor(p[i * 3 + 1] / cell);
      const cz = is3D ? Math.floor(p[i * 3 + 2] / cell) : 0;
      const key = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
      let b = grid.get(key);
      if (!b) grid.set(key, (b = []));
      b.push(i);
    }
    let m = 0;
    const L = this.linkPositions;
    const LS = this.linkSpeeds;
    const zr = is3D ? 1 : 0;
    outer:
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(p[i * 3] / cell);
      const cy = Math.floor(p[i * 3 + 1] / cell);
      const cz = is3D ? Math.floor(p[i * 3 + 2] / cell) : 0;
      for (let dz = -zr; dz <= zr; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const b = grid.get(((cx + dx) * 73856093) ^ ((cy + dy) * 19349663) ^ ((cz + dz) * 83492791));
            if (!b) continue;
            for (const j of b) {
              if (j <= i) continue;
              const ax = p[i * 3] - p[j * 3];
              const ay = p[i * 3 + 1] - p[j * 3 + 1];
              const az = p[i * 3 + 2] - p[j * 3 + 2];
              const d2 = ax * ax + ay * ay + az * az;
              if (d2 < r2) {
                const o = m * 6;
                L[o] = p[i * 3]; L[o + 1] = p[i * 3 + 1]; L[o + 2] = p[i * 3 + 2];
                L[o + 3] = p[j * 3]; L[o + 4] = p[j * 3 + 1]; L[o + 5] = p[j * 3 + 2];
                const s = 1 - d2 / r2; // fade with distance via the speed ramp
                LS[m * 2] = s; LS[m * 2 + 1] = s;
                if (++m >= this.maxLinks) break outer;
              }
            }
          }
        }
      }
    }
    this.links.geometry.setDrawRange(0, m * 2);
    this.links.geometry.attributes.position.needsUpdate = true;
    this.links.geometry.attributes.speed.needsUpdate = true;
  }

  _updateUniforms() {
    const u = this.material.uniforms;
    const h = this.container.clientHeight || 2;
    u.uWorldSize.value = this.sizeParam * this.materialSize * this.diag * 0.0038;
    const su = this.spriteMaterial.uniforms;
    su.uLen.value = this.sizeParam * this.materialSize * this.diag * 0.011;
    su.uWidth.value = this.sizeParam * this.materialSize * this.diag * 0.0021;
    su.uWispFreq.value = 9.0 / this.diag;
    this.linkMaterial.uniforms.uIntensity.value = this.material.uniforms.uIntensity.value * 0.12;
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
      if (this.onStats) {
        this.onStats(
          Math.round(this._fpsFrames / this._fpsAcc),
          (this._simMsAcc ?? 0) / Math.max(1, this._fpsFrames)
        );
      }
      this._fpsAcc = 0;
      this._fpsFrames = 0;
      this._simMsAcc = 0;
    }

    if (!this.field || !this.points) return;

    this._time += dt;
    this.material.uniforms.uTime.value = this._time;
    if (this.controls) this.controls.update();
    const simT0 = performance.now();
    if (this.field.update && !this.paused && dt > 0) this.field.update(dt);
    if (!this.paused && dt > 0) this._updateParticles(dt);
    this._simMsAcc = (this._simMsAcc ?? 0) + (performance.now() - simT0);
    this._updateUniforms();
    this.composer.render();

    if (this._clearTrailsNext) {
      this._clearTrailsNext = false;
      this.afterimagePass.uniforms.damp.value = this.trailDamp ?? 0.9;
    }
  }
}
