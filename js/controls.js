window.BloomControls = class BloomControls {
  constructor(audio) {
    this.audio = audio;
    this.busy = false;
    this.selectedVoice = 'atmosphere';
    this.melodyTab = 'music';
    this.keyboardInstrument = 'melody';
    this.vocalInputs = new Map();
    this.vocalSetIndex = 0;
    this.animations = new Map();
    this.melodyWaves = [];
    this.nextMelodyWave = 0;
    this.keys = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ'];
    this.keyNames = ['A', 'S', 'D', 'F', 'G', 'H', 'J'];
    this.phraseNames = ['Исток', 'Отражение', 'Полёт'];
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  }

  choiceLabel(id, value) {
    return Array.from(document.getElementById(id).options).find(option => option.value === value).textContent;
  }

  status(text) { document.querySelector('#status').textContent = text; }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.audio.onEvent = event => this.soundEvent(event);
    this.buildMelodyWaves();
    this.reducedMotion.addEventListener('change', () => this.clearVoiceAnimation('melody'));
    this.resizeScene();
    this.resizeObserver = new ResizeObserver(() => this.resizeScene());
    this.resizeObserver.observe(document.querySelector('.world'));
    document.querySelectorAll('[data-toggle]').forEach(button => button.addEventListener('click', () => {
      const name = button.dataset.toggle;
      this.audio.setVoice(name, !this.audio.settings.enabled[name]);
      if (!this.audio.settings.enabled[name]) this.clearVoiceAnimation(name);
      this.renderStates();
      const hasVoices = Object.values(this.audio.settings.enabled).some(Boolean);
      this.status(this.audio.running ? (hasVoices ? 'Голоса входят в общую музыкальную сетку. MELODY: ' + this.choiceLabel('mode', this.audio.settings.mode) + '.' : 'Все голоса выключены. Пространство ждёт следующего звука.') : 'Выберите голоса и нажмите «Воспроизвести» для запуска звука.');
    }));
    document.querySelectorAll('input[type=range]').forEach(input => input.addEventListener('input', () => {
      this.audio.setParameter(input.dataset.parameter || input.id, Number(input.value));
      if (input.id === 'arp-gate') this.renderMode();
      document.getElementById(input.id + '-value').textContent = input.value + input.dataset.unit;
    }));
    document.querySelectorAll('[data-choice]').forEach(select => select.addEventListener('change', () => {
      const numeric = ['octave', 'arp-octaves'].includes(select.dataset.choice);
      this.audio.setChoice(select.dataset.choice, numeric ? Number(select.value) : select.value);
      if (['voice-mode', 'voice-sample'].includes(select.dataset.choice)) this.releaseVocalInputs();
      if (select.dataset.choice === 'octave') {
        this.clearVoiceAnimation('melody');
        this.renderNotes();
      }
      this.renderMode();
      if (select.dataset.choice === 'harmony') this.renderHarmony(true);
      this.renderVoice();
    }));
    const tabs = Array.from(document.querySelectorAll('[data-tab]'));
    tabs.forEach((button, index) => {
      button.addEventListener('click', () => this.selectMelodyTab(button.dataset.tab));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        this.selectMelodyTab(tabs[next].dataset.tab);
        tabs[next].focus();
      });
    });
    document.querySelectorAll('[data-phrase]').forEach(button => button.addEventListener('click', () => {
      this.audio.setPhrase(Number(button.dataset.phrase));
      this.renderPhrase();
    }));
    document.querySelector('#mode').addEventListener('change', event => {
      this.audio.setMode(event.target.value);
      this.clearVoiceAnimation('melody');
      if (event.target.value === 'arp') this.selectMelodyTab('arp');
      this.renderMode();
      this.renderPhrase();
      this.status('MELODY: ' + this.choiceLabel('mode', event.target.value) + '. ' + document.querySelector('#mode-hint').textContent);
    });
    document.querySelector('#scale').addEventListener('change', event => {
      this.audio.setScale(event.target.value);
      this.clearVoiceAnimation('melody');
      this.renderNotes();
      this.renderVoice();
      this.status('Клавиатура: ' + (event.target.value === 'minor' ? 'Ля минор — семь нот.' : 'Ля минорная пентатоника — пять нот.'));
    });
    document.querySelector('#notes').addEventListener('click', event => {
      const button = event.target.closest('[data-note]');
      if (button) this.note(button);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.closeSettings(); return; }
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      const index = this.keys.indexOf(event.code);
      if (this.keyboardInstrument === 'voice') {
        if (this.audio.settings.vocal.mode !== 'notes') return;
        const note = this.vocalNotes()[index];
        if (index >= 0 && note) { event.preventDefault(); this.holdVocal(note, 'key:' + event.code); }
        return;
      }
      const button = document.querySelectorAll('[data-note]')[index];
      if (index >= 0 && button) { event.preventDefault(); this.note(button); }
    });
    document.addEventListener('keyup', event => {
      this.releaseVocal('key:' + event.code);
      this.releaseVocal('button:' + event.code);
    });
    window.addEventListener('blur', () => this.releaseVocalInputs());
    document.querySelector('#voice-launch').addEventListener('click', event => this.toggleSettings('voice', event.currentTarget));
    document.querySelector('#voice-enabled').addEventListener('click', () => {
      this.audio.setVoice('voice', !this.audio.settings.enabled.voice);
      this.renderStates();
    });
    document.querySelector('#keyboard-target').addEventListener('change', event => {
      this.releaseVocalInputs();
      this.keyboardInstrument = event.target.value;
      this.renderMode();
      this.renderVoice();
    });
    document.querySelector('#voice-restart').addEventListener('click', () => this.audio.vocal.startAtmosphere());
    document.querySelector('#voice-chords-prev').addEventListener('click', () => this.switchVocalSet(-1));
    document.querySelector('#voice-chords-next').addEventListener('click', () => this.switchVocalSet(1));
    const vocalKeyboard = document.querySelector('#voice-notes');
    vocalKeyboard.addEventListener('pointerdown', event => {
      const button = event.target.closest('[data-vocal-note]');
      if (!button || button.disabled || event.button !== 0) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      this.holdVocal(button.dataset.vocalNote, 'pointer:' + event.pointerId);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) vocalKeyboard.addEventListener(type, event => this.releaseVocal('pointer:' + event.pointerId));
    vocalKeyboard.addEventListener('keydown', event => {
      const button = event.target.closest('[data-vocal-note]');
      if (!button || button.disabled || event.repeat || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); this.holdVocal(button.dataset.vocalNote, 'button:' + event.code);
    });
    vocalKeyboard.addEventListener('keyup', event => {
      const button = event.target.closest('[data-vocal-note]');
      if (button && ['Enter', ' '].includes(event.key)) { event.preventDefault(); this.releaseVocal('button:' + event.code); }
    });
    document.querySelectorAll('[data-settings]').forEach(button => button.addEventListener('click', () => this.toggleSettings(button.dataset.settings, button)));
    document.querySelector('#settings').addEventListener('click', event => this.toggleSettings(this.selectedVoice, event.currentTarget));
    document.querySelector('#close-settings').addEventListener('click', () => this.closeSettings());
    document.querySelector('#play').addEventListener('click', () => this.togglePlayback());
    document.querySelector('#fade').addEventListener('click', () => this.togglePlayback(6));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.audio.running && !this.busy) this.togglePlayback();
    });
    this.renderNotes();
    this.renderMode();
    this.renderStates();
    this.renderHarmony();
    this.renderVoice();
  }

  resizeScene() {
    const world = document.querySelector('.world');
    const width = world.clientWidth;
    const height = world.clientHeight;
    const scale = Math.max(width / 1672, height / 941);
    const scene = document.querySelector('#scene');
    scene.style.setProperty('--scene-width', (1672 * scale) + 'px');
    scene.style.setProperty('--scene-height', (941 * scale) + 'px');
    scene.style.setProperty('--scene-left', ((width - 1672 * scale) / 2) + 'px');
    scene.style.setProperty('--scene-top', ((height - 941 * scale) / 2) + 'px');
  }

  renderStates() {
    const panelOpen = !document.querySelector('#inspector').hidden;
    document.querySelectorAll('[data-toggle]').forEach(button => {
      const name = button.dataset.toggle;
      const enabled = this.audio.settings.enabled[name];
      const selected = panelOpen && name === this.selectedVoice;
      button.setAttribute('aria-pressed', String(enabled));
      const voice = button.closest('.voice');
      voice.classList.toggle('active', enabled);
      voice.classList.toggle('selected', selected);
      const state = enabled ? (this.audio.running ? 'Вкл.' : 'Выбран') : 'Выкл.';
      document.querySelector('[data-state="' + name + '"]').textContent = state + (selected && (!enabled || this.audio.running) ? ' · Выбран' : '');
      const settings = voice.querySelector('[data-settings]');
      settings.setAttribute('aria-expanded', String(selected));
      settings.querySelector('span').textContent = selected ? '−' : '＋';
    });
    document.querySelector('#settings').setAttribute('aria-expanded', String(panelOpen));
    this.renderVoice();
  }

  renderNotes() {
    const container = document.querySelector('#notes');
    container.replaceChildren();
    this.audio.getNotes().forEach((note, index) => {
      const button = document.createElement('button');
      button.dataset.note = note;
      button.title = note + ' · клавиша ' + this.keyNames[index];
      button.setAttribute('aria-label', 'Нота ' + note + ', клавиша ' + this.keyNames[index]);
      button.append(document.createTextNode(note.replace(/[0-9]/g, '')));
      const key = document.createElement('small');
      key.textContent = this.keyNames[index];
      button.append(key);
      container.append(button);
    });
    this.renderMode();
  }

  renderMode() {
    const mode = this.audio.settings.mode;
    const hints = {
      manual: 'Играйте сами · клавиши ' + this.keyNames.slice(0, this.audio.getNotes().length).join(' '),
      auto: 'Играет выбранная фраза. Для ручных нот выберите «Вручную».',
      layer: 'Автоматическая мелодия тише на 8 дБ. Добавляйте свои ноты.',
      arp: 'Арпеджиатор: ' + this.choiceLabel('arp-direction', this.audio.settings.arp.direction) + ' · ' + ({ '2n': '1/2', '4n': '1/4', '8n': '1/8' }[this.audio.settings.arp.rate]) + '. Настройки — в панели.'
    };
    document.querySelector('#mode-hint').textContent = this.keyboardInstrument === 'voice' ? (this.audio.settings.vocal.mode === 'notes' ? 'Клавиатура: VOICE. Выбор инструмента — в панели VOICE.' : (this.audio.settings.vocal.mode === 'auto' ? 'VOICE играет автоматически. Для клавиш выберите MELODY в панели VOICE.' : 'VOICE играет запись. Для клавиш выберите MELODY в панели VOICE.')) : hints[mode];
    document.querySelectorAll('[data-note]').forEach(button => { button.disabled = this.keyboardInstrument === 'voice' || ['auto', 'arp'].includes(mode); });
  }

  renderPhrase() {
    document.querySelectorAll('[data-phrase]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.phrase) === this.audio.settings.phrase)));
    const pending = this.audio.running && this.audio.settings.mode !== 'manual' && this.audio.activePhrase !== this.audio.settings.phrase;
    document.querySelector('#phrase-name').textContent = this.phraseNames[this.audio.settings.phrase] + (pending ? '…' : '');
    document.querySelector('#phrase-name').title = this.phraseNames[this.audio.settings.phrase] + (pending ? ' · ожидает смены' : '');
    if (pending) this.status('Фраза сменится на следующей границе двух тактов.');
  }

  renderHarmony(announce = false) {
    const pending = this.audio.running && this.audio.settings.harmony !== this.audio.activeHarmony;
    document.querySelector('#harmony-pending').hidden = !pending;
    if (announce) this.status(pending ? 'Гармония сменится на следующем такте.' : 'Гармония: ' + this.choiceLabel('harmony', this.audio.settings.harmony) + '.');
    this.renderVoice();
  }

  selectMelodyTab(tab) {
    this.melodyTab = tab;
    document.querySelectorAll('[data-tab]').forEach(button => {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-tab-panel]').forEach(panel => { panel.hidden = panel.dataset.tabPanel !== tab; });
  }

  toggleSettings(voice, trigger) {
    const panel = document.querySelector('#inspector');
    if (!panel.hidden && voice === this.selectedVoice) { this.closeSettings(); return; }
    this.selectedVoice = voice;
    this.settingsTrigger = trigger;
    panel.hidden = false;
    panel.classList.toggle('melody-inspector', voice === 'melody');
    panel.classList.toggle('vocal-inspector', voice === 'voice');
    document.querySelectorAll('[data-panel]').forEach(section => { section.hidden = section.dataset.panel !== voice; });
    document.querySelector('#inspector-title').textContent = voice.toUpperCase();
    this.renderStates();
    const firstControl = Array.from(panel.querySelectorAll('[data-panel="' + voice + '"] input, [data-panel="' + voice + '"] select')).find(control => control.offsetParent !== null);
    if (firstControl) firstControl.focus({ preventScroll: true });
    // On compact screens the inspector precedes the voice list, without covering it.
    if (getComputedStyle(panel).position === 'relative') document.querySelector('.voice-layer').scrollTop = 0;
  }

  closeSettings() {
    const panel = document.querySelector('#inspector');
    if (panel.hidden) return;
    panel.hidden = true;
    this.renderStates();
    if (this.settingsTrigger) this.settingsTrigger.focus({ preventScroll: true });
  }

  note(button) {
    if (this.busy) return;
    if (['auto', 'arp'].includes(this.audio.settings.mode)) { this.status(this.choiceLabel('mode', this.audio.settings.mode) + ': ручные ноты отключены. Выберите «Вручную» или «Совместно».'); return; }
    if (!this.audio.playNote(button.dataset.note)) this.status('Для ручных нот нажмите «Воспроизвести» и включите MELODY.');
  }

  holdVocal(note, input) {
    if (this.busy || this.vocalInputs.has(input)) return;
    if ([...this.vocalInputs.values()].includes(note) || this.audio.vocal.beginNote(note, undefined, this.vocalSetIndex)) this.vocalInputs.set(input, note);
    else this.status(this.audio.vocal.players.size >= 3 ? 'VOICE: дождитесь затухания одной из трёх нот.' : 'Для VOICE включите голос и воспроизведение.');
    this.renderVocalPager();
  }
  releaseVocal(input) {
    const note = this.vocalInputs.get(input);
    if (!note) return;
    this.vocalInputs.delete(input);
    if (![...this.vocalInputs.values()].includes(note)) this.audio.vocal.releaseNote(note);
    this.renderVoice();
  }
  releaseVocalInputs() {
    for (const note of new Set(this.vocalInputs.values())) this.audio.vocal.releaseNote(note);
    this.vocalInputs.clear();
    this.renderVoice();
  }
  vocalNotes() {
    const key = [this.audio.activeHarmony, this.audio.settings.scale, this.audio.settings.vocal.sample].join(':');
    // Only explicit musical choices invalidate a bank. Transport time never does.
    // Defer even those UI updates while a pointer/key owns an original note.
    if (key !== this.vocalBankKey && !this.vocalInputs.size) {
      this.vocalBankHarmony = this.audio.activeHarmony;
      this.vocalSets = this.audio.harmonies[this.vocalBankHarmony].chords.map((_, index) => this.audio.vocal.notes(undefined, index));
      this.vocalBankKey = key;
    }
    return this.vocalSets?.[this.vocalSetIndex] || [];
  }
  switchVocalSet(direction) {
    if (this.busy || this.vocalInputs.size || this.audio.settings.vocal.mode !== 'notes') return false;
    this.vocalNotes();
    const count = this.vocalSets.length;
    this.vocalSetIndex = (this.vocalSetIndex + direction + count) % count;
    this.renderVoice();
    return true;
  }
  renderVocalPager() {
    this.vocalNotes();
    const count = this.vocalSets?.length || 1;
    const disabled = this.busy || this.vocalInputs.size > 0 || count < 2;
    document.querySelector('#voice-chords-prev').disabled = disabled;
    document.querySelector('#voice-chords-next').disabled = disabled;
    document.querySelector('#voice-chords-page').textContent = 'Аккорды ' + (this.vocalSetIndex + 1) + ' / ' + count;
    document.querySelector('#voice-chord-name').textContent = this.audio.harmonies[this.vocalBankHarmony].labels[this.vocalSetIndex];
  }
  renderVoice() {
    const vocal = this.audio.vocal;
    const settings = vocal.settings;
    const enabled = this.audio.settings.enabled.voice;
    const playing = this.audio.running;
    const panel = document.querySelector('#inspector');
    const open = !panel.hidden && this.selectedVoice === 'voice';
    const launcher = document.querySelector('#voice-launch');
    launcher.setAttribute('aria-expanded', String(open));
    launcher.classList.toggle('active', enabled && playing);
    let state = !enabled ? 'Выкл.' : !playing ? 'Выбран' : 'Вкл.';
    if (vocal.error) state = 'Ошибка';
    else if (enabled && vocal.loading) state = 'Загрузка…';
    else if (enabled && (vocal.atmospherePlaying || vocal.players.size)) state = 'Звучит';
    else if (enabled && settings.mode === 'atmosphere' && vocal.finished) state = 'Завершено';
    document.querySelector('#voice-state').textContent = state;
    const toggle = document.querySelector('#voice-enabled');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.textContent = enabled ? 'Выключить VOICE' : 'Включить VOICE';
    toggle.disabled = this.busy;
    document.querySelectorAll('[data-vocal-notes-only]').forEach(element => { element.hidden = settings.mode === 'atmosphere'; });
    document.querySelectorAll('[data-vocal-auto-only]').forEach(element => { element.hidden = settings.mode !== 'auto'; });
    document.querySelector('.vocal-keyboard-choice').hidden = settings.mode === 'auto';
    document.querySelectorAll('[data-vocal-manual-only]').forEach(element => { element.hidden = settings.mode !== 'notes'; });
    document.querySelectorAll('[data-vocal-atmosphere-only]').forEach(element => { element.hidden = settings.mode !== 'atmosphere'; });
    document.querySelector('#keyboard-target option[value=voice]').disabled = settings.mode !== 'notes';
    const reverb = document.querySelector('#voice-reverb');
    reverb.value = vocal.reverbAmount();
    document.querySelector('#voice-reverb-value').textContent = reverb.value + '%';
    const restart = document.querySelector('#voice-restart');
    restart.disabled = this.busy || !playing || !enabled || !vocal.ready || !!vocal.error || vocal.loading || vocal.atmospherePlaying;
    restart.textContent = vocal.finished ? 'Снова воспроизвести 8580' : 'Запустить запись 8580';
    const notes = this.vocalNotes();
    const signature = this.vocalBankKey + ':' + this.vocalSetIndex + ':' + notes.join(',');
    if (signature !== this.vocalSignature && !this.vocalInputs.size) {
      this.vocalSignature = signature;
      const container = document.querySelector('#voice-notes');
      container.replaceChildren();
      const slots = Math.max(...this.vocalSets.map(set => set.length));
      Array.from({ length: slots }, (_, index) => notes[index]).forEach((note, index) => {
        const button = document.createElement('button');
        if (note) button.dataset.vocalNote = note;
        else button.disabled = true;
        button.setAttribute('aria-label', note ? 'VOICE: нота ' + note + ', клавиша ' + this.keyNames[index] : 'В этом аккорде нет ноты для клавиши ' + this.keyNames[index]);
        button.title = note ? note + ' · удерживайте клавишу ' + this.keyNames[index] : 'Нет ноты в этом наборе';
        button.append(document.createTextNode(note || '—'));
        const key = document.createElement('small');
        key.textContent = this.keyNames[index];
        button.append(key);
        container.append(button);
      });
    }
    this.renderVocalPager();
    document.querySelectorAll('[data-vocal-note]').forEach(button => {
      button.disabled = this.busy || !playing || !enabled || !vocal.ready || settings.mode !== 'notes';
      button.setAttribute('aria-pressed', String(vocal.players.has(button.dataset.vocalNote)));
    });
    const hint = vocal.error || (vocal.loading ? 'Загрузка четырёх вокальных записей…' : !playing ? 'Включите VOICE и нажмите «Воспроизвести».' : !enabled ? 'VOICE выключен.' : settings.mode === 'atmosphere' ? '8580 · 23,2 с · собственная гармония; высота и скорость сохранены.' : settings.mode === 'auto' ? 'Автоматически · ' + (vocal.autoLabel || this.audio.harmonies[this.audio.activeHarmony].labels[0]) + (vocal.samples[settings.sample].sustain ? '' : ' · удержание ограничено длиной сэмпла') : 'До трёх нот одновременно. Клавиатура: ' + this.keyboardInstrument.toUpperCase() + '. Удерживайте клавиши или вокальные кнопки.');
    document.querySelector('#voice-hint').textContent = hint;
  }

  animate(element, frames, options, cleanup) {
    const previous = this.animations.get(element);
    if (previous) previous.cancel();
    const animation = element.animate(frames, options);
    this.animations.set(element, animation);
    animation.onfinish = () => {
      if (this.animations.get(element) === animation) this.animations.delete(element);
      if (cleanup) cleanup();
    };
    return animation;
  }

  buildMelodyWaves() {
    // Six reusable groups, all in the artwork's own coordinate system.
    const layer = document.querySelector('#melody-waves');
    for (let index = 0; index < 6; index++) {
      const wave = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wave.setAttribute('class', 'melody-wave');
      for (const [radius, className] of [[217, 'wave-halo'], [145, 'wave-line inner'], [188, 'wave-line'], [217, 'wave-line']]) {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('r', radius);
        circle.setAttribute('class', className);
        wave.append(circle);
      }
      layer.append(wave);
      this.melodyWaves.push(wave);
    }
  }

  melodyWave(event) {
    const wave = this.melodyWaves[this.nextMelodyWave++ % this.melodyWaves.length];
    wave.setAttribute('data-wave-note', event.note);
    wave.setAttribute('data-wave-source', event.source);
    const midi = this.audio.noteToMidi(event.note);
    const pitch = Math.max(0, Math.min(1, (midi - 57) / 30));
    const strength = Math.max(0, Math.min(1, event.strength));
    const opacity = Math.min(0.5, 0.22 + strength * 0.25 + pitch * 0.06);
    const reduced = this.reducedMotion.matches;
    const frames = reduced ? [{ opacity: 0 }, { opacity: opacity * 0.7, offset: 0.25 }, { opacity: 0 }] : [
      { opacity: 0, transform: 'scale(' + (0.99 + pitch * 0.01) + ')' },
      { opacity, offset: 0.2, transform: 'scale(1.015)' },
      { opacity: 0, transform: 'scale(' + (1.05 + pitch * 0.025) + ')' }
    ];
    // No fill-forwards: a finished wave returns to the transparent base style.
    this.animate(wave, frames, { duration: reduced ? 350 : 1700, easing: 'cubic-bezier(.22,.61,.36,1)' });
  }

  soundEvent(event) {
    if (event.type === 'voice-state' || event.type === 'voice-notes') { this.renderVoice(); return; }
    if (event.type === 'harmony') { this.renderHarmony(true); return; }
    if (event.type === 'phrase') { this.renderPhrase(); return; }
    if (event.type !== 'sound') return;
    const reduced = this.reducedMotion.matches;
    const glow = document.querySelector('[data-glow="' + event.voice + '"]');
    const strength = Math.min(0.7, 0.15 + event.strength * 0.65);
    if (event.voice !== 'melody') this.animate(glow, [{ opacity: 0 }, { opacity: strength, offset: 0.18 }, { opacity: 0 }], { duration: reduced ? 250 : event.voice === 'atmosphere' ? event.duration : 900, easing: 'ease-out' });
    if (event.voice === 'melody') {
      this.melodyWave(event);
      const button = Array.from(document.querySelectorAll('[data-note]')).find(item => item.dataset.note[0] === event.note[0]);
      if (button) {
        button.classList.add('struck');
        this.animate(button, [{ opacity: 1 }, { opacity: 1 }], { duration: reduced ? 180 : 450 }, () => button.classList.remove('struck'));
      }
    }
    if (event.voice === 'texture') this.particles(event, reduced);
  }

  particles(event, reduced) {
    const group = document.querySelector('#texture-particles');
    const count = reduced ? 1 : Math.min(5, 1 + Math.ceil(event.density / 30));
    for (let index = 0; index < count; index++) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', 1500 + (Math.random() - 0.5) * 140);
      circle.setAttribute('cy', 350 + (Math.random() - 0.5) * 180);
      circle.setAttribute('r', 2 + Math.random() * 2);
      group.append(circle);
      const frames = reduced ? [{ opacity: 0.65 }, { opacity: 0 }] : [{ opacity: 0, transform: 'translateY(0px)' }, { opacity: 0.7, offset: 0.2 }, { opacity: 0, transform: 'translateY(-24px)' }];
      this.animate(circle, frames, { duration: reduced ? 250 : 1600 + Math.random() * 500, easing: 'ease-out' }, () => circle.remove());
    }
  }

  clearVoiceAnimation(voice) {
    const elements = [document.querySelector('[data-glow="' + voice + '"]')];
    if (voice === 'melody') elements.push(...this.melodyWaves, ...document.querySelectorAll('[data-note]'));
    if (voice === 'texture') elements.push(...document.querySelectorAll('#texture-particles circle'));
    for (const element of elements) {
      const animation = this.animations.get(element);
      if (animation) animation.cancel();
      this.animations.delete(element);
      element.classList.remove('struck');
      if (element.parentElement && element.parentElement.id === 'texture-particles') element.remove();
    }
  }

  clearAnimations() {
    for (const animation of this.animations.values()) animation.cancel();
    this.animations.clear();
    document.querySelectorAll('.struck').forEach(element => element.classList.remove('struck'));
    document.querySelector('#texture-particles').replaceChildren();
  }

  async togglePlayback(fadeSeconds = 0.12) {
    if (this.busy) return;
    this.busy = true;
    this.renderVoice();
    const play = document.querySelector('#play');
    play.disabled = true;
    document.querySelector('#fade').disabled = true;
    try {
      if (this.audio.running) {
        this.status(fadeSeconds > 1 ? 'Пространство постепенно затихает…' : 'Остановка…');
        await this.audio.stop(fadeSeconds);
        this.vocalInputs.clear();
        this.clearAnimations();
        this.status('Тишина. Параметры сохранены для следующего исполнения.');
      } else {
        this.status('Пробуждаем звук…');
        await this.audio.start();
        if (document.hidden) await this.audio.stop();
        this.status('Добавляйте голоса. MELODY: ' + this.choiceLabel('mode', this.audio.settings.mode) + '.');
      }
    } catch (error) {
      console.error(error);
      this.status('Не удалось запустить звук. Проверьте соединение и перезагрузите страницу.');
    } finally {
      this.busy = false;
      play.disabled = false;
      document.querySelector('#fade').disabled = !this.audio.running;
      document.querySelector('#play-label').textContent = this.audio.running ? 'Остановить' : 'Воспроизвести';
      document.querySelector('#play-icon').setAttribute('d', this.audio.running ? 'M6 6h12v12H6z' : 'M8 5l11 7-11 7z');
      this.renderStates();
      this.renderPhrase();
      this.renderHarmony();
    }
  }
};
