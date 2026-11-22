<script lang="ts">
  import { ArrowLeft, CircleCheck, Clock3, Globe, Plus, Users } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import type { DirectoryUser, Domain, Group, MailApi } from '@kofra/mail-core';

  let { api, onBack }: { api: MailApi; onBack: () => void } = $props();
  type Panel = 'Domains' | 'Users and aliases' | 'Groups';
  type Action = 'domain' | 'user' | 'alias' | 'group';
  const panels: Panel[] = ['Domains', 'Users and aliases', 'Groups'];
  let panel = $state<Panel>('Domains');
  let domains = $state<Domain[]>([]);
  let users = $state<DirectoryUser[]>([]);
  let groups = $state<Group[]>([]);
  let action = $state<Action>();
  let name = $state('');
  let email = $state('');
  let user = $state('');
  let kind = $state<Domain['kind']>('Primary');
  let moderated = $state(false);
  let error = $state('');
  let loadError = $state('');
  let busy = $state(false);
  let dialog: HTMLDialogElement;
  let heading: HTMLHeadingElement;
  const failure = (cause: unknown) => cause instanceof Error ? cause.message : 'The demo directory could not be updated.';
  async function refresh() { [domains, users, groups] = await Promise.all([api.listDomains(), api.listUsers(), api.listGroups()]); }
  onMount(() => { void refresh().catch((cause) => loadError = failure(cause)); });
  async function select(value: Panel) { panel = value; await tick(); heading.focus(); }
  async function open(value: Action) {
    action = value; name = ''; email = ''; user = users[0]?.email ?? ''; kind = 'Primary'; moderated = false; error = '';
    await tick(); dialog.showModal();
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true; error = '';
    try {
      if (action === 'domain') await api.addDomain(name, kind);
      else if (action === 'user') await api.addUser({ name: name.trim(), email: email.trim().toLowerCase() });
      else if (action === 'alias') await api.addAlias(user, email.trim().toLowerCase());
      else if (action === 'group') await api.addGroup({ name: name.trim(), email: email.trim().toLowerCase(), members: 0, moderated });
      await refresh(); dialog.close();
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
    <p class="muted">Changes affect example data only. No DNS, mail routing or access is changed.</p>
    {#if loadError}<p role="alert" class="notice warning">{loadError}</p>{/if}
    <div class="admin-actions">
      {#if panel === 'Domains'}<button class="pill primary" onclick={() => open('domain')}><Plus size={17} /> Add domain</button>
      {:else if panel === 'Users and aliases'}<button class="pill primary" onclick={() => open('user')}><Plus size={17} /> Add user</button><button class="pill" disabled={!users.length} onclick={() => open('alias')}>Add alias</button>
      {:else}<button class="pill primary" onclick={() => open('group')}><Plus size={17} /> Add group</button>{/if}
    </div>
    <table class="admin-table" aria-labelledby="admin-heading">
      {#if panel === 'Domains'}
        <thead><tr><th scope="col">Domain</th><th scope="col">Type</th><th scope="col">Status</th></tr></thead>
        <tbody>{#each domains as domain (domain.name)}<tr><th scope="row"><span class="table-icon"><Globe size={17} />{domain.name}</span></th><td>{domain.kind}</td><td><span class="table-icon" class:success={domain.status === 'Active'}>{#if domain.status === 'Active'}<CircleCheck size={17} />{:else}<Clock3 size={17} />{/if}{domain.status}</span></td></tr>{/each}</tbody>
      {:else if panel === 'Users and aliases'}
        <thead><tr><th scope="col">Name</th><th scope="col">Address</th><th scope="col">Aliases</th></tr></thead>
        <tbody>{#each users as person (person.email)}<tr><th scope="row">{person.name}</th><td>{person.email}</td><td>{person.aliases.join(', ') || 'None'}</td></tr>{/each}</tbody>
      {:else}
        <thead><tr><th scope="col">Group</th><th scope="col">Address</th><th scope="col">Members</th><th scope="col">Posting</th></tr></thead>
        <tbody>{#each groups as group (group.email)}<tr><th scope="row"><span class="table-icon"><Users size={17} />{group.name}</span></th><td>{group.email}</td><td>{group.members}</td><td>{group.moderated ? 'Moderated' : 'Open'}</td></tr>{/each}</tbody>
      {/if}
    </table>
  </section>
</div>

<dialog class="modal" bind:this={dialog} aria-labelledby="admin-dialog-heading">
  <form onsubmit={save}>
    <h2 id="admin-dialog-heading">Add {action ?? 'item'}</h2>
    {#if action === 'domain'}
      <label class="field">Domain name<input required maxlength="253" placeholder="team.example.com" bind:value={name} /></label>
      <label class="field">Domain type<select bind:value={kind}><option>Primary</option><option>Alias</option></select></label>
    {:else if action === 'user'}
      <label class="field">Display name<input required maxlength="128" bind:value={name} /></label><label class="field">User email<input type="email" required maxlength="254" bind:value={email} /></label>
    {:else if action === 'alias'}
      <label class="field">User<select required bind:value={user}>{#each users as person (person.email)}<option value={person.email}>{person.email}</option>{/each}</select></label><label class="field">Alias email<input type="email" required maxlength="254" bind:value={email} /></label>
    {:else if action === 'group'}
      <label class="field">Group name<input required maxlength="128" bind:value={name} /></label><label class="field">Group email<input type="email" required maxlength="254" bind:value={email} /></label><label class="checkbox-line"><input type="checkbox" bind:checked={moderated} /> Moderate posts</label>
    {/if}
    {#if error}<p class="notice warning" role="alert">{error}</p>{/if}
    <div class="dialog-actions"><button class="pill" type="button" onclick={() => dialog.close()} disabled={busy}>Cancel</button><button class="pill primary" disabled={busy}>Save {action ?? 'item'}</button></div>
  </form>
</dialog>
