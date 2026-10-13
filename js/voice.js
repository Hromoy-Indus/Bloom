/* Only the four prepared WAVs. Original files are never rewritten.
 * F0 measured with YIN; see docs/vocal-analysis.json. Player resampling changes
 * duration/formants as well as pitch, so notes stay within about five semitones.
 */
window.BloomVoice = class BloomVoice {
  static assetRoot = new URL('../assets/audio/', document.currentScript.src).href;
  constructor(audio) {
    this.audio = audio;
    this.samples = {
      a: { file: '01_ethereal_stable_A.wav', hz: 441.07, gainDb: 6, sustain: { start: 3.6, end: 4.384580498866213, crossfade: 0.08 } },
      b: { file: '02_solo_soft_B.wav', hz: 218.46, gainDb: 12 },
      c: { file: '03_solo_soft_C.wav', hz: 247.07, gainDb: 11.5, sustain: { start: 3, end: 3.8554648526077098, crossfade: 0.08 } }
    };
    this.players = new Map();
    this.sustainBuffers = new Map();
    this.resetAutoPhrase();
    this.pool = [];
    this.loadVersion = 0;
    this.error = '';
    this.noteStarts = 0;
    this.trackStarts = 0;
    this.ready = false;
    this.atmospherePlaying = false;
    this.atmosphereRequest = 0;
    this.finished = false;
  }
  now() { return this.filter?.context ? this.filter.context.now() : window.Tone ? Tone.now() : 0; }
  get settings() { return this.audio.settings.vocal; }
  notify() { if (this.audio.onEvent) this.audio.onEvent({ type: 'voice-state' }); }
  filterFrequency() { return 900 * Math.pow(8, this.settings.timbre / 100); }
  reverbAmount() { return this.settings.mode === 'atmosphere' ? this.settings.atmosphereReverb : this.settings.reverb; }
  build() {
    this.reverb = this.audio.keep(new Tone.Reverb({ decay: 3.5, preDelay: 0.03, wet: this.reverbAmount() / 100 }).connect(this.audio.channels.voice));
    this.filter = this.audio.keep(new Tone.Filter({ frequency: this.filterFrequency(), type: 'lowpass', rolloff: -12, Q: 0.4 }).connect(this.reverb));
  }
  load() {
    if (this.ready) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const version = ++this.loadVersion;
    this.error = '';
    this.loading = true;
    const urls = Object.fromEntries(Object.entries(this.samples).map(([id, sample]) => [id, BloomVoice.assetRoot + sample.file]));
    urls.atmosphere = BloomVoice.assetRoot + '04_ethereal_8580_fade_at_23s.wav';
    let buffers;
    const promise = new Promise((resolve, reject) => {
      buffers = new Tone.ToneAudioBuffers({ urls, onload: () => {
        if (version === this.loadVersion) {
          this.ready = true;
          this.loading = false;
          this.notify();
        }
        resolve();
      }, onerror: () => {
        if (version === this.loadVersion) {
          this.loading = false;
          this.error = 'Не удалось загрузить вокальные WAV. Проверьте файлы в assets/audio/ и перезагрузите страницу.';
          this.notify();
        }
        reject(new Error('Не удалось загрузить четыре вокальных файла VOICE.'));
      } });
    });
    this.buffers = buffers;
    this.loadPromise = promise;
    this.notify();
    return promise;
  }
  rootMidi() { return 69 + 12 * Math.log2(this.samples[this.settings.sample].hz / 440); }
  notes(time, chordIndex) {
    const root = this.rootMidi();
    const chosenChord = Number.isInteger(chordIndex) ? this.audio.harmonies[this.audio.activeHarmony].chords[chordIndex] : null;
    const chord = chosenChord || (this.audio.running ? this.audio.currentChord(time ?? this.now()) : this.audio.harmonies[this.audio.activeHarmony].chords[0]);
    const pitches = new Set(chord.map(note => this.audio.noteToMidi(note) % 12));
    const scale = this.audio.settings.scale === 'pentatonic' ? [9, 0, 2, 4, 7] : [9, 11, 0, 2, 4, 5, 7];
    const notes = [];
    for (let midi = Math.ceil(root - 5.25); midi <= Math.floor(root + 5.25); midi++) {
      if (pitches.has(midi % 12) && scale.includes(midi % 12)) notes.push(this.audio.midiToNote(midi));
    }
    return notes;
  }
  beginNote(note, time = this.now(), chordIndex, automatic = false) {
    if (!this.audio.running || this.audio.stopPromise || !this.audio.settings.enabled.voice || this.settings.mode !== (automatic ? 'auto' : 'notes') || !this.ready || !this.filter) return false;
    if (!this.notes(time, chordIndex).includes(note) || this.players.has(note) || this.players.size >= 3) return false;
    if (!this.pool.length) this.createPool();
    const slot = this.pool.find(entry => !entry.inUse);
    if (!slot) return false;
    const sample = this.samples[this.settings.sample];
    const { player, envelope } = slot;
    const sustain = automatic && sample.sustain;
    player.buffer = sustain ? this.sustainBuffer(this.settings.sample) : this.buffers.get(this.settings.sample);
    player.loop = !!sustain;
    if (sustain) { player.loopStart = sustain.start + sustain.crossfade; player.loopEnd = player.buffer.duration; }
    player.playbackRate = Math.pow(2, (this.audio.noteToMidi(note) - this.rootMidi()) / 12);
    player.volume.value = sample.gainDb;
    slot.sample = this.settings.sample;
    slot.note = note; slot.inUse = true; slot.releasing = false;
    this.players.set(note, slot);
    this.noteStarts++;
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampTo(1, this.settings.attack, time);
    player.start(time);
    this.notify();
    return true;
  }
  sustainBuffer(id) {
    if (this.sustainBuffers.has(id)) return this.sustainBuffers.get(id);
    const spec = this.samples[id].sustain, source = this.buffers.get(id).get();
    const end = Math.round(spec.end * source.sampleRate), start = Math.round(spec.start * source.sampleRate);
    const fade = Math.round(spec.crossfade * source.sampleRate);
    const raw = this.filter.context.rawContext.createBuffer(source.numberOfChannels, end, source.sampleRate);
    for (let channel = 0; channel < source.numberOfChannels; channel++) {
      const input = source.getChannelData(channel), output = raw.getChannelData(channel);
      output.set(input.subarray(0, end)); // Natural onset stays bit-identical.
      for (let i = 0; i < fade; i++) {
        const x = i / (fade - 1), blend = x*x*x*(10+x*(-15+6*x));
        output[end-fade+i] = input[end-fade+i]*(1-blend) + input[start+i]*blend;
      }
    }
    const buffer = new Tone.ToneAudioBuffer(raw);
    this.sustainBuffers.set(id, buffer);
    return buffer;
  }
  resetAutoPhrase() {
    this.autoPhrase = null;
    this.autoNextAt = 0;
    this.autoChordIndex = 0;
    this.autoPhraseCount = 0;
    this.autoLabel = '';
    this.autoPreviousChord = null;
    this.autoPreviousVoicing = null;
    this.autoSelectionLimited = false;
  }
  chordIdentity(notes) {
    // Pitch-class sets: inversions, octave doublings and spelling do not
    // turn the same harmony into a different chord.
    return [...new Set(notes.map(note => (this.audio.noteToMidi(note)%12+12)%12))].sort((a,b)=>a-b).join(',');
  }
  autoVoicing(time, chordIndex) {
    const chord = this.audio.harmonies[this.audio.activeHarmony].chords[chordIndex];
    const available = this.notes(time, chordIndex);
    return [...new Set(chord.map(pitch => available.find(note => this.audio.noteToMidi(note)%12 === this.audio.noteToMidi(pitch)%12)).filter(Boolean))].slice(0,3);
  }
  selectAutoChord(time) {
    const bank = this.audio.harmonies[this.audio.activeHarmony];
    if (!bank.chords.length) return null;
    const preferred = Math.floor(this.audio.barAt(time)/2)%bank.chords.length;
    // Prefer the Transport chord. On a repeat, scan forward in this same
    // Harmony only; no random choices or chords from another mood.
    for (let offset=0; offset<bank.chords.length; offset++) {
      const index = (preferred+offset)%bank.chords.length;
      const voicing = this.autoVoicing(time,index);
      if (!voicing.length) continue;
      const identity = this.chordIdentity(bank.chords[index]);
      const voicedIdentity = this.chordIdentity(voicing);
      // Also exclude an identical audible reduction (e.g. pentatonic chords).
      if (identity===this.autoPreviousChord || voicedIdentity===this.autoPreviousVoicing) continue;
      return { index, voicing, identity, voicedIdentity };
    }
    return null;
  }
  autoStep(time) {
    // Single existing conductor clock. Audio-context deadlines are seconds,
    // unaffected by BPM; entrances wait for the next eighth-note grid point.
    if (this.settings.mode !== 'auto' || !this.audio.running || this.audio.stopPromise || !this.audio.settings.enabled.voice || !this.ready) return;
    if (time + 0.001 < this.autoNextAt || this.players.size) return;
    if (!this.autoPhrase) {
      // Small downward-only variation: the slider is the third-hold ceiling.
      const variation = [0, -0.025, -0.01, -0.015][this.autoPhraseCount % 4];
      const maximum = this.settings.chordDuration * (1+variation);
      this.autoPhrase = { maximum, durations: [1/2.2, 1.3/2.2, 1].map(ratio => maximum * ratio), pause: this.settings.phrasePause };
      this.autoChordIndex = 0;
      this.autoPhraseCount++;
    }
    const bank = this.audio.harmonies[this.audio.activeHarmony];
    const choice = this.selectAutoChord(time);
    if (!choice) {
      // A single distinct playable chord cannot satisfy the rule. Leave the
      // phrase intact and retry on the same conductor after one beat.
      this.autoSelectionLimited = true;
      this.autoNextAt = time + Tone.Time('4n').toSeconds();
      return;
    }
    const chordIndex = choice.index, voicing = choice.voicing;
    const sample = this.samples[this.settings.sample];
    let duration = this.autoPhrase.durations[this.autoChordIndex];
    if (!sample.sustain) {
      // B needs more even, longer openings. Fit the longest hold into the
      // actual resampled source, reserving the selected Release and stop margin.
      const fastest = Math.max(...voicing.map(note => Math.pow(2,(this.audio.noteToMidi(note)-this.rootMidi())/12)));
      const budget = Math.max(0.3, this.buffers.get(this.settings.sample).duration / fastest - this.settings.release - 0.03);
      const maximum = Math.min(this.autoPhrase.maximum, budget);
      duration = maximum * [0.9, 0.95, 1][this.autoChordIndex];
    }
    const endHold = time + duration;
    let started = false;
    voicing.forEach((note,index) => {
      const start = time + index*Math.min(0.12,duration*0.1);
      if (!this.beginNote(note,start,chordIndex,true)) return;
      started = true;
      const slot = this.players.get(note);
      const sourceEnd = start + slot.player.buffer.duration / slot.player.playbackRate;
      const release = sample.sustain ? this.settings.release : Math.min(this.settings.release, Math.max(0.02,sourceEnd-endHold-0.03));
      slot.envelope.gain.linearRampTo(0,release,endHold);
      slot.player.stop(endHold+release+0.02);
    });
    if (!started) return;
    this.autoSelectionLimited = false;
    this.autoPreviousChord = choice.identity;
    this.autoPreviousVoicing = choice.voicedIdentity;
    this.autoLabel = bank.labels[chordIndex];
    this.autoNextAt = endHold;
    this.autoChordIndex++;
    if (this.autoChordIndex === 3) {
      this.autoNextAt += this.autoPhrase.pause;
      this.autoPhrase = null;
    }
    this.notify();
  }
  createPool() {
    // Fixed three-player pool: no growing graph and no disconnecting a note's
    // gain during an Offline render. Players remain idle until a user note.
    for (let index = 0; index < 3; index++) {
      const envelope = new Tone.Gain({ gain: 0, context: this.filter.context }).connect(this.filter);
      const slot = { envelope, inUse: false, releasing: false, note: null };
      slot.player = new Tone.Player({ context: this.filter.context, loop: false,
        playbackRate: 1, volume: 0, fadeIn: 0, fadeOut: 0, onstop: () => {
          if (this.players.get(slot.note) === slot) this.players.delete(slot.note);
          slot.inUse = false; slot.note = null; slot.releasing = false;
          this.notify();
        } }).connect(envelope);
      this.pool.push(slot);
    }
  }
  releaseNote(note, time = this.now(), release = this.settings.release) {
    const entry = this.players.get(note);
    if (!entry || entry.releasing) return;
    entry.releasing = true;
    entry.envelope.gain.linearRampTo(0, release, time);
    entry.player.stop(time + release + 0.02);
  }
  stopNotes(time = this.now(), release = this.settings.release) {
    for (const note of this.players.keys()) this.releaseNote(note, time, release);
  }
  atmosphereFadeCurve() {
    // One second of quintic smoothstep, with zero first/second derivatives
    // at both ends: full gain until 16.5 s, silence at 17.5 s.
    return Array.from({ length: 101 }, (_, index) => {
      const x = index / 100;
      const smooth = x * x * x * (10 + x * (-15 + 6 * x));
      return 1 - smooth;
    });
  }
  scheduleAtmosphereFade(startTime) {
    const gain = this.longEnvelope.gain;
    const now = this.now();
    // Replace pending automation without a discontinuity in a source still
    // completing its explicit stop; restartAfter keeps the new source separate.
    gain.cancelAndHoldAtTime(now);
    gain.setValueAtTime(1, startTime);
    gain.setValueCurveAtTime(this.atmosphereFadeCurve(), startTime + 16.5, 1);
  }
  async startAtmosphere() {
    if (this.atmospherePlaying || this.atmosphereStartPromise) return false;
    const request = ++this.atmosphereRequest;
    const start = async () => {
      await this.load();
      if (request !== this.atmosphereRequest || !this.audio.running || this.audio.stopPromise || !this.audio.settings.enabled.voice || this.settings.mode !== 'atmosphere' || !this.filter) return false;
      if (!this.longPlayer) {
        this.longEnvelope = new Tone.Gain({ gain: 0, context: this.filter.context }).connect(this.filter);
        this.longPlayer = new Tone.Player({ context: this.filter.context, url: this.buffers.get('atmosphere'), loop: false,
          playbackRate: 1, volume: 4, fadeIn: 0, fadeOut: 0, onstop: () => {
            if (this.atmospherePlaying && this.now() >= this.longEndsAt - 0.05) {
              this.atmospherePlaying = false;
              this.finished = true;
              this.notify();
            }
          } }).connect(this.longEnvelope);
      }
      this.longPlayer.fadeIn = 0;
      this.longPlayer.fadeOut = 0;
      this.finished = false;
      this.atmospherePlaying = true;
      this.trackStarts++;
      const startTime = Math.max(this.now(), this.restartAfter || 0);
      this.longEndsAt = startTime + 17.5;
      this.scheduleAtmosphereFade(startTime);
      this.longPlayer.start(startTime);
      // Stop the source at zero gain; keep Filter/Reverb connected for the tail.
      this.longPlayer.stop(this.longEndsAt);
      this.notify();
      return true;
    };
    const promise = start();
    this.atmosphereStartPromise = promise;
    try { return await promise; }
    catch (error) { this.error = error.message; this.notify(); return false; }
    finally { if (this.atmosphereStartPromise === promise) this.atmosphereStartPromise = null; }
  }
  stopAtmosphere(release = 0.12) {
    this.atmosphereRequest++;
    this.atmosphereStartPromise = null;
    if (this.longPlayer && this.atmospherePlaying) {
      // Ready-made composition uses fadeOut=0. Fade its channel only on a
      // user stop/mode switch, then stop the single player after the fade.
      this.audio.channels.voice.volume.linearRampTo(-Infinity, release);
      this.longPlayer.stop(this.now() + release);
      this.restartAfter = this.now() + release + 0.02;
    }
    this.atmospherePlaying = false;
  }
  async activate() {
    try {
      const loading = this.load();
      const version = this.loadVersion;
      await loading;
      if (version !== this.loadVersion || !this.audio.running || !this.audio.settings.enabled.voice || !this.filter) return;
      // Mode and parameters may have changed while loading.
      this.applySettings();
      if (this.settings.mode === 'atmosphere') await this.startAtmosphere();
    } catch (error) { this.error = error.message; this.notify(); }
  }
  setEnabled(enabled) {
    if (!enabled) { this.resetAutoPhrase(); this.stopNotes(); this.stopAtmosphere(); }
    else if (this.audio.running) this.activate();
    this.notify();
  }
  setChoice(name, value) {
    if (name === 'mode' && ['notes', 'auto', 'atmosphere'].includes(value)) {
      this.resetAutoPhrase();
      this.stopNotes(this.now(), 0.12);
      this.stopAtmosphere();
      this.settings.mode = value;
      this.applySettings();
      if (this.audio.channels) this.audio.channels.voice.volume.linearRampTo(this.audio.settings.enabled.voice ? this.audio.channelDb('voice') : -Infinity, 0.3, this.now() + 0.14);
      if (this.audio.running && this.audio.settings.enabled.voice) this.activate();
    }
    if (name === 'sample' && this.samples[value]) {
      if (this.settings.mode !== 'auto') this.stopNotes(this.now(), 0.12);
      this.settings.sample = value;
    }
    this.notify();
  }
  setParameter(name, value) {
    const ranges = { timbre: [0, 100], attack: [0.02, 2], release: [0.1, 3], reverb: [0, 50], chordDuration: [3, 5], phrasePause: [0, 10] };
    if (!ranges[name] || !Number.isFinite(value)) return;
    const [low, high] = ranges[name];
    const key = name === 'reverb' && this.settings.mode === 'atmosphere' ? 'atmosphereReverb' : name;
    this.settings[key] = Math.max(low, Math.min(high, value));
    this.applySettings();
  }
  applySettings() {
    if (this.filter) this.filter.frequency.rampTo(this.filterFrequency(), 0.3);
    if (this.reverb) this.reverb.wet.rampTo(this.reverbAmount() / 100, 0.2);
  }
  dispose() {
    this.loadVersion++;
    this.atmosphereRequest++;
    for (const { player, envelope } of this.pool) { player.dispose(); envelope.dispose(); }
    this.pool = [];
    this.players.clear();
    for (const buffer of this.sustainBuffers.values()) buffer.dispose();
    this.sustainBuffers.clear();
    this.resetAutoPhrase();
    if (this.longPlayer) this.longPlayer.dispose();
    this.longPlayer = null;
    if (this.longEnvelope) this.longEnvelope.dispose();
    this.longEnvelope = null;
    const buffers = this.buffers;
    if (buffers) {
      if (this.ready) buffers.dispose();
      else this.loadPromise.then(() => buffers.dispose(), () => buffers.dispose());
    }
    this.buffers = null;
    this.loadPromise = null;
    this.ready = false;
    this.loading = false;
    this.atmospherePlaying = false;
    this.finished = false;
    this.atmosphereStartPromise = null;
    this.restartAfter = 0;
    this.filter = null;
    this.reverb = null;
  }
  snapshot() {
    return { ready: this.ready, loading: !!this.loading, mode: this.settings.mode,
      autoSelectionLimited: this.autoSelectionLimited, lastAutoChord: this.autoPreviousChord,
      lastAutoVoicing: this.autoPreviousVoicing,
      loadedFiles: this.ready ? 4 : 0, noteStarts: this.noteStarts, trackStarts: this.trackStarts,
      sample: this.settings.sample, rootHz: this.samples[this.settings.sample].hz,
      activeNotes: [...this.players.keys()], activePlayers: this.players.size,
      pooledPlayers: this.pool.length,
      activeSamples: [...this.players.values()].map(entry => entry.sample),
      rates: [...this.players.values()].map(entry => entry.player.playbackRate),
      atmospherePlaying: this.atmospherePlaying, longRate: this.longPlayer ? this.longPlayer.playbackRate : null,
      filterHz: this.filter ? this.filter.frequency.value : null, wet: this.reverb ? this.reverb.wet.value : null };
  }
};
