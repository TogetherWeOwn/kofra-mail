<script lang="ts">
  import { ArrowLeft, CircleCheck } from '@lucide/svelte';
  import type { Identity, Limits, Settings } from '@kofra/mail-contract';

  let { value, identities, limits, onBack, onSave }: {
    value: Settings; identities: Identity[]; limits: Limits; onBack: () => void;
    onSave: (patch: Partial<Settings>) => Promise<Settings>;
  } = $props();
  function initial() { return { ...value }; }
  let savedValue = initial();
  let settings = $state(initial());
  const identityKinds = { primary: 'Primary address', alias: 'Alias', alias_domain: 'Domain alias', group: 'Group' };
  const encoder = new TextEncoder();
  let saved = $state(false);
  let saving = $state(false);
  let error = $state('');
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    saving = true; error = ''; saved = false;
    try {
      if (encoder.encode(settings.signature).length > limits.signatureBytes) throw new Error('The signature is too long.');
      const patch: Partial<Settings> = {};
      if (settings.defaultFrom !== savedValue.defaultFrom) patch.defaultFrom = settings.defaultFrom;
      if (settings.signature !== savedValue.signature) patch.signature = settings.signature;
      if (settings.undoSeconds !== savedValue.undoSeconds) patch.undoSeconds = settings.undoSeconds;
      if (settings.replyFromReceivedAddress !== savedValue.replyFromReceivedAddress) patch.replyFromReceivedAddress = settings.replyFromReceivedAddress;
      if (Object.keys(patch).length) { savedValue = await onSave(patch); settings = { ...savedValue }; }
      saved = true;
    }
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
      <li><CircleCheck size={18} /><span><strong>{identity.email}</strong><small>{identityKinds[identity.kind]}{identity.sendAs === 'pending' ? ' · Sending pending' : ''}</small></span></li>
    {/each}
  </ul>
  <form onsubmit={save}>
    <label class="field">Default From address<select disabled={saving} bind:value={settings.defaultFrom}>{#each identities as identity (identity.email)}<option value={identity.email} disabled={identity.sendAs !== 'active'}>{identity.email}</option>{/each}</select></label>
    <label class="checkbox-line"><input type="checkbox" disabled={saving} bind:checked={settings.replyFromReceivedAddress} /> Reply from the address that received the message</label>
    <label class="field">Signature<textarea rows="4" maxlength={limits.signatureBytes} disabled={saving} bind:value={settings.signature} placeholder="Add a signature to new messages"></textarea></label>
    <label class="field">Undo send window<select disabled={saving} bind:value={settings.undoSeconds}>{#each limits.undoSecondsOptions as seconds (seconds)}<option value={seconds}>{seconds} seconds</option>{/each}</select></label>
    <button class="pill primary" disabled={saving}>Save settings</button>
    {#if saved}<p role="status" class="saved">Settings saved.</p>{/if}
    {#if error}<p role="alert" class="notice warning">{error}</p>{/if}
  </form>
</div>
