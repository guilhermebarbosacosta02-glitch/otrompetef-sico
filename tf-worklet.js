/* O Trompete Físico — módulo AudioWorklet (gerado por build.py) */
(function () {
    const TWO_PI = Math.PI * 2;
    const MAXH = 56;
    const NVOICES = 16;

    /* Articulações */
    const LEGATO = 0, STACCATO = 1, MARCATO = 2, SUSTAIN = 3;

    function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

    /* Gerador de números pseudo-aleatórios rápido e determinístico (xorshift). */
    let seed = 0x9e3779b9;
    function rnd() {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296);
    }

    class Voice {
      constructor(sr) {
        this.sr = sr;
        this.shape = new Float64Array(MAXH + 1);
        this.amp = new Float64Array(MAXH + 1);
        this.dAmp = new Float64Array(MAXH + 1);
        this.reset();
      }
      reset() {
        this.active = false;
        this.id = -1;
        this.group = '';
        this.stage = 0; // 0 off, 1 on, 2 release
        this.age = 0;
        this.amp.fill(0); this.dAmp.fill(0);
        this.nH = 0;
        this.inc = undefined;
      }
      start(ev, P, now) {
        const sr = this.sr;
        const wasActive = this.active;
        this.active = true;
        this.id = ev.id;
        this.group = ev.group || 'live';
        this.stage = 1;
        this.age = 0;
        this.t = 0;
        this.art = ev.art | 0;
        this.vel = clamp(ev.vel, 0.02, 1);
        this.logF = Math.log2(ev.freq);
        this.logFTarget = this.logF;
        if (!wasActive) { this.phase = rnd() * 0.25; this.p = 0; this.accent = 0; }
        else { this.p *= 0.3; this.inc = undefined; }
        const hum = P.humanize;
        const art = this.art;
        // Tempo de ataque (constante de tempo, em segundos) por articulação
        const atk = [0.034, 0.008, 0.006, 0.016][art] * P.attack;
        this.cAtk = 1 - Math.exp(-1 / (Math.max(0.001, atk) * sr));
        this.sustainLevel = this.vel * [0.92, 1.0, 0.66, 1.0][art];
        this.pTarget = this.sustainLevel;
        // Acento (marcato) e golpe de língua
        this.accent = art === MARCATO ? this.vel * 0.75 : art === STACCATO ? this.vel * 0.15 : 0;
        this.cAccent = Math.exp(-1 / (0.11 * sr));
        this.burst = this.vel * [0.18, 0.9, 1.25, 0.6][art] * (0.4 + P.breath);
        this.cBurst = Math.exp(-1 / (0.009 * sr));
        // "Scoop": os lábios começam ligeiramente abaixo e assentam na nota
        this.scoop = -[10, 22, 38, 18][art] * (0.5 + 0.7 * hum) * (0.6 + 0.6 * rnd());
        this.cScoop = Math.exp(-1 / (0.022 * sr));
        // Vibrato
        this.vibPhase = rnd();
        this.vibRate = P.vibRate * (0.94 + 0.12 * rnd());
        this.vibAmt = 0;
        // Micro-variação de afinação
        this.jit = 0; this.jitV = 0;
        // Fim automático do staccato
        this.autoOff = art === STACCATO ? Math.round(0.075 * sr) : -1;
        this.relTau = P.release * (art === STACCATO ? 0.7 : 1);
        this.drop = 0;
        this.slurDip = 1;
        // Filtro de ruído (SVF) — estado
        this.nLow = 0; this.nBand = 0;
        this.blocksSinceShape = 999;
      }
      slur(ev) {
        this.id = ev.id;
        this.logFTarget = Math.log2(ev.freq);
        this.vel = clamp(ev.vel, 0.02, 1);
        this.sustainLevel = this.vel * 0.92;
        this.pTarget = this.sustainLevel;
        this.slurDip = 0.8;            // ligeira quebra de pressão na ligadura de lábios
        this.burst += 0.05 * this.vel;  // pequeno sopro
        this.vibAmt *= 0.4;
        this.t = Math.min(this.t, Math.round(0.12 * this.sr));
        this.stage = 1;
        this.autoOff = -1;
      }
      bend(freq) { this.logFTarget = Math.log2(freq); }
      release(fast) {
        if (this.stage !== 1) { if (fast) this.relTau = Math.min(this.relTau, 0.012); return; }
        this.stage = 2;
        if (fast) this.relTau = 0.012;
        this.pTarget = 0;
      }
    }

    /* Filtro de radiação do instrumento (tubo + campânula + surdina), em amplitude. */
    function radiation(f, P, e) {
      // Campânula: passa-altos suave (graves irradiam mal)
      const h = f / 380;
      const h15 = h * Math.sqrt(h);
      let w = h15 / (1 + h15);
      // Formante principal do trompete (~1.2 kHz) e segundo formante (~2.6 kHz)
      const l1 = Math.log2(f / 1250);
      const l2 = Math.log2(f / 2700);
      w *= 1 + 0.85 * Math.exp(-(l1 * l1) / 0.26) + 0.35 * Math.exp(-(l2 * l2) / 0.18);
      // Queda nos agudos; a frequência de corte sobe com a pressão e o brilho
      const fl = 2400 * (0.55 + 0.9 * P.brightness) * (0.75 + 0.45 * e);
      const r = f / fl;
      w /= Math.sqrt(1 + r * r * r * r);
      switch (P.mute) {
        case 1: { // Surdina direita: nasal, brilhante, sem graves
          const a = f / 1100; const a2 = a * a;
          w *= (a2 / (1 + a2)) * (1 + 1.6 * Math.exp(-Math.pow(Math.log2(f / 1850), 2) / 0.08));
          w /= Math.sqrt(1 + Math.pow(f / 7500, 4));
          break;
        }
        case 2: { // Surdina cup: escura e aveludada
          const a = f / 300; const a2 = a * a;
          w *= (a2 / (1 + a2)) / (1 + Math.pow(f / 1350, 4));
          w *= 1 + 0.5 * Math.exp(-Math.pow(Math.log2(f / 800), 2) / 0.1);
          break;
        }
        case 3: { // Harmon: zumbido estreito e penetrante
          const a = f / 1300; const a4 = a * a * a * a;
          w *= (a4 / (1 + a4)) * (1 + 2.6 * Math.exp(-Math.pow(Math.log2(f / 1750), 2) / 0.03));
          w /= 1 + Math.pow(f / 4200, 4);
          break;
        }
      }
      return w;
    }

    class TrumpetProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.sr = sampleRate;
        this.voices = [];
        for (let i = 0; i < NVOICES; i++) this.voices.push(new Voice(this.sr));
        this.queue = [];
        this.P = {
          brightness: 0.55, breath: 0.35, vibDepth: 14, vibRate: 5.4, vibDelay: 0.32,
          attack: 1, release: 0.07, mute: 0, humanize: 0.5, gain: 0.32, pure: false
        };
        this.port.onmessage = (e) => this.onMessage(e.data);
        const po = options && options.processorOptions;
        if (po) {
          if (po.params) Object.assign(this.P, po.params);
          if (po.events) for (const ev of po.events) this.enqueue(Object.assign({}, ev));
        }
        this.meterAcc = 0; this.meterN = 0; this.meterPeak = 0;
      }

      onMessage(m) {
        if (!m) return;
        if (m.type === 'params') { Object.assign(this.P, m.p); return; }
        if (m.type === 'panic') { this.queue.length = 0; for (const v of this.voices) v.release(true); return; }
        if (m.type === 'clear') {
          this.queue = this.queue.filter((ev) => (ev.group || 'live') !== m.group);
          for (const v of this.voices) if (v.active && v.group === m.group) v.release(true);
          return;
        }
        if (m.type === 'batch') { for (const ev of m.events) this.enqueue(ev); return; }
        this.enqueue(m);
      }

      enqueue(ev) {
        if (ev.t === undefined || ev.t === null) ev.t = 0;
        if (ev.type === 'on' && ev.dur > 0) {
          this.insert({ type: 'off', id: ev.id, t: ev.t + ev.dur, group: ev.group });
        }
        this.insert(ev);
      }
      insert(ev) {
        const q = this.queue;
        let i = q.length;
        while (i > 0 && q[i - 1].t > ev.t) i--;
        q.splice(i, 0, ev);
      }

      apply(ev) {
        const P = this.P;
        if (ev.type === 'on') {
          const group = ev.group || 'live';
          if (ev.mono) {
            let cur = null;
            for (const v of this.voices) {
              if (v.active && v.group === group && v.stage === 1) {
                if (!cur || v.age < cur.age) cur = v;
              }
            }
            if (cur && ev.art === LEGATO) { cur.slur(ev); return; }
            for (const v of this.voices) if (v.active && v.group === group) v.release(true);
          }
          let voice = null;
          for (const v of this.voices) if (!v.active) { voice = v; break; }
          if (!voice) {
            for (const v of this.voices) if (v.stage === 2 && (!voice || v.age > voice.age)) voice = v;
          }
          if (!voice) {
            for (const v of this.voices) if (!voice || v.age > voice.age) voice = v;
          }
          voice.start(ev, P);
        } else if (ev.type === 'off') {
          for (const v of this.voices) if (v.active && v.id === ev.id) v.release(false);
        } else if (ev.type === 'bend') {
          for (const v of this.voices) if (v.active && v.id === ev.id) v.bend(ev.freq);
        }
      }

      /* Atualiza o espectro alvo da voz uma vez por bloco. */
      updateShape(v, n) {
        const P = this.P;
        const sr = this.sr;
        // Jitter (passeio aleatório suave) e vibrato
        const hum = P.humanize;
        v.jitV = v.jitV * 0.96 + (rnd() - 0.5) * 0.9 * hum;
        v.jit = v.jit * 0.985 + v.jitV * 0.05;
        const tSec = v.t / sr;
        let vibTarget = 0;
        if (v.art !== STACCATO && v.stage === 1 && tSec > P.vibDelay) {
          vibTarget = Math.min(1, (tSec - P.vibDelay) / 0.45);
        }
        v.vibAmt += (vibTarget - v.vibAmt) * 0.05;
        v.vibPhase += v.vibRate * n / sr;
        if (v.vibPhase > 1) v.vibPhase -= 1;
        const vibS = Math.sin(TWO_PI * v.vibPhase);
        v.vibS = vibS;
        // Glissando (legato) em domínio logarítmico
        const cG = 1 - Math.exp(-n / (0.03 * sr));
        v.logF += (v.logFTarget - v.logF) * cG;
        // tom puro (tubo de Rubens): sem vibrato nem desvios, afinação estável
        const cents = P.pure ? 0 : v.scoop + v.jit * 3 + vibS * P.vibDepth * v.vibAmt + v.drop;
        const f = Math.pow(2, v.logF + cents / 1200);
        const nextInc = f / sr;
        v.incStart = v.inc === undefined ? nextInc : v.inc;
        v.inc = nextInc;

        // Espectro: harmónicos superiores dependem não-linearmente da pressão
        const e = clamp(v.p + v.accent, 0.0005, 1.3);
        const gamma = 0.32 + 0.38 * (1 - P.brightness);
        const ratio = Math.pow(0.1 + 0.8 * Math.min(e, 1.15), gamma);
        const nyq = Math.min(sr * 0.45, 18000);
        const nH = Math.max(1, Math.min(MAXH, Math.floor(nyq / f)));
        let m = 1, norm = 0;
        const s = v.shape;
        if (P.pure) {
          // onda sinusoidal pura: só o fundamental
          s[1] = 1;
          for (let k = 1; k <= MAXH; k++) v.dAmp[k] = ((k === 1 ? 1 : 0) - v.amp[k]) / n;
          v.nHRender = Math.max(1, v.nH); v.nH = 1;
          return;
        }
        for (let k = 1; k <= nH; k++) {
          let fk = f * k;
          let a = radiation(fk, P, e) * m;
          // suave atenuação junto a Nyquist para evitar artefactos
          if (fk > nyq * 0.8) a *= (nyq - fk) / (nyq * 0.2);
          s[k] = a;
          norm += a * a;
          m *= ratio;
        }
        norm = norm > 0 ? 1 / Math.sqrt(norm) : 0;
        // Interpolação linear das amplitudes ao longo do bloco (sem cliques)
        const inv = 1 / n;
        for (let k = 1; k <= MAXH; k++) {
          const target = k <= nH ? s[k] * norm : 0;
          v.dAmp[k] = (target - v.amp[k]) * inv;
        }
        if (nH < v.nH) { /* harmónicos a desaparecer continuam a ser interpolados até zero */ }
        v.nHRender = Math.max(nH, v.nH);
        v.nH = nH;
      }

      renderVoice(v, out, from, to, blockN) {
        const P = this.P;
        const sr = this.sr;
        const amp = v.amp, dAmp = v.dAmp;
        const nH = v.nHRender;
        let phase = v.phase;
        let inc = v.incStart;
        const dInc = (v.inc - v.incStart) / blockN;
        inc += dInc * from;
        let p = v.p, accent = v.accent, burst = v.burst, scoop = v.scoop;
        const cRel = 1 - Math.exp(-1 / (Math.max(0.004, v.relTau) * sr));
        const cAtk = v.cAtk;
        const breath = P.breath;
        // SVF para o ruído (centro ~1.8 kHz, banda larga)
        const fc = 2 * Math.sin(Math.PI * 1800 / sr);
        const q = 1.1;
        let nLow = v.nLow, nBand = v.nBand;
        // tremolo acoplado ao vibrato + pequena instabilidade de sopro (humanização)
        const trem = P.pure ? 1 : (1 + 0.12 * (v.vibS || 0) * v.vibAmt * (P.vibDepth / 14)) * (1 + 0.035 * P.humanize * clamp(v.jit, -1, 1));
        const gain = P.gain;
        for (let i = from; i < to; i++) {
          // Envelope de pressão
          if (v.stage === 1) {
            if (v.autoOff >= 0 && v.t >= v.autoOff) { v.stage = 2; v.pTarget = 0; }
            p += (v.pTarget * v.slurDip - p) * cAtk;
          } else {
            p += (0 - p) * cRel;
            v.drop -= 0.003;
          }
          v.slurDip += (1 - v.slurDip) * 0.0012;
          accent *= v.cAccent;
          burst *= v.cBurst;
          scoop *= v.cScoop;
          // Oscilador harmónico (Chebyshev)
          phase += inc; inc += dInc;
          if (phase >= 1) phase -= 1;
          const th = TWO_PI * phase;
          const s1 = Math.sin(th);
          const c2 = 2 * Math.cos(th);
          let sPrev = 0, sCur = s1;
          let acc = amp[1] * s1;
          amp[1] += dAmp[1];
          for (let k = 2; k <= nH; k++) {
            const sN = c2 * sCur - sPrev;
            sPrev = sCur; sCur = sN;
            acc += amp[k] * sN;
            amp[k] += dAmp[k];
          }
          const e = p + accent;
          const loud = e > 0 ? Math.pow(e, 1.25) : 0;
          // Ruído de sopro síncrono com o período + golpe de língua
          const wn = rnd() * 2 - 1;
          nLow += fc * nBand;
          const hp = wn - nLow - q * nBand;
          nBand += fc * hp;
          const pulse = 0.55 + 0.45 * s1;
          const noise = P.pure ? 0 : nBand * (breath * 0.05 * e * pulse + burst * 0.11);
          out[i] += (acc * loud * trem + noise) * gain;
          v.t++;
        }
        v.phase = phase;
        v.p = p; v.accent = accent; v.burst = burst; v.scoop = scoop;
        v.nLow = nLow; v.nBand = nBand;
        if (v.stage === 2 && p < 0.0004 && burst < 0.001) v.reset();
      }

      process(inputs, outputs) {
        const out = outputs[0];
        const L = out[0];
        const n = L.length;
        const sr = this.sr;
        const t0 = currentTime;
        const tEnd = t0 + n / sr;
        L.fill(0);

        // Atualiza espectros (uma vez por bloco)
        for (const v of this.voices) if (v.active) { this.updateShape(v, n); v.age++; }

        let pos = 0;
        while (pos < n) {
          let next = n;
          while (this.queue.length && this.queue[0].t < tEnd) {
            const ev = this.queue[0];
            const off = Math.max(0, Math.round((ev.t - t0) * sr));
            if (off > pos) { next = Math.min(off, n); break; }
            this.queue.shift();
            const wasActive = this.voices.map((v) => v.active);
            this.apply(ev);
            // voz nova a meio do bloco: inicializa espectro
            this.voices.forEach((v, i) => { if (v.active && (!wasActive[i] || v.t === 0)) this.updateShape(v, n); });
          }
          for (const v of this.voices) if (v.active) this.renderVoice(v, L, pos, next, n);
          pos = next;
        }

        // Proteção suave contra saturação + medidor
        let peak = 0, sum = 0;
        for (let i = 0; i < n; i++) {
          let x = L[i];
          const ax = Math.abs(x);
          if (ax > 0.85) x = Math.sign(x) * (0.85 + 0.15 * Math.tanh((ax - 0.85) / 0.15));
          L[i] = x;
          if (ax > peak) peak = ax;
          sum += x * x;
        }
        for (let c = 1; c < out.length; c++) out[c].set(L);
        this.meterAcc += sum; this.meterN += n; if (peak > this.meterPeak) this.meterPeak = peak;
        if (this.meterN >= 2048) {
          let activeIds = [];
          for (const v of this.voices) if (v.active && v.stage === 1) activeIds.push(v.id);
          this.port.postMessage({ type: 'meter', rms: Math.sqrt(this.meterAcc / this.meterN), peak: this.meterPeak, active: activeIds });
          this.meterAcc = 0; this.meterN = 0; this.meterPeak = 0;
        }
        return true;
      }
    }

    /* Gravador: captura PCM estéreo do barramento do trompete para exportar em WAV. */
    class RecorderProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.rec = false;
        this.size = 8192;
        this.bufL = new Float32Array(this.size);
        this.bufR = new Float32Array(this.size);
        this.idx = 0;
        this.port.onmessage = (e) => {
          if (e.data === 'start') { this.rec = true; this.idx = 0; }
          else if (e.data === 'stop') { this.flush(); this.rec = false; this.port.postMessage({ type: 'done' }); }
        };
      }
      flush() {
        if (this.idx > 0) {
          this.port.postMessage({ type: 'chunk', l: this.bufL.slice(0, this.idx), r: this.bufR.slice(0, this.idx) });
          this.idx = 0;
        }
      }
      process(inputs, outputs) {
        const inp = inputs[0];
        if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);
        if (!this.rec || !inp || !inp[0]) return true;
        const l = inp[0], r = inp[1] || inp[0];
        for (let i = 0; i < l.length; i++) {
          this.bufL[this.idx] = l[i]; this.bufR[this.idx] = r[i]; this.idx++;
          if (this.idx >= this.size) this.flush();
        }
        return true;
      }
    }

    registerProcessor('tf-trumpet', TrumpetProcessor);
    registerProcessor('tf-recorder', RecorderProcessor);
  })();
