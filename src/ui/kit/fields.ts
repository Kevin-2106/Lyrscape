/** Static field templates and a value setter that never fights the user's focus. */
export function colorField(key: string, label: string): string {
  return `<label class="field color-field"><span>${label}</span><span class="color-input"><input type="color" data-setting="${key}" aria-label="${label}取色器"><input type="text" data-setting="${key}" spellcheck="false" aria-label="${label} CSS 值" placeholder="#ffffff"></span></label>`;
}

export function rangeField(key: string, label: string, min: number, max: number, step: number): string {
  return `<label class="field range-field"><span>${label}<output data-output="${key}"></output></span><input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}"></label>`;
}

export function toggleField(label: string, attribute: string, hint = ''): string {
  return `<label class="toggle-field"><span class="toggle-text">${label}${hint ? `<small>${hint}</small>` : ''}</span><input class="switch" type="checkbox" ${attribute}><span class="switch-track" aria-hidden="true"></span></label>`;
}

let probe: HTMLElement | undefined;
function cssColorToHex(color: string): string {
  if (/^#[\da-f]{6}$/i.test(color)) return color;
  if (/^#[\da-f]{3}$/i.test(color)) return `#${color.slice(1).split('').map(char => char + char).join('')}`;
  if (!probe) {
    probe = document.createElement('span');
    probe.hidden = true; probe.setAttribute('aria-hidden', 'true');
    document.body.append(probe);
  }
  probe.style.color = color;
  const rgb = getComputedStyle(probe).color.match(/^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/);
  return rgb ? `#${rgb.slice(1, 4).map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}` : '#ffffff';
}

export function setValue(element: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  if (element instanceof HTMLInputElement && element.type === 'checkbox') element.checked = Boolean(value);
  else if (document.activeElement === element) return;
  else if (element instanceof HTMLInputElement && element.type === 'color') element.value = cssColorToHex(String(value));
  else element.value = String(value);
}

export function setSelected(buttons: Iterable<HTMLButtonElement>, isSelected: (button: HTMLButtonElement) => boolean): void {
  for (const button of buttons) {
    const selected = isSelected(button);
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}
