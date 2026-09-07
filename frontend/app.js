const state = {
  incidents: [],
  priority: '',
  query: '',
  status: ''
};

const elements = {
  adminToken: document.querySelector('#adminToken'),
  form: document.querySelector('#incidentForm'),
  formStatus: document.querySelector('#formStatus'),
  list: document.querySelector('#incidentList'),
  priorityFilter: document.querySelector('#priorityFilter'),
  searchInput: document.querySelector('#searchInput'),
  statCritical: document.querySelector('#statCritical'),
  statOpen: document.querySelector('#statOpen'),
  statProgress: document.querySelector('#statProgress'),
  statTotal: document.querySelector('#statTotal'),
  statusFilter: document.querySelector('#statusFilter')
};

function titleCase(value) {
  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function authHeaders() {
  const token = elements.adminToken.value.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...options.headers
    },
    ...options
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message ?? 'Request failed');
  }
  return payload;
}

function incidentQuery() {
  const params = new URLSearchParams();
  if (state.status) {
    params.set('status', state.status);
  }
  if (state.priority) {
    params.set('priority', state.priority);
  }
  if (state.query) {
    params.set('q', state.query);
  }
  return params.toString();
}

function renderStats(stats) {
  elements.statTotal.textContent = stats.total ?? 0;
  elements.statOpen.textContent = stats.byStatus?.open ?? 0;
  elements.statProgress.textContent = stats.byStatus?.in_progress ?? 0;
  elements.statCritical.textContent = stats.openCritical ?? 0;
}

function renderIncidents() {
  if (state.incidents.length === 0) {
    elements.list.innerHTML = '<div class="empty-state">No incidents match the current view.</div>';
    return;
  }

  elements.list.innerHTML = state.incidents.map((incident) => {
    const updated = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(incident.updatedAt));

    return `
      <article class="incident-card">
        <div class="incident-card-header">
          <div>
            <h3>${escapeHtml(incident.title)}</h3>
            <p>${escapeHtml(incident.description || 'No description')}</p>
          </div>
          <div class="badges">
            <span class="badge priority-${incident.priority}">${titleCase(incident.priority)}</span>
            <span class="badge status-${incident.status}">${titleCase(incident.status)}</span>
          </div>
        </div>
        <div class="incident-meta">
          <span>Owner: ${escapeHtml(incident.owner)}</span>
          <span>Updated: ${updated}</span>
        </div>
        <div class="incident-actions">
          ${statusButton(incident, 'open')}
          ${statusButton(incident, 'in_progress')}
          ${statusButton(incident, 'resolved')}
          <button class="danger" data-delete-id="${incident.id}" type="button">Delete</button>
        </div>
      </article>
    `;
  }).join('');
}

function statusButton(incident, status) {
  if (incident.status === status) {
    return '';
  }
  return `<button class="secondary" data-id="${incident.id}" data-status="${status}" type="button">${titleCase(status)}</button>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refresh() {
  const query = incidentQuery();
  const [incidentsPayload, statsPayload] = await Promise.all([
    api(`/api/incidents${query ? `?${query}` : ''}`),
    api('/api/stats')
  ]);

  state.incidents = incidentsPayload.incidents;
  renderStats(statsPayload.stats);
  renderIncidents();
}

async function createIncident(event) {
  event.preventDefault();
  elements.formStatus.textContent = '';

  const formData = new FormData(elements.form);
  const body = {
    description: formData.get('description'),
    owner: formData.get('owner'),
    priority: formData.get('priority'),
    title: formData.get('title')
  };

  try {
    await api('/api/incidents', {
      body: JSON.stringify(body),
      method: 'POST'
    });
    elements.form.reset();
    elements.formStatus.textContent = 'Incident created.';
    await refresh();
  } catch (error) {
    elements.formStatus.textContent = error.message;
  }
}

async function updateStatus(event) {
  const button = event.target.closest('button[data-id]');
  if (!button) {
    return;
  }

  button.disabled = true;

  try {
    await api(`/api/incidents/${encodeURIComponent(button.dataset.id)}/status`, {
      body: JSON.stringify({ status: button.dataset.status }),
      method: 'PATCH'
    });
    await refresh();
  } catch (error) {
    elements.formStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function deleteIncident(event) {
  const button = event.target.closest('button[data-delete-id]');
  if (!button) {
    return;
  }

  if (!window.confirm('Delete this incident? This cannot be undone.')) {
    return;
  }

  button.disabled = true;

  try {
    await api(`/api/incidents/${encodeURIComponent(button.dataset.deleteId)}`, {
      method: 'DELETE'
    });
    await refresh();
  } catch (error) {
    elements.formStatus.textContent = error.message;
    button.disabled = false;
  }
}

function handleListClick(event) {
  if (event.target.closest('button[data-delete-id]')) {
    return deleteIncident(event);
  }
  return updateStatus(event);
}

function debounce(fn, waitMs) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), waitMs);
  };
}

elements.adminToken.value = localStorage.getItem('opsboard.adminToken') ?? '';
elements.adminToken.addEventListener('input', () => {
  localStorage.setItem('opsboard.adminToken', elements.adminToken.value.trim());
});

elements.form.addEventListener('submit', createIncident);
elements.list.addEventListener('click', handleListClick);
elements.statusFilter.addEventListener('change', async () => {
  state.status = elements.statusFilter.value;
  await refresh();
});
elements.priorityFilter.addEventListener('change', async () => {
  state.priority = elements.priorityFilter.value;
  await refresh();
});
elements.searchInput.addEventListener('input', debounce(async () => {
  state.query = elements.searchInput.value.trim();
  await refresh();
}, 250));

refresh().catch((error) => {
  elements.list.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
});
