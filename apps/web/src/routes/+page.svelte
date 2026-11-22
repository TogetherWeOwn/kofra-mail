<script lang="ts">
  import '@fontsource-variable/ibm-plex-sans';
  import 'suite-shell/styles.css';
  import '$lib/mail.css';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { TopBar } from 'suite-shell';
  import { Archive, File, Inbox, Mail, OctagonAlert, Paperclip, Pencil, Plus, RefreshCw, Shield, Search, Send, Star, Tag, Trash2 } from '@lucide/svelte';
  import { onDestroy, onMount, tick } from 'svelte';
  import type { Attachment, Conversation, Draft, Identity, Label, Mailbox, Message, PendingSend, Settings, Thread, ThreadFilter, ThreadUpdate } from '@kofra/mail-core';
  import Compose from '$lib/Compose.svelte';
  import MailSettings from '$lib/MailSettings.svelte';
  import MailAdmin from '$lib/MailAdmin.svelte';
  import { createFakeMailApi } from '@kofra/mail-core/fake';
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
  let identities = $state<Identity[]>([]);
  let drafts = $state<Draft[]>([]);
  let settings = $state<Settings>();
  let admin = $state(false);
  let draft = $state.raw<Draft>();
  let openingCompose = false;
  let queued = $state<PendingSend[]>([]);
  const sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const undoing = new Set<string>();
  let labelDialog: HTMLDialogElement;
  let headingHost: HTMLElement;
  let lastOpen: HTMLButtonElement | undefined;
  let request = 0;
  const heading = $derived(view === 'label' ? labels.find((label) => label.id === labelId)?.name ?? 'Label' : view === 'search' ? 'Search results' : links.find((item) => item.key === view)?.text ?? 'Inbox');
  const shortDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  const initials = (name: string) => name.split(' ').slice(0, 2).map((word) => word[0]).join('');
  const account = { name: 'Alex Morgan', email: 'alex@example.com' };
  const apps = [{ id: 'mail', label: 'Mail', href: '#mail', icon: 'mail' }] as const;

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
      const [nextRows, nextLabels, nextMailboxes, nextDrafts] = await Promise.all([api.listThreads(currentFilter()), api.listLabels(), api.listMailboxes(), api.listDrafts()]);
      if (ticket === request) {
        const visible = new Set(nextRows.map((row) => row.id));
        selected = selected.filter((id) => visible.has(id));
        rows = nextRows; labels = nextLabels; mailboxes = nextMailboxes; drafts = nextDrafts;
      }
    } catch (cause) { if (ticket === request) showError(cause); }
    finally { if (ticket === request) busy = false; }
  }
  onMount(() => { void refresh(); if (location.hash) syncHash(); });
  onDestroy(() => { for (const timer of sendTimers.values()) clearTimeout(timer); });

  async function openSettings() {
    try {
      const [value, available] = await Promise.all([api.getSettings(), api.listIdentities()]);
      if (location.hash !== '#mail-settings') return;
      settings = value; identities = available;
      navOpen = false;
      admin = false;
      await focusHeading();
    } catch (cause) { showError(cause); }
  }
  function syncHash() {
    if (location.hash === '#mail-settings') { if (!settings) void openSettings(); }
    else if (location.hash === '#mail-admin') {
      settings = undefined; admin = true; navOpen = false; error = ''; void focusHeading();
    } else if (location.hash === '#mail' || !location.hash) void navigate('inbox');
  }
  function returnToMail() {
    settings = undefined; admin = false;
    replaceState('#mail', page.state);
    void focusHeading();
  }
  async function compose(event?: { mode: 'reply' | 'forward'; message: Message; threadId: string }, saved?: Draft) {
    if (openingCompose || draft) return;
    error = ''; navOpen = false;
    if (saved && identities.length) {
      draft = { ...saved, attachments: saved.attachments.map((item) => ({ ...item })) };
      return;
    }
    openingCompose = true;
    try {
      const [preferences, available] = await Promise.all([api.getSettings(), api.listIdentities()]);
      identities = available;
      if (saved) { draft = { ...saved, attachments: saved.attachments.map((item) => ({ ...item })) }; return; }
      const message = event?.message;
      const reply = event?.mode === 'reply';
      const prefix = reply ? 'Re:' : 'Fwd:';
      const subject = message ? (message.subject.toLowerCase().startsWith(prefix.toLowerCase()) ? message.subject : `${prefix} ${message.subject}`) : '';
      const signature = preferences.signature ? `\n\n${preferences.signature}` : '';
      const quote = message ? `\n\n${reply ? `On ${shortDate.format(new Date(message.date))}, ${message.from.name} wrote:` : `Forwarded message from ${message.from.name} <${message.from.email}>`}\n${message.text.split('\n').map((line) => `> ${line}`).join('\n')}` : '';
      const to = message && reply ? [identities.some((address) => address.email === message.from.email) ? message.to[0]?.email : message.from.email].filter((address): address is string => !!address) : [];
      const messageIdentity = message && [...message.to, ...(message.cc ?? []), message.from]
        .find((address) => available.some((identity) => identity.email.toLowerCase() === address.email.toLowerCase()));
      const from = available.find((identity) => identity.email.toLowerCase() === messageIdentity?.email.toLowerCase())?.email ?? preferences.defaultFrom;
      draft = { from, to, cc: [], bcc: [], subject, body: signature + quote, replyToThreadId: reply ? event.threadId : undefined, attachments: message && !reply ? message.attachments.map((file) => ({ ...file })) : [] };
    } catch (cause) { showError(cause); }
    finally { openingCompose = false; }
  }
  function sent(send: PendingSend) {
    queued = [...queued, send];
    sendTimers.set(send.id, setTimeout(() => {
      sendTimers.delete(send.id);
      if (!queued.some((item) => item.id === send.id)) return;
      queued = queued.filter((item) => item.id !== send.id);
      status = 'Message sent in the demo.';
      void refreshOpenThread();
      void refresh();
    }, Math.max(0, send.undoUntil - Date.now())));
  }
  async function refreshOpenThread() {
    const id = thread?.id;
    if (!id) return;
    try { const latest = await api.getThread(id); if (thread?.id === id) thread = latest; }
    catch (cause) { showError(cause); }
  }
  async function undo(send: PendingSend) {
    if (undoing.has(send.id)) return;
    undoing.add(send.id);
    try {
      const restored = await api.undoSend(send.id);
      const timer = sendTimers.get(send.id);
      if (timer !== undefined) clearTimeout(timer);
      sendTimers.delete(send.id);
      queued = queued.filter((item) => item.id !== send.id);
      if (restored) {
        if (draft || openingCompose) status = 'Send undone; saved to Drafts.';
        else { status = 'Send undone.'; await compose(undefined, restored); }
      } else { status = 'The undo window has ended.'; await refreshOpenThread(); }
      await refresh();
    } catch (cause) { showError(cause); }
    finally { undoing.delete(send.id); }
  }

  async function focusHeading() { await tick(); headingHost.querySelector<HTMLElement>('[data-view-heading]')?.focus(); }
  function toggleNav() {
    if (matchMedia('(max-width: 720px)').matches) navOpen = !navOpen;
    else navCollapsed = !navCollapsed;
  }
  async function navigate(next: View, id?: string) {
    if (location.hash === '#mail-settings' || location.hash === '#mail-admin') replaceState('#mail', page.state);
    navOpen = false; settings = undefined; admin = false; view = next; labelId = id; thread = undefined; lastOpen = undefined; error = ''; selected = [];
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
      if (change.mailboxId) {
        selected = [];
        status = `Moved to ${mailboxes.find((box) => box.id === change.mailboxId)?.name ?? 'mailbox'}.`;
        await refresh();
        await closeThread();
      } else {
        if (thread && ids.includes(thread.id)) thread = await api.getThread(thread.id);
        await refresh();
      }
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

<svelte:window onhashchange={syncHash} onkeydown={(event) => { if (event.key === 'Escape') navOpen = false; }} />
<svelte:head><title>Riaklo Mail</title><meta name="description" content="Riaklo Mail demo inbox" /></svelte:head>
<a class="skip" href="#mail-content" onclick={(event) => { event.preventDefault(); headingHost.focus(); }}>Skip to mail</a>
<TopBar productName="Riaklo Mail" productHref="#mail" productIcon="mail" currentAppId="mail" {apps} {account} accountHref="#mail-settings" onMenuClick={toggleNav} menuControls="mail-nav" settingsLabel="Mail settings" settingsHref={busy ? undefined : '#mail-settings'}>
  {#snippet search()}
    <form class="search" role="search" onsubmit={submitSearch}>
      <Search size={20} /><input id="mail-search" type="search" aria-label="Search mail" placeholder="Search mail" disabled={busy} bind:value={searchText} />
    </form>
  {/snippet}
</TopBar>
<div class="frame" class:nav-collapsed={navCollapsed}>
  {#if navOpen}<button class="backdrop" aria-label="Close mail navigation" onclick={() => navOpen = false}></button>{/if}
  <button class="compose-trigger pill primary" disabled={busy} onclick={() => compose()}><Pencil size={19} /> Compose</button>
  <nav id="mail-nav" class:mobile-open={navOpen} aria-label="Mail navigation">
    <ul>
      {#each links as item (item.key)}
        {@const count = mailboxes.find((box) => box.id === item.key)?.unread}
        <li><button aria-current={view === item.key ? 'page' : undefined} aria-describedby={count ? `unread-${item.key}` : undefined} onclick={() => navigate(item.key)}><item.icon size={20} /><span>{item.text}</span>{#if count}<b aria-hidden="true">{count}</b>{/if}</button>{#if count}<span hidden id={`unread-${item.key}`}>{count} unread</span>{/if}</li>
      {/each}
    </ul>
    <div class="nav-labels"><h2>Labels</h2><button class="icon" aria-label="Create label" onclick={() => { newLabel = ''; error = ''; labelDialog.showModal(); }}><Plus size={18} /></button></div>
    <ul>
      {#each labels as label, index (label.id)}
        <li><button aria-current={view === 'label' && labelId === label.id ? 'page' : undefined} onclick={() => navigate('label', label.id)}><i class={`dot color-${index % 4}`}></i><span>{label.name}</span></button></li>
      {/each}
    </ul>
    <ul class="admin-entry"><li><button aria-current={admin ? 'page' : undefined} onclick={() => location.hash = 'mail-admin'}><Shield size={20} /> <span>Mail admin</span></button></li></ul>
  </nav>
  <main id="mail-content" class="card" bind:this={headingHost} tabindex="-1" aria-busy={busy}>
    {#if error}<p role="alert" class="notice warning">{error}</p>{/if}
    {#if admin}
      <MailAdmin {api} onBack={returnToMail} />
    {:else if settings}
      <MailSettings value={settings} {identities} onBack={returnToMail} onSave={api.updateSettings} />
    {:else if thread}
      {#key thread.id}
        <ThreadView {thread} {labels} onBack={closeThread} onUpdate={(change) => { if (thread) void update([thread.id], change); }} onDownload={download} onSaveToDrive={saveToDrive} onCompose={(mode, message) => { if (thread) void compose({ mode, message, threadId: thread.id }); }} />
      {/key}
    {:else if view === 'drafts'}
      <h1 class="list-heading" tabindex="-1" data-view-heading>Drafts</h1>
      {#if drafts.length}<ul class="draft-list" aria-label="Drafts">{#each drafts as item (item.id)}<li><button onclick={() => compose(undefined, item)}>Open draft {item.subject || '(No subject)'}</button></li>{/each}</ul>
      {:else}<p class="empty">No drafts.</p>{/if}
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
        <span hidden id="unread-conversation">Unread conversation.</span>
        <span hidden id="has-attachments">Has attachments.</span>
        <ul class="mail-list" aria-label={heading}>
          {#each rows as row, index (row.id)}
            <li class="mail-row" class:unread={row.unread} class:chosen={selected.includes(row.id)}>
              <input type="checkbox" class="row-check" aria-label={`Select ${row.subject}`} checked={selected.includes(row.id)} onchange={() => toggleSelect(row.id)} />
              <button class="icon star" aria-label={`${row.starred ? 'Unstar' : 'Star'} ${row.subject}`} aria-pressed={row.starred} onclick={() => update([row.id], { starred: !row.starred })}><Star size={17} fill={row.starred ? 'currentColor' : 'none'} /></button>
              <button class="open-mail" id={`open-${row.id}`} aria-describedby={[row.unread ? 'unread-conversation' : '', row.hasAttachments ? 'has-attachments' : ''].filter(Boolean).join(' ') || undefined} onclick={(event) => open(row.id, event.currentTarget)}>
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
{#snippet undoNotices()}
  {#if queued.length}
    <div class="send-notices" aria-label="Queued messages">
      {#each queued as send (send.id)}<div class="send-notice"><span role="status">Message queued</span><button type="button" class="pill" onclick={() => undo(send)}>Undo send</button></div>{/each}
    </div>
  {/if}
{/snippet}
{#if draft}
  <Compose initial={draft} {identities} {api} {undoNotices} undoStatus={status === 'Send undone; saved to Drafts.' ? status : ''} onClose={() => { draft = undefined; void refresh(); }} onSent={sent} onStatus={(message) => status = message} />
{:else}
  {@render undoNotices()}
{/if}
<dialog bind:this={labelDialog} class="modal" aria-labelledby="label-heading">
  <form onsubmit={createLabel}>
    <h2 id="label-heading">New label</h2><label class="field">Label name<input required maxlength="72" bind:value={newLabel} /></label>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="dialog-actions"><button class="pill" type="button" onclick={() => labelDialog.close()}>Cancel</button><button class="pill primary">Create</button></div>
  </form>
</dialog>
