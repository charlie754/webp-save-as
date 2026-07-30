'use strict';
/**
 * Options page controller. Every control writes immediately - there is no Save button.
 */
(function () {
  const Settings = ExtSettings;

  const CHECKBOXES = Settings.BOOLEAN_KEYS;
  const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  const el = function (id) { return document.getElementById(id); };

  const quality = el('jpegQuality');
  const qualityValue = el('jpegQualityValue');
  const colour = el('jpegBackground');
  const colourHex = el('jpegBackgroundHex');
  const status = el('status');

  let statusTimer = null;

  function flash(text) {
    status.textContent = text;
    status.dataset.visible = 'true';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { status.dataset.visible = 'false'; }, 1600);
  }

  /** <input type="color"> only accepts #rrggbb, so expand the #rgb shorthand. */
  function toLongHex(value) {
    const s = String(value || '').trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) {
      return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    }
    return s;
  }

  function render(settings) {
    for (let i = 0; i < CHECKBOXES.length; i++) {
      const key = CHECKBOXES[i];
      const node = el(key);
      if (node) node.checked = !!settings[key];
    }
    const percent = Math.round(settings.jpegQuality * 100);
    quality.value = String(percent);
    qualityValue.textContent = percent + '%';
    colour.value = toLongHex(settings.jpegBackground);
    colourHex.value = settings.jpegBackground;
    colourHex.removeAttribute('aria-invalid');
  }

  async function save(patch, message) {
    const saved = await Settings.set(patch);
    flash(message || 'Saved');
    return saved;
  }

  function bind() {
    for (let i = 0; i < CHECKBOXES.length; i++) {
      const key = CHECKBOXES[i];
      const node = el(key);
      if (!node) continue;
      node.addEventListener('change', function () {
        const patch = {};
        patch[key] = node.checked;
        save(patch).then(function (settings) {
          // showJpg/showPng cannot both be off; re-render if the store corrected us.
          if (settings[key] !== node.checked) render(settings);
        });
      });
    }

    quality.addEventListener('input', function () {
      qualityValue.textContent = quality.value + '%';
    });
    quality.addEventListener('change', function () {
      save({ jpegQuality: Number(quality.value) / 100 });
    });

    colour.addEventListener('input', function () {
      colourHex.value = colour.value;
      colourHex.removeAttribute('aria-invalid');
    });
    colour.addEventListener('change', function () {
      save({ jpegBackground: colour.value });
    });

    colourHex.addEventListener('input', function () {
      const value = colourHex.value.trim();
      if (!HEX_COLOR.test(value)) {
        colourHex.setAttribute('aria-invalid', 'true');
        return;
      }
      colourHex.removeAttribute('aria-invalid');
      colour.value = toLongHex(value);
      save({ jpegBackground: value.toLowerCase() });
    });

    const swatches = document.querySelectorAll('.swatch');
    for (let i = 0; i < swatches.length; i++) {
      swatches[i].addEventListener('click', function (event) {
        const value = event.currentTarget.dataset.colour;
        colour.value = value;
        colourHex.value = value;
        colourHex.removeAttribute('aria-invalid');
        save({ jpegBackground: value });
      });
    }

    el('reset').addEventListener('click', async function () {
      render(await Settings.reset());
      flash('Defaults restored');
    });
  }

  Settings.get().then(function (settings) {
    render(settings);
    bind();
  });
})();
