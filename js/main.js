/* One engine and one set of controls for the life of this page. */
window.bloom = { audio: new BloomAudio() };
window.bloom.controls = new BloomControls(window.bloom.audio);
window.bloom.controls.bind();
if (!window.Tone) window.bloom.controls.status('Аудиобиблиотека не загрузилась. Проверьте интернет и перезагрузите страницу.');
