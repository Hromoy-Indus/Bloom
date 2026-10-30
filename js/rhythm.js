/* Musical-event loop. The shared 8n conductor opens bounded scheduling windows;
   only off-grid hits own one-shot Transport events. No second clock or audio bank. */
window.BloomRhythmLoop = class BloomRhythmLoop {
  constructor(rhythm) {
    this.rhythm = rhythm;
    this.bars = 1; this.quantize = '16n'; this.activeQuantize = this.quantize; this.events = [];
    this.state = 'ready'; this.message = ''; this.revision = 0; this.serial = 0;
    this.scheduled = new Map(); this.queued = new Map();
  }
  get audio() { return this.rhythm.audio; }
  now() { const c = Tone.getContext(); return c.immediate ? c.immediate() : Tone.now(); }
  ticks(time = this.now()) { return Tone.Transport.getTicksAtTime(time); }
  barTicks() { return Tone.Transport.PPQ * (Number(Tone.Transport.timeSignature) || 4); }
  canRun() { return this.audio.running && !this.audio.stopPromise && this.audio.settings.enabled.rhythm && this.rhythm.settings.playMode === 'loop' && Tone.Transport.state === 'started'; }
  notify(time) { if (this.rhythm.settings.playMode === 'loop') this.audio.dispatch('rhythm-state', {}, time); }
  reject(message) { this.message = message; this.notify(); return false; }
  nextBar() {
    // Do not arm a boundary already visited by the lookAhead conductor.
    const horizon = Math.max(this.ticks(), this.ticks(Tone.now()), this.rhythm.lastStepTick ?? -Infinity);
    return (Math.floor((horizon + .001) / this.barTicks()) + 1) * this.barTicks();
  }
  setLength(value) {
    if (![1, 2, 4].includes(Number(value)) || this.events.length || this.recording || this.pending) return false;
    this.bars = Number(value); this.notify(); return true;
  }
  get quantizeLocked() { return Boolean(this.pending === 'record' || (this.recording && this.ticks() < this.recording.end - .001)); }
  settleQuantize() { this.activeQuantize = this.quantize; this.pendingQuantize = null; this.quantizeChange = null; }
  setQuantize(value) {
    if (!['off', '8n', '16n'].includes(value) || this.quantizeLocked) return false;
    this.quantize = value;
    if (this.state === 'playing' && this.events.length && this.canRun()) {
      if (value === this.activeQuantize) this.pendingQuantize = null;
      else {
        const context = Tone.getContext();
        const horizon = Math.max(this.ticks(), this.ticks(this.now() + (context.lookAhead || 0)), this.rhythm.lastStepTick ?? -Infinity);
        // Replace an uncommitted choice, never re-grid a window already handed
        // to the audio engine. Each complete iteration keeps one grid.
        const tick = this.pendingQuantize?.tick ?? this.anchor + (Math.floor((horizon - this.anchor + .001) / this.lengthTicks) + 1) * this.lengthTicks;
        this.pendingQuantize = { value, tick };
      }
    } else this.settleQuantize();
    this.notify(); return true;
  }
  effectiveEvents(quantize = this.activeQuantize) {
    const length = this.recording ? this.recording.end - this.recording.start : this.lengthTicks;
    if (!length) return [];
    const grid = quantize === 'off' ? 0 : Tone.Transport.PPQ / (quantize === '8n' ? 2 : 4);
    const groups = new Map(), result = [];
    for (const event of this.events) {
      const raw = event.rawOffsetTicks;
      if (!Number.isFinite(raw) || raw < 0 || raw >= length) continue;
      const rounded = grid ? Math.round(raw / grid) * grid : raw;
      const offsetTicks = ((rounded % length) + length) % length;
      if (!grid) { result.push({ ...event, offsetTicks }); continue; }
      const key = event.voice + ':' + offsetTicks;
      if (!groups.has(key)) groups.set(key, { ...event, id: 'grid:' + key, offsetTicks });
      // RHYTHM uses fixed hit strength: no velocity sum, gain change, or new
      // dynamics model. Only the derived playback list is merged.
    }
    return grid ? Array.from(groups.values()) : result;
  }
  record() {
    if (!this.canRun()) return this.reject('Включите RHYTHM в LOOP и нажмите «Воспроизвести» BLOOM.');
    if (this.events.length) return this.reject('Для новой записи сначала нажмите CLEAR. Сохранённая петля не изменена.');
    if (this.recording || this.pending) return this.reject('Запись уже подготовлена или выполняется.');
    this.cancelSchedules(); this.settleQuantize(); this.events = []; this.message = '';
    const barTicks = this.barTicks(), start = this.nextBar();
    this.recording = { start, end: start + barTicks * this.bars, barTicks, bars: this.bars, quantize: this.quantize, events: this.events, perBar: [] };
    this.pending = 'record'; this.startTick = start; this.state = 'waiting'; this.notify(); return true;
  }
  play() {
    if (!this.canRun()) return this.reject('Включите RHYTHM в LOOP и нажмите «Воспроизвести» BLOOM.');
    if (!this.events.length || this.recording || this.pending || this.state === 'playing') return false;
    this.cancelSchedules(); this.settleQuantize(); this.message = ''; this.pending = 'play'; this.startTick = this.nextBar(); this.state = 'waiting'; this.notify(); return true;
  }
  cancelSchedules() {
    this.revision++;
    for (const id of this.scheduled.values()) Tone.Transport.clear(id);
    this.scheduled.clear(); this.queued.clear(); this.plan = null;
  }
  stop() {
    // A conductor callback may be ahead of audible time. Abort a draft only if
    // its actual recording interval has not ended; completed events survive Stop.
    const draft = this.recording;
    if (draft && this.ticks() < draft.end - .001) {
      this.events = []; this.message = 'Запись отменена. Нажмите REC, чтобы начать заново.';
    }
    this.recording = null; this.pending = null; this.cancelSchedules(); this.settleQuantize();
    this.state = this.events.length ? 'stopped' : 'ready'; this.notify();
  }
  clear() { this.stop(); this.events = []; this.state = 'ready'; this.message = ''; this.notify(); }
  capture(voice, inputTime) {
    const draft = this.recording;
    if (!draft || !this.canRun()) return;
    const tick = this.ticks(inputTime), raw = tick - draft.start, length = draft.end - draft.start;
    if (raw < 0 || raw >= length) return;
    const bar = Math.floor(raw / draft.barTicks);
    if ((draft.perBar[bar] || 0) >= 64) {
      this.message = 'Лимит 64 события на такт: ручная игра продолжается, лишние удары не записываются.'; this.notify(); return;
    }
    const event = { id: ++this.serial, voice, rawOffsetTicks: raw };
    draft.events.push(event); draft.perBar[bar] = (draft.perBar[bar] || 0) + 1;
    // Last-lookAhead hits can arrive after the conductor has prepared the first
    // playback window. Insert a rounded-to-zero hit there once, before it sounds.
    if (this.state === 'playing' && this.plan) for (const effective of this.effectiveEvents()) this.queueEvent(effective, this.plan);
  }
  fire(event, time, revision) {
    if (revision !== this.revision || this.state !== 'playing' || !this.canRun()) return;
    if (this.rhythm.triggerSlot(event.voice, time)) { this.playedHits = (this.playedHits || 0) + 1; this.audio.counts.rhythm++; }
  }
  queueEvent(event, plan) {
    const length = this.lengthTicks;
    // Transport visits integer PPQ ticks. Keep fractional OFF data intact,
    // and select windows using the reachable playback tick, including hits
    // immediately before the end or just across an 8n window boundary.
    const offset = Math.max(0, Math.min(length - 1, Math.round(event.offsetTicks)));
    const iteration = Math.max(0, Math.ceil((plan.tick - this.anchor - offset - .001) / length));
    const scheduledTick = this.anchor + iteration * length + offset;
    if (scheduledTick < plan.tick - .001 || scheduledTick >= plan.end - .001) return;
    const key = event.id + ':' + iteration;
    if (this.queued.has(key)) return;
    this.queued.set(key, iteration);
    const revision = this.revision;
    if (scheduledTick <= plan.tick + .001) {
      // The conductor may already have visited this tick in lookAhead. A late
      // rounded-to-zero input still arrives before the audible boundary: use
      // its known audio time directly rather than insert a past clock event.
      this.fire(event, plan.delivered ? Math.max(plan.time, this.now() + 256 / (Tone.getContext().sampleRate || 44100)) : plan.time, revision);
      return;
    }
    const id = Tone.Transport.scheduleOnce(time => {
      this.scheduled.delete(key); this.fire(event, time, revision);
    }, scheduledTick + 'i');
    this.scheduled.set(key, id);
  }
  step(time) {
    // This callback belongs to the integer 8n conductor. Remove conversion
    // noise (e.g. 3839.9999999999995) before defining half-open windows.
    const tick = Math.round(this.ticks(time)), draft = this.recording;
    let quantizeCommitted = false;
    if (this.pending && tick + .001 >= this.startTick) {
      const action = this.pending; this.pending = null;
      if (action === 'record') this.state = 'recording';
      else { this.state = 'playing'; this.anchor = this.startTick; }
    }
    if (draft && tick + .001 >= draft.end && this.state === 'recording') {
      this.state = 'playing'; this.anchor = draft.end;
      this.lengthTicks = draft.end - draft.start; this.savedBarTicks = draft.barTicks;
    }
    if (draft && this.ticks() >= draft.end - .001) {
      this.recording = null;
      if (!this.events.length) { this.state = 'ready'; this.message = 'Пустая запись. Нажмите REC и сыграйте ритм.'; }
    }
    if (this.state === 'playing') {
      if (this.pendingQuantize && tick + .001 >= this.pendingQuantize.tick) {
        this.quantizeChange = { tick: this.pendingQuantize.tick, previous: this.activeQuantize };
        this.activeQuantize = this.pendingQuantize.value; this.pendingQuantize = null; quantizeCommitted = true;
      }
      const iteration = Math.floor((tick - this.anchor) / this.lengthTicks);
      for (const [key, cycle] of this.queued) if (cycle < iteration - 1) this.queued.delete(key);
      const plan = { tick, end: tick + Tone.Transport.PPQ / 2, time, delivered: false };
      this.plan = plan;
      for (const event of this.effectiveEvents()) this.queueEvent(event, plan);
      plan.delivered = true;
    }
    // Draw anticipates its target slightly. Announce a committed grid just
    // after the audible boundary so the pending hint clears on that frame.
    this.notify(time + (quantizeCommitted ? .02 : 0));
  }
  snapshot() {
    const tick = this.ticks(), draft = this.recording;
    let state = this.state, bar = -1;
    if (draft && tick < draft.end - .001) {
      state = tick < draft.start ? 'waiting' : 'recording';
      if (state === 'recording') bar = Math.min(draft.bars - 1, Math.floor((tick - draft.start) / draft.barTicks));
    } else if (state === 'playing') {
      if (tick < this.anchor) state = 'waiting';
      else if (!this.events.length) state = 'ready';
      else bar = Math.floor(((tick - this.anchor) % this.lengthTicks) / this.savedBarTicks);
    }
    const committedAhead = this.quantizeChange && tick < this.quantizeChange.tick - .001;
    return { state, bar, bars: this.bars, quantize: this.quantize,
      activeQuantize: committedAhead ? this.quantizeChange.previous : this.activeQuantize,
      quantizePending: Boolean(this.pendingQuantize || committedAhead), quantizeLocked: this.quantizeLocked,
      count: this.events.length,
      locked: Boolean(draft || this.pending || this.events.length), message: this.message };
  }
};

/* RHYTHM: fixed palette banks, universal slots, one existing conductor. */
window.BloomRhythm = class BloomRhythm {
  constructor(audio) { this.audio = audio; this.settings.playMode ??= 'auto'; this.settings.palette ??= 'organic'; this.loop = new window.BloomRhythmLoop(this); this.reset(); }
  get settings() { return this.audio.settings.rhythm; }
  reset() { this.activeMode = this.settings.mode; this.activeDensity = this.settings.density; this.waitingForBar = false; this.hits = 0; this.manualHits = 0; this.lastStepTick = -Infinity; }
  get pending() { return this.settings.playMode === 'auto' && (this.waitingForBar || this.activeMode !== this.settings.mode || this.activeDensity !== this.settings.density); }
  build() {
    const keep = node => this.audio.keep(node);
    this.reverb = keep(new Tone.Reverb({ decay: 1.2, preDelay: 0.015, wet: 0.12 }).connect(this.audio.channels.rhythm));
    this.lowpass = keep(new Tone.Filter({ frequency: 3000, type: 'lowpass', rolloff: -12, Q: 0.4 }).connect(this.reverb));
    this.highpass = keep(new Tone.Filter({ frequency: 30, type: 'highpass', rolloff: -12, Q: 0.4 }).connect(this.lowpass));
    this.buildPalettes(keep);
    this.applySoftness();
  }
  buildPalettes(keep) {
    const filter = frequency => keep(new Tone.Filter({ frequency, type: 'lowpass', Q: 0.4 }).connect(this.highpass));
    const tonal = (kind, options, output, voices = 4) => {
      const synth = keep(new Tone.PolySynth(kind, options).connect(output));
      synth.maxPolyphony = voices;
      return synth;
    };
    const noise = (volume, attack, decay, release, output) => {
      const airCut = keep(new Tone.Filter({ frequency: 320, type: 'highpass', Q: .4 }).connect(output));
      const source = keep(new Tone.NoiseSynth({ volume, noise: { type: 'pink' },
        envelope: { attack, decay, sustain: 0, release } }).connect(airCut));
      source.rhythmFilter = output;
      return source;
    };
    const env = (attack, decay, release) => ({ attack, decay, sustain: 0, release });
    // Fixed banks, allocated once per engine start. Slots 1..4 are palette-independent.
    const organic = {
      1: tonal(Tone.Synth, { volume: -16, oscillator: { type: 'custom', partials: [1, .2, .05] }, envelope: env(.025, .14, .25) }, this.highpass),
      2: tonal(Tone.MembraneSynth, { volume: -20, pitchDecay: .09, octaves: .65,
        oscillator: { type: 'sine' }, envelope: env(.018, .17, .28) }, filter(1800)),
      3: noise(-6, .015, .06, .12, filter(1600)),
      4: noise(-13, .12, .2, .3, filter(1350))
    };
    this.breathTone = tonal(Tone.Synth, { volume: -31, oscillator: { type: 'sine' }, envelope: env(.12, .22, .32) }, this.highpass, 3);
    const musical = {
      1: tonal(Tone.MembraneSynth, { volume: -18, pitchDecay: .045, octaves: .35,
        oscillator: { type: 'custom', partials: [1, .12, .03] }, envelope: env(.014, .2, .18) }, filter(900)),
      2: tonal(Tone.Synth, { volume: -18, oscillator: { type: 'sine' }, envelope: env(.035, .075, .12) }, filter(650)),
      3: noise(-12, .018, .035, .09, filter(2800)),
      4: tonal(Tone.Synth, { volume: -22, oscillator: { type: 'sine' }, envelope: env(.065, .22, .4) }, filter(1450))
    };
    this.banks = { organic, musical };
    // NoiseSynth cannot start twice at the same audio time. A bounded pool also
    // lets a manual hit overlap an AUTO accent without restarting its envelope.
    this.noisePools = {};
    for (const [palette, slot, volume, attack, decay, release, cutoff] of [
      ['organic',3,-6,.015,.06,.12,1600], ['organic',4,-13,.12,.2,.3,1350], ['musical',3,-12,.018,.035,.09,2800]
    ]) {
      const pool = [{ source: this.banks[palette][slot], until: -Infinity }];
      for (let i=1;i<4;i++) pool.push({ source: noise(volume,attack,decay,release,filter(cutoff)), until: -Infinity });
      this.noisePools[palette + slot] = pool;
    }
    // Diagnostic aliases retained for existing lifecycle probes, not separate sources.
    this.low = organic[1]; this.air = organic[3];
  }
  get manualSources() {
    if (!this.banks) return null;
    const bank = this.banks[this.settings.palette];
    return { pulse: bank[1], tap: bank[2], dust: bank[3], shimmer: bank[4] };
  }
  slotFor(value) { return ({ pulse: 1, tap: 2, dust: 3, shimmer: 4 })[value] || Number(value); }
  triggerSlot(slot, time, velocity = 1) {
    const bank = this.banks?.[this.settings.palette];
    if (!bank?.[slot]) return false;
    const root = this.audio.noteToMidi(this.audio.currentChord(time)[0]) % 12;
    const organic = this.settings.palette === 'organic';
    let source = bank[slot];
    const pool = this.noisePools[this.settings.palette + slot];
    if (pool) {
      const free = pool.find(voice => voice.until <= time);
      if (!free) return false; // Bounded overload: skip instead of stealing a tail.
      source = free.source;
      free.until = time + (slot === 4 ? 1 : .5);
    }
    if (slot === 3 && !organic) {
      const softness = this.settings.softness / 100;
      source.rhythmFilter.frequency.setValueAtTime(2800 - 600 * softness, time);
      source.rhythmFilter.frequency.linearRampTo(1900 - 500 * softness, .14, time);
    }
    if (slot === 3 || (slot === 4 && organic)) {
      source.triggerAttackRelease(slot === 3 ? (organic ? .035 : .055) : .24, time, (slot === 3 ? .38 : .32) * velocity);
      if (slot === 4) this.breathTone.triggerAttackRelease(this.audio.midiToNote(60 + root), .25, time, .3 * velocity);
    } else {
      const octave = slot === 1 ? 36 : slot === 2 ? (organic ? 60 : 48) : (organic ? 72 : 60);
      source.triggerAttackRelease(this.audio.midiToNote(octave + root), slot === 1 ? .065 : slot === 2 ? .09 : (organic ? .14 : .18), time, (slot === 1 ? .5 : slot === 2 ? .46 : .42) * velocity);
    }
    return true;
  }
  triggerPad(pad, time) {
    const slot = this.slotFor(pad);
    if (!this.audio.running || this.audio.stopPromise || !this.audio.settings.enabled.rhythm || !Number.isInteger(slot) || slot < 1 || slot > 4 || !this.banks) return false;
    const context = Tone.getContext();
    const inputTime = time === undefined ? (context.immediate ? context.immediate() : Tone.now()) : time;
    if (time === undefined) {
      time = (context.immediate ? context.immediate() : Tone.now()) + 256 / (context.sampleRate || 44100);
    }
    if (!Number.isFinite(time)) return false;
    if (!this.triggerSlot(slot, time)) return false;
    this.manualHits++;
    this.loop.capture(slot, inputTime);
    return true;
  }
  applySoftness(time) {
    if (!this.banks) return;
    const s = this.settings.softness / 100;
    this.lowpass.frequency.linearRampTo(5000 * Math.pow(.24, s), .2, time);
    const shapes = { organic: [[.012,.018,.16,.14],[.016,.018,.24,.16],[.008,.014,.07,.1],[.09,.09,.26,.18]],
      musical: [[.012,.016,.16,.13],[.03,.018,.09,.05],[.01,.014,.065,.07],[.055,.03,.32,.14]] };
    for (const [palette, bank] of Object.entries(this.banks)) for (const [slot, source] of Object.entries(bank)) {
      const [a,b,r,d] = shapes[palette][Number(slot)-1];
      source.set({ envelope: { attack: a+b*s, release: r+d*s } });
    }
    for (const [key, pool] of Object.entries(this.noisePools)) for (const voice of pool.slice(1)) {
      voice.source.set({ envelope: this.banks[key.slice(0,-1)][Number(key.slice(-1))].get().envelope });
    }
    this.breathTone.set({ envelope: { attack: .1+.08*s, release: .28+.18*s } });
  }
  setPlayMode(value) {
    if (!['manual', 'auto', 'loop'].includes(value)) return;
    const changed = this.settings.playMode !== value;
    if (changed) this.loop.stop();
    this.settings.playMode = value;
    if (value !== 'auto') this.waitingForBar = false;
    else if (changed) this.waitingForBar = this.audio.running && this.audio.settings.enabled.rhythm;
    this.syncWhenSilent();
  }
  setPalette(value) {
    if (['organic', 'musical'].includes(value)) this.settings.palette = value;
  }
  setChoice(value) {
    if (!['heart','dust','flow'].includes(value)) return;
    this.settings.mode = value; this.syncWhenSilent();
  }
  setParameter(name, value, time) {
    if (!['density','softness'].includes(name) || !Number.isFinite(value)) return;
    this.settings[name] = Math.max(0, Math.min(100, value));
    if (name === 'softness') this.applySoftness(time);
    this.syncWhenSilent();
  }
  syncWhenSilent() {
    if (!this.audio.running || !this.audio.settings.enabled.rhythm) {
      this.activeMode = this.settings.mode; this.activeDensity = this.settings.density;
    }
  }
  setEnabled(enabled) {
    if (enabled) { this.syncWhenSilent(); this.waitingForBar = this.audio.running && this.settings.playMode === 'auto'; }
    else { this.loop.stop(); this.release(); this.reset(); }
  }
  release(time) {
    if (this.banks) for (const bank of Object.values(this.banks)) for (const [slot, source] of Object.entries(bank)) {
      if (slot === '3' || source === this.banks.organic[4]) source.triggerRelease(time);
      else source.releaseAll(time);
    }
    if (this.noisePools) for (const pool of Object.values(this.noisePools)) for (const voice of pool.slice(1)) voice.source.triggerRelease(time);
    this.breathTone?.releaseAll(time);
  }
  dispose() {
    // Nodes belong to audio.keep() and are disposed once by BloomAudio.
    this.loop.stop();
    this.banks = null; this.noisePools = null; this.breathTone = null;
    this.low = this.air = this.lowpass = this.highpass = this.reverb = null;
    this.reset();
  }
  pattern() {
    // [eighth-note position in two bars, source, velocity, density threshold].
    const patterns = {
      heart: [[0,'low',.46,1],[1,'low',.24,1],[8,'low',.43,30],[9,'low',.22,30],
        [4,'low',.34,65],[5,'low',.18,65],[12,'low',.32,85],[13,'low',.17,85]],
      dust: [[0,'air',.2,1],[6,'air',.14,25],[11,'air',.18,40],[3,'air',.12,55],
        [14,'air',.13,70],[8,'air',.15,85],[5,'air',.1,95]],
      flow: [[0,'low',.38,1],[8,'low',.35,1],[3,'air',.16,20],[11,'air',.14,20],
        [6,'low',.24,45],[14,'low',.22,45],[7,'air',.11,65],[15,'air',.1,65],
        [2,'air',.09,85],[10,'air',.08,85]]
    };
    return patterns[this.activeMode];
  }
  step(time) {
    this.lastStepTick = Tone.Transport.getTicksAtTime(time);
    if (!this.audio.running || this.audio.stopPromise || !this.audio.settings.enabled.rhythm) return;
    if (this.settings.playMode === 'loop') { this.loop.step(time); return; }
    if (this.settings.playMode !== 'auto') return;
    const eighth = this.audio.eighthAt(time);
    if (eighth % 8 === 0 && this.pending) {
      this.activeMode = this.settings.mode; this.activeDensity = this.settings.density; this.waitingForBar = false;
      this.audio.dispatch('rhythm-state', {}, time);
    }
    if (this.waitingForBar || this.activeDensity === 0) return;
    for (const [position, source, velocity, threshold] of this.pattern()) {
      if (position !== eighth % 16 || this.activeDensity < threshold) continue;
      // Preserve all pattern positions, thresholds and relative accents.
      // Low events -> slot 1; air events -> slot 3 in either palette.
      if (!this.triggerSlot(source === 'low' ? 1 : 3, time, velocity / (source === 'low' ? .5 : .38))) continue;
      this.hits++; this.audio.counts.rhythm++;
    }
  }
};
