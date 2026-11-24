<script lang="ts">
  import { ArrowLeft, CircleCheck, Clock3, Globe, Plus } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import type { AdminMailbox, Domain, DomainInput, MailService, Member } from '@kofra/mail-contract';
  import { mailAction } from './mail-action';

  let { api, onBack }: { api: MailService; onBack: () => void } = $props();
  type Panel = 'Domains' | 'Mailboxes and aliases';
  type Action = 'domain' | 'mailbox' | 'alias';
  const panels: Panel[] = ['Domains', 'Mailboxes and aliases'];
  let panel = $state<Panel>('Domains');
  let domains = $state<Domain[]>([]);
  let mailboxes = $state<AdminMailbox[]>([]);
  let members = $state<Member[]>([]);
  let mailboxCursor = $state<string | null>(null);
  let memberCursor = $state<string | null>(null);
  let action = $state<Action>();
  let name = $state('');
  let email = $state('');
  let owner = $state('');
  let mailbox = $state('');
  let kind = $state<DomainInput['kind']>('secondary');
  let aliasOf = $state('');
  let sendAs = $state(false);
  let error = $state('');
  let loadError = $state('');
  let loading = $state(true);
  let busy = $state(false);
  let dialog: HTMLDialogElement;
  let heading: HTMLHeadingElement;
  const create = mailAction();
  const failure = (cause: unknown) => cause instanceof Error ? cause.message : 'The directory could not be updated.';
  const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
  const availableMembers = $derived(members.filter((member) => !member.hasMailbox));
  const addressDomains = $derived(domains.filter((domain) => domain.kind !== 'alias'));
  async function loadMailboxes(append = false) {
    const next = await api.listMailboxes(append ? { cursor: mailboxCursor ?? undefined } : {});
    mailboxes = [...new Map([...(append ? mailboxes : []), ...next.items].map((item) => [item.id, item])).values()];
    mailboxCursor = next.nextCursor;
  }
  async function loadMembers(append = false) {
    const next = await api.listMembers(append ? { cursor: memberCursor ?? undefined } : {});
    members = [...new Map([...(append ? members : []), ...next.items].map((item) => [item.id, item])).values()];
    memberCursor = next.nextCursor;
  }
  onMount(() => {
    void Promise.allSettled([api.listDomains().then(({ items }) => domains = items), loadMailboxes()])
      .then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') loadError = failure(failed.reason);
        loading = false;
      });
  });
  async function select(value: Panel) { panel = value; await tick(); heading.focus(); }
  async function open(value: Action) {
    if (loading || busy) return;
    action = value; name = ''; email = ''; owner = ''; mailbox = mailboxes[0]?.id ?? '';
    kind = 'secondary'; aliasOf = addressDomains.find((domain) => domain.kind === 'primary')?.name ?? '';
    sendAs = false; error = ''; create.clear();
    await tick(); dialog.showModal();
    if (value === 'mailbox') {
      busy = true;
      try { await loadMembers(); }
      catch (cause) { error = failure(cause); }
      finally { busy = false; }
    }
  }
  async function moreMailboxes() {
    if (!mailboxCursor || loading) return;
    loading = true; loadError = '';
    try { await loadMailboxes(true); }
    catch (cause) { loadError = failure(cause); }
    finally { loading = false; }
  }
  async function moreMembers() {
    if (!memberCursor || busy) return;
    busy = true; error = '';
    try { await loadMembers(true); }
    catch (cause) { error = failure(cause); }
    finally { busy = false; }
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true; error = '';
    try {
      if (action === 'domain') {
        const input: DomainInput = { name: name.trim().toLowerCase(), kind, ...(kind === 'alias' ? { aliasOf } : {}) };
        const domain = await api.addDomain(input, create.options(input));
        domains = [...domains, domain];
      } else if (action === 'mailbox') {
        const input = { displayName: name.trim(), primaryAddress: email.trim().toLowerCase(), ownerUserId: owner };
        const added = await api.createMailbox(input, create.options(input));
        mailboxes = [...mailboxes, added];
      } else if (action === 'alias') {
        const input = { mailboxId: mailbox, address: email.trim().toLowerCase(), sendAs };
        const alias = await api.createAlias(input, create.options(input));
        mailboxes = mailboxes.map((item) => item.id === alias.mailboxId ? { ...item, aliases: [...item.aliases, alias] } : item);
      }
      create.clear(); dialog.close();
    } catch (cause) { error = failure(cause); }
    finally { busy = false; }
  }
</script>

<div class="toolbar"><button class="icon" aria-label="Back to mail" onclick={onBack}><ArrowLeft size={20} /></button><strong>Mail admin</strong></div>
<div class="admin-layout">
  <aside class="admin-nav" aria-label="Admin sections">
    {#each panels as item (item)}<button class="pill" aria-current={item === panel ? 'page' : undefined} onclick={() => select(item)}>{item}</button>{/each}
  </aside>
  <section class="admin-content" aria-labelledby="admin-heading">
    <h1 id="admin-heading" tabindex="-1" data-view-heading bind:this={heading}>{panel}</h1>
    <p class="muted">Manage mail addresses and domains for this workspace.</p>
    {#if loadError}<p role="alert" class="notice warning">{loadError}</p>{/if}
    <div class="admin-actions">
      {#if panel === 'Domains'}<button class="pill primary" disabled={loading} onclick={() => open('domain')}><Plus size={17} /> Add domain</button>
      {:else}<button class="pill primary" disabled={loading} onclick={() => open('mailbox')}><Plus size={17} /> Add mailbox</button><button class="pill" disabled={loading || !mailboxes.length} onclick={() => open('alias')}>Add alias</button>{/if}
    </div>
    <table class="admin-table" aria-labelledby="admin-heading" aria-busy={loading}>
      {#if panel === 'Domains'}
        <thead><tr><th scope="col">Domain</th><th scope="col">Type</th><th scope="col">Routing</th><th scope="col">Sending</th></tr></thead>
        <tbody>{#each domains as domain (domain.name)}<tr><th scope="row"><span class="table-icon"><Globe size={17} />{domain.name}</span></th><td>{title(domain.kind)}{domain.aliasOf ? ` of ${domain.aliasOf}` : ''}</td><td><span class="table-icon" class:success={domain.routing === 'active'}>{#if domain.routing === 'active'}<CircleCheck size={17} />{:else if domain.routing === 'pending'}<Clock3 size={17} />{/if}{title(domain.routing)}</span></td><td>{title(domain.sending)}</td></tr>{/each}</tbody>
      {:else}
        <thead><tr><th scope="col">Name</th><th scope="col">Address</th><th scope="col">Aliases</th></tr></thead>
        <tbody>{#each mailboxes as person (person.id)}<tr><th scope="row">{person.displayName}</th><td>{person.primaryAddress}</td><td>{person.aliases.map((item) => item.address).join(', ') || 'None'}</td></tr>{/each}</tbody>
      {/if}
    </table>
    {#if panel === 'Mailboxes and aliases' && mailboxCursor}<button class="pill" disabled={loading} onclick={moreMailboxes}>Load more mailboxes</button>{/if}
  </section>
</div>

<dialog class="modal" bind:this={dialog} aria-labelledby="admin-dialog-heading" oncancel={(event) => { if (busy) event.preventDefault(); }}>
  <form onsubmit={save}>
    <h2 id="admin-dialog-heading">Add {action ?? 'item'}</h2>
    {#if action === 'domain'}
      <label class="field">Domain name<input required maxlength="253" placeholder="team.example.com" bind:value={name} /></label>
      <label class="field">Domain type<select bind:value={kind}><option value="secondary">Secondary</option><option value="alias">Alias</option></select></label>
      {#if kind === 'alias'}<label class="field">Alias target<select required bind:value={aliasOf}>{#each addressDomains as domain (domain.name)}<option value={domain.name}>{domain.name}</option>{/each}</select></label>{/if}
    {:else if action === 'mailbox'}
      <label class="field">Display name<input required maxlength="256" bind:value={name} /></label><label class="field">Mailbox address<input type="email" required maxlength="254" bind:value={email} /></label>
      <label class="field">Workspace member<select required disabled={busy} bind:value={owner}><option disabled value="">Choose a member</option>{#each availableMembers as member (member.id)}<option value={member.id}>{member.name} ({member.email})</option>{/each}</select></label>
      {#if memberCursor}<button class="pill" type="button" disabled={busy} onclick={moreMembers}>Load more members</button>{:else if !availableMembers.length && !busy}<p class="muted">No workspace members without a mailbox.</p>{/if}
    {:else if action === 'alias'}
      <label class="field">Mailbox<select required bind:value={mailbox}>{#each mailboxes as person (person.id)}<option value={person.id}>{person.primaryAddress}</option>{/each}</select></label><label class="field">Alias address<input type="email" required maxlength="254" bind:value={email} /></label>
      <label class="checkbox-line"><input type="checkbox" bind:checked={sendAs} /> Request sending from this alias</label>
    {/if}
    {#if error}<p class="notice warning" role="alert">{error}</p>{/if}
    <div class="dialog-actions"><button class="pill" type="button" onclick={() => dialog.close()} disabled={busy}>Cancel</button><button class="pill primary" disabled={busy || (action === 'mailbox' && !owner)}>Save {action ?? 'item'}</button></div>
  </form>
</dialog>
