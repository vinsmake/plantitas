// Condensation — a fogged greenhouse pane you can wipe.
//
// The fog is a low-res Float32 mask (1 = wiped clear) that slowly fogs back
// over. Drips are simulated here and drawn into a small 2D canvas as a
// normal map (RG = normal, A = coverage); the shader refracts the sharp
// photo through them. Beads of condensation are procedural (screen space).

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSharp;
uniform sampler2D uFog;
uniform sampler2D uMask;
uniform sampler2D uDrops;
uniform vec2 uRes;     // device px
uniform vec2 uImg;     // photo size
uniform float uZoom;
uniform float uDpr;
uniform float uTime;
uniform float uBlade;  // squeegee edge, 0 top → 1 bottom (-1 = none)
out vec4 o;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash22(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

vec2 cover(vec2 f) {
  float ra = uRes.x / uRes.y, ia = uImg.x / uImg.y;
  vec2 s = ra > ia ? vec2(1.0, ia / ra) : vec2(ra / ia, 1.0);
  vec2 uv = (f - 0.5) * s / uZoom + 0.5;
  uv.y += (0.56 - 0.5) * (1.0 - s.y);           // frame a little below centre
  return uv;
}

void main() {
  vec2 f = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y); // y down
  vec2 uv = cover(f);
  vec3 sharpC = texture(uSharp, uv).rgb;

  float clear = texture(uMask, f).r;
  if (uBlade >= 0.0) clear = max(clear, smoothstep(uBlade + 0.006, uBlade - 0.006, f.y));
  vec2 px = gl_FragCoord.xy / uDpr;              // css px, y up
  float dens = 0.82 + 0.18 * vnoise(px * 0.012 + vec2(0.0, uTime * 0.02)) ;
  float fog = (1.0 - smoothstep(0.0, 1.0, clear)) * dens;

  vec3 fogC = texture(uFog, uv).rgb;
  vec3 fogRaw = fogC;
  fogC = mix(fogC, vec3(0.9, 0.92, 0.9), 0.55);
  fogC *= 0.97 + 0.05 * vnoise(px * 0.35);        // fine mist grain

  // condensation beads (they live in the fog; wiping takes them too)
  float cs = 8.0;
  vec2 g = px / cs, gi = floor(g), gf = fract(g);
  float bead = 0.0;
  vec2 bn = vec2(0.0);
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec2 oo = vec2(float(i), float(j));
    vec2 c = oo + hash22(gi + oo);
    if (hash(gi + oo + 9.1) < 0.4) continue;
    float rr = 0.1 + 0.3 * pow(hash(gi + oo + 3.7), 2.5);
    vec2 d = gf - c;
    float dl = length(d) / rr;
    if (dl < 1.0 && 1.0 - dl > bead) { bead = smoothstep(1.0, 0.75, dl); bn = d / rr; }
  }
  float beadA = bead * smoothstep(0.25, 0.9, fog);
  // a bead is a tiny clear lens: it shows the room (softly), bright on top, a thin dark lower rim
  vec3 beadC = mix(texture(uSharp, uv - vec2(bn.x, -bn.y) * 0.008 / uZoom).rgb, fogRaw, 0.45) * 1.08;
  float bl = length(bn);
  beadC *= 1.0 - 0.28 * smoothstep(0.7, 1.0, bl) * smoothstep(-0.3, 0.6, dot(bn, vec2(0.3, -0.9)));
  beadC += 0.5 * smoothstep(0.35, 0.75, dot(bn, vec2(-0.5, 0.7))) * smoothstep(1.0, 0.7, bl);

  vec3 col = mix(sharpC, fogC, fog);
  col = mix(col, mix(beadC, fogC, 0.3), beadA * 0.6);

  // drips
  vec4 dt = texture(uDrops, f);
  if (dt.a > 0.01) {
    vec2 n = (dt.rg - 0.5) * 2.0;                  // canvas space: y down
    float nl = min(1.0, length(n));
    vec3 dc = texture(uSharp, uv - n * 0.03 / uZoom).rgb;  // a drop is a little lens: flipped, magnified
    dc *= 0.82 + 0.3 * (1.0 - nl);
    dc += 0.7 * smoothstep(0.55, 0.95, dot(n, vec2(-0.55, -0.75)));
    dc *= 1.0 - 0.5 * smoothstep(0.7, 1.0, nl) * smoothstep(-0.2, 0.8, dot(n, vec2(0.4, 0.9)));
    col = mix(col, dc, smoothstep(0.05, 0.5, dt.a));
  }

  // glass: faint tint + corner falloff
  vec2 q = f - 0.5;
  col *= 1.0 - 0.18 * dot(q, q) * 2.0;
  o = vec4(col, 1.0);
}`

type Drop = { x: number; y: number; r: number; v: number; wait: number; stick: number; seed: number; trail: number }
type Bead = { x: number; y: number; r: number; life: number; max: number }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

export class GlassEngine {
  ok = false
  reduced = false
  onClear?: (fraction: number) => void

  private gl: WebGL2RenderingContext | null = null
  private u: Record<string, WebGLUniformLocation | null> = {}
  private tex: Record<string, WebGLTexture | null> = {}
  private imgSize = [1, 1]
  private w = 1
  private h = 1
  private sc = 1

  // fog mask grid
  private cell = 5
  private gw = 1
  private gh = 1
  private mask = new Float32Array(1)
  private writing = new Float32Array(1)
  private bytes = new Uint8Array(1)
  private writeBox = { x0: 0, x1: 1 }
  private writeP = 0
  private blade = -1
  private zoom = 1

  // drips
  private drops: Drop[] = []
  private beads: Bead[] = []
  private dc = document.createElement('canvas')
  private dctx = this.dc.getContext('2d')!
  private sprite = document.createElement('canvas')
  private nextAmbient = 1.5
  private wipeAcc = 0
  private time = 0
  private clearT = 0
  private last: { x: number; y: number } | null = null
  private text = 'come in'

  constructor(private canvas: HTMLCanvasElement, sharp: HTMLImageElement, fog: HTMLImageElement) {
    this.makeSprite()
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false })
    if (!gl) return
    try {
      const sh = (type: number, src: string) => {
        const s = gl.createShader(type)!
        gl.shaderSource(s, src)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader')
        return s
      }
      const prog = gl.createProgram()!
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link')
      gl.useProgram(prog)
      const buf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'aPos')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
      for (const n of ['uSharp', 'uFog', 'uMask', 'uDrops', 'uRes', 'uImg', 'uZoom', 'uDpr', 'uTime', 'uBlade'])
        this.u[n] = gl.getUniformLocation(prog, n)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      this.tex.sharp = this.texFrom(gl, 0, sharp, true)
      this.tex.fog = this.texFrom(gl, 1, fog, false)
      this.tex.mask = this.newTex(gl, 2)
      this.tex.drops = this.newTex(gl, 3)
      gl.uniform1i(this.u.uSharp, 0)
      gl.uniform1i(this.u.uFog, 1)
      gl.uniform1i(this.u.uMask, 2)
      gl.uniform1i(this.u.uDrops, 3)
      this.imgSize = [sharp.naturalWidth, sharp.naturalHeight]
      this.gl = gl
      this.ok = true
    } catch (err) {
      console.warn('[condensation] WebGL2 setup failed', err)
    }
    canvas.addEventListener('webglcontextlost', this.onLost)
  }

  private onLost = (e: Event) => {
    e.preventDefault()
    this.ok = false
  }

  private texFrom(gl: WebGL2RenderingContext, unit: number, img: HTMLImageElement, mips: boolean) {
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    if (mips) gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private newTex(gl: WebGL2RenderingContext, unit: number) {
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  /** a drop as a normal map: RG = normal (0.5 ± 0.5), A = coverage */
  private makeSprite() {
    const S = 64
    this.sprite.width = this.sprite.height = S
    const ctx = this.sprite.getContext('2d')!
    const d = ctx.createImageData(S, S)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const dx = ((x + 0.5) / S) * 2 - 1
        const dy = ((y + 0.5) / S) * 2 - 1
        const l = Math.hypot(dx, dy)
        const i = (y * S + x) * 4
        if (l > 1) continue
        d.data[i] = 128 + 127 * dx
        d.data[i + 1] = 128 + 127 * dy
        d.data[i + 2] = 0
        d.data[i + 3] = 255 * clamp((1 - l) / 0.12, 0, 1)
      }
    ctx.putImageData(d, 0, 0)
  }

  get mobile() {
    return this.w < 700
  }

  resize(w: number, h: number) {
    this.w = Math.max(1, w)
    this.h = Math.max(1, h)
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
    this.sc = dpr
    this.canvas.width = Math.round(this.w * dpr)
    this.canvas.height = Math.round(this.h * dpr)
    this.dc.width = Math.ceil(this.w / 2)
    this.dc.height = Math.ceil(this.h / 2)
    this.cell = clamp(this.w / 260, 3, 6)
    this.gw = Math.ceil(this.w / this.cell)
    this.gh = Math.ceil(this.h / this.cell)
    this.mask = new Float32Array(this.gw * this.gh)
    this.bytes = new Uint8Array(this.gw * this.gh)
    this.drops = []
    this.beads = []
    this.rasterWriting()
  }

  /** "come in", written into the fog with a fingertip */
  private rasterWriting() {
    const c = document.createElement('canvas')
    c.width = this.gw
    c.height = this.gh
    const ctx = c.getContext('2d')!
    const fontPx = (this.mobile ? Math.min(this.w * 0.25, 120) : Math.min(this.w * 0.13, this.h * 0.26, 230)) / this.cell
    ctx.font = `italic 400 ${fontPx}px "Instrument Serif", serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(1.2, fontPx * (this.mobile ? 0.045 : 0.07))
    ctx.strokeStyle = ctx.fillStyle = '#fff'
    const cx = this.gw * (this.mobile ? 0.5 : 0.5)
    const cy = this.gh * (this.mobile ? 0.47 : 0.5)
    ctx.fillText(this.text, cx, cy)
    ctx.strokeText(this.text, cx, cy)
    const tw = ctx.measureText(this.text).width
    this.writeBox = { x0: cx - tw / 2 - 2, x1: cx + tw / 2 + 2 }
    const img = ctx.getImageData(0, 0, this.gw, this.gh).data
    this.writing = new Float32Array(this.gw * this.gh)
    for (let i = 0; i < this.writing.length; i++) this.writing[i] = img[i * 4 + 3] / 255
  }

  /** 0 → 1: the word is traced left to right */
  setWriting(p: number) {
    this.writeP = clamp(p, 0, 1)
  }

  /** a few letters of the word start to run */
  dripFromWriting(n = 4) {
    if (this.reduced) return
    const cands: number[] = []
    for (let j = 1; j < this.gh - 1; j++)
      for (let i = 0; i < this.gw; i++) {
        const k = j * this.gw + i
        if (this.writing[k] > 0.6 && this.writing[k + this.gw] < 0.1) cands.push(k)
      }
    for (let s = 0; s < n && cands.length; s++) {
      const k = cands.splice(Math.floor(Math.random() * cands.length), 1)[0]
      const i = k % this.gw
      const j = (k - i) / this.gw
      this.spawn((i + 0.5) * this.cell, (j + 1) * this.cell, 2.4 + Math.random() * 1.6, s * 0.7 + Math.random() * 0.8)
    }
  }

  /** squeegee edge in css px from the top (negative = not on the glass) */
  setBlade(y: number) {
    this.blade = y
  }

  setZoom(z: number) {
    this.zoom = z
  }

  /** fog everything back up */
  fogAll() {
    this.mask.fill(0)
    this.drops = []
    this.beads = []
  }

  private stamp(x: number, y: number, r: number, v = 1.35) {
    const gx = x / this.cell
    const gy = y / this.cell
    const R = r / this.cell
    const x0 = Math.max(0, Math.floor(gx - R)), x1 = Math.min(this.gw - 1, Math.ceil(gx + R))
    const y0 = Math.max(0, Math.floor(gy - R)), y1 = Math.min(this.gh - 1, Math.ceil(gy + R))
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy) / R
        if (d >= 1) continue
        const f = d < 0.5 ? 1 : 1 - (d - 0.5) / 0.5
        const k = j * this.gw + i
        const val = f * f * (3 - 2 * f) * v
        if (val > this.mask[k]) this.mask[k] = val
      }
  }

  /** wipe along the pointer path (css px, stage space) */
  wipe(x: number, y: number, radius: number) {
    const l = this.last
    this.last = { x, y }
    if (!l) {
      this.stamp(x, y, radius)
      return
    }
    const dist = Math.hypot(x - l.x, y - l.y)
    if (dist > 220) {
      this.stamp(x, y, radius) // pointer re-entered somewhere else: don't draw a line across
      return
    }
    const n = Math.max(1, Math.ceil(dist / (radius * 0.25)))
    for (let s = 1; s <= n; s++) this.stamp(l.x + ((x - l.x) * s) / n, l.y + ((y - l.y) * s) / n, radius)
    // pushed water gathers and runs
    this.wipeAcc += dist
    if (this.wipeAcc > 130 && !this.reduced && this.blade < 0) {
      this.wipeAcc = 0
      this.spawn(x + (Math.random() - 0.5) * radius, y + radius * 0.75, 3.5 + Math.random() * 3, 0.1 + Math.random() * 0.6)
    }
  }

  lift() {
    this.last = null
  }

  private spawn(x: number, y: number, r: number, wait: number) {
    if (this.drops.length > 70) return
    this.drops.push({ x, y, r, v: 0, wait, stick: 0, seed: Math.random() * 100, trail: 0 })
  }

  private clearAt(x: number, y: number) {
    const i = clamp(Math.floor(x / this.cell), 0, this.gw - 1)
    const j = clamp(Math.floor(y / this.cell), 0, this.gh - 1)
    return Math.max(this.mask[j * this.gw + i], this.writing[j * this.gw + i] * this.writeP)
  }

  step(dt: number) {
    dt = Math.min(dt, 0.05)
    this.time += dt
    const bladeOn = this.blade >= 0

    // ---- fog creeps back (values above 1 are a short "still wet" hold)
    const decay = dt * (this.reduced ? 0.08 : 0.13)
    const m = this.mask
    for (let i = 0; i < m.length; i++) if (m[i] > 0) m[i] = Math.max(0, m[i] - decay)

    // ---- ambient drips + the word's letters dripping
    if (!this.reduced && !bladeOn && this.time > this.nextAmbient) {
      this.nextAmbient = this.time + 0.9 + Math.random() * 1.6
      const x = Math.random() * this.w
      const y = Math.random() * this.h * 0.7
      if (this.clearAt(x, y) < 0.2) this.spawn(x, y, 2.5 + Math.random() * 2.5, 0.3 + Math.random() * 2.5)
    }

    // ---- drips
    const live: Drop[] = []
    for (const d of this.drops) {
      if (bladeOn && d.y < this.blade + 6) continue // the squeegee takes it
      if (d.wait > 0) {
        d.wait -= dt
        live.push(d)
        continue
      }
      if (d.stick > 0) {
        d.stick -= dt
        d.v *= Math.exp(-dt * 20)
      } else {
        const vmax = 35 + d.r * 32
        d.v = Math.min(vmax, d.v + 700 * dt)
        if (Math.random() < dt * 1.1) d.stick = 0.06 + Math.random() * 0.45
      }
      const py = d.y
      const px = d.x
      d.y += d.v * dt
      d.x += Math.sin(d.y * 0.045 + d.seed) * d.v * dt * 0.12
      // clear trail behind it, and leave little beads
      const n = Math.max(1, Math.ceil((d.y - py) / 3))
      for (let s = 1; s <= n; s++) this.stamp(px + ((d.x - px) * s) / n, py + ((d.y - py) * s) / n, d.r * 1.25, 1.25)
      d.trail += d.y - py
      if (d.trail > 12 + Math.random() * 10) {
        d.trail = 0
        if (this.beads.length < 260) {
          const br = d.r * (0.28 + Math.random() * 0.2)
          this.beads.push({ x: d.x + (Math.random() - 0.5) * d.r * 0.6, y: d.y - d.r * 1.6, r: br, life: 3 + Math.random() * 3, max: 0 })
          this.beads[this.beads.length - 1].max = this.beads[this.beads.length - 1].life
        }
        d.r *= 0.985 // loses a little water to every bead
      }
      if (d.y < this.h + 30 && d.r > 1.2) live.push(d)
    }
    this.drops = live
    this.beads = this.beads.filter((b) => {
      b.life -= dt
      return b.life > 0 && !(bladeOn && b.y < this.blade + 4)
    })

    this.draw()

    this.clearT -= dt
    if (this.clearT <= 0 && this.onClear) {
      this.clearT = 0.25
      let s = 0
      const bladeRow = bladeOn ? this.blade / this.cell : -1
      for (let j = 0; j < this.gh; j++) {
        if (j < bladeRow) {
          s += this.gw
          continue
        }
        for (let i = 0; i < this.gw; i++) s += Math.min(1, Math.max(m[j * this.gw + i], this.writing[j * this.gw + i] * this.writeP))
      }
      this.onClear(s / (this.gw * this.gh))
    }
  }

  /** the word, drawn in from left to right */
  private writingAt(i: number, k: number) {
    const w = this.writing[k]
    if (w <= 0) return 0
    const span = this.writeBox.x1 - this.writeBox.x0
    const head = this.writeBox.x0 + span * this.writeP
    return w * clamp((head - i) / 6, 0, 1)
  }

  private draw() {
    const gl = this.gl
    if (!gl || !this.ok) return

    // mask → bytes
    const b = this.bytes
    const m = this.mask
    for (let j = 0, k = 0; j < this.gh; j++)
      for (let i = 0; i < this.gw; i++, k++) {
        let v = m[k]
        if (this.writeP > 0) v = Math.max(v, this.writingAt(i, k))
        b[k] = v >= 1 ? 255 : (v * 255) | 0
      }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.tex.mask)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.gw, this.gh, 0, gl.RED, gl.UNSIGNED_BYTE, b)

    // drips → normal-map canvas (half res)
    const ctx = this.dctx
    ctx.clearRect(0, 0, this.dc.width, this.dc.height)
    for (const bd of this.beads) {
      const r = bd.r * Math.min(1, (bd.life / bd.max) * 2) * 0.5
      if (r > 0.3) ctx.drawImage(this.sprite, bd.x / 2 - r, bd.y / 2 - r, r * 2, r * 2)
    }
    for (const d of this.drops) {
      const r = d.r / 2
      const stretch = 1 + Math.min(0.5, d.v / 260)
      ctx.drawImage(this.sprite, d.x / 2 - r * 0.62, d.y / 2 - r * 2.1 * stretch, r * 1.24, r * 1.5 * stretch) // tail
      ctx.drawImage(this.sprite, d.x / 2 - r, d.y / 2 - r * stretch, r * 2, r * 2 * stretch)
    }
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.tex.drops)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.dc)

    const u = this.u
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height)
    gl.uniform2f(u.uImg, this.imgSize[0], this.imgSize[1])
    gl.uniform1f(u.uZoom, this.zoom)
    gl.uniform1f(u.uDpr, this.sc)
    gl.uniform1f(u.uTime, this.time)
    gl.uniform1f(u.uBlade, this.blade >= 0 ? this.blade / this.h : -1)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.gl = null
    this.ok = false
  }
}
