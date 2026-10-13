/* BLOOM's original A-minor score. Audio is created only after a Play gesture. */
window.BloomAudio = class BloomAudio {
  constructor() {
    this.settings = {
      tempo: 70, master: 70, brightness: 35, intensity: 35,
      volumes: { atmosphere: 65, melody: 60, texture: 45, voice: 55 },
      enabled: { atmosphere: false, melody: false, texture: false, voice: false },
      vocal: { chordDuration: 4, phrasePause: 2, mode: 'notes', sample: 'a', timbre: 65, attack: 0.3, release: 0.8, reverb: 18, atmosphereReverb: 0 },
      mode: 'manual', scale: 'minor', phrase: 0,
      harmony: 'rain', autoPattern: 'echo', variation: 20, octave: 0, noteLength: 'medium',
      textureCharacter: 'dust', arp: { direction: 'up', rate: '8n', octaves: 1, gate: 65 },
      advanced: {
        atmosphere: { attack: 2.5, release: 4, reverb: 42, chorus: 24 },
        melody: { attack: 0.12, release: 2.8, reverb: 32, delay: 18 },
        texture: { brightness: 55, delay: 30, reverb: 22 }
      }
    };
    this.running = false;
    this.vocal = new BloomVoice(this);
    this.nodes = [];
    this.events = [];
    this.generation = 0;
    this.activePhrase = 0;
    this.activeHarmony = this.settings.harmony;
    this.arpIndex = 0;
    this.harmonyPrepared = false;
    this.debug = new URLSearchParams(location.search).has('debug');
    this.counts = { atmosphere: 0, auto: 0, arp: 0, manual: 0, texture: 0 };
    // Relative tonal centres share natural notes, making transitions compatible.
    this.harmonies = {
      dawn: { labels: ['Cmaj9', 'Fmaj7', 'Am7', 'Gsus2'], velocity: 0.42, space: 1,
        chords: [['C3', 'E3', 'B3', 'D4'], ['F2', 'A2', 'C3', 'E3'], ['A2', 'C3', 'E3', 'G3'], ['G2', 'A2', 'D3', 'G3']] },
      rain: { labels: ['Am(add9)', 'Dm(add9)', 'Fmaj7', 'Em7'], velocity: 0.4, space: 2,
        chords: [['A2', 'C3', 'E3', 'B3'], ['D3', 'F3', 'A3', 'E4'], ['F2', 'A2', 'C3', 'E3'], ['E3', 'G3', 'B3', 'D4']] },
      bloom: { labels: ['Fmaj9', 'Cmaj7', 'Am(add9)', 'Gsus4(add9)'], velocity: 0.48, space: 0,
        chords: [['F2', 'A2', 'E3', 'G3'], ['C3', 'E3', 'G3', 'B3'], ['A2', 'C3', 'E3', 'B3'], ['G2', 'C3', 'D3', 'A3']] }
    };
    this.phrases = [
      [['E5', null, 'C5', null, 'B4', null, 'A4', null], ['C5', null, 'A4', null, 'E5', null, null, null], ['G4', null, 'E5', null, 'D5', null, 'C5', null], ['D5', null, 'B4', null, 'A4', null, null, null]],
      [['A4', null, null, 'B4', 'C5', null, 'E5', null], ['A4', null, 'G4', null, 'E4', null, null, null], ['E5', null, null, 'G5', 'E5', null, 'D5', null], ['B4', null, 'D5', null, 'G4', null, null, null]],
      [['C5', null, 'E5', null, null, 'A5', null, 'E5'], ['E5', null, 'C5', null, null, 'A4', null, null], ['D5', null, 'G5', null, null, 'E5', null, 'C5'], ['A4', null, 'B4', null, null, 'D5', null, null]]
    ];
  }

  keep(node) { this.nodes.push(node); return node; }
  db(percent, ceiling = 0) { return percent <= 0 ? -Infinity : ceiling + 20 * Math.log10(percent / 100); }
  // Fixed post-effect calibration: 100% is now about the former 158%.
  // Keep source timbres, relative balance, Master and the limiter unchanged.
  channelDb(voice) { return this.db(this.settings.volumes[voice], 4); }
  filterFrequency(value = this.settings.brightness) { return 350 * Math.pow(12, value / 100); }
  textureFrequency() { return 650 * Math.pow(8, this.settings.advanced.texture.brightness / 100); }
  getNotes() {
    const notes = this.settings.scale === 'pentatonic' ? ['A4', 'C5', 'D5', 'E5', 'G5'] : ['A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5'];
    return notes.map(note => this.midiToNote(this.noteToMidi(note) + this.settings.octave * 12));
  }
  noteToMidi(note) {
    const pitches = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const match = /^([A-G])([#b]?)(\d)$/.exec(note);
    return (Number(match[3]) + 1) * 12 + pitches[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
  }
  midiToNote(midi) { return ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][midi % 12] + (Math.floor(midi / 12) - 1); }
  fitMelody(midi) {
    while (midi < 57) midi += 12;
    while (midi > 91) midi -= 12;
    return midi;
  }
  currentChord(time) { return this.harmonies[this.activeHarmony].chords[Math.floor(this.barAt(time) / 2) % 4]; }
  chordPool(time, low = 69) {
    let pitches = Array.from(new Set(this.currentChord(time).map(note => this.noteToMidi(note) % 12)));
    if (this.settings.scale === 'pentatonic') pitches = pitches.filter(pitch => [9, 0, 2, 4, 7].includes(pitch));
    return pitches.map(pitch => low + ((pitch - low % 12 + 12) % 12)).sort((a, b) => a - b);
  }
  noteDuration(baseBeats = 0.5) {
    const factor = { short: 0.5, medium: 1, long: 2 }[this.settings.noteLength];
    return Tone.Time('4n').toSeconds() * baseBeats * factor;
  }

  scaleNote(note) {
    if (this.settings.scale !== 'pentatonic' || !note) return note;
    return note.replace(/^B/, 'A').replace(/^F/, 'E');
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.running) return;
    if (!window.Tone) throw new Error('Tone.js не загрузился. Проверьте интернет и перезагрузите страницу.');
    this.startPromise = this.startEngine();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  async startEngine() {
    await Tone.start();
    try {
      this.generation++;
      this.counts = { atmosphere: 0, auto: 0, arp: 0, manual: 0, texture: 0 };
      this.activePhrase = this.settings.phrase;
      this.activeHarmony = this.settings.harmony;
      this.harmonyPrepared = false;
      this.arpIndex = 0;
      this.previousAutoMidi = null;
      this.lastArpNote = null;
      this.lastTextureNote = null;
      this.lastNoteDuration = null;
      this.build();
      await Promise.all([this.atmosphereReverb.generate(), this.melodyReverb.generate(), this.textureReverb.generate(),
        this.vocal.reverb.generate(), this.settings.enabled.voice ? this.vocal.load() : Promise.resolve()]);
      Tone.Transport.bpm.value = this.settings.tempo;
      Tone.Transport.position = 0;
      // Controls remain available while reverb buffers are prepared: use their latest values.
      this.master.mute = this.settings.master === 0;
      this.master.volume.value = this.db(this.settings.master, -6);
      this.filter.frequency.value = this.filterFrequency();
      for (const [voice, parameters] of Object.entries(this.settings.advanced)) {
        for (const [parameter, value] of Object.entries(parameters)) this.applyAdvanced(voice, parameter, value);
      }
      this.running = true;
      this.updateChannels();
      this.updateModeGains();
      this.updateAutomaticEnvelope();
      this.applyTextureCharacter();
      this.output.gain.rampTo(1, 0.3);
      Tone.Transport.start('+0.1');
      if (this.settings.enabled.voice) this.vocal.activate();
      if (this.debug) this.debugTimer = setInterval(() => console.info('[BLOOM audio]', JSON.stringify(this.snapshot())), 2000);
    } catch (error) {
      this.running = false;
      Tone.Transport.stop();
      this.dispose();
      throw error;
    }
  }

  build() {
    const advanced = this.settings.advanced;
    this.output = this.keep(new Tone.Gain(0).toDestination());
    this.limiter = this.keep(new Tone.Limiter(-3).connect(this.output));
    this.master = this.keep(new Tone.Volume(this.db(this.settings.master, -6)).connect(this.limiter));
    this.master.mute = this.settings.master === 0;
    if (this.debug) {
      this.meter = this.keep(new Tone.Meter({ normalRange: false, smoothing: 0 }));
      this.waveform = this.keep(new Tone.Analyser('waveform', 1024));
      this.output.connect(this.meter);
      this.output.connect(this.waveform);
    }
    this.channels = {};
    for (const name of ['atmosphere', 'melody', 'texture', 'voice']) {
      this.channels[name] = this.keep(new Tone.Channel({ volume: -Infinity, pan: name === 'texture' ? 0.2 : name === 'melody' ? -0.12 : 0 }).connect(this.master));
    }

    this.atmosphereReverb = this.keep(new Tone.Reverb({ decay: 6, preDelay: 0.04, wet: advanced.atmosphere.reverb / 100 }).connect(this.channels.atmosphere));
    this.chorus = this.keep(new Tone.Chorus({ frequency: 0.27, delayTime: 3.5, depth: 0.3, wet: advanced.atmosphere.chorus / 100 }).connect(this.atmosphereReverb).start());
    this.filter = this.keep(new Tone.Filter({ frequency: this.filterFrequency(), type: 'lowpass', rolloff: -24, Q: 0.4 }).connect(this.chorus));
    this.pad = this.keep(new Tone.PolySynth(Tone.Synth, {
      volume: -10, oscillator: { type: 'fattriangle', count: 3, spread: 7 },
      envelope: { attack: advanced.atmosphere.attack, decay: 1, sustain: 0.65, release: advanced.atmosphere.release }
    }).connect(this.filter));

    this.melodyReverb = this.keep(new Tone.Reverb({ decay: 4.5, preDelay: 0.025, wet: advanced.melody.reverb / 100 }).connect(this.channels.melody));
    this.melodyDelay = this.keep(new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.22, wet: advanced.melody.delay / 100 }).connect(this.melodyReverb));
    this.manualGain = this.keep(new Tone.Gain(1).connect(this.melodyDelay));
    this.autoGain = this.keep(new Tone.Gain(0).connect(this.melodyDelay));
    const leadOptions = {
      volume: -12, harmonicity: 3, modulationIndex: 0.7,
      oscillator: { type: 'sine' }, modulation: { type: 'sine' },
      envelope: { attack: advanced.melody.attack, decay: 1.3, sustain: 0.08, release: advanced.melody.release },
      modulationEnvelope: { attack: 0.16, decay: 0.8, sustain: 0.05, release: 1.5 }
    };
    this.manualLead = this.keep(new Tone.PolySynth(Tone.FMSynth, leadOptions).connect(this.manualGain));
    this.autoLead = this.keep(new Tone.PolySynth(Tone.FMSynth, leadOptions).connect(this.autoGain));
    this.manualLead.maxPolyphony = 24;
    this.autoLead.maxPolyphony = 16;

    this.textureReverb = this.keep(new Tone.Reverb({ decay: 3.5, preDelay: 0.03, wet: advanced.texture.reverb / 100 }).connect(this.channels.texture));
    this.textureDelay = this.keep(new Tone.FeedbackDelay({ delayTime: '4n.', feedback: 0.25, wet: advanced.texture.delay / 100 }).connect(this.textureReverb));
    this.textureFilter = this.keep(new Tone.Filter({ frequency: this.textureFrequency(), type: 'lowpass', Q: 0.5 }).connect(this.textureDelay));
    this.air = this.keep(new Tone.NoiseSynth({ volume: this.textureSourceDb('air'), noise: { type: 'pink' }, envelope: { attack: 0.7, decay: 1.8, sustain: 0, release: 1.4 } }).connect(this.textureFilter));
    // PolySynth's option volume belongs to each internal Synth; its own output
    // Volume is separate and is calibrated by applyTextureCharacter below.
    this.spark = this.keep(new Tone.PolySynth(Tone.Synth, { volume: -18, oscillator: { type: 'sine' }, envelope: { attack: 0.15, decay: 2, sustain: 0, release: 2 } }).connect(this.textureFilter));
    this.vocal.build();

    // Three shared schedules only: conductor, melody clock (AUTO or ARP), texture.
    this.events.push(Tone.Transport.scheduleRepeat(time => this.conductorStep(time), '8n', 0));
    this.events.push(Tone.Transport.scheduleRepeat(time => this.autoStep(time), '8n', 0));
    this.nextTextureBeat = 0;
    this.events.push(Tone.Transport.scheduleRepeat(time => this.textureStep(time), '4n', 0));
  }

  barAt(time) { return Math.floor((Tone.Transport.getTicksAtTime(time) + 0.01) / (Tone.Transport.PPQ * 4)); }
  eighthAt(time) { return Math.round(Tone.Transport.getTicksAtTime(time) / (Tone.Transport.PPQ / 2)); }

  setHarmony(harmony) {
    if (!this.harmonies[harmony]) return;
    this.settings.harmony = harmony;
    if (!this.running) this.activeHarmony = harmony;
    else if (harmony === this.activeHarmony && this.harmonyPrepared) {
      this.harmonyPrepared = false;
      this.updateChannels(Tone.now(), 0.3);
    }
  }

  duckHarmony(time) {
    // The prepared long vocal retains its dynamics when Harmony changes.
    for (const [name, channel] of Object.entries(this.channels)) if (name !== 'voice') channel.volume.linearRampTo(-Infinity, 0.12, time);
  }

  commitHarmony(time) {
    if (this.eighthAt(time) % 8 !== 0 || this.activeHarmony === this.settings.harmony) return false;
    if (!this.harmonyPrepared) this.duckHarmony(time);
    this.activeHarmony = this.settings.harmony;
    this.pad.releaseAll(time);
    this.releaseMelody(time, true);
    this.spark.releaseAll(time);
    this.air.triggerRelease(time);
    if (this.settings.vocal.mode === 'notes') this.vocal.stopNotes(time, 0.12);
    this.arpIndex = 0;
    this.previousAutoMidi = null;
    this.nextTextureBeat = 0;
    this.harmonyPrepared = false;
    this.updateChannels(time + 0.14, 0.7);
    this.dispatch('harmony', { harmony: this.activeHarmony }, time);
    return true;
  }

  conductorStep(time) {
    if (!this.running) return;
    const eighth = this.eighthAt(time);
    if (eighth % 8 === 7 && this.settings.harmony !== this.activeHarmony) {
      this.duckHarmony(time);
      this.harmonyPrepared = true;
    }
    const changed = this.commitHarmony(time);
    this.vocal.autoStep(time);
    if (this.settings.enabled.voice && (changed || eighth % 16 === 0)) this.dispatch('voice-notes', {}, time);
    if (!this.settings.enabled.atmosphere || (!changed && eighth % 16 !== 0)) return;
    const mood = this.harmonies[this.activeHarmony];
    const duration = eighth % 16 === 8 ? '1m' : '2m';
    this.pad.triggerAttackRelease(this.currentChord(time), duration, time, mood.velocity);
    this.counts.atmosphere++;
    this.visual('atmosphere', time, { duration: Tone.Time(duration).toSeconds() * 1000 });
  }

  autoStep(time) {
    if (!this.running) return;
    this.commitHarmony(time);
    const eighth = this.eighthAt(time);
    if (eighth % 16 === 0 && this.activePhrase !== this.settings.phrase) {
      this.activePhrase = this.settings.phrase;
      this.dispatch('phrase', { phrase: this.activePhrase }, time);
    }
    if (!this.settings.enabled.melody || this.settings.mode === 'manual') return;
    if (this.settings.mode === 'arp') { this.arpStep(time, eighth); return; }

    const patterns = {
      sparse: { steps: [0, 10], lengths: [1.5, 2], velocity: 0.4 },
      flow: { steps: [0, 3, 5, 8, 11, 13], lengths: [0.65], velocity: 0.33 },
      echo: { steps: [0, 2, 4, 10, 12], lengths: [0.4], velocity: 0.36 },
      drift: { steps: [0, 5, 9, 14], lengths: [0.75, 1.5, 0.5, 1], velocity: 0.35 }
    };
    const pattern = patterns[this.settings.autoPattern];
    const step = eighth % 16;
    const position = pattern.steps.indexOf(step);
    if (position < 0) return;
    const variation = this.settings.variation / 100;
    if (variation > 0 && Math.random() < variation * 0.12) return;
    const chordIndex = Math.floor(this.barAt(time) / 2) % 4;
    const seedNotes = this.phrases[this.activePhrase][chordIndex].filter(Boolean);
    const seed = this.noteToMidi(seedNotes[position % seedNotes.length]);
    const pool = this.chordPool(time);
    let index = pool.reduce((best, value, current) => Math.abs(value - seed) < Math.abs(pool[best] - seed) ? current : best, 0);
    if (variation > 0 && Math.random() < variation * 0.45) index = Math.max(0, Math.min(pool.length - 1, index + (Math.random() < 0.5 ? -1 : 1)));
    let midi = pool[index];
    // Keep ordinary variation close; octave excursions are rare and bounded.
    if (variation > 0 && Math.random() < variation * 0.1) midi += Math.random() < 0.5 ? -12 : 12;
    midi = this.fitMelody(midi + this.settings.octave * 12);
    if (this.previousAutoMidi !== null && Math.abs(midi - this.previousAutoMidi) > 12) midi = this.fitMelody(midi + (midi > this.previousAutoMidi ? -12 : 12));
    this.previousAutoMidi = midi;
    let beats = pattern.lengths[position % pattern.lengths.length];
    if (variation > 0 && Math.random() < variation * 0.35) beats *= Math.random() < 0.5 ? 0.75 : 1.25;
    const mood = this.harmonies[this.activeHarmony];
    // RAIN leaves extra space instead of raising synthesis/compression levels.
    if (this.activeHarmony === 'rain' && this.settings.autoPattern === 'flow' && step === 11) return;
    const note = this.midiToNote(midi);
    this.autoLead.triggerAttackRelease(note, this.noteDuration(beats), time, pattern.velocity * (mood.space === 2 ? 0.9 : 1));
    this.lastNoteDuration = this.noteDuration(beats);
    this.counts.auto++;
    this.visual('melody', time, { note, source: 'auto' });
  }

  arpNotes(time) {
    const base = this.chordPool(time, 57);
    const notes = [];
    for (let octave = 0; octave < this.settings.arp.octaves; octave++) {
      for (const midi of base) notes.push(midi + (octave + this.settings.octave) * 12);
    }
    // Shift the whole phrase when needed: direction and octave spacing survive.
    while (Math.min(...notes) < 45) for (let i = 0; i < notes.length; i++) notes[i] += 12;
    while (Math.max(...notes) > 91) for (let i = 0; i < notes.length; i++) notes[i] -= 12;
    return notes.sort((a, b) => a - b);
  }

  arpDuration() {
    const length = { short: 0.55, medium: 0.8, long: 1 }[this.settings.noteLength];
    return Tone.Time(this.settings.arp.rate).toSeconds() * this.settings.arp.gate / 100 * length;
  }

  arpStep(time, eighth) {
    const stride = { '2n': 4, '4n': 2, '8n': 1 }[this.settings.arp.rate];
    if (eighth % stride !== 0) return;
    const pool = this.arpNotes(time);
    let order = pool;
    if (this.settings.arp.direction === 'down') order = [...pool].reverse();
    if (this.settings.arp.direction === 'up-down') order = [...pool, ...pool.slice(1, -1).reverse()];
    const midi = this.settings.arp.direction === 'random' ? pool[Math.floor(Math.random() * pool.length)] : order[this.arpIndex % order.length];
    this.arpIndex++;
    this.updateAutomaticEnvelope();
    const note = this.midiToNote(midi);
    this.autoLead.triggerAttackRelease(note, this.arpDuration(), time, 0.3);
    this.lastArpNote = note;
    this.lastNoteDuration = this.arpDuration();
    this.counts.arp++;
    this.visual('melody', time, { note, source: 'arp' });
  }

  textureStep(time) {
    if (!this.running) return;
    this.commitHarmony(time);
    if (!this.settings.enabled.texture || this.settings.intensity === 0) return;
    const beat = Math.round(Tone.Transport.getTicksAtTime(time) / Tone.Transport.PPQ);
    if (beat < this.nextTextureBeat) return;
    const mood = this.harmonies[this.activeHarmony];
    const baseInterval = this.settings.intensity < 34 ? 8 : this.settings.intensity < 67 ? 4 : 2;
    this.nextTextureBeat = beat + baseInterval + mood.space + (Math.random() < 0.3 ? 1 : 0);
    const character = this.settings.textureCharacter;
    const pool = this.chordPool(time, 72);
    const index = Math.floor(Math.random() * pool.length);
    const note = this.midiToNote(pool[index]);
    if (character === 'air') this.air.triggerAttackRelease(Math.random() < 0.5 ? '2n' : '4n', time, 0.18 + Math.random() * 0.07);
    if (character === 'dust') this.spark.triggerAttackRelease(note, Math.random() < 0.5 ? '8n' : '4n', time, 0.23 + Math.random() * 0.06);
    if (character === 'shimmer') {
      this.spark.triggerAttackRelease(note, '4n', time, 0.18);
      const next = this.midiToNote(pool[(index + 1) % pool.length]);
      this.spark.triggerAttackRelease(next, '8n', time + Tone.Time('8n').toSeconds() * 0.25, 0.14);
    }
    this.lastTextureNote = character === 'air' ? null : note;
    this.counts.texture++;
    this.visual('texture', time, { density: this.settings.intensity });
  }

  // Calibrated +16 dB against the former -26/-20/-24 dB source levels.
  // Texture remains sparse and SHIMMER stays 4 dB below DUST.
  textureSourceDb(character) { return { air: -10, dust: -4, shimmer: -8 }[character]; }

  applyTextureCharacter() {
    if (!this.spark) return;
    this.spark.volume.rampTo(this.textureSourceDb(this.settings.textureCharacter === 'shimmer' ? 'shimmer' : 'dust'), 0.2);
    this.air.volume.rampTo(this.textureSourceDb('air'), 0.2);
  }

  dispatch(type, detail, time) {
    const generation = this.generation;
    const deliver = () => {
      if (this.running && generation === this.generation && this.onEvent) this.onEvent({ type, ...detail });
    };
    if (time === undefined) deliver();
    else Tone.Draw.schedule(deliver, time);
  }

  visual(voice, time, detail = {}) {
    if (this.settings.master === 0 || this.settings.volumes[voice] === 0) return;
    const generation = this.generation;
    const deliver = () => {
      if (!this.running || generation !== this.generation || !this.settings.enabled[voice]) return;
      if (voice === 'melody' && detail.source === 'auto' && !['auto', 'layer'].includes(this.settings.mode)) return;
      if (voice === 'melody' && detail.source === 'arp' && this.settings.mode !== 'arp') return;
      if (this.onEvent) this.onEvent({ type: 'sound', voice, strength: this.settings.volumes[voice] / 100 * this.settings.master / 100, ...detail });
    };
    if (time === undefined) deliver();
    else Tone.Draw.schedule(deliver, time);
  }

  updateChannels(time, duration = 0.3) {
    if (!this.channels) return;
    for (const name of Object.keys(this.channels)) {
      if (name !== 'voice' && this.harmonyPrepared && time === undefined) continue;
      // Volume ramps in linear gain space, including zero. Immediate mute would
      // cut an active waveform before the 300 ms fade and could click.
      this.channels[name].volume.linearRampTo(this.settings.enabled[name] ? this.channelDb(name) : -Infinity, duration, time);
    }
  }

  updateModeGains() {
    if (!this.autoGain) return;
    this.autoGain.gain.rampTo(this.settings.mode === 'manual' ? 0 : this.settings.mode === 'layer' ? 0.4 : 1, 0.08);
    this.manualGain.gain.rampTo(['auto', 'arp'].includes(this.settings.mode) ? 0 : 1, 0.08);
  }

  updateAutomaticEnvelope() {
    if (!this.autoLead) return;
    const settings = this.settings.advanced.melody;
    const arp = this.settings.mode === 'arp';
    this.autoLead.set({ envelope: {
      attack: arp ? Math.min(settings.attack, Math.max(0.03, this.arpDuration() * 0.45)) : settings.attack,
      release: arp ? Math.min(settings.release, Tone.Time(this.settings.arp.rate).toSeconds() * 1.5, 1.2) : settings.release
    } });
  }

  releaseMelody(time, fast = false) {
    if (!this.manualLead) return;
    if (fast) {
      this.manualLead.set({ envelope: { release: 0.15 } });
      this.autoLead.set({ envelope: { release: 0.15 } });
    }
    this.manualLead.releaseAll(time);
    this.autoLead.releaseAll(time);
    if (fast) {
      this.manualLead.set({ envelope: { release: this.settings.advanced.melody.release } });
      this.updateAutomaticEnvelope();
    }
  }

  setVoice(name, enabled) {
    this.settings.enabled[name] = enabled;
    this.updateChannels();
    if (!enabled && this.running) {
      if (name === 'atmosphere') this.pad.releaseAll();
      if (name === 'melody') this.releaseMelody();
      if (name === 'texture') { this.spark.releaseAll(); this.air.triggerRelease(); }
    }
    if (name === 'voice') this.vocal.setEnabled(enabled);
  }

  setMode(mode) {
    if (!['manual', 'auto', 'layer', 'arp'].includes(mode)) return;
    this.settings.mode = mode;
    this.arpIndex = 0;
    if (this.running) { this.releaseMelody(Tone.now(), true); this.updateModeGains(); this.updateAutomaticEnvelope(); }
  }

  setScale(scale) {
    if (!['minor', 'pentatonic'].includes(scale)) return;
    this.settings.scale = scale;
    if (this.running) this.releaseMelody();
    this.vocal.stopNotes(undefined, 0.12);
  }

  setPhrase(phrase) {
    this.settings.phrase = Math.max(0, Math.min(2, Number(phrase)));
    if (!this.running || this.settings.mode === 'manual') this.activePhrase = this.settings.phrase;
  }

  setChoice(name, value) {
    if (name.startsWith('voice-')) { this.vocal.setChoice(name.slice(6), value); return; }
    if (name === 'harmony') { this.setHarmony(value); return; }
    const choices = {
      autoPattern: ['sparse', 'flow', 'echo', 'drift'], octave: [-1, 0, 1],
      noteLength: ['short', 'medium', 'long'], textureCharacter: ['air', 'dust', 'shimmer']
    };
    if (name.startsWith('arp-')) {
      const parameter = name.slice(4);
      const options = { direction: ['up', 'down', 'up-down', 'random'], rate: ['2n', '4n', '8n'], octaves: [1, 2] };
      if (!options[parameter] || !options[parameter].includes(value)) return;
      this.settings.arp[parameter] = value;
      this.arpIndex = 0;
    } else {
      if (!choices[name] || !choices[name].includes(value)) return;
      this.settings[name] = value;
      if (name === 'textureCharacter') { this.nextTextureBeat = 0; if (this.running) this.applyTextureCharacter(); }
    }
    if (this.running && name !== 'textureCharacter') this.updateAutomaticEnvelope();
  }

  setParameter(name, value) {
    if (name === 'arp-gate') { this.settings.arp.gate = value; if (this.running) this.updateAutomaticEnvelope(); return; }
    const [voice, parameter] = name.split('-');
    if (parameter === 'volume') {
      if (!(voice in this.settings.volumes) || !Number.isFinite(value)) return;
      this.settings.volumes[voice] = Math.max(0, Math.min(150, value));
      this.updateChannels();
      return;
    }
    if (voice === 'voice') { this.vocal.setParameter(parameter, value); return; }
    if (parameter && this.settings.advanced[voice] && parameter in this.settings.advanced[voice]) {
      this.settings.advanced[voice][parameter] = value;
      if (this.running) this.applyAdvanced(voice, parameter, value);
      return;
    }
    this.settings[name] = value;
    if (!this.running) return;
    if (name === 'tempo') { Tone.Transport.bpm.rampTo(value, 0.4); this.updateAutomaticEnvelope(); }
    if (name === 'master') {
      this.master.mute = value === 0;
      this.master.volume.linearRampTo(this.db(value, -6), 0.15);
    }
    if (name === 'brightness') this.filter.frequency.rampTo(this.filterFrequency(), 0.3);
    if (name === 'intensity') this.nextTextureBeat = 0;
  }

  applyAdvanced(voice, parameter, value) {
    if (parameter === 'attack' || parameter === 'release') {
      const settings = { envelope: { [parameter]: value } };
      if (voice === 'atmosphere') this.pad.set(settings);
      if (voice === 'melody') { this.manualLead.set(settings); this.updateAutomaticEnvelope(); }
    }
    if (parameter === 'reverb') this[voice + 'Reverb'].wet.rampTo(value / 100, 0.2);
    if (parameter === 'chorus') this.chorus.wet.rampTo(value / 100, 0.2);
    if (parameter === 'delay') this[voice + 'Delay'].wet.rampTo(value / 100, 0.2);
    if (voice === 'texture' && parameter === 'brightness') this.textureFilter.frequency.rampTo(this.textureFrequency(), 0.3);
  }

  playNote(note) {
    if (!this.running || !this.settings.enabled.melody || ['auto', 'arp'].includes(this.settings.mode)) return false;
    if (!this.getNotes().includes(note)) return false;
    this.manualLead.triggerAttackRelease(note, this.noteDuration(), Tone.now(), 0.45);
    this.lastNoteDuration = this.noteDuration();
    this.counts.manual++;
    this.visual('melody', undefined, { note, source: 'manual' });
    return true;
  }

  async stop(fadeSeconds = 0.12) {
    if (this.stopPromise) return this.stopPromise;
    if (!this.running) return;
    this.stopPromise = this.stopEngine(fadeSeconds);
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }

  async stopEngine(fadeSeconds) {
    this.output.gain.cancelScheduledValues(Tone.now());
    this.output.gain.rampTo(0, fadeSeconds);
    await new Promise(resolve => setTimeout(resolve, fadeSeconds * 1000 + 80));
    this.running = false;
    this.generation++;
    Tone.Transport.stop();
    Tone.Transport.position = 0;
    this.pad.releaseAll();
    this.releaseMelody();
    this.spark.releaseAll();
    this.air.triggerRelease();
    this.dispose();
    if (this.debug) console.info('[BLOOM stopped]', JSON.stringify({ transport: Tone.Transport.state, nodes: this.nodes.length, events: this.events.length, counts: this.counts, vocal: this.vocal.snapshot() }));
  }

  snapshot() {
    return {
      context: Tone.getContext().state, transport: Tone.Transport.state,
      vocal: this.vocal.snapshot(),
      nodes: this.nodes.length, events: this.events.length,
      rmsDb: this.meter ? this.meter.getValue() : null,
      samplePeak: this.waveform ? Math.max(...Array.from(this.waveform.getValue(), Math.abs)) : null,
      levels: {
        synthsDb: { atmosphere: this.pad.get().volume, manual: this.manualLead.get().volume,
          auto: this.autoLead.get().volume, spark: this.spark.get().volume },
        outputsDb: { atmosphere: this.pad.volume.value, manual: this.manualLead.volume.value,
          auto: this.autoLead.volume.value, air: this.air.volume.value, spark: this.spark.volume.value },
        channelsDb: Object.fromEntries(Object.entries(this.channels).map(([name, channel]) => [name, channel.volume.value])),
        masterDb: this.master.volume.value, limiterReductionDb: this.limiter.reduction
      },
      mode: this.settings.mode, scale: this.settings.scale, phrase: this.activePhrase,
      harmony: this.activeHarmony, requestedHarmony: this.settings.harmony,
      pattern: this.settings.autoPattern, variation: this.settings.variation, octave: this.settings.octave, noteLength: this.settings.noteLength,
      arp: { ...this.settings.arp }, textureCharacter: this.settings.textureCharacter,
      lastArpNote: this.lastArpNote || null, lastNoteDuration: this.lastNoteDuration || null, lastTextureNote: this.lastTextureNote || null,
      lastAutoNote: this.autoLead && this.previousAutoMidi !== null ? this.midiToNote(this.previousAutoMidi) : null,
      counts: { ...this.counts },
      filterHz: this.filter.frequency.value, textureHz: this.textureFilter.frequency.value,
      autoGain: this.autoGain.gain.value, manualGain: this.manualGain.gain.value,
      actual: {
        atmosphere: { ...this.pad.get().envelope, reverb: this.atmosphereReverb.wet.value, chorus: this.chorus.wet.value },
        melody: { ...this.manualLead.get().envelope, reverb: this.melodyReverb.wet.value, delay: this.melodyDelay.wet.value },
        automaticEnvelope: this.autoLead.get().envelope,
        texture: { reverb: this.textureReverb.wet.value, delay: this.textureDelay.wet.value }
      }
    };
  }

  dispose() {
    this.vocal.dispose();
    clearInterval(this.debugTimer);
    this.debugTimer = null;
    for (const id of this.events) Tone.Transport.clear(id);
    this.events = [];
    for (const node of this.nodes.reverse()) node.dispose();
    this.nodes = [];
    this.channels = null;
  }
};
