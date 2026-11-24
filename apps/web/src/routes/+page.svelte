<script lang="ts">
  import '@fontsource-variable/ibm-plex-sans';
  import 'suite-shell/styles.css';
  import '$lib/mail.css';
  import { pushState, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { TopBar } from 'suite-shell';
  import { Archive, File, Inbox, Mail, OctagonAlert, Paperclip, Pencil, Plus, RefreshCw, Shield, Search, Send, Star, Tag, Trash2 } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import { createHttpMailService, isMailApiError, type Conversation, type Draft, type Identity, type Label, type Message, type MessageAttachment, type Session, type Settings, type ThreadChange, type ThreadQuery, type ThreadSummary, type View, type ViewList } from '@kofra/mail-contract';
  import Compose, { type ComposeDraft } from '$lib/Compose.svelte';
  import MailSettings from '$lib/MailSettings.svelte';
  import MailAdmin from '$lib/MailAdmin.svelte';
  import ThreadView from '$lib/ThreadView.svelte';
  import { contentFrameUrl } from '$lib/content-origin';
  import { mailAction } from '$lib/mail-action';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  const api = createHttpMailService();
  const links = [
    { key: 'inbox', text: 'Inbox', icon: Inbox }, { key: 'starred', text: 'Starred', icon: Star },
    { key: 'sent', text: 'Sent', icon: Send }, { key: 'drafts', text: 'Drafts', icon: File },
    { key: 'all', text: 'All mail', icon: Mail }, { key: 'spam', text: 'Spam', icon: OctagonAlert }, { key: 'trash', text: 'Trash', icon: Trash2 }
  ] as const;
  type UiView = typeof links[number]['key'] | 'search' | 'label';
  let view = $state<UiView>('inbox');
  let labelId = $state<string>();
  let navOpen = $state(false);
  let navCollapsed = $state(false);
  let session = $state<Session>();
  let labels = $state<Label[]>([]);
  let views = $state<ViewList>();
  let rows = $state<ThreadSummary[]>([]);
  let thread = $state<Conversation>();
  let cursor = $state<string | null>(null);
  let initializing = $state(true);
  let busy = $state(false);
  let moreBusy = $state(false);
  let mutating = $state(false);
  let searchText = $state('');
  let query = $state('');
  let status = $state('');
  let error = $state('');
  let selected = $state<string[]>([]);
  let newLabel = $state('');
  let labelError = $state('');
  let labelSaving = $state(false);
  const labelAction = mailAction();
  const driveActions = new Map<string, ReturnType<typeof mailAction>>();
  const savingToDrive = new Set<string>();
  let identities = $state<Identity[]>([]);
  let drafts = $state<Draft[]>([]);
  let settings = $state<Settings>();
  let admin = $state(false);
  let draft = $state.raw<ComposeDraft>();
  let openingCompose = false;
  let labelDialog: HTMLDialogElement;
  let headingHost: HTMLElement;
  let lastOpen: HTMLButtonElement | undefined;
  let request = 0;
  let threadRequest = 0;
  let threadRefresh = 0;
  let loadedPages = 1;
  let listState: string | undefined;
  let checkingForChanges = false;
  const canUseMail = $derived(!!session?.mailbox && !initializing);
  const canAdmin = $derived(session?.workspace.role === 'admin');
  const heading = $derived(view === 'label' ? labels.find((label) => label.id === labelId)?.name ?? 'Label' : view === 'search' ? 'Search results' : links.find((item) => item.key === view)?.text ?? 'Inbox');
  const shortDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  const initials = (name: string) => name.split(' ').slice(0, 2).map((word) => word[0]).join('');
  const account = $derived(session ? { name: session.user.name, email: session.mailbox?.primaryAddress ?? '' } : undefined);
  const apps = [{ id: 'mail', label: 'Mail', href: '#mail', icon: 'mail' }] as const;

  function currentFilter(): ThreadQuery {
    if (view === 'label') return { view: 'all', labelId };
    if (view === 'search') return { view: 'all', q: query, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
    return { view: view === 'drafts' ? 'inbox' : view };
  }
  function showError(cause: unknown) { error = cause instanceof Error ? cause.message : 'This action did not complete.'; }
  async function refresh(preservePages = false) {
    if (!session?.mailbox) return;
    const ticket = ++request;
    busy = true;
    moreBusy = false;
    const isDrafts = view === 'drafts';
    const pageCount = preservePages ? loadedPages : 1;
    const filter = currentFilter();
    async function threadPages() {
      if (isDrafts) return;
      let next = await api.listThreads(filter);
      const firstState = next.state;
      let pages = 1;
      while (ticket === request && pages < pageCount && next.nextCursor) {
        const page = await api.listThreads({ ...filter, cursor: next.nextCursor });
        next = { ...page, items: appendUnique(next.items, page.items) };
        pages++;
      }
      return { next, pages, firstState };
    }
    try {
      const [threadResult, nextDrafts, nextLabels, nextViews] = await Promise.all([
        threadPages(), isDrafts ? api.listDrafts({}) : undefined,
        api.listLabels(), api.listViews(),
      ]);
      if (ticket !== request) return;
      const nextRows = threadResult?.next;
      loadedPages = threadResult?.pages ?? 1;
      listState = threadResult?.firstState ?? nextDrafts?.state;
      rows = nextRows?.items ?? [];
      drafts = nextDrafts?.items ?? [];
      const visible = new Set(rows.map((row) => row.id));
      selected = selected.filter((id) => visible.has(id));
      labels = nextLabels.items;
      views = nextViews;
      cursor = (nextRows ?? nextDrafts)?.nextCursor ?? null;
    } catch (cause) { if (ticket === request) showError(cause); }
    finally { if (ticket === request) busy = false; }
  }
  function appendUnique<T extends { id: string }>(current: T[], more: T[]): T[] {
    return [...new Map([...current, ...more].map((item) => [item.id, item])).values()];
  }
  async function loadMore() {
    if (!cursor || busy || moreBusy) return;
    const ticket = request;
    moreBusy = true; error = '';
    try {
      if (view === 'drafts') {
        const next = await api.listDrafts({ cursor });
        if (ticket === request) { drafts = appendUnique(drafts, next.items); cursor = next.nextCursor; }
      } else {
        const next = await api.listThreads({ ...currentFilter(), cursor });
        if (ticket === request) { rows = appendUnique(rows, next.items); cursor = next.nextCursor; loadedPages++; }
      }
    } catch (cause) { if (ticket === request) showError(cause); }
    finally { if (ticket === request) moreBusy = false; }
  }
  async function initialize() {
    initializing = true; error = '';
    try {
      session = await api.getSession();
      await refresh();
      syncHash();
    } catch (cause) { showError(cause); }
    finally { initializing = false; }
  }
  async function checkForChanges() {
    if (!canUseMail || busy || moreBusy || mutating || checkingForChanges) return;
    checkingForChanges = true;
    const ticket = request;
    try {
      const latest = await api.listViews();
      if (ticket !== request) return;
      if (listState === latest.state) views = latest;
      await Promise.all([
        listState !== latest.state ? refresh(true) : undefined,
        thread && thread.state !== latest.state ? refreshOpenThread() : undefined,
      ]);
    } catch (cause) { showError(cause); }
    finally { checkingForChanges = false; }
  }
  onMount(() => {
    void initialize();
    const followMailLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
      if (!(event.target instanceof Element) || !event.target.closest('a[href="#mail"]')) return;
      event.preventDefault();
      if ((settings || admin) && location.hash !== '#mail') pushState('#mail', page.state);
      void navigate('inbox');
    };
    document.addEventListener('click', followMailLink, true);
    return () => { request++; threadRequest++; document.removeEventListener('click', followMailLink, true); };
  });

  async function openSettings() {
    try {
      const [value, available] = await Promise.all([api.getSettings(), api.listIdentities()]);
      if (location.hash !== '#mail-settings') return;
      settings = value; identities = available.items;
      navOpen = false;
      admin = false;
      await focusHeading();
    } catch (cause) { showError(cause); }
  }
  function syncHash() {
    if (location.hash === '#mail-settings' && session?.mailbox) { if (!settings) void openSettings(); }
    else if (location.hash === '#mail-admin' && canAdmin) {
      settings = undefined; admin = true; navOpen = false; error = ''; void focusHeading();
    } else if (settings || admin) {
      settings = undefined; admin = false; void focusHeading();
    }
  }
  function returnToMail() {
    settings = undefined; admin = false;
    replaceState('#mail', page.state);
    void focusHeading();
  }
  async function compose(event?: { mode: 'reply' | 'forward'; message: Message }, draftId?: string) {
    if (openingCompose || draft || !canUseMail) return;
    error = ''; navOpen = false;
    openingCompose = true;
    try {
      const available = await api.listIdentities();
      identities = available.items;
      if (draftId) { draft = await api.getDraft(draftId); return; }
      const preferences = await api.getSettings();
      const active = identities.filter((identity) => identity.sendAs === 'active');
      const isOwn = (email: string) => active.some((identity) => identity.email.toLowerCase() === email.toLowerCase());
      const message = event?.message;
      const reply = event?.mode === 'reply';
      const prefix = reply ? 'Re:' : 'Fwd:';
      const subject = message ? (message.subject.toLowerCase().startsWith(prefix.toLowerCase()) ? message.subject : `${prefix} ${message.subject}`) : '';
      const signature = preferences.signature ? `\n\n${preferences.signature}` : '';
      const quote = message ? `\n\n${reply ? `On ${shortDate.format(new Date(message.date))}, ${message.from.name} wrote:` : `Forwarded message from ${message.from.name} <${message.from.email}>`}\n${message.text.split('\n').map((line) => `> ${line}`).join('\n')}` : '';
      const to = message && reply ? (message.sent ? message.to.slice(0, 1) : message.replyTo?.length ? message.replyTo : [message.from]) : [];
      const preferred = message?.sent && reply ? message.from : message && reply && preferences.replyFromReceivedAddress ? [...message.to, ...message.cc].find((address) => isOwn(address.email)) : undefined;
      const from = active.find((identity) => identity.email.toLowerCase() === preferred?.email.toLowerCase())?.email ?? preferences.defaultFrom;
      draft = {
        from, to, cc: [], bcc: [], subject, body: signature + quote,
        inReplyTo: reply ? message?.id : undefined, forwardOf: reply ? undefined : message?.id,
        attachments: message && !reply ? message.attachments.map((file) => ({ kind: 'message', messageId: message.id, ...file })) : [],
      };
    } catch (cause) { showError(cause); }
    finally { openingCompose = false; }
  }
  async function refreshOpenThread() {
    const id = thread?.thread.id;
    if (!id) return;
    const ticket = threadRequest;
    const refreshTicket = ++threadRefresh;
    try {
      const latest = await api.getThread(id);
      if (ticket === threadRequest && refreshTicket === threadRefresh && thread?.thread.id === id) thread = latest;
    } catch (cause) {
      if (ticket !== threadRequest || refreshTicket !== threadRefresh) return;
      if (isMailApiError(cause, 'not_found')) await closeThread();
      else showError(cause);
    }
  }
  async function focusHeading() { await tick(); headingHost.querySelector<HTMLElement>('[data-view-heading]')?.focus(); }
  function toggleNav() {
    if (matchMedia('(max-width: 720px)').matches) navOpen = !navOpen;
    else navCollapsed = !navCollapsed;
  }
  async function navigate(next: UiView, id?: string) {
    if (location.hash === '#mail-settings' || location.hash === '#mail-admin') replaceState('#mail', page.state);
    threadRequest++;
    navOpen = false; settings = undefined; admin = false; view = next; labelId = id; thread = undefined; lastOpen = undefined; error = ''; selected = [];
    rows = []; drafts = []; cursor = null;
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
  async function open(id: string, button: HTMLButtonElement, unread: boolean) {
    const ticket = ++threadRequest;
    lastOpen = button; error = '';
    try {
      if (unread) await api.updateThreads({ ids: [id], set: { unread: false } });
      const latest = await api.getThread(id);
      if (ticket !== threadRequest) return;
      thread = latest;
      if (unread) {
        rows = rows.map((row) => row.id === id ? { ...row, unread: false } : row);
        if (view === 'search') void refresh(true);
        else void refreshViewCounts(request);
      }
      // Do not steal focus if the user began using the shell while mail loaded.
      if (document.activeElement === button || document.activeElement === document.body) await focusHeading();
    } catch (cause) { if (ticket === threadRequest) showError(cause); }
  }
  async function refreshViewCounts(ticket: number) {
    try {
      const next = await api.listViews();
      if (ticket === request) views = next;
    } catch (cause) { if (ticket === request) showError(cause); }
  }
  async function closeThread() {
    threadRequest++;
    const id = thread?.thread.id;
    thread = undefined;
    await tick();
    if (lastOpen?.isConnected) lastOpen.focus();
    else if (id && document.getElementById(`open-${id}`)) document.getElementById(`open-${id}`)?.focus();
    else await focusHeading();
  }
  async function update(ids: string[], change: ThreadChange) {
    if (mutating || !ids.length) return;
    const maximum = session?.limits.batchThreads;
    if (maximum !== undefined && ids.length > maximum) { error = `Select no more than ${maximum} conversations at once.`; return; }
    error = ''; mutating = true;
    const ticket = threadRequest;
    try {
      await api.updateThreads({ ids, set: change });
      if (change.folder) {
        selected = [];
        status = `Moved to ${links.find((item) => item.key === change.folder)?.text ?? 'Archive'}.`;
        await refresh();
        if (ticket === threadRequest && thread && ids.includes(thread.thread.id)) await closeThread();
      } else {
        await Promise.all([refresh(true), thread && ids.includes(thread.thread.id) ? refreshOpenThread() : undefined]);
      }
    } catch (cause) { showError(cause); }
    finally { mutating = false; }
  }
  async function createLabel(event: SubmitEvent) {
    event.preventDefault();
    if (labelSaving) return;
    labelSaving = true; labelError = '';
    const input = { name: newLabel.trim() };
    try {
      const label = await api.createLabel(input, labelAction.options(input));
      labelAction.clear(); labelDialog.close(); await navigate('label', label.id);
    } catch (cause) { labelError = cause instanceof Error ? cause.message : 'Could not create the label.'; }
    finally { labelSaving = false; }
  }
  async function download(messageId: string, file: MessageAttachment) {
    error = '';
    try {
      const link = await api.getAttachmentUrl(messageId, file.part);
      const url = contentFrameUrl(link.url, data.contentOrigin);
      if (!url || !(Date.parse(link.expiresAt) > Date.now())) throw new Error('The attachment download link is unavailable.');
      const a = document.createElement('a');
      a.href = url; a.download = file.name; a.rel = 'noreferrer noopener'; a.referrerPolicy = 'no-referrer'; a.click();
    } catch (cause) { showError(cause); }
  }
  async function saveToDrive(messageId: string, file: MessageAttachment) {
    const key = `${messageId}:${file.part}`;
    if (!session?.features.drive || savingToDrive.has(key)) return;
    error = ''; savingToDrive.add(key);
    const action = driveActions.get(key) ?? mailAction();
    driveActions.set(key, action);
    try {
      const saved = await api.saveAttachmentToDrive(messageId, file.part, action.options(key));
      driveActions.delete(key);
      status = `Saved ${saved.name} to Drive.`;
    } catch (cause) { showError(cause); }
    finally { savingToDrive.delete(key); }
  }
  function toggleSelect(id: string) { selected = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]; }
</script>

<svelte:window onhashchange={syncHash} onfocus={checkForChanges} onkeydown={(event) => { if (event.key === 'Escape') navOpen = false; }} />
<svelte:head><title>Riaklo Mail</title><meta name="description" content="Riaklo Mail inbox" /></svelte:head>
<a class="skip" href="#mail-content" onclick={(event) => { event.preventDefault(); headingHost.focus(); }}>Skip to mail</a>
<TopBar productName="Riaklo Mail" productHref="#mail" productIcon="mail" currentAppId="mail" {apps} {account} accountHref="#mail-settings" onMenuClick={toggleNav} menuControls="mail-nav" settingsLabel="Mail settings" settingsHref={canUseMail ? '#mail-settings' : undefined}>
  {#snippet search()}
    <form class="search" role="search" onsubmit={submitSearch}>
      <Search size={20} /><input id="mail-search" type="search" aria-label="Search mail" placeholder="Search mail" disabled={!canUseMail} bind:value={searchText} />
    </form>
  {/snippet}
</TopBar>
<div class="frame" class:nav-collapsed={navCollapsed}>
  {#if navOpen}<button class="backdrop" aria-label="Close mail navigation" onclick={() => navOpen = false}></button>{/if}
  <button class="compose-trigger pill primary" disabled={!canUseMail} onclick={() => compose()}><Pencil size={19} /> Compose</button>
  <nav id="mail-nav" class:mobile-open={navOpen} aria-label="Mail navigation">
    <ul>
      {#each links as item (item.key)}
        {@const count = item.key === 'drafts' ? views?.drafts : views?.items.find((entry) => entry.view === item.key)?.unreadThreads}
        <li><button disabled={!canUseMail} aria-current={view === item.key ? 'page' : undefined} aria-describedby={count ? `count-${item.key}` : undefined} onclick={() => navigate(item.key)}><item.icon size={20} /><span>{item.text}</span>{#if count}<b aria-hidden="true">{count}</b>{/if}</button>{#if count}<span hidden id={`count-${item.key}`}>{count} {item.key === 'drafts' ? 'drafts' : 'unread'}</span>{/if}</li>
      {/each}
    </ul>
    <div class="nav-labels"><h2>Labels</h2><button class="icon" aria-label="Create label" disabled={!canUseMail} onclick={() => { newLabel = ''; labelError = ''; labelAction.clear(); labelDialog.showModal(); }}><Plus size={18} /></button></div>
    <ul>
      {#each labels as label, index (label.id)}
        <li><button aria-current={view === 'label' && labelId === label.id ? 'page' : undefined} onclick={() => navigate('label', label.id)}><i class={`dot color-${index % 4}`}></i><span>{label.name}</span></button></li>
      {/each}
    </ul>
    {#if canAdmin}<ul class="admin-entry"><li><button aria-current={admin ? 'page' : undefined} onclick={() => location.hash = 'mail-admin'}><Shield size={20} /> <span>Mail admin</span></button></li></ul>{/if}
  </nav>
  <main id="mail-content" class="card" bind:this={headingHost} tabindex="-1" aria-busy={initializing || busy}>
    {#if error}<p role="alert" class="notice warning">{error}</p>{/if}
    {#if admin && canAdmin}
      <MailAdmin {api} onBack={returnToMail} />
    {:else if initializing}
      <p class="empty" role="status">Loading mail…</p>
    {:else if !session}
      <h1 class="list-heading" tabindex="-1" data-view-heading>Mail unavailable</h1>
      <button class="pill" onclick={initialize}>Try again</button>
    {:else if !session.mailbox}
      <h1 class="list-heading" tabindex="-1" data-view-heading>No mailbox assigned</h1>
      <p class="empty">Ask a workspace administrator to assign you a mailbox.</p>
    {:else if settings}
      <MailSettings value={settings} {identities} limits={session.limits} onBack={returnToMail} onSave={(patch) => api.updateSettings(patch)} />
    {:else if thread}
      {#key thread.thread.id}
        <ThreadView conversation={thread} view={currentFilter().view} {labels} {api} contentOrigin={session.features.htmlContent ? data.contentOrigin : undefined} drive={session.features.drive} onBack={closeThread} onUpdate={(change) => { if (thread) void update([thread.thread.id], change); }} onDownload={download} onSaveToDrive={saveToDrive} onCompose={(mode, message) => compose({ mode, message })} />
      {/key}
    {:else if view === 'drafts'}
      <h1 class="list-heading" tabindex="-1" data-view-heading>Drafts</h1>
      {#if busy}<p class="empty">Loading drafts…</p>
      {:else if drafts.length}<ul class="draft-list" aria-label="Drafts">{#each drafts as item (item.id)}<li><button onclick={() => compose(undefined, item.id)}>Open draft {item.subject || '(No subject)'}</button></li>{/each}</ul>
      {:else}<p class="empty">No drafts.</p>{/if}
    {:else}
      <div class="toolbar listbar">
        <input type="checkbox" aria-label="Select all conversations" checked={!!rows.length && rows.every((row) => selected.includes(row.id))} disabled={!rows.length || busy || mutating} onchange={(event) => selected = event.currentTarget.checked ? rows.map((row) => row.id) : []} />
        <button class="icon" aria-label="Refresh mail" disabled={busy} onclick={() => refresh()}><RefreshCw size={19} /></button>
        {#if selected.length}
          {#if view === 'trash' || view === 'spam'}<button class="icon" aria-label="Move selected to Inbox" disabled={mutating} onclick={() => update(selected, { folder: 'inbox' })}><Inbox size={19} /></button>
          {:else}<button class="icon" aria-label="Archive selected" disabled={mutating} onclick={() => update(selected, { folder: 'archive' })}><Archive size={19} /></button><button class="icon" aria-label="Delete selected" disabled={mutating} onclick={() => update(selected, { folder: 'trash' })}><Trash2 size={19} /></button>{/if}
        {/if}
        <span class="toolbar-spacer"></span><span class="muted tally">{rows.length} {rows.length === 1 ? 'conversation' : 'conversations'}</span>
      </div>
      <h1 class:sr-only={view === 'inbox'} class="list-heading" tabindex="-1" data-view-heading>{heading}</h1>
      {#if view === 'search'}
        <div class="filters" aria-label="Search filters">
          <button class="pill" onclick={() => addSearchFilter('from:')}>From</button><button class="pill" onclick={() => addSearchFilter('to:')}>To</button><button class="pill" onclick={() => addSearchFilter('subject:')}>Subject</button><button class="pill" onclick={() => addSearchFilter('has:attachment')}><Paperclip size={15} /> Has attachment</button><button class="pill" onclick={() => addSearchFilter('before:')}>Date</button>
        </div>
      {:else if view === 'spam' || view === 'trash'}<p class="expiry muted">Messages in {heading} are automatically removed after {session.limits.spamTrashRetentionDays} days.</p>{/if}
      {#if busy && !rows.length}<p class="empty">Loading conversations…</p>
      {:else if !rows.length}<p class="empty">{view === 'search' ? 'No conversations match your search.' : 'No conversations here.'}</p>
      {:else}
        <span hidden id="unread-conversation">Unread conversation.</span>
        <span hidden id="has-attachments">Has attachments.</span>
        <ul class="mail-list" aria-label={heading}>
          {#each rows as row, index (row.id)}
            <li class="mail-row" class:unread={row.unread} class:chosen={selected.includes(row.id)}>
              <input type="checkbox" class="row-check" aria-label={`Select ${row.subject}`} checked={selected.includes(row.id)} onchange={() => toggleSelect(row.id)} />
              <button class="icon star" aria-label={`${row.starred ? 'Unstar' : 'Star'} ${row.subject}`} aria-pressed={row.starred} disabled={mutating} onclick={() => update([row.id], { starred: !row.starred })}><Star size={17} fill={row.starred ? 'currentColor' : 'none'} /></button>
              <button class="open-mail" id={`open-${row.id}`} aria-describedby={[row.unread ? 'unread-conversation' : '', row.hasAttachments ? 'has-attachments' : ''].filter(Boolean).join(' ') || undefined} onclick={(event) => open(row.id, event.currentTarget, row.unread)}>
                <span class={`avatar row-avatar color-${index % 4}`} aria-hidden="true">{initials(row.from.name)}</span>
                <span class="sender">{row.from.name || row.from.email}{#if row.count > 1} <small>{row.count}</small>{/if}</span>
                <span class="snippet">{#each labels.filter((label) => row.labelIds.includes(label.id)) as label (label.id)}<span class="label-chip"><Tag size={11} />{label.name}</span>{/each}<span class="subject">{row.subject}</span><span class="preview"><span class="desktop"> – </span>{row.snippet}</span></span>
                {#if row.hasAttachments}<span class="paperclip"><Paperclip size={16} /></span>{/if}<time datetime={row.lastDate}>{shortDate.format(new Date(row.lastDate))}</time>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if !thread && !settings && !admin && cursor}<div class="toolbar"><button class="pill" disabled={busy || moreBusy} onclick={loadMore}>{moreBusy ? 'Loading…' : 'Load more'}</button></div>{/if}
  </main>
</div>
<div class="status" class:sr-only={!status} aria-live="polite">{status}{#if status}<button class="icon" aria-label="Dismiss notification" onclick={() => status = ''}>×</button>{/if}</div>
{#if draft}
  <Compose initial={draft} {identities} {api} m3={session?.features.m3 === true} onClose={() => { draft = undefined; void refresh(); }} onStatus={(message) => status = message} />
{/if}
<dialog bind:this={labelDialog} class="modal" aria-labelledby="label-heading" oncancel={(event) => { if (labelSaving) event.preventDefault(); }}>
  <form onsubmit={createLabel}>
    <h2 id="label-heading">New label</h2><label class="field">Label name<input required maxlength={session?.limits.labelNameChars} bind:value={newLabel} /></label>
    {#if labelError}<p role="alert">{labelError}</p>{/if}
    <div class="dialog-actions"><button class="pill" type="button" disabled={labelSaving} onclick={() => labelDialog.close()}>Cancel</button><button class="pill primary" disabled={labelSaving}>Create</button></div>
  </form>
</dialog>
