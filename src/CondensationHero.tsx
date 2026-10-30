import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import { GlassEngine } from './GlassEngine'

gsap.registerPlugin(ScrollTrigger)

const SHARP = new URL('./assets/greenhouse.webp', import.meta.url).href
const FOG = new URL('./assets/greenhouse-fog.webp', import.meta.url).href

const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const sweepOf = (p: number) => smooth(0.1, 0.48, p)
const zoomOf = (p: number) => 1 + 0.35 * smooth(0.55, 0.92, p)
const CLEARED_AT = 0.52

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${src}`))
    img.src = src
  })
}

export default function CondensationHero() {
  const trackRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bladeRef = useRef<HTMLDivElement>(null)
  const clearRef = useRef<HTMLElement>(null)
  const engineRef = useRef<GlassEngine | null>(null)
  const lenisRef = useRef<Lenis | null>(null)
  const stRef = useRef<ScrollTrigger | null>(null)
  const progressRef = useRef(0)
  const writeRef = useRef(0)
  const reduced = usePrefersReducedMotion()

  const [state, setState] = useState<'loading' | 'ready' | 'nogl' | 'error'>('loading')
  const [isTouch] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)

  const apply = (p: number) => {
    progressRef.current = p
    const stage = stageRef.current
    const eng = engineRef.current
    const h = stage?.clientHeight ?? 800
    const s = sweepOf(p)
    const y = -40 + (h + 80) * s
    if (bladeRef.current) {
      bladeRef.current.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`
      bladeRef.current.style.visibility = s > 0 && s < 1 ? 'visible' : 'hidden'
    }
    if (eng) {
      eng.setBlade(s > 0 ? y : -1)
      eng.setZoom(zoomOf(p))
    }
  }

  /* ------------------------------------------------ load + engine */
  useEffect(() => {
    let alive = true
    let cleanup = () => {}
    Promise.all([loadImage(SHARP), loadImage(FOG), document.fonts?.load('italic 100px "Instrument Serif"').catch(() => null)])
      .then(([sharp, fog]) => {
        const stage = stageRef.current
        const canvas = canvasRef.current
        if (!alive || !stage || !canvas) return
        const engine = new GlassEngine(canvas, sharp, fog)
        if (!engine.ok) {
          setState('nogl')
          return
        }
        engineRef.current = engine
        engine.reduced = reduced
        engine.onClear = (f) => {
          if (clearRef.current) clearRef.current.textContent = `${String(Math.round(f * 100)).padStart(2, '0')}%`
        }
        engine.resize(stage.clientWidth, stage.clientHeight)
        engine.setWriting(writeRef.current)
        apply(progressRef.current)
        setState('ready')

        let running = false
        let inView = true
        const tick = (_t: number, dtMs: number) => {
          engine.step(dtMs / 1000)
          if (!engine.ok) setState('nogl')
        }
        const sync = () => {
          const want = inView && !document.hidden
          if (want && !running) gsap.ticker.add(tick)
          if (!want && running) gsap.ticker.remove(tick)
          running = want
        }
        const io = new IntersectionObserver(([e]) => {
          inView = e.isIntersecting
          sync()
        })
        if (trackRef.current) io.observe(trackRef.current)
        document.addEventListener('visibilitychange', sync)
        sync()
        const ro = new ResizeObserver(() => {
          engine.resize(stage.clientWidth, stage.clientHeight)
          apply(progressRef.current)
        })
        ro.observe(stage)

        // trace the word into the fog, then let it run
        const w = { p: writeRef.current }
        const tw = gsap.to(w, {
          p: 1,
          duration: reduced ? 0.01 : 2.4,
          delay: reduced ? 0 : 0.5,
          ease: 'power1.inOut',
          onUpdate: () => {
            writeRef.current = w.p
            engine.setWriting(w.p)
          },
          onComplete: () => engine.dripFromWriting(5),
        })

        cleanup = () => {
          tw.kill()
          gsap.ticker.remove(tick)
          io.disconnect()
          ro.disconnect()
          document.removeEventListener('visibilitychange', sync)
          engine.dispose()
          engineRef.current = null
        }
      })
      .catch((err) => {
        console.warn('[condensation]', err)
        if (alive) setState('error')
      })
    return () => {
      alive = false
      cleanup()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (engineRef.current) engineRef.current.reduced = reduced
  }, [reduced, state])

  /* ------------------------------------------------ wiping */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let down = false
    const local = (x: number, y: number) => {
      const r = stage.getBoundingClientRect()
      return { x: x - r.left, y: y - r.top }
    }
    const onUi = (t: EventTarget | null) => t instanceof Element && !!t.closest('button, a')
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || onUi(e.target)) return
      const p = local(e.clientX, e.clientY)
      engineRef.current?.wipe(p.x, p.y, down ? 58 : 38)
    }
    const press = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') down = true
    }
    const release = () => {
      down = false
    }
    const leave = (e: PointerEvent) => e.pointerType !== 'touch' && engineRef.current?.lift()
    // touch uses touch events: they keep firing while the page scrolls, so a
    // finger both scrolls and wipes, the way it would on real glass
    const tStart = (e: TouchEvent) => {
      if (onUi(e.target)) return
      engineRef.current?.lift()
      tMove(e)
    }
    const tMove = (e: TouchEvent) => {
      if (onUi(e.target)) return
      const t = e.touches[0]
      if (!t) return
      const p = local(t.clientX, t.clientY)
      engineRef.current?.wipe(p.x, p.y, 40)
    }
    const tEnd = () => engineRef.current?.lift()
    stage.addEventListener('pointermove', move)
    stage.addEventListener('pointerdown', press)
    window.addEventListener('pointerup', release)
    stage.addEventListener('pointerleave', leave)
    stage.addEventListener('touchstart', tStart, { passive: true })
    stage.addEventListener('touchmove', tMove, { passive: true })
    stage.addEventListener('touchend', tEnd, { passive: true })
    return () => {
      stage.removeEventListener('pointermove', move)
      stage.removeEventListener('pointerdown', press)
      window.removeEventListener('pointerup', release)
      stage.removeEventListener('pointerleave', leave)
      stage.removeEventListener('touchstart', tStart)
      stage.removeEventListener('touchmove', tMove)
      stage.removeEventListener('touchend', tEnd)
    }
  }, [])

  /* ------------------------------------------------ smooth scroll */
  useEffect(() => {
    if (reduced) return
    const lenis = new Lenis({ lerp: 0.085 })
    lenisRef.current = lenis
    lenis.on('scroll', ScrollTrigger.update)
    const tick = (t: number) => lenis.raf(t * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)
    return () => {
      gsap.ticker.remove(tick)
      lenis.destroy()
      lenisRef.current = null
    }
  }, [reduced])

  /* ------------------------------------------------ intro + scroll story */
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const ctx = gsap.context(() => {
      if (!reduced) {
        gsap.timeline({ defaults: { ease: 'expo.out' }, delay: 0.15 })
          .from('.cd-top > *', { opacity: 0, y: -8, duration: 1, stagger: 0.08 })
          .from('.cd-head .li', { yPercent: 110, duration: 1.6, stagger: 0.1 }, 0.2)
          .from('.cd-sub__in, .cd-dock__in', { opacity: 0, y: 10, duration: 1.2, stagger: 0.1 }, 0.8)
      }

      const target = { p: 0 } // fresh per run: a StrictMode revert can't zero a shared object
      const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } })
      tl.to(target, { p: 1, duration: 1, onUpdate: () => apply(target.p) }, 0)
        .to('.cd-head, .cd-sub, .cd-dock', { opacity: 0, y: -20, duration: 0.06, stagger: 0.015 }, 0.04)
        .fromTo('.cd-note', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.06 }, 0.16)
        .to('.cd-note', { opacity: 0, y: -14, duration: 0.05 }, 0.44)
        .to('.cd-frame', { scale: 2.6, opacity: 0, duration: 0.3, ease: 'power2.in' }, 0.55)
        .fromTo('.cd-final', { opacity: 0, y: 30, pointerEvents: 'none' }, { opacity: 1, y: 0, pointerEvents: 'auto', duration: 0.07 }, 0.9)

      stRef.current = ScrollTrigger.create({
        trigger: track,
        start: 'top top',
        end: 'bottom bottom',
        animation: reduced ? undefined : tl,
        scrub: reduced ? false : 0.6,
        onUpdate(self) {
          if (!reduced) return
          // discrete states only: fogged → clear → inside
          const p = self.progress > 0.75 ? 1 : self.progress > 0.25 ? CLEARED_AT : 0
          tl.progress(p)
          apply(p)
        },
      })
      apply(0)
    }, stageRef)
    return () => {
      stRef.current = null
      ctx.revert()
    }
  }, [reduced]) // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToProgress = (p: number, then?: () => void) => {
    const st = stRef.current
    if (!st) return
    const y = st.start + (st.end - st.start) * p
    if (lenisRef.current) lenisRef.current.scrollTo(y, { duration: p === 0 ? 2.4 : 2, onComplete: then })
    else {
      window.scrollTo({ top: y, behavior: 'auto' })
      then?.()
    }
  }
  const fogAgain = () =>
    scrollToProgress(0, () => {
      engineRef.current?.fogAll()
      engineRef.current?.dripFromWriting(4)
    })

  const glass = state === 'ready'

  return (
    <main className="cd-root" data-state={state}>
      <section ref={trackRef} className="cd-track" aria-label="Condensation — a fogged greenhouse window">
        <div ref={stageRef} className={`cd-stage${glass ? ' is-live' : ''}`}>
          <canvas ref={canvasRef} className="cd-gl" aria-hidden="true" />
          {(state === 'nogl' || state === 'error') && (
            <div className="cd-fallback" aria-hidden="true">
              {state === 'nogl' && <img src={SHARP} alt="" />}
            </div>
          )}

          <div className="cd-frame" aria-hidden="true">
            <i className="cd-bar cd-bar--v1" />
            <i className="cd-bar cd-bar--v2" />
            <i className="cd-bar cd-bar--h" />
          </div>

          <div ref={bladeRef} className="cd-blade" aria-hidden="true">
            <i className="cd-blade__handle" />
            <i className="cd-blade__bar" />
          </div>

          <header className="cd-top">
            <span>Oversight Supply</span>
            <span className="cd-top__c">The <em>Glasshouse</em></span>
            <span className="cd-top__r">
              Glass clear <b ref={clearRef}>00%</b>
            </span>
          </header>

          <h1 className="cd-head">
            <span className="ln"><span className="li">Grown behind</span></span>
            <span className="ln"><span className="li"><em>glass.</em></span></span>
          </h1>

          <div className="cd-sub">
            <p className="cd-sub__in">
              {state === 'nogl'
                ? 'Your browser can’t draw the fogged glass (WebGL2 is off), so here is the clear view.'
                : state === 'error'
                  ? 'The greenhouse photo didn’t load. Check your connection and reload.'
                  : isTouch
                    ? 'It’s 14 °C inside and 3 °C out. Drag a finger across the glass to look in.'
                    : 'It’s 14 °C inside and 3 °C out. Move across the glass to wipe it; hold to wipe wider.'}
            </p>
          </div>

          <div className="cd-dock">
            <div className="cd-dock__in">
              <button type="button" onClick={() => engineRef.current?.fogAll()} disabled={!glass}>Fog it up</button>
              <button type="button" onClick={() => scrollToProgress(CLEARED_AT)}>Clear the glass ↓</button>
            </div>
          </div>

          <p className="cd-note" aria-hidden="true">
            Every morning, <em>before the doors open.</em>
          </p>

          <div className="cd-final">
            <p className="cd-final__kicker">Oversight Supply · the glasshouse</p>
            <h2 className="cd-final__title">
              Come in, <br />
              it’s <em>warm.</em>
            </h2>
            <p className="cd-final__body">Everything on our benches was raised right here, under this glass, a few degrees warmer than wherever you are.</p>
            <button type="button" className="cd-final__btn" onClick={fogAgain}>
              Fog it up again <span aria-hidden="true">↑</span>
            </button>
          </div>

          {state === 'loading' && (
            <div className="cd-loader" role="status">
              Warming the glass…
            </div>
          )}
        </div>
      </section>
    </main>
  )
}
