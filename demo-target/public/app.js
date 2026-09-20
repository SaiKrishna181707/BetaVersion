/**
 * Fieldwork: the authorized demo target for Centopus.
 *
 * Every request stays in this browser. There is no fetch, no XHR, and no external asset.
 * Three friction sources are deliberate and documented in demo-target/README.md:
 *   1. The invite action lives behind the project overflow menu, not the Team tab.
 *   2. The member list resolves slowly and pushes the page down.
 *   3. The invite form clears its field when validation fails.
 */
const STORAGE_KEY = 'fieldwork:state:v1';
const SANDBOX_EMAIL = 'tester@sandbox.test';
const SANDBOX_PASSWORD = 'sandbox';
const MEMBERS_LOAD_MS = 1200;
const INVITE_VALIDATION_MS = 900;

const app = document.getElementById('app');

const emptyState = () => ({ signedIn: false, projects: [], invitations: 0 });

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      signedIn: parsed.signedIn === true,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      invitations: typeof parsed.invitations === 'number' ? parsed.invitations : 0,
    };
  } catch {
    return emptyState();
  }
}

let state = loadState();

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* Storage is optional for the demo target. */
  }
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function currentPath() {
  const raw = window.location.hash.replace(/^#/, '');
  const path = raw.split('?')[0] || '/';
  return path.startsWith('/') ? path : `/${path}`;
}

const findProject = (id) => state.projects.find((project) => project.id === id) || null;

function renderSignIn() {
  app.innerHTML = `
    <main class="shell narrow">
      <h1>Sign in to Fieldwork</h1>
      <p class="muted">Project planning for small teams.</p>
      <form id="signin-form" novalidate>
        <div class="field">
          <label for="email">Work email</label>
          <input id="email" name="email" type="email" autocomplete="off" data-synthetic-target="email" />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="off" data-synthetic-target="password" />
        </div>
        <p class="error" id="signin-error" role="alert" hidden></p>
        <button type="submit" data-synthetic-target="sign-in-submit">Sign in</button>
      </form>
      <p class="hint">
        Disposable sandbox account, not a secret:
        <span class="mono">${SANDBOX_EMAIL} / ${SANDBOX_PASSWORD}</span>
      </p>
    </main>`;

  const form = document.getElementById('signin-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = form.querySelector('#email').value.trim().toLowerCase();
    const password = form.querySelector('#password').value;
    if (email !== SANDBOX_EMAIL || password !== SANDBOX_PASSWORD) {
      const error = document.getElementById('signin-error');
      error.textContent = 'Those details were not recognised.';
      error.hidden = false;
      return;
    }
    state.signedIn = true;
    saveState();
    window.location.hash = '#/projects';
    render();
  });
}

function renderProjects() {
  app.innerHTML = `
    <main class="shell" data-synthetic-checkpoint="OPEN_APP">
      <header class="page-head">
        <div>
          <h1>Projects</h1>
          <p class="muted">Fieldwork workspace / sandbox data</p>
        </div>
        <div class="row">
          <button id="new-project" data-synthetic-target="new-project">New project</button>
          <button id="sign-out" class="secondary">Sign out</button>
        </div>
      </header>
      <form id="create-project" class="panel" hidden data-synthetic-target="create-project-form" novalidate>
        <div class="field">
          <label for="project-name">Project name</label>
          <input id="project-name" name="name" autocomplete="off" data-synthetic-target="project-name" />
        </div>
        <p class="error" id="project-error" role="alert" hidden></p>
        <div class="row">
          <button type="submit" data-synthetic-target="create-project-submit">Create project</button>
          <button type="button" class="secondary" id="cancel-project">Cancel</button>
        </div>
      </form>
      <ul class="list">
        ${state.projects.length === 0
          ? '<li class="empty">No projects yet.</li>'
          : state.projects.map((project) => `
            <li>
              <a href="#/projects/${encodeURIComponent(project.id)}/overview" data-synthetic-target="open-project">${escapeHtml(project.name)}</a>
              <span class="muted mono">${project.members.length} member${project.members.length === 1 ? '' : 's'}</span>
            </li>`).join('')}
      </ul>
    </main>`;

  const panel = document.getElementById('create-project');
  document.getElementById('new-project').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) document.getElementById('project-name').focus();
  });
  document.getElementById('cancel-project').addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('sign-out').addEventListener('click', () => {
    state.signedIn = false;
    saveState();
    window.location.hash = '#/signin';
    render();
  });
  panel.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('project-name');
    const error = document.getElementById('project-error');
    const name = input.value.trim();
    if (name.length < 3) {
      error.textContent = 'Project names need at least 3 characters.';
      error.hidden = false;
      input.focus();
      return;
    }
    const project = {
      id: `p${Date.now().toString(36)}`,
      name,
      members: [{ email: SANDBOX_EMAIL, role: 'Owner' }],
      invitations: [],
    };
    state.projects.push(project);
    saveState();
    window.location.hash = `#/projects/${encodeURIComponent(project.id)}/overview`;
    render();
  });
}

function renderInvitePanel(project, tab) {
  const panel = document.getElementById('invite-panel');
  panel.hidden = false;
  const form = document.getElementById('invite-form');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = form.querySelector('#invite-email');
    const error = form.querySelector('#invite-error');
    const email = input.value.trim();
    error.hidden = true;

    // Validation resolves asynchronously, then clears the field on failure.
    setTimeout(() => {
      if (!isEmail(email)) {
        error.textContent = 'That address does not look right. Please try again.';
        error.hidden = false;
        input.value = '';
        input.focus();
        return;
      }
      if (project.invitations.includes(email)) {
        error.textContent = 'That teammate already has an invitation.';
        error.hidden = false;
        input.value = '';
        return;
      }
      project.invitations.push(email);
      project.members.push({ email, role: 'Member' });
      state.invitations += 1;
      saveState();
      renderProject(project, tab, `Invitation sent to ${email}.`);
    }, INVITE_VALIDATION_MS);
  });
}

function renderTab(project, tab) {
  const content = document.getElementById('tab-content');

  if (tab === 'team') {
    content.innerHTML = `
      <p class="muted">Members are listed from the workspace directory.</p>
      <ul class="list" id="members" aria-busy="true">
        <li class="skeleton"></li>
        <li class="skeleton"></li>
      </ul>
      <p class="note">Only project owners can invite people.</p>`;
    setTimeout(() => {
      const members = document.getElementById('members');
      if (!members) return;
      members.setAttribute('aria-busy', 'false');
      members.innerHTML = project.members.map((member) => `
        <li>
          <span>${escapeHtml(member.email)}</span>
          <span class="muted mono">${escapeHtml(member.role)}</span>
        </li>`).join('');
    }, MEMBERS_LOAD_MS);
    return;
  }

  if (tab === 'settings') {
    content.innerHTML = `
      <div class="field">
        <label for="rename">Project name</label>
        <input id="rename" value="${escapeHtml(project.name)}" />
      </div>
      <p class="muted">Renaming is disabled in the demo target.</p>
      <hr />
      <h2>Delete project</h2>
      <p class="muted">Destructive actions are never available to synthetic users.</p>
      <button class="secondary" disabled>Delete project</button>`;
    return;
  }

  content.innerHTML = `
    <h2>Product launch</h2>
    <p class="muted">A shared space for the next big thing.</p>
    <div class="cards">
      <div class="card"><strong>Open tasks</strong><span class="mono">3</span></div>
      <div class="card"><strong>Members</strong><span class="mono">${project.members.length}</span></div>
      <div class="card"><strong>Invitations</strong><span class="mono">${project.invitations.length}</span></div>
    </div>`;
}

function renderProject(project, tab, message) {
  const tabs = [['overview', 'Overview'], ['team', 'Team'], ['settings', 'Settings']];
  const base = `#/projects/${encodeURIComponent(project.id)}`;

  app.innerHTML = `
    <main class="shell" data-synthetic-checkpoint="CREATE_PROJECT">
      <p class="breadcrumb"><a href="#/projects">Projects</a> / ${escapeHtml(project.name)}</p>
      <header class="page-head">
        <div>
          <h1>${escapeHtml(project.name)}</h1>
          <p class="muted">Product launch workspace</p>
        </div>
        <button id="project-actions" class="icon" aria-haspopup="menu" aria-expanded="false"
                aria-label="Project actions" data-synthetic-target="project-overflow">...</button>
      </header>
      <div id="project-menu" class="menu" role="menu" hidden>
        <button type="button" role="menuitem" id="open-invite" data-synthetic-target="invite-teammate">Invite teammate</button>
        <button type="button" role="menuitem" id="menu-settings">Project settings</button>
      </div>
      ${message ? `<p class="notice" role="status" data-synthetic-checkpoint="INVITE_TEAMMATE">${escapeHtml(message)}</p>` : ''}
      <div id="invite-panel" class="panel" hidden data-synthetic-target="invite-panel">
        <form id="invite-form" novalidate>
          <div class="field">
            <label for="invite-email">Teammate email</label>
            <input id="invite-email" type="email" autocomplete="off" data-synthetic-target="invite-email" />
          </div>
          <p class="error" id="invite-error" role="alert" hidden></p>
          <div class="row">
            <button type="submit" data-synthetic-target="invite-submit">Send invitation</button>
            <button type="button" class="secondary" id="cancel-invite">Cancel</button>
          </div>
        </form>
      </div>
      <nav class="tabs">
        ${tabs.map(([id, label]) => `
          <a href="${base}/${id}" data-synthetic-target="tab-${id}"
             class="${tab === id ? 'selected' : ''}"${tab === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
      </nav>
      <section id="tab-content" class="tab-content"></section>
    </main>`;

  const menu = document.getElementById('project-menu');
  const actions = document.getElementById('project-actions');
  actions.addEventListener('click', () => {
    const opening = menu.hidden;
    menu.hidden = !opening;
    actions.setAttribute('aria-expanded', String(opening));
  });
  document.getElementById('menu-settings').addEventListener('click', () => {
    window.location.hash = `${base}/settings`;
  });
  document.getElementById('open-invite').addEventListener('click', () => {
    menu.hidden = true;
    actions.setAttribute('aria-expanded', 'false');
    renderInvitePanel(project, tab);
  });
  document.getElementById('cancel-invite').addEventListener('click', () => {
    document.getElementById('invite-panel').hidden = true;
  });

  renderTab(project, tab);
}

function renderNotFound() {
  app.innerHTML = `
    <main class="shell narrow">
      <h1>Page not found</h1>
      <p class="muted">That route does not exist in the demo target.</p>
      <p><a href="#/projects">Back to projects</a></p>
    </main>`;
}

function render() {
  const path = currentPath();
  const desired = !state.signedIn
    ? '/signin'
    : (path === '/' || path === '/signin' ? '/projects' : path);
  if (desired !== path) {
    window.location.hash = `#${desired}`;
    return;
  }

  if (!state.signedIn) {
    renderSignIn();
    return;
  }

  if (path === '/projects') {
    renderProjects();
    return;
  }

  const match = path.match(/^\/projects\/([^/]+)(?:\/(overview|team|settings))?$/);
  if (match) {
    const project = findProject(decodeURIComponent(match[1]));
    if (!project) {
      renderNotFound();
      return;
    }
    renderProject(project, match[2] || 'overview', '');
    return;
  }

  renderNotFound();
}

window.addEventListener('hashchange', render);
render();
