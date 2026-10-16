import type { ConfigField, ConfigValue } from '../../sdk/types';

export interface ConfigFieldsView {
  /** Shows stored values without disturbing a field the user is editing. */
  sync(values: Record<string, ConfigValue> | undefined): void;
}

let sequence = 0;

/**
 * Plugin options as settings rows: switches for booleans, slider plus exact number
 * for ranges, menus for choices. Every value control carries `data-plugin-config`.
 */
export function renderConfigFields(host: HTMLElement, owner: { id: string; name: string; fields?: ConfigField[] },
  onChange: (patch: Record<string, ConfigValue>) => void, signal: AbortSignal): ConfigFieldsView {
  host.replaceChildren();
  const sliders = new Map<string, HTMLInputElement>(), outputs = new Map<string, HTMLOutputElement>();
  for (const field of owner.fields ?? []) {
    const id = `option-${++sequence}`;
    const row = document.createElement('div'); row.className = `option-row is-${field.type}`;
    const text = document.createElement('label'); text.className = 'option-text'; text.htmlFor = id;
    const title = document.createElement('span'); title.className = 'option-label'; title.textContent = field.label; text.append(title);
    if (field.description) { const note = document.createElement('small'); note.textContent = field.description; text.append(note); }
    row.append(text);
    const control = document.createElement('div'); control.className = 'option-control';
    let input: HTMLInputElement | HTMLSelectElement;
    if (field.type === 'select') {
      input = document.createElement('select');
      for (const option of field.options ?? []) input.add(new Option(option.label, option.value));
      control.append(input);
    } else if (field.type === 'boolean') {
      input = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'switch' });
      const track = document.createElement('span'); track.className = 'switch-track'; track.setAttribute('aria-hidden', 'true');
      control.classList.add('switch-host'); control.append(input, track);
    } else {
      const slider = Object.assign(document.createElement('input'), { type: 'range', min: String(field.min), max: String(field.max), step: String(field.step ?? 1), tabIndex: -1 });
      slider.dataset.pluginSlider = field.key; slider.setAttribute('aria-hidden', 'true');
      input = Object.assign(document.createElement('input'), { type: 'number', min: String(field.min), max: String(field.max), step: String(field.step ?? 1), required: true });
      const output = document.createElement('output'); output.hidden = true;
      sliders.set(field.key, slider); outputs.set(field.key, output);
      slider.addEventListener('input', () => { input.value = slider.value; paint(slider); onChange({ [field.key]: Number(slider.value) }); }, { signal });
      control.append(slider, input, output);
    }
    input.id = id; input.dataset.pluginConfig = field.key;
    input.setAttribute('aria-label', `${owner.name} ${field.label}`);
    input.addEventListener('change', () => {
      if (input instanceof HTMLInputElement && !input.checkValidity()) { input.reportValidity(); return; }
      const value: ConfigValue = input instanceof HTMLSelectElement ? input.value : input.type === 'checkbox' ? input.checked : Number(input.value);
      onChange({ [field.key]: value });
    }, { signal });
    row.append(control); host.append(row);
  }
  const paint = (slider: HTMLInputElement) => {
    const min = Number(slider.min), max = Number(slider.max);
    slider.style.setProperty('--progress', `${max > min ? (Number(slider.value) - min) / (max - min) * 100 : 0}%`);
  };
  return {
    sync(values) {
      host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-plugin-config]').forEach(input => {
        const value = values?.[input.dataset.pluginConfig!];
        if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
        else if (document.activeElement !== input) input.value = String(value ?? '');
        const slider = sliders.get(input.dataset.pluginConfig!);
        if (slider && document.activeElement !== slider) { slider.value = String(value ?? slider.min); paint(slider); }
      });
    },
  };
}
