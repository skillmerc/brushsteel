// Menu, Duel or Path: a small choice
// at the top centre. Menu opens the main menu (?menu=1), Duel the duel against
// master 1 (?master=1), Path the run map (?mode=path). Each is a plain link, so
// the page starts fresh; leaving a Path fight under way this way still costs a
// life when the run is next opened.

const CSS = `
.bs-mode{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:30;display:flex;gap:4px;font:14px/1 Georgia,'Times New Roman',serif;letter-spacing:.18em;text-transform:uppercase}
.bs-mode a{color:#1b1611;text-decoration:none;padding:7px 12px;opacity:.55;border-bottom:1.5px solid transparent}
.bs-mode a:hover{opacity:.9}
.bs-mode a.on{opacity:1;border-bottom-color:#a61e18}
`;

export function createModeSwitch(current: 'duel' | 'path'): HTMLElement {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const nav = document.createElement('nav');
  nav.className = 'bs-mode';
  nav.setAttribute('aria-label', 'Mode');
  for (const [id, label, href] of [['menu', 'Menu', '?menu=1'], ['duel', 'Duel', '?master=1'], ['path', 'Path', '?mode=path']] as const) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (id === current) {
      a.className = 'on';
      a.setAttribute('aria-current', 'page');
    }
    nav.appendChild(a);
  }
  document.body.appendChild(nav);
  return nav;
}
