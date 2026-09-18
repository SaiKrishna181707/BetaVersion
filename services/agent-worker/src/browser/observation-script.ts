/**
 * The in-page observation routine, kept as source text rather than as a function.
 *
 * It cannot be a normal function: the local runner is compiled by tsx/esbuild, which
 * injects `__name(...)` calls into every nested function. Playwright serializes the
 * function with `toString()` and evaluates it inside the page, where `__name` does not
 * exist, so the observation would throw before it could report anything.
 *
 * Source text is also what a future AgentCore transport has to ship, so this stays the
 * single definition of what "observe the page" means.
 *
 * Rules for editing: plain JavaScript only. No backticks, no template interpolation,
 * no TypeScript syntax, and no imports. The result must match `PageObservation`.
 */
export const OBSERVE_SOURCE = String.raw`(selector) => {
  const clean = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const visible = (element) => {
    if (element.closest('[hidden]') !== null) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  const roleOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox' || type === 'radio') return 'checkbox';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    const role = element.getAttribute('role');
    if (role === 'menuitem') return 'menuitem';
    if (role === 'tab') return 'link';
    if (role === 'button') return 'button';
    return 'other';
  };
  const isField = (element) => element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA';
  const nameOf = (element) => {
    const aria = element.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (isField(element)) {
      const labels = Array.from(element.labels || []).map((label) => label.textContent || '').join(' ');
      if (clean(labels).length > 0) return clean(labels);
    }
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return clean(placeholder);
    return clean(element.textContent);
  };
  const contextOf = (element) => {
    const container = element.closest('section, header, form, nav, main');
    if (container === null) return null;
    const heading = container.querySelector('h1, h2, h3');
    const text = heading ? heading.textContent : container.getAttribute('aria-label');
    const cleaned = clean(text);
    return cleaned.length > 0 ? cleaned : null;
  };
  // Refs are observation-scoped. Clearing the previous stamps first guarantees that one
  // ref matches exactly one element, even when the product re-renders around the observer.
  Array.from(document.querySelectorAll('[data-synthetic-ref]'))
    .forEach((stamped) => stamped.removeAttribute('data-synthetic-ref'));
  const elements = [];
  let index = 0;
  for (const element of Array.from(document.querySelectorAll(selector))) {
    if (!visible(element)) continue;
    index += 1;
    const ref = 'e' + index;
    element.setAttribute('data-synthetic-ref', ref);
    const value = typeof element.value === 'string' ? element.value : '';
    elements.push({
      ref: ref,
      role: roleOf(element),
      name: nameOf(element),
      target_descriptor: element.getAttribute('data-synthetic-target'),
      disabled: element.disabled === true || element.getAttribute('aria-disabled') === 'true',
      value_present: value.length > 0,
      context: contextOf(element),
    });
  }
  const checkpoints = Array.from(document.querySelectorAll('[data-synthetic-checkpoint]'))
    .map((element) => element.getAttribute('data-synthetic-checkpoint') || '')
    .filter((value) => value.length > 0)
    .filter((value, position, all) => all.indexOf(value) === position);
  const body = document.body ? (document.body.innerText || '') : '';
  return {
    url: window.location.href,
    route: window.location.hash.replace(/^#/, '') || '/',
    page_title: document.title,
    headings: Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((heading) => clean(heading.textContent))
      .filter((value) => value.length > 0)
      .slice(0, 12),
    text_excerpt: clean(body.slice(0, 600)),
    checkpoints: checkpoints,
    elements: elements,
  };
}`;
