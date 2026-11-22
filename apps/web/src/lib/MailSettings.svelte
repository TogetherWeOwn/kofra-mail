<script lang="ts">
  import { ArrowLeft, CircleCheck } from '@lucide/svelte';
  import type { Identity, Settings } from '@kofra/mail-core';

  let { value, identities, onBack, onSave }: {
    value: Settings; identities: Identity[]; onBack: () => void; onSave: (settings: Settings) => Promise<void>;
  } = $props();
  function initial() { return { ...value }; }
  let settings = $state(initial());
  let saved = $state(false);
  let saving = $state(false);
  let error = $state('');
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    saving = true; error = ''; saved = false;
    try { await onSave({ ...settings }); saved = true; }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Settings could not be saved.'; }
    finally { saving = false; }
  }
</script>

<div class="toolbar">
  <button class="icon" aria-label="Back to mail" onclick={onBack}><ArrowLeft size={20} /></button>
</div>
<div class="settings-screen">
  <h1 tabindex="-1" data-view-heading>Mail settings</h1>
  <h2>Addresses</h2>
  <p class="muted">Choose the default address for new messages. You can change it when composing.</p>
  <ul class="address-list">
    {#each identities as identity (identity.email)}
      <li><CircleCheck size={18} /><span><strong>{identity.email}</strong><small>{identity.primary ? 'Primary address' : 'Alias'}</small></span></li>
    {/each}
  </ul>
  <form onsubmit={save}>
    <label class="field">Default From address<select bind:value={settings.defaultFrom}>{#each identities as identity (identity.email)}<option value={identity.email}>{identity.email}</option>{/each}</select></label>
    <label class="field">Signature<textarea rows="4" maxlength="5000" bind:value={settings.signature} placeholder="Add a signature to new messages"></textarea></label>
    <label class="field">Undo send window<select bind:value={settings.undoSeconds}>{#each [5, 10, 20, 30] as seconds (seconds)}<option value={seconds}>{seconds} seconds</option>{/each}</select></label>
    <button class="pill primary" disabled={saving}>Save settings</button>
    {#if saved}<p role="status" class="saved">Settings saved.</p>{/if}
    {#if error}<p role="alert" class="notice warning">{error}</p>{/if}
  </form>
</div>
