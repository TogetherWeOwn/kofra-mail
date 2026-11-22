<script lang="ts">
  import '@fontsource-variable/ibm-plex-sans';
  import '$lib/mail.css';
  import { Archive, File, Inbox, Mail, OctagonAlert, Paperclip, Plus, RefreshCw, Search, Send, Star, Tag, Trash2 } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import type { Attachment, Conversation, Label, Mailbox, Thread, ThreadFilter, ThreadUpdate } from '@kofra/mail-core';
  import { createFakeMailApi } from '@kofra/mail-core/fake';
  import SuiteShell from '$lib/SuiteShell.svelte';
  import ThreadView from '$lib/ThreadView.svelte';

  const api = createFakeMailApi();
  const links = [
    { key: 'inbox', text: 'Inbox', icon: Inbox }, { key: 'starred', text: 'Starred', icon: Star },
    { key: 'sent', text: 'Sent', icon: Send }, { key: 'drafts', text: 'Drafts', icon: File },
    { key: 'all', text: 'All mail', icon: Mail }, { key: 'spam', text: 'Spam', icon: OctagonAlert }, { key: 'trash', text: 'Trash', icon: Trash2 }
  ] as const;
  type View = typeof links[number]['key'] | 'search' | 'label';
  let view = $state<View>('inbox');
  let labelId = $state<string>();
  let navOpen = $state(false);
  let navCollapsed = $state(false);
  let labels = $state<Label[]>([]);
  let mailboxes = $state<Mailbox[]>([]);
  let rows = $state<Thread[]>([]);
  let thread = $state<Conversation>();
  let busy = $state(true);
  let searchText = $state('');
  let query = $state('');
  let status = $state('');
  let error = $state('');
  let selected = $state<string[]>([]);
  let newLabel = $state('');
  let labelDialog: HTMLDialogElement;
  let headingHost: HTMLElement;
  let lastOpen: HTMLButtonElement | undefined;
  let request = 0;
  const heading = $derived(view === 'label' ? labels.find((label) => label.id === labelId)?.name ?? 'Label' : view === 'search' ? 'Search results' : links.find((item) => item.key === view)?.text ?? 'Inbox');
  const shortDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const initials = (name: string) => name.split(' ').slice(0, 2).map((word) => word[0]).join('');
  const account = { name: 'Alex Morgan', email: 'alex@example.com', initials: 'AM' };

  function currentFilter(): ThreadFilter {
    if (view === 'label') return { labelId };
    if (view === 'search') return { query };
    if (view === 'starred') return { starred: true };
    if (view === 'all') return {};
    return { mailboxId: view };
  }
  function showError(cause: unknown) { error = cause instanceof Error ? cause.message : 'This action did not complete.'; }
  async function refresh() {
    const ticket = ++request;
    try {
      const [nextRows, nextLabels, nextMailboxes] = await Promise.all([api.listThreads(currentFilter()), api.listLabels(), api.listMailboxes()]);
      if (ticket === request) { rows = nextRows; labels = nextLabels; mailboxes = nextMailboxes; }
    } catch (cause) { if (ticket === request) showError(cause); }
    finally { if (ticket === request) busy = false; }
  }
  onMount(() => { void refresh(); });

  async function focusHeading() { await tick(); headingHost.querySelector<HTMLElement>('[data-view-heading]')?.focus(); }
  function toggleNav() {
    if (matchMedia('(max-width: 720px)').matches) navOpen = !navOpen;
    else navCollapsed = !navCollapsed;
  }
  async function navigate(next: View, id?: string) {
    navOpen = false; view = next; labelId = id; thread = undefined; lastOpen = undefined; error = ''; selected = [];
    await refresh(); await focusHeading();
  }
  function submitSearch(event: SubmitEvent) {
    event.preventDefault(); query = searchText.trim(); void navigate(query ? 'search' : 'inbox');
  }
  function addSearchFilter(filter: string) {
    searchText = [searchText.trim(), filter].filter(Boolean).join(' ');
    if (!filter.endsWith(':')) { query = searchText; void navigate('search'); }
    else document.getElementById('mail-search')?.focus();
  }
  async function open(id: string, button: HTMLButtonElement) {
    lastOpen = button; error = '';
    try {
      await api.updateThread(id, { unread: false });
      thread = await api.getThread(id);
      if (!thread) throw new Error('Conversation not found.');
      await refresh(); await focusHeading();
    } catch (cause) { showError(cause); }
  }
  async function closeThread() {
    const id = thread?.id;
    thread = undefined;
    await tick();
    if (lastOpen?.isConnected) lastOpen.focus();
    else if (id && document.getElementById(`open-${id}`)) document.getElementById(`open-${id}`)?.focus();
    else await focusHeading();
  }
  async function update(ids: string[], change: ThreadUpdate) {
    error = '';
    try {
      await Promise.all(ids.map((id) => api.updateThread(id, change)));
      if (change.mailboxId) { selected = []; await closeThread(); status = `Moved to ${mailboxes.find((box) => box.id === change.mailboxId)?.name ?? 'mailbox'}.`; }
      else if (thread && ids.includes(thread.id)) thread = await api.getThread(thread.id);
      await refresh();
    } catch (cause) { showError(cause); }
  }
  async function createLabel(event: SubmitEvent) {
    event.preventDefault(); error = '';
    try { const label = await api.createLabel(newLabel); labelDialog.close(); await navigate('label', label.id); }
    catch (cause) { showError(cause); }
  }
  async function download(file: Attachment) {
    try {
      const url = URL.createObjectURL(await api.downloadAttachment(file.id));
      const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { showError(cause); }
  }
  async function saveToDrive(file: Attachment) {
    try { await api.saveToDrive(file.id); status = `Saved ${file.name} to demo Drive.`; }
    catch (cause) { showError(cause); }
  }
  function toggleSelect(id: string) { selected = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]; }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') navOpen = false; }} />
<svelte:head><title>Riaklo Mail</title><meta name="description" content="Riaklo Mail demo inbox" /></svelte:head>
<a class="skip" href="#mail-content">Skip to mail</a>
<SuiteShell product="Mail" {account} onMenu={toggleNav} onSettings={() => {}}>
  {#snippet search()}
    <form class="search" role="search" onsubmit={submitSearch}>
      <Search size={20} /><input id="mail-search" type="search" aria-label="Search mail" placeholder="Search mail" disabled={busy} bind:value={searchText} />
    </form>
  {/snippet}
</SuiteShell>
<div class="frame" class:nav-collapsed={navCollapsed}>
  {#if navOpen}<button class="backdrop" aria-label="Close mail navigation" onclick={() => navOpen = false}></button>{/if}
  <nav class:mobile-open={navOpen} aria-label="Mail navigation">
    <ul>
      {#each links as item (item.key)}
        {@const count = mailboxes.find((box) => box.id === item.key)?.unread}
        <li><button aria-current={view === item.key ? 'page' : undefined} onclick={() => navigate(item.key)}><item.icon size={20} /><span>{item.text}</span>{#if count}<b aria-hidden="true">{count}</b>{/if}</button></li>
      {/each}
    </ul>
    <div class="nav-labels"><h2>Labels</h2><button class="icon" aria-label="Create label" onclick={() => { newLabel = ''; error = ''; labelDialog.showModal(); }}><Plus size={18} /></button></div>
    <ul>
      {#each labels as label, index (label.id)}
        <li><button aria-current={view === 'label' && labelId === label.id ? 'page' : undefined} onclick={() => navigate('label', label.id)}><i class={`dot color-${index % 4}`}></i><span>{label.name}</span></button></li>
      {/each}
    </ul>
  </nav>
  <main id="mail-content" class="card" bind:this={headingHost} tabindex="-1" aria-busy={busy}>
    {#if error}<p role="alert" class="notice warning">{error}</p>{/if}
    {#if thread}
      {#key thread.id}
        <ThreadView {thread} {labels} onBack={closeThread} onUpdate={(change) => { if (thread) void update([thread.id], change); }} onDownload={download} onSaveToDrive={saveToDrive} />
      {/key}
    {:else}
      <div class="toolbar listbar">
        <input type="checkbox" aria-label="Select all conversations" checked={!!rows.length && rows.every((row) => selected.includes(row.id))} disabled={!rows.length} onchange={(event) => selected = event.currentTarget.checked ? rows.map((row) => row.id) : []} />
        <button class="icon" aria-label="Refresh mail" onclick={refresh}><RefreshCw size={19} /></button>
        {#if selected.length}
          {#if view === 'trash' || view === 'spam'}<button class="icon" aria-label="Move selected to Inbox" onclick={() => update(selected, { mailboxId: 'inbox' })}><Inbox size={19} /></button>
          {:else}<button class="icon" aria-label="Archive selected" onclick={() => update(selected, { mailboxId: 'archive' })}><Archive size={19} /></button><button class="icon" aria-label="Delete selected" onclick={() => update(selected, { mailboxId: 'trash' })}><Trash2 size={19} /></button>{/if}
        {/if}
        <span class="toolbar-spacer"></span><span class="muted tally">{rows.length} {rows.length === 1 ? 'conversation' : 'conversations'}</span>
      </div>
      <h1 class:sr-only={view === 'inbox'} class="list-heading" tabindex="-1" data-view-heading>{heading}</h1>
      {#if view === 'search'}
        <div class="filters" aria-label="Search filters">
          <button class="pill" onclick={() => addSearchFilter('from:')}>From</button><button class="pill" onclick={() => addSearchFilter('to:')}>To</button><button class="pill" onclick={() => addSearchFilter('subject:')}>Subject</button><button class="pill" onclick={() => addSearchFilter('has:attachment')}><Paperclip size={15} /> Has attachment</button><button class="pill" onclick={() => addSearchFilter('before:')}>Date</button>
        </div>
      {:else if view === 'spam' || view === 'trash'}<p class="expiry muted">Conversations in {heading} are automatically removed after 30 days.</p>{/if}
      {#if busy}<p class="empty">Loading conversations…</p>
      {:else if !rows.length}<p class="empty">{view === 'search' ? 'No conversations match your search.' : 'No conversations here.'}</p>
      {:else}
        <ul class="mail-list" aria-label={heading}>
          {#each rows as row, index (row.id)}
            <li class="mail-row" class:unread={row.unread} class:chosen={selected.includes(row.id)}>
              <input type="checkbox" class="row-check" aria-label={`Select ${row.subject}`} checked={selected.includes(row.id)} onchange={() => toggleSelect(row.id)} />
              <button class="icon star" aria-label={`${row.starred ? 'Unstar' : 'Star'} ${row.subject}`} aria-pressed={row.starred} onclick={() => update([row.id], { starred: !row.starred })}><Star size={17} fill={row.starred ? 'currentColor' : 'none'} /></button>
              <button class="open-mail" id={`open-${row.id}`} onclick={(event) => open(row.id, event.currentTarget)}>
                <span class={`avatar row-avatar color-${index % 4}`} aria-hidden="true">{initials(row.from.name)}</span>
                <span class="sender">{row.from.name}{#if row.count > 1} <small>{row.count}</small>{/if}</span>
                <span class="snippet">{#each labels.filter((label) => row.labelIds.includes(label.id)) as label (label.id)}<span class="label-chip"><Tag size={11} />{label.name}</span>{/each}<span class="subject">{row.subject}</span><span class="preview"><span class="desktop"> – </span>{row.snippet}</span></span>
                {#if row.hasAttachments}<span class="paperclip"><Paperclip size={16} /></span>{/if}<time datetime={row.date}>{shortDate.format(new Date(row.date))}</time>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </main>
</div>
<div class="status" class:sr-only={!status} aria-live="polite">{status}{#if status}<button class="icon" aria-label="Dismiss notification" onclick={() => status = ''}>×</button>{/if}</div>
<dialog bind:this={labelDialog} class="modal" aria-labelledby="label-heading">
  <form onsubmit={createLabel}>
    <h2 id="label-heading">New label</h2><label class="field">Label name<input required maxlength="72" bind:value={newLabel} /></label>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="dialog-actions"><button class="pill" type="button" onclick={() => labelDialog.close()}>Cancel</button><button class="pill primary">Create</button></div>
  </form>
</dialog>
